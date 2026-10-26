import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { communitySupportLevel } from '../server/community-support-runtime.mjs';
import { createLearningCompassService } from '../server/learning-compass-service.mjs';
import { writeSiteIconAssets } from '../server/site-icon-service.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('level uses the smaller effective contribution and can decrease after reversal', () => {
  for (const [flowers, coins, level] of [[0,0,1],[10,9,1],[10,10,2],[25,12,2],[30,30,4]]) {
    assert.equal(communitySupportLevel(flowers, coins), level);
  }
  assert.equal(communitySupportLevel(30, 9), 1);
  assert.throws(() => communitySupportLevel(-1, 10), { code: 'SUPPORT_UNAVAILABLE' });
});

test('guide source identity must resolve to one public original, including variants', () => {
  const source = { id: 'source-a', file_url: 'https://resources.nkustudy.top/guide-sources/a.pdf' };
  const snapshot = { guides: [{ id: 'guide-a', sources: [source], variant_details: [{ sections: [{ source_ids: ['variant-source'] }] }] }],
    sources: [source, { id: 'variant-source', file_url: 'https://resources.nkustudy.top/guide-sources/v.pdf' }, { id: 'unused', file_url: source.file_url }] };
  const service = createLearningCompassService(snapshot);
  assert.deepEqual(service.publicDownloadSourceById('source-a'), source);
  assert.equal(service.publicDownloadSourceById('variant-source').id, 'variant-source');
  assert.equal(service.publicDownloadSourceById('unused'), null);
  snapshot.sources.push({ id: 'source-a', file_url: 'https://resources.nkustudy.top/guide-sources/different.pdf' });
  assert.equal(createLearningCompassService(snapshot).publicDownloadSourceById('source-a'), null);
});

test('actual server: capability, downloads, moderation, restart, account deletion and disabled rollout', { timeout: 90000 }, async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nkustudy-support-http-')));
  const dataDir = path.join(dir, 'data');
  const dbPath = path.join(dir, 'state.sqlite');
  await fs.mkdir(dataDir);
  for (const name of ['about','feedback','footer','guides','home','links','manifest','participate','reviews']) {
    await fs.copyFile(path.join(root, 'src/data/fixtures', `${name}.json`), path.join(dataDir, `${name}.json`));
  }
  const manifestPath = path.join(dataDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.resourceRoot = 'https://resources.nkustudy.top/resources/';
  manifest.courses[0].sections[0].files = [{ title: 'Synthetic.pdf', path: 'fixtures/example-course/synthetic.pdf', size: 32 }];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const reviewsPath = path.join(dataDir, 'reviews.json');
  const reviews = JSON.parse(await fs.readFile(reviewsPath, 'utf8'));
  reviews.rules = { ...reviews.rules, submissionOpen: true, moderationRequired: true, minLength: 5, hourlyLimit: 100, dailyLimit: 100 };
  reviews.reviews = [{ id: 'historic-review', courseTitle: '示例课程', teacher: '历史教师', content: 'historical synthetic review', rating: 5, status: 'approved', hidden: false }];
  await fs.writeFile(reviewsPath, JSON.stringify(reviews));
  await fs.writeFile(path.join(dataDir, 'notify-settings.json'), '{"enabled":false,"guide_feedback_enabled":false}');
  await fs.writeFile(path.join(dataDir, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = 'synthetic-support-password-2026';
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), ADMIN_ORIGIN: base, ADMIN_INITIAL_PASSWORD: password,
    ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'), BACKUP_SECRET_FILE: path.join(dataDir, 'backup-secrets.json'),
    PUBLIC_DIR: path.join(dir, 'public/current'), PUBLIC_RELEASES_DIR: path.join(dir, 'public/releases'), TRUSTED_PROXIES: '127.0.0.1/32',
    COMMUNITY_SUPPORT_ENABLED: '1', COMMUNITY_SUPPORT_DOWNLOAD_REPORTING: '1', COMMUNITY_SUPPORT_PERSONAL_STATS: '1' };
  let child, db, output = '';
  async function start() {
    output = '';
    child = spawn(process.execPath, ['server/admin-server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Synthetic server did not start: ${output}`)), 15000);
      const collect = chunk => { output += chunk; if (output.includes('NKUStudy admin API listening')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Synthetic server exited: ${output}`)); });
    });
  }
  async function stop() {
    if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
  // Retain the isolated synthetic files as evidence; no recursive cleanup.
  t.after(async () => { await stop(); db?.close(); });
  t.diagnostic(`Synthetic evidence directory: ${dir}`);
  async function request(route, { method = 'GET', body, token, cookie, status = 200 } = {}) {
    const headers = { 'content-type': 'application/json', origin: base, 'x-nkustudy-admin-request': '1' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
    return { value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const home = async () => (await request('/api/v1/home')).value.data.community_support;
  await start();
  db = new Database(dbPath);
  db.pragma('busy_timeout=5000');
  const initial = await home();
  assert.equal(initial.enabled, true, output);
  assert.equal(initial.flowers, 0); assert.equal(initial.coins, 0, 'historical approved reviews are not backfilled');
  const admin = await request('/admin-api/login', { method: 'POST', body: { username: 'Shview', password } });
  await t.test('UI11 theme settings and public CSS remain functional', async () => {
    const saved = await request('/admin-api/theme-settings', { method: 'POST', cookie: admin.cookie,
      body: { data: { active: { light: { '--primary': '#123456' }, dark: {} } } } });
    assert.equal(saved.value.data.active.light['--primary'], '#123456');
    const current = await request('/admin-api/theme-settings', { cookie: admin.cookie });
    assert.equal(current.value.data.customDefault.light['--primary'], '#123456');
    const css = await fetch(base + '/theme.css');
    assert.equal(css.status, 200); assert.match(await css.text(), /--primary:#123456;/);
  });
  await t.test('UI11 existing upload rejection is preserved and existing custom icons still serve', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } }).png().toBuffer();
    const response = await fetch(base + '/admin-api/site-icon', { method: 'POST', body: png,
      headers: { 'content-type': 'image/png', cookie: admin.cookie, origin: base, 'x-nkustudy-admin-request': '1' } });
    // Independently reproduced on the exported UI11 server: its existing admin
    // content-type gate rejects raw PNG with 415. This feature does not fix it.
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, 'Content-Type must be application/json.');
    // Seed an existing icon using UI11's real image writer, then check serving.
    await writeSiteIconAssets({ bytes: png, dataDir, sharpImpl: sharp });
    const icon = await fetch(base + '/site-icon/favicon-32.png');
    assert.equal(icon.status, 200); assert.equal(icon.headers.get('x-site-icon-source'), 'custom');
    assert.equal((await sharp(Buffer.from(await icon.arrayBuffer())).metadata()).width, 32);
    const head = await fetch(base + '/site-icon/favicon-32.png', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
  await t.test('UI11 backup selection still rejects an empty backup without producing one', async () => {
    const result = await request('/admin-api/backup-run', { method: 'POST', cookie: admin.cookie, status: 409,
      body: { parts: { siteData: false, serverConfig: false, courseFiles: false } } });
    // Original UI11 drops the internal code and returns 409; preserve that
    // observed contract while proving no empty backup is reported complete.
    assert.equal(result.value.code, undefined);
    assert.equal(result.value.error, '至少选择一项备份内容。');
    assert.equal(result.value.complete, false);
  });
  const A = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'Support synthetic A', password } });
  const B = await request('/api/v1/auth/web-register', { method: 'POST', body: { nickname: 'Support synthetic B', password } });
  const tokenA = A.cookie.split('=')[1], tokenB = B.cookie.split('=')[1];
  db.prepare('UPDATE mp_users SET phone=?,phone_verified_at=? WHERE id=?').run('13800000001', Date.now(), A.value.data.user.id);
  const courseId = manifest.courses[0].uid;
  const resources = (await request(`/api/v1/courses/${courseId}/resources`)).value.data.items;
  const event = { event_id: 'mp_synthetic_download_0001', kind: 'resource', resource_id: resources[0].id, course_id: courseId, attribution: 'account' };
  const download = (body, options = {}) => request('/api/v1/community-support/downloads', { method: 'POST', body, token: tokenA, ...options });
  const replay = await Promise.all(Array.from({ length: 100 }, () => download(event)));
  assert.ok(replay.every(item => item.value.data.recorded === true));
  assert.equal((await home()).flowers, 1);
  await download(event, { token: tokenB, status: 409 });
  await download({ ...event, resource_id: 'unknown' }, { status: 409 });
  await download({ ...event, event_id: 'mp_synthetic_unknown_0002', resource_id: 'unknown' }, { status: 404 });
  await download({ ...event, event_id: 'mp_synthetic_forged_0003', user_id: B.value.data.user.id }, { status: 400 });
  await download({ ...event, event_id: 'mp_synthetic_oversized_003', resource_id: 'x'.repeat(5000) }, { status: 400 });
  await download({ ...event, event_id: 'mp_synthetic_anon_bad_004', attribution: 'community' }, { status: 400 });
  await download({ ...event, event_id: 'mp_synthetic_anonymous_005', attribution: 'community' }, { token: undefined });
  await download({ ...event, event_id: 'mp_synthetic_expired_0006' }, { token: 'invalid', status: 401 });
  await download({ ...event, event_id: 'mp_synthetic_cookie_0007' }, { token: undefined, cookie: A.cookie, status: 401 });
  assert.deepEqual((await request('/api/v1/me/community-support', { token: tokenA })).value.data, { flowers: 1, coins: 0 });
  assert.deepEqual((await request('/api/v1/me/community-support', { token: tokenB })).value.data, { flowers: 0, coins: 0 });
  await request(`/api/v1/me/community-support?user_id=${A.value.data.user.id}`, { token: tokenB, status: 400 });
  await request('/api/v1/me/community-support', { cookie: A.cookie, status: 401 });
  assert.equal((await home()).flowers, 2);
  for (let index = 0; index < 4; index++) await download({ ...event, event_id: `mp_synthetic_rate_${index}_0008` });
  await download({ ...event, event_id: 'mp_synthetic_rate_rejected' }, { status: 429 });
  assert.equal((await home()).flowers, 6);

  const submitted = await request('/api/v1/reviews', { method: 'POST', token: tokenA,
    body: { course_id: courseId, teacher: '合成教师', rating: 5, body: 'This is a synthetic contribution review.' } });
  assert.equal(submitted.value.data.pending, true);
  assert.equal((await home()).coins, 0);
  const listed = await request('/admin-api/reviews', { cookie: admin.cookie });
  const reviewId = listed.value.data.reviews.find(item => item.user_id === A.value.data.user.id).id;
  async function moderate(changes) {
    const current = await request(`/admin-api/reviews/${reviewId}`, { cookie: admin.cookie });
    return request(`/admin-api/reviews/${reviewId}`, { method: 'PATCH', cookie: admin.cookie,
      body: { expectedItemRevision: current.value.itemRevision, changes } });
  }
  await moderate({ publicationDecision: 'approve' });
  assert.equal((await home()).coins, 1);
  await moderate({ publicationDecision: 'approve' });
  assert.equal((await home()).coins, 1);
  const beforeHide = await home();
  await moderate({ hidden: true });
  const hidden = await home();
  assert.equal(hidden.coins, 0); assert.ok(hidden.revision > beforeHide.revision);
  await moderate({ hidden: false });
  assert.equal((await home()).coins, 1);
  assert.deepEqual((await request('/api/v1/me/community-support', { token: tokenA })).value.data, { flowers: 5, coins: 1 });
  const beforeRestart = await home();
  await stop(); await start();
  assert.deepEqual(await home(), beforeRestart);
  assert.equal((await request('/admin-api/theme-settings', { cookie: admin.cookie })).value.data.active.light['--primary'], '#123456');
  assert.equal((await fetch(base + '/site-icon/favicon-32.png')).headers.get('x-site-icon-source'), 'custom');
  const deleted = await request('/api/v1/me/delete-account', { method: 'POST', token: tokenA, body: {} });
  assert.equal(deleted.value.data.deleted, true);
  const afterDeletion = await home();
  assert.equal(afterDeletion.flowers, 6); assert.equal(afterDeletion.coins, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_downloads WHERE user_id=?').get(A.value.data.user.id).n, 0);
  await download(event, { token: tokenB, status: 409 });
  await request('/api/v1/me/community-support', { token: tokenA, status: 401 });
  await stop(); env.COMMUNITY_SUPPORT_ENABLED = '0'; await start();
  assert.deepEqual(await home(), { version: 1, enabled: false });
  await download({ ...event, event_id: 'mp_disabled_request_00001' }, { token: tokenB, status: 503 });
  await stop(); env.COMMUNITY_SUPPORT_ENABLED = '1'; await start();
  const restored = await home();
  assert.equal(restored.flowers, 6); assert.equal(restored.coins, 1);
  assert.ok(restored.revision >= afterDeletion.revision);
  await t.test('offline baseline CLI consumes actual server state and required-mode HTTP preserves personal contributions', async () => {
    const personalBefore = (await request('/api/v1/me/community-support', { token: tokenB })).value.data;
    await stop();
    const migration = spawn(process.execPath, ['scripts/migrate-community-support-baseline.mjs', '--apply'], {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
        PUBLIC_RESOURCE_ORIGIN: 'https://resources.nkustudy.top' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let migrationOutput = '', migrationError = '';
    migration.stdout.on('data', chunk => { migrationOutput += chunk; });
    migration.stderr.on('data', chunk => { migrationError += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { migration.kill('SIGTERM'); reject(new Error('Synthetic baseline CLI timeout')); }, 15000);
      migration.once('error', error => { clearTimeout(timer); reject(error); });
      migration.once('close', result => { clearTimeout(timer); resolve(result); });
    });
    assert.equal(code, 0, migrationError);
    assert.equal(migrationError, '');
    const applied = JSON.parse(migrationOutput);
    assert.equal(applied.ok, true); assert.equal(applied.applied, true); assert.equal(applied.replayed, false);
    const resourceBaseline = applied.receipt.counts.resourceCount;
    assert.ok(resourceBaseline > 0);
    assert.equal(applied.receipt.counts.successfulDownloadCount, 6);
    assert.equal(applied.receipt.counts.historicalPublicReviewCount, 1);
    assert.equal(applied.receipt.publicAfter.flowers, resourceBaseline + 6);
    assert.equal(applied.receipt.publicAfter.coins, 2);
    env.COMMUNITY_SUPPORT_BASELINE_REQUIRED = '1';
    await start();
    const migrated = await home();
    assert.equal(migrated.enabled, true, output);
    assert.equal(migrated.flowers, resourceBaseline + 6);
    assert.equal(migrated.coins, 2);
    assert.equal(migrated.revision, applied.receipt.publicAfter.revision);
    assert.deepEqual((await request('/api/v1/me/community-support', { token: tokenB })).value.data, personalBefore);
    const nextEvent = { ...event, event_id: 'mp_after_public_baseline_001' };
    const recorded = await download(nextEvent, { token: tokenB });
    assert.equal(recorded.value.data.community_support.flowers, resourceBaseline + 7);
    assert.equal(recorded.value.data.community_support.coins, 2);
    const repeated = await download(nextEvent, { token: tokenB });
    assert.deepEqual(repeated.value.data, recorded.value.data);
    assert.deepEqual((await request('/api/v1/me/community-support', { token: tokenB })).value.data,
      { flowers: personalBefore.flowers + 1, coins: personalBefore.coins });
    const beforeRequiredRestart = await home();
    await stop(); await start();
    assert.deepEqual(await home(), beforeRequiredRestart);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 7);
    assert.equal(db.prepare("SELECT user_id FROM community_support_reviews WHERE review_id='historic-review'").get().user_id, null);
  });
  // Broken optional accounting metadata must preserve the rest of the site.
  await stop();
  const damaged = JSON.parse(await fs.readFile(reviewsPath, 'utf8'));
  damaged.community_support_ledger.sequence = 'synthetic-corruption';
  await fs.writeFile(reviewsPath, JSON.stringify(damaged));
  await start();
  await request('/api/v1/health');
  assert.deepEqual(await home(), { version: 1, enabled: false });
  await download({ ...event, event_id: 'mp_corrupt_request_000001' }, { token: tokenB, status: 503 });
  const preserved = JSON.parse(await fs.readFile(reviewsPath, 'utf8'));
  assert.equal(preserved.community_support_ledger.sequence, 'synthetic-corruption');
});
