import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { CommunitySupportService, COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID,
  readCommunitySupportPublicBaselineStatus } from '../server/community-support-service.mjs';
import { captureRuntime, saveEncryptedBackup, decryptSnapshot } from '../server/runtime-backup.mjs';

const timestamp = '2026-10-24T05:00:00.000Z';
const review = (id, userId = 1, changes = {}) => ({ id, user_id: userId, schemaVersion: 2,
  courseTitle: 'Synthetic course', teacher: 'Synthetic teacher', content: 'Synthetic review content.',
  status: 'approved', publicationState: 'approved', decisionSource: 'admin_decision',
  reviewedBy: 'synthetic-admin', reviewedAt: timestamp, hidden: false, ...changes });
const event = (index = 1, changes = {}) => ({ event_id: `baseline_download_event_${index}`, kind: 'resource',
  resource_id: 'resource-a', course_id: 'course-a', attribution: 'account', ...changes });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nkustudy-public-baseline-'));
  const dbPath = path.join(directory, 'state.sqlite');
  let db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  let source = { reviews: [review('historic-public', 1), review('historic-hidden', 2, { hidden: true }), review('historic-deleted-owner', undefined)],
    community_support_ledger: { version: 1, epoch: randomUUID(), sequence: 0,
      baseline_review_ids: ['historic-public', 'historic-hidden', 'historic-deleted-owner'] } };
  delete source.reviews[2].user_id;
  let faultStage = '';
  const deps = { readReviews: () => structuredClone(source), assertActiveUser: id => ({ id }),
    validateResource: () => true, enabled: true, downloadReporting: true, personalStats: true,
    now: () => Date.parse(timestamp), fault: stage => { if (stage === faultStage) throw new Error('Synthetic migration fault'); }, ...options };
  let service = new CommunitySupportService({ ...deps, db });
  service.initializeReviews(source);
  t.after(() => { if (db.open) db.close(); });
  return {
    get db() { return db; }, get service() { return service; }, get source() { return source; }, dbPath,
    mutate(change) { change(source); source.community_support_ledger.sequence++; },
    replace(next) { source = next; }, fault(stage) { faultStage = stage; },
    reopen(changes = {}) {
      db.close(); db = new Database(dbPath); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
      service = new CommunitySupportService({ ...deps, ...changes, db });
      return service;
    },
  };
}

test('one migration adds deduplicated resource baseline and historical public coins at the same source sequence', t => {
  const f = fixture(t);
  f.service.recordDownload(event(), { userId: 1 });
  const originalMarker = structuredClone(f.source.community_support_ledger);
  const before = f.service.snapshot();
  assert.equal(before.flowers, 1); assert.equal(before.coins, 0);
  const result = f.service.migratePublicBaseline({ resourceIds: ['resource-b', 'resource-a', 'resource-b'] });
  assert.equal(result.applied, true); assert.equal(result.replayed, false);
  assert.equal(result.receipt.migrationId, COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID);
  assert.deepEqual(result.receipt.counts, { resourceCount: 2, publicReviewCount: 2, historicalPublicReviewCount: 2, successfulDownloadCount: 1 });
  assert.deepEqual(result.receipt.publicBefore, { flowers: 1, coins: 0, revision: before.revision });
  assert.deepEqual(result.receipt.publicAfter, { flowers: 3, coins: 2, revision: before.revision + 1 });
  assert.deepEqual(f.source.community_support_ledger, originalMarker);
  assert.deepEqual(f.service.myStats(1), { flowers: 1, coins: 0 });
  assert.deepEqual(f.service.myStats(2), { flowers: 0, coins: 0 });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE user_id IS NOT NULL').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 1, 'baseline never fabricates a historical download');
  const status = f.service.publicBaselineStatus();
  assert.equal(status.rule_version, 2); assert.equal(status.resource_baseline, 2);
  assert.deepEqual(status.receipt, result.receipt);
});

test('migration replay and restart preserve original receipt, baseline and all later downloads', t => {
  const f = fixture(t);
  f.service.recordDownload(event(1), { userId: 1 });
  f.service.recordDownload(event(2, { attribution: 'community' }), { ip: '192.0.2.1' });
  const first = f.service.migratePublicBaseline({ resourceIds: ['resource-a', 'resource-b'] });
  f.service.recordDownload(event(3), { userId: 2 });
  const beforeReplay = f.service.snapshot();
  const replay = f.service.migratePublicBaseline({ resourceIds: ['new-current-resource'] });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(f.service.snapshot(), beforeReplay);
  const restarted = f.reopen({ requirePublicBaseline: true });
  restarted.initializeReviews(f.source);
  assert.deepEqual(restarted.snapshot(), beforeReplay);
  assert.deepEqual(restarted.migratePublicBaseline({}).receipt, first.receipt);
  assert.equal(restarted.snapshot().flowers, 5);
  assert.deepEqual(restarted.myStats(1), { flowers: 1, coins: 0 });
  assert.deepEqual(restarted.myStats(2), { flowers: 1, coins: 0 });
  assert.throws(() => restarted.migratePublicBaseline({ resourceIds: [], migrationId: 'another-migration' }), { code: 'BASELINE_MIGRATION_CONFLICT' });
});

test('historic moderation tracks hidden, revoked, restored and removed states without personal rewards', t => {
  const f = fixture(t);
  f.service.migratePublicBaseline({ resourceIds: ['resource-a'] });
  assert.equal(f.service.snapshot().coins, 2);
  f.mutate(source => { source.reviews[0].hidden = true; });
  const hidden = f.service.snapshot(); assert.equal(hidden.coins, 1);
  f.mutate(source => { source.reviews[0].hidden = false; });
  assert.equal(f.service.snapshot().coins, 2);
  f.mutate(source => { source.reviews[0].publicationState = 'pending'; source.reviews[0].status = 'pending'; });
  assert.equal(f.service.snapshot().coins, 1);
  f.mutate(source => { source.reviews[0].publicationState = 'approved'; source.reviews[0].status = 'approved'; });
  assert.equal(f.service.snapshot().coins, 2);
  f.mutate(source => { source.reviews[1].hidden = false; });
  assert.equal(f.service.snapshot().coins, 3, 'a baseline review that was hidden at migration can later become public');
  f.mutate(source => { source.reviews = source.reviews.filter(row => row.id !== 'historic-public'); });
  const removed = f.service.snapshot(); assert.equal(removed.coins, 2); assert.ok(removed.revision > hidden.revision);
  assert.deepEqual(f.service.myStats(1), { flowers: 0, coins: 0 });
  assert.deepEqual(f.service.myStats(2), { flowers: 0, coins: 0 });
});

test('new review contributions and deleted owners remain unchanged by migration and derived-table rebuild', t => {
  const f = fixture(t);
  f.mutate(source => source.reviews.push(review('new-a', 1), review('new-b', 2)));
  f.service.recordDownload(event(1), { userId: 1 });
  f.service.recordDownload(event(2), { userId: 2 });
  f.service.clearAccount(1);
  const beforeB = f.service.myStats(2);
  const result = f.service.migratePublicBaseline({ resourceIds: ['resource-a'] });
  assert.deepEqual(beforeB, { flowers: 1, coins: 1 });
  assert.deepEqual(f.service.myStats(2), beforeB);
  assert.equal(f.service.snapshot().coins, 4);
  assert.equal(f.db.prepare("SELECT user_id FROM community_support_reviews WHERE review_id='new-a'").get().user_id, null);
  // A controlled projection rebuild must not rebuild the download ledger or
  // use the baseline snapshot to recreate any account associations.
  f.db.exec('DELETE FROM community_support_reviews');
  f.service.rebuildReviewProjection();
  assert.equal(f.service.snapshot().coins, 4);
  assert.equal(f.service.snapshot().flowers, 3);
  assert.deepEqual(f.service.myStats(2), beforeB);
  assert.equal(f.db.prepare("SELECT user_id FROM community_support_reviews WHERE review_id='new-a'").get().user_id, null);
  assert.equal(f.db.prepare("SELECT user_id FROM community_support_reviews WHERE review_id='historic-public'").get().user_id, null);
  assert.deepEqual(f.service.publicBaselineReceipt(), result.receipt);
});

test('migration failure rolls back projection, receipt, schema additions and revision', t => {
  for (const stage of ['afterPublicBaselineProjection', 'afterPublicBaselineReceipt']) {
    const f = fixture(t);
    f.service.recordDownload(event(), { userId: 1 });
    const before = f.service.snapshot();
    const personal = f.service.myStats(1);
    f.fault(stage);
    assert.throws(() => f.service.migratePublicBaseline({ resourceIds: ['resource-a'] }), { code: 'SUPPORT_UNAVAILABLE', statusCode: 503 });
    assert.deepEqual(f.service.snapshot(), before);
    assert.deepEqual(f.service.myStats(1), personal);
    assert.equal(f.service.publicBaselineStatus().applied, false);
    assert.equal(f.db.prepare('PRAGMA table_info(community_support_meta)').all().some(row => row.name === 'public_baseline_rule'), false);
    f.fault('');
    assert.equal(f.service.migratePublicBaseline({ resourceIds: ['resource-a'] }).replayed, false);
    assert.equal(f.service.snapshot().flowers, 2);
  }
});

test('required baseline fails closed before apply without automatically changing schema or counters', t => {
  const f = fixture(t);
  const required = f.reopen({ requirePublicBaseline: true });
  assert.throws(() => required.snapshot(), { code: 'SUPPORT_UNAVAILABLE' });
  assert.throws(() => required.myStats(1), { code: 'SUPPORT_UNAVAILABLE' });
  assert.throws(() => required.recordDownload(event(), { userId: 1 }), { code: 'SUPPORT_UNAVAILABLE' });
  assert.equal(f.db.prepare('PRAGMA table_info(community_support_meta)').all().some(row => row.name === 'public_baseline_rule'), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 0);
  required.migratePublicBaseline({ resourceIds: ['resource-a'] });
  assert.equal(required.snapshot().flowers, 1);
});

test('receipt, base amount, source evidence and projection rule corruption are never silently reset', t => {
  for (const mutate of [
    db => db.exec('UPDATE community_support_meta SET public_baseline_receipt=NULL'),
    db => db.exec("UPDATE community_support_meta SET public_baseline_receipt='{}'"),
    db => db.exec("UPDATE community_support_meta SET public_baseline_receipt_hash='bad'"),
    db => db.exec('UPDATE community_support_meta SET public_resource_baseline=22'),
    db => db.exec('UPDATE community_support_meta SET public_baseline_rule=1'),
    db => db.exec("UPDATE community_support_meta SET baseline_ids='[]'"),
  ]) {
    const f = fixture(t);
    f.service.migratePublicBaseline({ resourceIds: ['resource-a'] });
    mutate(f.db);
    const before = f.db.prepare('SELECT * FROM community_support_meta').get();
    assert.throws(() => f.service.publicBaselineStatus(), { code: 'SUPPORT_UNAVAILABLE' });
    assert.throws(() => f.service.snapshot(), { code: 'SUPPORT_UNAVAILABLE' });
    assert.throws(() => f.service.migratePublicBaseline({ resourceIds: ['resource-a'] }), { code: 'SUPPORT_UNAVAILABLE' });
    assert.deepEqual(f.db.prepare('SELECT * FROM community_support_meta').get(), before);
  }
});

test('source checkpoint conflicts and revision overflow roll back explicit migration', t => {
  for (const corruption of ['digest', 'sequence', 'revision']) {
    const f = fixture(t);
    if (corruption === 'digest') f.source.reviews[0].hidden = true;
    if (corruption === 'sequence') f.db.exec('UPDATE community_support_meta SET review_sequence=1');
    if (corruption === 'revision') f.db.prepare('UPDATE community_support_meta SET revision=?').run(Number.MAX_SAFE_INTEGER);
    const before = f.db.prepare('SELECT * FROM community_support_meta').get();
    assert.throws(() => f.service.migratePublicBaseline({ resourceIds: ['resource-a'] }), { code: 'SUPPORT_UNAVAILABLE' });
    assert.deepEqual(f.db.prepare('SELECT * FROM community_support_meta').get(), before);
    assert.equal(f.service.publicBaselineStatus().applied, false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_reviews').get().n, 0);
  }
});

test('resource base plus new download overflow cannot commit an event or consume a rate allowance', t => {
  const f = fixture(t);
  const result = f.service.migratePublicBaseline({ resourceIds: [] });
  const receipt = structuredClone(result.receipt);
  receipt.counts.resourceCount = Number.MAX_SAFE_INTEGER;
  receipt.publicAfter.flowers = Number.MAX_SAFE_INTEGER;
  const encoded = canonical(receipt);
  f.db.prepare('UPDATE community_support_meta SET public_resource_baseline=?,public_baseline_receipt=?,public_baseline_receipt_hash=?')
    .run(Number.MAX_SAFE_INTEGER, encoded, sha(encoded));
  assert.equal(f.service.snapshot().flowers, Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), { code: 'SUPPORT_UNAVAILABLE' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_rate_limits').get().n, 0);
});

test('pure baseline status works on read-only restored SQLite and rejects a lost receipt', t => {
  const f = fixture(t);
  const applied = f.service.migratePublicBaseline({ resourceIds: ['resource-a', 'resource-b'] });
  const restored = new Database(f.dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = readCommunitySupportPublicBaselineStatus(restored, { required: true });
    assert.equal(result.applied, true);
    assert.deepEqual(result.receipt, applied.receipt);
  } finally { restored.close(); }
  f.db.exec('UPDATE community_support_meta SET public_baseline_receipt=NULL');
  assert.throws(() => f.reopen({ requirePublicBaseline: true }).initializeReviews(f.source), { code: 'SUPPORT_UNAVAILABLE' });
});

test('migration serialized against another SQLite writer retains every successful concurrent download', async t => {
  const f = fixture(t);
  f.db.pragma('busy_timeout=10000');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { default: Database } = await import(workerData.databaseUrl);
      const { CommunitySupportService } = await import(workerData.serviceUrl);
      const db = new Database(workerData.dbPath);
      db.pragma('busy_timeout=10000');
      const service = new CommunitySupportService({ db, readReviews: () => structuredClone(workerData.source),
        assertActiveUser: id => ({ id }), validateResource: () => true,
        enabled: true, downloadReporting: true, personalStats: true });
      parentPort.once('message', () => {
        try {
          for (let index = 0; index < 25; index++) {
            const result = service.recordDownload({ event_id: 'baseline_worker_download_' + index,
              kind: 'resource', course_id: 'course-a', resource_id: 'resource-' + index, attribution: 'account' }, { userId: 1 });
            if (result.recorded !== true) throw Error('Missing download receipt');
          }
          db.close(); parentPort.postMessage({ done: true });
        } catch (error) { db.close(); throw error; }
      });
      parentPort.postMessage({ ready: true });
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { dbPath: f.dbPath, source: f.source,
    databaseUrl: import.meta.resolve('better-sqlite3'), serviceUrl: new URL('../server/community-support-service.mjs', import.meta.url).href } });
  t.after(async () => { await worker.terminate(); });
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const finished = new Promise((resolve, reject) => {
    worker.on('message', message => { if (message.ready) readyResolve(); if (message.done) resolve(); });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Synthetic worker exited with ${code}`)); });
  });
  await Promise.race([ready, finished]);
  worker.postMessage('start');
  const migrated = f.service.migratePublicBaseline({ resourceIds: ['resource-a', 'resource-b'] });
  await finished;
  assert.equal(migrated.applied, true);
  assert.equal(f.service.snapshot().flowers, 27);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 25);
  assert.deepEqual(f.service.myStats(1), { flowers: 25, coins: 0 });
  assert.equal(f.service.snapshot().coins, 2);
});

test('encrypted runtime backup roundtrip retains migrated baseline, receipt and personal statistics in an isolated ledger', t => {
  const f = fixture(t);
  f.mutate(source => source.reviews.push(review('new-backup-review', 2)));
  f.service.recordDownload(event(1), { userId: 1 });
  f.service.recordDownload(event(2), { userId: 2 });
  const applied = f.service.migratePublicBaseline({ resourceIds: ['resource-a', 'resource-b'] });
  f.service.recordDownload(event(3), { userId: 2 });
  const publicBefore = f.service.snapshot();
  const personalBefore = f.service.myStats(2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nku-baseline-encrypted-roundtrip-'));
  fs.chmodSync(root, 0o700);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'reviews.json'), JSON.stringify(f.source), { mode: 0o600 });
  const snapshot = captureRuntime({ db: f.db, dataDir, requiredFiles: ['reviews.json'] });
  const password = 'synthetic-baseline-backup-password';
  const archive = saveEncryptedBackup({ snapshot, password, directory: path.join(root, 'encrypted') });
  assert.equal(archive.complete, true);
  const decrypted = decryptSnapshot(fs.readFileSync(archive.file), password);
  assert.equal(decrypted.tables.community_support_downloads, 3);
  const stateEntry = decrypted.files.find(entry => entry.name === 'state.sqlite');
  const reviewsEntry = decrypted.files.find(entry => entry.name === 'data/reviews.json');
  assert.ok(stateEntry); assert.ok(reviewsEntry);
  // Deserialize only into new isolated files. No production restore, activation,
  // deletion-ledger replay, existing path replacement or cleanup is performed.
  const isolated = path.join(root, 'isolated-check');
  fs.mkdirSync(isolated, { mode: 0o700 });
  const restoredDbPath = path.join(isolated, 'state.sqlite');
  const restoredReviewsPath = path.join(isolated, 'reviews.json');
  fs.writeFileSync(restoredDbPath, Buffer.from(stateEntry.base64, 'base64'), { mode: 0o600 });
  fs.writeFileSync(restoredReviewsPath, Buffer.from(reviewsEntry.base64, 'base64'), { mode: 0o600 });
  const restoredDb = new Database(restoredDbPath);
  t.after(() => restoredDb.close());
  const readRestoredReviews = () => JSON.parse(fs.readFileSync(restoredReviewsPath, 'utf8'));
  const restored = new CommunitySupportService({ db: restoredDb, readReviews: readRestoredReviews,
    assertActiveUser: id => ({ id }), enabled: true, downloadReporting: true,
    personalStats: true, requirePublicBaseline: true, validateResource: () => true });
  restored.initializeReviews(readRestoredReviews());
  assert.deepEqual(restored.snapshot(), publicBefore);
  assert.deepEqual(restored.myStats(2), personalBefore);
  assert.deepEqual(restored.publicBaselineReceipt(), applied.receipt);
  assert.deepEqual(readRestoredReviews().community_support_ledger, f.source.community_support_ledger);
  const replay = restored.migratePublicBaseline({ resourceIds: ['later-catalogue-resource'] });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, applied.receipt);
  assert.deepEqual(restored.snapshot(), publicBefore);
  assert.equal(restoredDb.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 3);
  assert.deepEqual(f.service.snapshot(), publicBefore, 'checking the isolated backup leaves the original ledger unchanged');
  t.diagnostic(`Synthetic encrypted backup evidence: ${root}`);
});
