import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { CommunitySupportReviewStore } from '../server/community-support-review-store.mjs';
import { createCommunitySupportRuntime } from '../server/community-support-runtime.mjs';
import { CommunitySupportService } from '../server/community-support-service.mjs';

const ON = { COMMUNITY_SUPPORT_ENABLED: '1', COMMUNITY_SUPPORT_DOWNLOAD_REPORTING: '1', COMMUNITY_SUPPORT_PERSONAL_STATS: '1' };
const disabled = { version: 1, enabled: false };
const approved = id => ({ id, user_id: 1, schemaVersion: 2, courseTitle: 'Synthetic course', teacher: 'Synthetic teacher',
  publicationState: 'approved', status: 'approved', decisionSource: 'admin_decision',
  reviewedBy: 'synthetic-reviewer', reviewedAt: '2026-10-23T00:00:00.000Z', hidden: false });
const event = { event_id: 'synthetic_runtime_download_001', kind: 'guide_source', resource_id: 'source-a', course_id: '', attribution: 'account' };

test('required public baseline rejects a pre-migration restore without initializing or resetting it', async t => {
  const f = await fixture(t);
  const required = { ...ON, COMMUNITY_SUPPORT_BASELINE_REQUIRED: '1' };
  const bytes = await f.bytes();
  assert.deepEqual(await f.runtime(required).initialize(), { configured: true, ready: false });
  assert.equal(await f.bytes(), bytes);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'community_support_%'").get().n, 0);
  await f.runtime().initialize();
  const legacyBytes = await f.bytes();
  const restored = f.runtime(required);
  assert.deepEqual(await restored.initialize(), { configured: true, ready: false });
  assert.deepEqual(restored.snapshot(), disabled);
  assert.equal(await f.bytes(), legacyBytes);
});

test('required migrated runtime retains public base, personal exclusions and disabled bookkeeping', async t => {
  const f = await fixture(t);
  await f.runtime().initialize();
  const service = new CommunitySupportService({ db: f.db, readReviews: f.read, assertActiveUser: id => ({ id }), enabled: true });
  service.migratePublicBaseline({ resourceIds: ['resource-a', 'resource-b'] });
  const required = { ...ON, COMMUNITY_SUPPORT_BASELINE_REQUIRED: '1' };
  const live = f.runtime(required);
  assert.deepEqual(await live.initialize(), { configured: true, ready: true });
  assert.equal(live.snapshot().flowers, 2);
  assert.equal(live.snapshot().coins, 1);
  assert.deepEqual(live.myStats(1), { flowers: 0, coins: 0 });
  const off = f.runtime({ COMMUNITY_SUPPORT_BASELINE_REQUIRED: '1' });
  assert.deepEqual(await off.initialize(), { configured: true, ready: true });
  await f.store.update(f.reviewsPath, doc => ({ ...doc, reviews: doc.reviews.map(row => ({ ...row, hidden: true })) }));
  assert.deepEqual(off.snapshot(), disabled);
  const restarted = f.runtime(required);
  assert.deepEqual(await restarted.initialize(), { configured: true, ready: true });
  assert.equal(restarted.snapshot().flowers, 2);
  assert.equal(restarted.snapshot().coins, 0);
  assert.deepEqual(restarted.myStats(1), { flowers: 0, coins: 0 });
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-support-runtime-'));
  const reviewsPath = path.join(directory, 'reviews.json');
  const db = new Database(':memory:');
  const store = new CommunitySupportReviewStore({ allowedRoot: directory, reviewsFilePath: reviewsPath });
  await store.write(reviewsPath, { reviews: [approved('historical')] });
  const reports = [];
  const options = { db, store, reviewsPath, readReviews: () => store.readSync(reviewsPath),
    assertActiveUser: id => ({ id }), readManifest: () => ({ courses: [] }),
    learningCompass: { publicDownloadSourceById: id => id === 'source-a' ? { id, file_url: 'https://resources.nkustudy.top/guide-sources/synthetic.pdf' } : null },
    onError: code => reports.push(code) };
  t.after(async () => { db.close(); await fs.unlink(reviewsPath); await fs.rmdir(directory); });
  return { db, store, reviewsPath, reports, options,
    runtime: (env = ON, changes = {}) => createCommunitySupportRuntime({ ...options, env, ...changes }),
    read: () => store.readSync(reviewsPath), bytes: () => fs.readFile(reviewsPath, 'utf8') };
}

test('runtime defaults off without creating contribution tables or writing the review source', async t => {
  const f = await fixture(t);
  const bytes = await f.bytes();
  const runtime = f.runtime({});
  assert.deepEqual(await runtime.initialize(), { configured: false, ready: false });
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name LIKE 'community_support_%'").get().count, 0);
  assert.equal(await f.bytes(), bytes);
  assert.equal(f.read().community_support_ledger, undefined);
  assert.deepEqual(runtime.snapshot(), disabled);
  assert.throws(() => runtime.recordDownload(event, { userId: 1 }), { code: 'SUPPORT_UNAVAILABLE', statusCode: 503 });
  assert.throws(() => runtime.myStats(1), { code: 'SUPPORT_UNAVAILABLE', statusCode: 503 });
  assert.deepEqual(f.reports, []);
});

test('first explicit activation enrolls only later reviews and can restart without resetting counts', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  assert.deepEqual(await runtime.initialize(), { configured: true, ready: true });
  assert.deepEqual(f.read().community_support_ledger.baseline_review_ids, ['historical']);
  assert.equal(runtime.snapshot().flowers, 0);
  assert.equal(runtime.snapshot().coins, 0);
  await f.store.update(f.reviewsPath, document => ({ ...document, reviews: [...document.reviews, approved('new-review')] }));
  const result = runtime.recordDownload(event, { userId: 1 });
  assert.equal(result.community_support.flowers, 1);
  assert.equal(result.community_support.coins, 1);
  assert.deepEqual(runtime.myStats(1), { flowers: 1, coins: 1 });
  const snapshot = runtime.snapshot();
  const marker = structuredClone(f.read().community_support_ledger);
  const restarted = f.runtime();
  assert.deepEqual(await restarted.initialize(), { configured: true, ready: true });
  assert.deepEqual(restarted.snapshot(), snapshot);
  assert.deepEqual(f.read().community_support_ledger, marker);
});

test('source marker with missing contribution database cannot silently recreate an empty ledger', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  runtime.recordDownload(event, { userId: 1 });
  assert.equal(f.read().community_support_ledger.sequence, 0, 'downloads alone need not change review sequence');
  const bytes = await f.bytes();
  const missingDb = new Database(':memory:');
  try {
    const restored = f.runtime(ON, { db: missingDb });
    assert.deepEqual(await restored.initialize(), { configured: true, ready: false });
    assert.deepEqual(restored.snapshot(), disabled);
    assert.equal(missingDb.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name LIKE 'community_support_%'").get().count, 0);
    assert.equal(await f.bytes(), bytes);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_downloads').get().count, 1);
  } finally { missingDb.close(); }
});

test('missing metadata singleton blocks initialization without recreating it or changing source bytes', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  runtime.recordDownload(event, { userId: 1 });
  f.db.exec('DELETE FROM community_support_meta WHERE singleton=1');
  const bytes = await f.bytes();
  const restored = f.runtime();
  assert.deepEqual(await restored.initialize(), { configured: true, ready: false });
  assert.deepEqual(restored.snapshot(), disabled);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_meta').get().count, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_downloads').get().count, 1);
  assert.equal(await f.bytes(), bytes);
});

test('missing source marker does not establish a new baseline against an existing database', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  runtime.recordDownload(event, { userId: 1 });
  const oldMeta = f.db.prepare('SELECT * FROM community_support_meta').get();
  const source = f.read();
  delete source.community_support_ledger;
  await fs.writeFile(f.reviewsPath, JSON.stringify(source));
  const bytes = await f.bytes();
  const restored = f.runtime();
  assert.deepEqual(await restored.initialize(), { configured: true, ready: false });
  assert.equal(await f.bytes(), bytes);
  assert.deepEqual(f.db.prepare('SELECT * FROM community_support_meta').get(), oldMeta);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_downloads').get().count, 1);
});

test('installed but disabled runtime keeps existing accounting synchronized and hides all capabilities', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  runtime.recordDownload(event, { userId: 1 });
  const before = runtime.snapshot();
  const switchedOff = f.runtime({ ...ON, COMMUNITY_SUPPORT_ENABLED: '0' });
  assert.deepEqual(await switchedOff.initialize(), { configured: true, ready: true });
  await f.store.update(f.reviewsPath, document => ({ ...document, reviews: [...document.reviews, approved('after-disable')] }));
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_reviews WHERE active=1').get().count, 1);
  assert.deepEqual(switchedOff.snapshot(), disabled);
  assert.throws(() => switchedOff.myStats(1), { code: 'SUPPORT_UNAVAILABLE' });
  assert.throws(() => switchedOff.recordDownload(event, { userId: 1 }), { code: 'SUPPORT_UNAVAILABLE' });
  const restarted = f.runtime();
  await restarted.initialize();
  assert.equal(restarted.snapshot().flowers, 1);
  assert.equal(restarted.snapshot().coins, 1);
  assert.ok(restarted.snapshot().revision > before.revision);
});

test('in-flight review rollback disables home capability and returns 503 for personal and download reads', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  const before = runtime.snapshot();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const pending = f.store.update(f.reviewsPath, document => ({ ...document, reviews: [...document.reviews, approved('will-rollback')] }), {
    rollbackOnAfterWriteError: true, afterWrite: async () => {
      entered(); await gate; throw new Error('synthetic rollback');
    },
  });
  const rejected = assert.rejects(pending, { atomicJsonRolledBack: true });
  await started;
  assert.deepEqual(runtime.snapshot(), disabled);
  assert.throws(() => runtime.myStats(1), { code: 'SUPPORT_UNAVAILABLE', statusCode: 503 });
  assert.throws(() => runtime.recordDownload(event, { userId: 1 }), { code: 'SUPPORT_UNAVAILABLE', statusCode: 503 });
  assert.equal(f.db.prepare('SELECT review_sequence FROM community_support_meta').get().review_sequence, 0);
  resume(); await rejected;
  assert.deepEqual(runtime.snapshot(), before);
  assert.deepEqual(runtime.myStats(1), { flowers: 0, coins: 0 });
});

test('corrupt optional marker survives startup normalization while reviews remain writable and statistics stay disabled', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.initialize();
  runtime.recordDownload(event, { userId: 1 });
  const source = f.read();
  source.community_support_ledger.sequence = 'damaged-sequence';
  await fs.writeFile(f.reviewsPath, JSON.stringify(source));
  // Simulate startup migration through a fresh store before runtime.initialize.
  const store = new CommunitySupportReviewStore({ allowedRoot: path.dirname(f.reviewsPath), reviewsFilePath: f.reviewsPath });
  await store.update(f.reviewsPath, document => ({ ...document, startupNormalized: true }));
  const restarted = f.runtime(ON, { store, readReviews: () => store.readSync(f.reviewsPath) });
  assert.deepEqual(await restarted.initialize(), { configured: true, ready: false });
  await store.update(f.reviewsPath, document => {
    document.reviews[0].hidden = true;
    document.reviews.push(approved('business-still-works'));
    return document;
  });
  assert.equal(f.read().reviews[0].hidden, true);
  assert.equal(f.read().reviews.length, 2);
  assert.deepEqual(f.read().community_support_ledger, source.community_support_ledger);
  assert.deepEqual(restarted.snapshot(), disabled);
  assert.throws(() => restarted.myStats(1), { code: 'SUPPORT_UNAVAILABLE' });
  assert.throws(() => store.assertProjectionReadable(), { code: 'SUPPORT_UNAVAILABLE' });
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM community_support_downloads').get().count, 1);
});
