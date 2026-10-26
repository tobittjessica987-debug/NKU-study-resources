import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MpAuthService } from '../server/mp-auth-service.mjs';
import { initializeRuntimeDeletionLedger } from '../server/deletion-ledger.mjs';
import { AccountDeletionService } from '../server/account-deletion-service.mjs';
import { CommunitySupportReviewStore } from '../server/community-support-review-store.mjs';
import { CommunitySupportService } from '../server/community-support-service.mjs';
import { replayRestoredDeletions, verifyRestoreReplayProof } from '../server/restore-reconciliation.mjs';

const POLICY = 's5-retain-published-v1';
const approvedReview = (id, userId) => ({ id, user_id: userId, courseTitle: 'Synthetic course',
  content: 'A retained synthetic review', schemaVersion: 2, publicationState: 'approved',
  reviewedBy: 'synthetic-admin', reviewedAt: '2026-10-01T00:00:00.000Z',
  decisionSource: 'admin_decision', status: 'approved', hidden: false });
const event = id => ({ event_id: id, kind: 'resource', resource_id: 'synthetic-resource',
  course_id: 'synthetic-course', attribution: 'account' });
function privateJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function fixture(t, { supportInstalled = true } = {}) {
  // Keep synthetic fixtures for diagnosis. No recursive deletion or live paths.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nku-support-s5-'));
  fs.chmodSync(root, 0o700);
  const destination = path.join(root, 'isolated-runtime');
  fs.mkdirSync(destination, { mode: 0o700 });
  const dataDir = path.join(destination, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const dbPath = path.join(destination, 'state.sqlite');
  const now = Date.now() - 10_000;
  const auth = new MpAuthService({ dbPath, now: () => now });
  const a = auth.webRegister({ nickname: 'Synthetic contribution A', password: 'Synthetic-password-A' });
  const b = auth.webRegister({ nickname: 'Synthetic contribution B', password: 'Synthetic-password-B' });
  const ledger = initializeRuntimeDeletionLedger({ db: auth.db, dataDir,
    directory: path.join(root, 'independent-ledger'), lineage: 'support-s5-synthetic', now });
  auth.isDeletionPending = id => ledger.entries().some(row => row.userId === id);
  const reviewsFilePath = path.join(dataDir, 'reviews.json');
  const store = new CommunitySupportReviewStore({ allowedRoot: dataDir, reviewsFilePath });
  await store.write(reviewsFilePath, { reviews: [] });
  await store.write(path.join(dataDir, 'feedback.json'), { items: [] });
  let support;
  if (supportInstalled) {
    await store.initializeCommunitySupport(reviewsFilePath);
    support = new CommunitySupportService({ db: auth.db,
      readReviews: () => store.readSync(reviewsFilePath), assertActiveUser: id => auth.assertActiveUser(id),
      validateResource: () => true, enabled: true, downloadReporting: true, personalStats: true });
    support.initializeReviews(store.readSync(reviewsFilePath));
  }
  await store.update(reviewsFilePath, current => ({ ...current,
    reviews: [approvedReview('support-review-a', a.user.id), approvedReview('support-review-b', b.user.id)] }));
  if (support) {
    support.recordDownload(event('support_download_a_001'), { userId: a.user.id, ip: '192.0.2.1' });
    support.recordDownload(event('support_download_b_001'), { userId: b.user.id, ip: '192.0.2.2' });
    assert.equal(support.snapshot().coins, 2);
    assert.equal(support.snapshot().flowers, 2);
  }
  const orders = { listUserOrderKeys: () => [], cleanupOrders: () => {}, get: () => null };
  const dependencies = { auth, ledger, store, dataDir, orders, communitySupport: support,
    cleanupAvatars: async () => ({ remaining: 0, sourceDeleted: true }) };
  t.after(() => { if (auth.db.open) auth.close(); });
  return { root, destination, dataDir, dbPath, now, auth, a, b, ledger, store, reviewsFilePath, support, dependencies };
}

function assertOwnershipCleared(db, userId, otherId) {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_downloads WHERE user_id=?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE user_id=?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_rate_limits WHERE actor_user_id=?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_downloads WHERE user_id=?').get(otherId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE user_id=?').get(otherId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE active=1').get().n, 2);
}

test('S5 clears contribution ownership before completion, retaining public totals and other accounts', async t => {
  const f = await fixture(t);
  const deletion = new AccountDeletionService(f.dependencies);
  const result = await deletion.request(f.a.user);
  assert.deepEqual([result.deleted, result.pending], [true, false]);
  assertOwnershipCleared(f.auth.db, f.a.user.id, f.b.user.id);
  assert.equal(f.support.snapshot().flowers, 2);
  assert.equal(f.support.snapshot().coins, 2);
  assert.deepEqual(f.support.myStats(f.b.user.id), { flowers: 1, coins: 1 });
  assert.throws(() => f.support.recordDownload(event('support_download_a_001'),
    { userId: f.b.user.id, ip: '192.0.2.2' }), { code: 'EVENT_CONFLICT' });
  assert.equal(f.store.readSync(f.reviewsFilePath).reviews[0].user_id, undefined);
  assert.equal(f.store.readSync(f.reviewsFilePath).reviews[0].publicationState, 'approved');
  assert.deepEqual(await deletion.resume({ all: true }), { complete: 1, pending: 0 });
  assertOwnershipCleared(f.auth.db, f.a.user.id, f.b.user.id);
});

test('contribution cleanup failure remains pending and the persistent deletion job retries', async t => {
  const f = await fixture(t);
  let unavailable = true;
  const communitySupport = { clearAccount(id) {
    if (unavailable) throw Object.assign(new Error('synthetic projection unavailable'), { code: 'SUPPORT_UNAVAILABLE' });
    return f.support.clearAccount(id);
  } };
  const deletion = new AccountDeletionService({ ...f.dependencies, communitySupport });
  const first = await deletion.request(f.a.user);
  assert.deepEqual([first.deleted, first.pending, first.accountDisabled], [false, true, true]);
  assert.equal(f.auth.db.prepare('SELECT last_error FROM account_deletion_jobs').get().last_error, 'SUPPORT_UNAVAILABLE');
  assert.equal(f.auth.db.prepare('SELECT COUNT(*) n FROM community_support_downloads WHERE user_id=?').get(f.a.user.id).n, 1);
  unavailable = false;
  assert.deepEqual(await deletion.resume(), { complete: 1, pending: 0 });
  assertOwnershipCleared(f.auth.db, f.a.user.id, f.b.user.id);
});

test('disabled feature wiring still scrubs an installed ledger, while old installations create no tables', async t => {
  const installed = await fixture(t);
  const result = await new AccountDeletionService({ ...installed.dependencies, communitySupport: null }).request(installed.a.user);
  assert.equal(result.deleted, true);
  assertOwnershipCleared(installed.auth.db, installed.a.user.id, installed.b.user.id);
  const legacy = await fixture(t, { supportInstalled: false });
  assert.equal((await new AccountDeletionService(legacy.dependencies).request(legacy.a.user)).deleted, true);
  assert.equal(legacy.auth.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name LIKE 'community_support_%'").get().n, 0);
  assert.equal(legacy.store.readSync(legacy.reviewsFilePath).community_support_ledger, undefined);
});

function prepareRestore(f) {
  // This is an isolated synthetic restore fixture, not a production backup.
  const backupDeletionLedgerHead = f.ledger.head();
  f.auth.db.exec('DELETE FROM mp_auth_tokens');
  privateJson(path.join(f.destination, '.restore-quarantine'), { quarantined: true });
  privateJson(path.join(f.dataDir, '.restore-quarantine'), { quarantined: true });
  privateJson(path.join(f.destination, 'restore-result.json'), { restored: true, quarantined: true,
    sessionsRevoked: true, snapshotCreatedAt: new Date(f.now + 1_000).toISOString(), backupDeletionLedgerHead });
  f.ledger.append({ eventId: 'synthetic-support-delete', userId: f.a.user.id, userCreatedAt: f.now,
    requestedAt: f.now + 2_000, policyVersion: POLICY, mode: 'retain-published' });
}

test('isolated old-state replay clears contribution owners and advances the durable review snapshot', async t => {
  const f = await fixture(t);
  const beforeSequence = f.store.readSync(f.reviewsFilePath).community_support_ledger.sequence;
  prepareRestore(f);
  // Close the fixture connection so the replay can checkpoint its own handles.
  f.auth.close();
  const result = await replayRestoredDeletions({ destination: f.destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result));
  assert.equal(result.quarantineReleased, false);
  assert.equal(verifyRestoreReplayProof({ destination: f.destination, ledger: f.ledger, freshHead: f.ledger.head() }).verified, true);
  const db = new Database(f.dbPath);
  try { assertOwnershipCleared(db, f.a.user.id, f.b.user.id); } finally { db.close(); }
  const reviews = f.store.readSync(f.reviewsFilePath);
  assert.ok(reviews.community_support_ledger.sequence > beforeSequence);
  assert.equal(reviews.reviews[0].user_id, undefined);
  assert.equal(reviews.reviews[0].publicationState, 'approved');
  assert.equal(fs.existsSync(path.join(f.destination, '.restore-quarantine')), true);
});

test('legacy isolated restore does not bootstrap contributions, and partial schema cannot pass replay', async t => {
  const legacy = await fixture(t, { supportInstalled: false });
  prepareRestore(legacy); legacy.auth.close();
  const result = await replayRestoredDeletions({ destination: legacy.destination, ledger: legacy.ledger, freshHead: legacy.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result));
  const oldDb = new Database(legacy.dbPath);
  try { assert.equal(oldDb.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name LIKE 'community_support_%'").get().n, 0); }
  finally { oldDb.close(); }
  assert.equal(legacy.store.readSync(legacy.reviewsFilePath).community_support_ledger, undefined);

  const broken = await fixture(t, { supportInstalled: false });
  broken.auth.db.exec('CREATE TABLE community_support_meta(singleton INTEGER PRIMARY KEY)');
  prepareRestore(broken); broken.auth.close();
  const failed = await replayRestoredDeletions({ destination: broken.destination, ledger: broken.ledger, freshHead: broken.ledger.head() });
  assert.equal(failed.replayVerified, false);
  assert.ok(failed.failures.some(item => item.code === 'RESTORE_SUPPORT_CLEANUP_FAILED'));
  assert.equal(failed.quarantineReleased, false);
});

test('isolated replay interrupted after contribution cleanup resumes without changing public totals', async t => {
  const f = await fixture(t);
  prepareRestore(f); f.auth.close();
  const failed = await replayRestoredDeletions({ destination: f.destination, ledger: f.ledger,
    freshHead: f.ledger.head(), fault: phase => {
      if (phase === 'afterCommunitySupport') throw new Error('synthetic interruption');
    } });
  assert.equal(failed.replayVerified, false);
  assert.equal(fs.existsSync(path.join(f.destination, 'restore-deletion-proof.json')), false);
  const recovered = await replayRestoredDeletions({ destination: f.destination,
    ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(recovered.replayVerified, true, JSON.stringify(recovered));
  const db = new Database(f.dbPath);
  try { assertOwnershipCleared(db, f.a.user.id, f.b.user.id); } finally { db.close(); }
});
