import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { archiveRows } from '../server/durable-log.mjs';

const root = path.resolve(import.meta.dirname, '..');
const password = 'S4-only-synthetic-password';

test('S4 actual HTTP: complete scoped exports, archived history, audit linkage and administrator isolation', { timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s4-law-'));
  const app = path.join(dir, 'app'), dataDir = path.join(dir, 'data'), dbPath = path.join(dir, 'state.sqlite');
  await fs.mkdir(app); await fs.mkdir(dataDir);
  await fs.cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
  await fs.writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  for (const name of ['about', 'feedback', 'footer', 'guides', 'home', 'links', 'manifest', 'participate', 'reviews']) {
    await fs.copyFile(path.join(root, 'src/data/fixtures', name + '.json'), path.join(dataDir, name + '.json'));
  }
  const reviews = JSON.parse(await fs.readFile(path.join(dataDir, 'reviews.json')));
  reviews.reviews = [
    { id: 'r1', user_id: 1, courseTitle: 'Synthetic course', teacher: 'Synthetic teacher', content: 'S4_OWNER_REVIEW', status: 'approved' },
    { id: 'r10', user_id: 10, courseTitle: 'Decoy course', teacher: 'Decoy', content: 'S4_OTHER_REVIEW', status: 'approved' },
  ];
  await fs.writeFile(path.join(dataDir, 'reviews.json'), JSON.stringify(reviews));
  const feedback = JSON.parse(await fs.readFile(path.join(dataDir, 'feedback.json')));
  feedback.items = Array.from({ length: 305 }, (_, i) => ({ id: `f-owner-${i}`, user_id: 1, type: 'report', private: true, title: `Synthetic ${i}`, content: `S4_PRIVATE_BODY_${i}`, status: 'pending' }));
  feedback.items.push({ id: 'f-owner-10-extra', user_id: 10, type: 'report', private: true, title: 'Other account', content: 'S4_OTHER_PRIVATE_BODY', status: 'pending' });
  await fs.writeFile(path.join(dataDir, 'feedback.json'), JSON.stringify(feedback));
  await fs.writeFile(path.join(dataDir, 'notify-settings.json'), '{"enabled":false}');
  await fs.writeFile(path.join(dataDir, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), ADMIN_ORIGIN: base, ADMIN_INITIAL_PASSWORD: password,
    ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'), BACKUP_SECRET_FILE: path.join(dataDir, 'backup-secrets.json'),
    PUBLIC_DIR: path.join(dir, 'public/current'), PUBLIC_RELEASES_DIR: path.join(dir, 'public/releases'), TRUSTED_PROXIES: '127.0.0.1/32' };
  let child, db, output = '', sequence = 0;
  async function start() {
    output = ''; child = spawn(process.execPath, ['server/admin-server.mjs'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output)), 15000);
      const collect = chunk => { output += chunk; if (output.includes('NKUStudy admin API listening')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    });
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); db?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await start(); db = new Database(dbPath); db.pragma('busy_timeout=5000');
  async function request(route, { cookie = '', method = 'GET', body, status = 200 } = {}) {
    const marker = `s4-http-${++sequence}`;
    const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-nkustudy-admin-request': '1', 'user-agent': marker, 'x-forwarded-for': `198.51.100.${sequence % 250 + 1}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer()), value = JSON.parse(bytes);
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}\n${output}`);
    const audit = db.prepare('SELECT * FROM admin_audit_log WHERE user_agent=? ORDER BY id').all(marker);
    if (route.startsWith('/admin-api/')) { assert.ok(audit.length); assert.equal(audit[0].status, status); }
    return { value, bytes, headers: response.headers, audit, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async username => (await request('/admin-api/login', { method: 'POST', body: { username, password } })).cookie;
  const admin = await login('Shview');
  const user = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'S4 synthetic user', password } });
  assert.equal(user.value.data.user.id, 1);
  db.prepare('UPDATE mp_users SET phone=?,phone_verified_at=?,openid=? WHERE id=1').run('13800001111', Date.now(), 'synthetic-openid-S4');
  const cookies = [admin];
  for (const [username, permissions] of [['S4viewer', ['content.read']], ['S4service', ['services.manage']], ['S4empty', []]]) {
    await request('/admin-api/accounts', { method: 'POST', cookie: admin, body: { username, password, permissions: permissions.length ? permissions : ['ai.manage'] } });
    // The UI disallows creating empty permissions; retained legacy accounts may still have none.
    if (!permissions.length) db.prepare('UPDATE admin_accounts SET permissions=? WHERE username=?').run('[]', username);
    cookies.push(await login(username));
  }

  const insertSecurity = db.prepare('INSERT INTO user_security_logs(at,user_id,action,target_type,target_id,result,detail,event_id) VALUES(?,?,?,?,?,?,?,?)');
  const insertAudit = db.prepare('INSERT INTO admin_audit_log(at,username,action,target,detail,event_id) VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 340; i++) {
      insertSecurity.run(1000 + i, 1, 'review.submit', 'review', 'r1', 'ok', 'synthetic', `s4-security-${i}`);
      insertAudit.run(1000 + i, 'Shview', 'content.update', 'feedback:f-owner-1', 'synthetic', `s4-audit-${i}`);
    }
    insertSecurity.run(1200, 10, 'review.submit', 'review', 'r10', 'ok', 'OTHER_LOG_SENTINEL', 's4-other-security');
    insertAudit.run(1200, 'Shview', 'content.update', 'feedback:f-owner-10-extra', 'OTHER_AUDIT_SENTINEL', 's4-other-audit');
  })();
  for (const [table, directory] of [['user_security_logs', 'security-archive'], ['admin_audit_log', 'audit-archive']]) {
    // Use the application's verified archive format; keep only 80 rows online.
    archiveRows({ db, table, directory: path.join(dataDir, directory), keepRows: 80, threshold: 300 });
  }
  const criteria = 'type=account&value=1&from=1000&to=2000&action=review.submit&audit_action=content.update&reference=S4-DEMO-001';

  await t.test('every enabled administrator can query and export, with exact archive-inclusive scope', async () => {
    for (const cookie of cookies) {
      const read = await request('/admin-api/law-query?' + criteria + '&log_page_size=100&content_page_size=100', { cookie });
      assert.equal(read.value.data.query.target, 'user:1'); assert.equal(read.value.data.complete, false);
      assert.equal(read.value.data.log_pagination.total, 340); assert.equal(read.value.data.audit_pagination.total, 340);
      assert.equal(read.value.data.feedback_pagination.total, 305);
      assert.equal(read.value.data.security_logs.length, 100); assert.equal(read.value.data.admin_audit.length, 100);
      const exported = await request('/admin-api/law-export?' + criteria + '&log_page=999&log_page_size=1&feedback_page=999', { cookie });
      assert.equal(exported.value.complete, true); assert.equal(exported.value.feedback.length, 305);
      assert.equal(exported.value.security_logs.length, 340); assert.equal(exported.value.admin_audit.length, 340);
      assert.equal(exported.value.reviews.length, 1); assert.equal(exported.value.account.id, 1);
      assert.equal(exported.value.snapshot.atomic_across_sources, false);
      assert.equal(exported.headers.get('cache-control'), 'no-store'); assert.match(exported.headers.get('content-disposition'), /attachment/);
      const digest = createHash('sha256').update(exported.bytes).digest('hex');
      assert.equal(exported.headers.get('x-content-sha256'), digest);
      const eventId = exported.value.audit_event_id;
      assert.equal(exported.audit[0].event_id, eventId); assert.equal(JSON.parse(exported.audit[0].detail).sha256, digest);
      const law = db.prepare('SELECT * FROM law_enforcement_logs WHERE event_id=?').get(eventId);
      assert.equal(law.query_value, 'user:1'); assert.equal(law.exported, 1); assert.ok(law.result_summary.includes(digest));
      const text = exported.bytes.toString();
      for (const secret of ['S4_OTHER_', 'OTHER_LOG_SENTINEL', 'OTHER_AUDIT_SENTINEL', 'web_password_hash', password, cookie.split('=')[1]]) assert.equal(text.includes(secret), false, secret);
    }
    const second = (await request('/admin-api/law-query?' + criteria + '&log_page=2&audit_page=2&feedback_page=2', { cookie: cookies[1] })).value.data;
    assert.equal(second.log_pagination.page, 2); assert.equal(second.security_logs.length, 100);
    assert.equal(second.feedback.length, 100); assert.equal(second.feedback[0].id, 'f-owner-100');
    const content = await request('/admin-api/law-query?type=feedback&id=f-owner-1&from=1000&to=2000', { cookie: cookies[2] });
    assert.equal(content.audit[0].target, 'feedback:f-owner-1'); assert.equal(content.value.data.admin_audit.length, 100);
    assert.equal(content.value.data.audit_pagination.total, 340); assert.equal(content.value.data.feedback.length, 1);
    assert.equal((await request('/admin-api/law-query?value=13800001111', { cookie: admin })).value.data.account.id, 1);
    assert.equal((await request('/admin-api/law-query?value=synthetic-openid-S4', { cookie: admin })).value.data.account.id, 1);
  });

  await t.test('anonymous, ordinary user, disabled, expired and revoked admin credentials are rejected', async () => {
    for (const cookie of ['', user.cookie, '__Host-nkustudy_admin=invalid']) {
      for (const endpoint of ['law-query', 'law-export', 'law-logs']) await request('/admin-api/' + endpoint + '?value=1', { cookie, status: 401 });
    }
    db.prepare("UPDATE admin_accounts SET enabled=0 WHERE username='S4empty'").run();
    await request('/admin-api/law-export?value=1', { cookie: cookies[3], status: 401 });
    db.prepare("UPDATE admin_accounts SET enabled=1 WHERE username='S4empty'").run();
    const expired = await login('S4empty');
    db.prepare("UPDATE admin_sessions SET expires_at=1 WHERE username='S4empty'").run();
    await request('/admin-api/law-query?value=1', { cookie: expired, status: 401 });
    const revoked = await login('S4empty');
    await request('/admin-api/logout', { method: 'POST', cookie: revoked, body: {} });
    await request('/admin-api/law-logs', { cookie: revoked, status: 401 });
    await request('/admin-api/backup?scope=all', { cookie: cookies[1], status: 403 });
  });

  await t.test('history refresh pages retained records; errors are audited and never download a partial file', async () => {
    for (const suffix of ['type=none', 'type=review&id=missing', 'value=1&from=invalid', 'value=1&from=2&to=1', 'value=1&log_page=-1']) {
      const status = suffix.includes('missing') ? 404 : 400;
      const result = await request('/admin-api/law-query?' + suffix, { cookie: admin, status });
      assert.equal(result.value.ok, false);
    }
    const failure = await request('/admin-api/law-export?value=unknown-sensitive-identifier', { cookie: admin, status: 404 });
    assert.equal(failure.headers.has('content-disposition'), false);
    const archive = archiveRows({ db, table: 'law_enforcement_logs', directory: path.join(dataDir, 'law-archive'), keepRows: 5, threshold: 10 });
    assert.ok(archive);
    const before = db.prepare('SELECT COUNT(*) n FROM law_enforcement_logs').get().n;
    const history = (await request('/admin-api/law-logs?actor=Shview&exported=true&page_size=2', { cookie: admin })).value;
    assert.ok(history.total >= 2); assert.equal(history.items.length, 2);
    assert.ok(history.items.every(row => row.queried_by === 'Shview' && row.exported === 1));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM law_enforcement_logs').get().n, before, 'history reads do not create fake queries in that same history');
    await stop(); await start();
    const again = (await request('/admin-api/law-logs?actor=Shview&exported=true&page_size=2', { cookie: admin })).value;
    assert.equal(again.total, history.total);
    const feedbackFile = path.join(dataDir, 'feedback.json');
    const savedFeedback = await fs.readFile(feedbackFile);
    try {
      const oversized = JSON.parse(savedFeedback);
      // Stay below the row cap and normal per-content length, but exceed the
      // attachment byte cap. This checks the real route, not a helper constant.
      oversized.items = Array.from({ length: 20000 }, (_, i) => ({
        ...oversized.items[0], id: `s4-large-${i}`, user_id: 1, content: 'x'.repeat(1900),
      }));
      await fs.writeFile(feedbackFile, JSON.stringify(oversized));
      const tooLarge = await request('/admin-api/law-export?value=1', { cookie: admin, status: 413 });
      assert.equal(tooLarge.value.code, 'LAW_EXPORT_TOO_LARGE');
      assert.equal(tooLarge.headers.has('content-disposition'), false);
      assert.equal(tooLarge.headers.has('x-content-sha256'), false);
      assert.equal(tooLarge.value.complete, undefined);
      assert.ok(tooLarge.bytes.length < 2000, 'the rejected attachment is not sent in the error response');
    } finally { await fs.writeFile(feedbackFile, savedFeedback); }
    await fs.writeFile(path.join(dataDir, 'security-archive', 'user_security_logs-corrupt.json'), '{"invalid":true}');
    const damaged = await request('/admin-api/law-export?value=1', { cookie: admin, status: 503 });
    assert.equal(damaged.headers.has('content-disposition'), false); assert.equal(damaged.value.complete, undefined);
    assert.equal(damaged.bytes.includes(Buffer.from(dataDir)), false);
    const auditText = JSON.stringify(db.prepare('SELECT detail FROM admin_audit_log').all()) + JSON.stringify(db.prepare('SELECT query_value,result_summary FROM law_enforcement_logs').all());
    for (const text of ['unknown-sensitive-identifier', '13800001111', 'synthetic-openid-S4', 'S4_PRIVATE_BODY_', password]) assert.equal(auditText.includes(text), false, text);
  });
});
