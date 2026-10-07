import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MpAuthService } from '../server/mp-auth-service.mjs';
import { createPublicApiHandler } from '../server/public-api-router.mjs';
import { createWebLoginService } from '../server/web-login-service.mjs';
import { AtomicJsonStore } from '../server/atomic-json-store.mjs';
import { ReviewSubmissionService } from '../server/review-submission-service.mjs';

const root = path.resolve(import.meta.dirname, '..');
const password = 'S5-only-synthetic-password';

test('S5 actual HTTP: account transaction invalidates confirmed tickets and all sessions without choosing a content policy', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s5-http-'));
  const app = path.join(dir, 'app'), dataDir = path.join(dir, 'data'), dbPath = path.join(dir, 'state.sqlite');
  await fs.mkdir(app); await fs.mkdir(dataDir);
  await fs.cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
  await fs.writeFile(path.join(app, 'package.json'), '{"type":"module"}');
  for (const name of ['about', 'feedback', 'footer', 'guides', 'home', 'links', 'manifest', 'participate', 'reviews']) {
    await fs.copyFile(path.join(root, 'src/data/fixtures', name + '.json'), path.join(dataDir, name + '.json'));
  }
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
    const marker = `s5-http-${++sequence}`;
    const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-nkustudy-admin-request': '1', 'user-agent': marker, 'x-forwarded-for': `198.51.100.${sequence % 250 + 1}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}\n${output}`);
    return { value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], marker };
  }
  const a = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'S5 account A', password, email: 'synthetic@example.invalid' } });
  const b = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'S5 account B', password } });
  const aid = a.value.data.user.id, bid = b.value.data.user.id;
  db.prepare('UPDATE mp_users SET phone=?,phone_verified_at=? WHERE id=?').run('13800005555', Date.now(), aid);
  for (const id of [aid, bid]) db.prepare('INSERT INTO mp_favorites VALUES(?,?,?)').run(id, 'synthetic-course', Date.now());
  const otherBefore = db.prepare('SELECT * FROM mp_users WHERE id=?').get(bid);
  const second = await request('/api/v1/auth/web-login', { method: 'POST', body: { nickname: 'S5 account A', password } });
  const ticket = (await request('/api/v1/auth/web-login/start', { method: 'POST', body: {} })).value.data.ticket;
  await request('/api/v1/auth/web-login/confirm', { method: 'POST', cookie: a.cookie, body: { ticket } });
  const beforeContent = await Promise.all(['reviews', 'feedback'].map(name => fs.readFile(path.join(dataDir, name + '.json'), 'utf8')));

  const removed = await request('/api/v1/me/delete-account', { method: 'POST', cookie: a.cookie, body: {} });
  assert.equal(removed.value.data.deleted, true);
  assert.match(removed.headers.get('set-cookie'), /Max-Age=0/);
  const row = db.prepare('SELECT * FROM mp_users WHERE id=?').get(aid);
  assert.ok(row.deleted_at > 0);
  for (const key of ['openid', 'web_password_hash', 'phone_verified_at']) assert.equal(row[key], null, key);
  for (const key of ['phone', 'avatar_url', 'email']) assert.equal(row[key], '', key);
  assert.equal(row.nickname.includes('S5 account A'), false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mp_auth_tokens WHERE user_id=?').get(aid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mp_favorites WHERE user_id=?').get(aid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mp_favorites WHERE user_id=?').get(bid).n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM mp_users WHERE id=?').get(bid), otherBefore);
  const event = db.prepare('SELECT * FROM user_security_logs WHERE user_agent=? AND action=?').get(removed.marker, 'account.delete');
  assert.equal(event.user_id, aid); assert.equal(event.result, 'ok');
  for (const cookie of [a.cookie, second.cookie]) {
    await request('/api/v1/me', { cookie, status: 401 });
    await request('/api/v1/auth/web-login', { cookie, method: 'POST', body: {}, status: 401 });
    await request('/api/v1/me/web-password', { cookie, method: 'POST', body: { password }, status: 401 });
  }
  const redemption = await request('/api/v1/auth/web-login/status?ticket=' + ticket);
  assert.equal(redemption.value.data.status, 'expired');
  assert.equal(redemption.headers.has('set-cookie'), false);
  await request('/api/v1/auth/web-login', { method: 'POST', body: { nickname: 'S5 account A', password }, status: 401 });
  assert.deepEqual(await Promise.all(['reviews', 'feedback'].map(name => fs.readFile(path.join(dataDir, name + '.json'), 'utf8'))), beforeContent);
  await stop(); await start();
  await request('/api/v1/me', { cookie: a.cookie, status: 401 });
  assert.equal(db.prepare('SELECT deleted_at FROM mp_users WHERE id=?').get(aid).deleted_at, row.deleted_at);
  await request('/api/v1/me', { cookie: b.cookie });
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('S5 requests paused in body reading cannot mutate after account deletion or session revocation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s5-body-'));
  const auth = new MpAuthService({ dbPath: path.join(dir, 'state.sqlite') });
  t.after(async () => { auth.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let sequence = 0;
  for (const invalidate of ['delete', 'revoke']) for (const route of ['/api/v1/auth/web-login/confirm', '/api/v1/reviews', '/api/v1/reviews/r1/reaction', '/api/v1/me/profile', '/api/v1/me/web-password', '/api/v1/me/web-password/change', '/api/v1/favorites']) {
    const session = auth.webRegister({ nickname: 'body-race-' + ++sequence, password });
    auth.setVerifiedPhone(session.user.id, '13800006666');
    const tickets = createWebLoginService(), ticket = tickets.create();
    const reached = deferred(), release = deferred(); let businessCalls = 0;
    const handler = createPublicApiHandler({ mpAuthService: auth, webLoginTickets: tickets, mpFavoritesService: { add() { businessCalls++; } },
      service: { assertReviewAttempt() {}, submitReview() { businessCalls++; }, reactReviewHelpful() { businessCalls++; } },
      clientIp: () => 'synthetic', readBody: async () => { reached.resolve(); await release.promise; return { ticket: ticket.id, reaction: 'up', nickname: 'unwanted', password, current_password: password, new_password: password }; } });
    const req = { method: route.endsWith('reaction') ? 'PUT' : 'POST', headers: { authorization: 'Bearer ' + session.token } };
    const response = { status: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const operation = handler(req, response, new URL(route, 'https://example.invalid'));
    await reached.promise;
    if (invalidate === 'delete') auth.deleteAccount(session.user.id);
    else auth.revoke('Bearer ' + session.token);
    const accountAfterInvalidation = auth.db.prepare('SELECT * FROM mp_users WHERE id=?').get(session.user.id);
    release.resolve(); await operation;
    assert.equal(response.status, 401, route);
    assert.equal(businessCalls, 0); assert.equal(tickets.get(ticket.id).status, 'pending');
    assert.deepEqual(auth.db.prepare('SELECT * FROM mp_users WHERE id=?').get(session.user.id), accountAfterInvalidation);
  }
});

test('S5 review mutations recheck account state after waiting for the JSON writer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s5-json-'));
  const dbPath = path.join(dir, 'state.sqlite'), reviewsPath = path.join(dir, 'reviews.json');
  const auth = new MpAuthService({ dbPath });
  t.after(async () => { auth.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const template = JSON.parse(await fs.readFile(path.join(root, 'src/data/fixtures/reviews.json'), 'utf8'));
  template.rules = { ...template.rules, submissionOpen: true, minLength: 1 };
  const store = new AtomicJsonStore({ allowedRoot: dir }); await store.write(reviewsPath, template);
  const service = new ReviewSubmissionService({ store, reviewsPath, readReviews: () => store.readSync(reviewsPath),
    consumeAttempt: () => true, consumeSubmission: () => true, actorHash: () => 'synthetic', assertActiveUser: id => auth.assertActiveUser(id) });
  for (const invalidate of ['delete', 'revoke']) for (const kind of ['submit', 'reaction']) {
    const session = auth.webRegister({ nickname: 'queue-' + kind + '-' + invalidate, password });
    const reached = deferred(), release = deferred();
    const first = store.update(reviewsPath, async current => { reached.resolve(); await release.promise; return current; });
    await reached.promise;
    const before = await fs.readFile(reviewsPath, 'utf8');
    const authorize = () => auth.requireUser('Bearer ' + session.token);
    const operation = kind === 'submit' ? service.submit({ courseTitle: 'S5', teacher: 'Synthetic', rating: 5, content: 'Synthetic review' }, { userId: session.user.id, authorize }) : service.reactHelpful('any-id', session.user.id, 'up', { authorize });
    const rejected = assert.rejects(operation, error => error.statusCode === 401);
    if (invalidate === 'delete') auth.deleteAccount(session.user.id);
    else auth.revoke('Bearer ' + session.token);
    release.resolve(); await first; await rejected;
    assert.equal(await fs.readFile(reviewsPath, 'utf8'), before);
  }
});
