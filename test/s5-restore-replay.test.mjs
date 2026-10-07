import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MpAuthService } from '../server/mp-auth-service.mjs';
import { DonateOrderStore } from '../server/donate-order-store.mjs';
import { AvatarStore } from '../server/avatar-store.mjs';
import { digest, readEnvelope } from '../server/durable-log.mjs';
import { initializeRuntimeDeletionLedger, openRuntimeDeletionLedger, readRuntimeDeletionBinding, DeletionLedger } from '../server/deletion-ledger.mjs';
import { captureRuntime, restoreSnapshot, verifySnapshot, saveEncryptedBackup, decryptSnapshot } from '../server/runtime-backup.mjs';
import { replayRestoredDeletions, verifyRestoreReplayProof, RESTORE_DELETION_JOBS_FILENAME, RESTORE_DELETION_PROOF_FILENAME } from '../server/restore-reconciliation.mjs';

const POLICY = 's5-retain-published-v1';
const root = path.resolve(import.meta.dirname, '..');
const codes = report => report.failures.map(item => item.code);
function privateJson(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); }
function tree(directory) {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return { name, mode: stat.mode, bytes: stat.isDirectory() ? tree(file) : digest(fs.readFileSync(file)) };
  });
}
function fixture(t, { bind = true, avatar = false } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nku-s5-restore-'));
  fs.chmodSync(directory, 0o700);
  const dataDir = path.join(directory, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const dbPath = path.join(directory, 'state', 'state.sqlite');
  const now = Date.now() - 100_000;
  const auth = new MpAuthService({ dbPath, now: () => now });
  const first = auth.webRegister({ nickname: 'synthetic-first', password: 'synthetic-password-one', email: 'first@example.test' });
  const other = auth.webRegister({ nickname: 'synthetic-other', password: 'synthetic-password-two' });
  auth.bindOpenidToUser(first.user.id, 'synthetic-openid'); auth.setVerifiedPhone(first.user.id, '13800001234');
  auth.db.exec("CREATE TABLE mp_favorites(user_id INTEGER,course_id TEXT); CREATE TABLE user_security_logs(user_id INTEGER,detail TEXT); CREATE TABLE admin_sessions(token TEXT)");
  auth.db.prepare('INSERT INTO mp_favorites VALUES (?,?)').run(first.user.id, 'synthetic-course');
  auth.db.prepare("INSERT INTO user_security_logs VALUES (?,'retained restricted evidence')").run(first.user.id);
  auth.db.exec("INSERT INTO admin_sessions VALUES ('synthetic-admin-token')");
  const orders = new DonateOrderStore({ dbPath });
  const ownKey = 'synthetic-order-one';
  orders.create({ outTradeNo: ownKey, userId: first.user.id, amountTotal: 500, nickname: 'synthetic-first', remark: 'identity remark', now });
  orders.markPaid({ outTradeNo: ownKey, amountTotal: 500, transactionId: 'synthetic-paid-transaction', now: now + 1000 });
  orders.create({ outTradeNo: 'synthetic-order-other', userId: other.user.id, amountTotal: 700, nickname: 'synthetic-other', now });
  const avatars = new AvatarStore({ dbPath });
  if (avatar) avatars.register({ id: 'synthetic-avatar-one', userId: first.user.id, bytes: 100, now });
  privateJson(path.join(dataDir, 'reviews.json'), { reviews: [
    { id: 'review-one', user_id: first.user.id, nickname: 'synthetic-first', contact: 'direct identity', status: 'approved', hidden: false, content: 'retained review', rating: 5, helpfulBy: [first.user.id, other.user.id], helpfulCount: 2 },
    { id: 'review-other', user_id: other.user.id, status: 'pending', content: 'other review', helpfulBy: [first.user.id], helpfulCount: 1 },
  ] });
  privateJson(path.join(dataDir, 'feedback.json'), { items: [{ id: 'private-one', user_id: first.user.id, contact: 'private contact', private: true,
    publicationState: 'pending', handlingStatus: 'processing', replyVisibility: 'submitter', content: 'retained private complaint', reply: 'retained reply' }] });
  privateJson(path.join(dataDir, 'donate.json'), { records: [{ date: '2026-10-07', nickname: 'synthetic-first', usage: 'retained usage', order_key: ownKey },
    { date: '2026-10-07', nickname: 'unattributed legacy', usage: 'legacy facts' }] });
  const ledgerDirectory = path.join(directory, 'independent-ledger');
  const ledger = bind ? initializeRuntimeDeletionLedger({ db: auth.db, dataDir, directory: ledgerDirectory, lineage: 'synthetic-recovery-lineage', now }) : null;
  const intent = overrides => ({ eventId: 'synthetic-intent-one', userId: first.user.id, userCreatedAt: now, requestedAt: now + 5000,
    policyVersion: POLICY, mode: 'retain-published', ...overrides });
  const capture = () => captureRuntime({ db: auth.db, dataDir, ...(ledger ? { deletionLedger: ledger } : {}) });
  const restore = snapshot => {
    const destination = path.join(directory, `restored-${fs.readdirSync(directory).length}`);
    restoreSnapshot({ snapshot, destination }); return destination;
  };
  t.after(() => { avatars.close(); orders.close(); auth.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, dataDir, dbPath, auth, orders, avatars, first, other, ownKey, now, ledger, ledgerDirectory, intent, capture, restore };
}

test('S5 runtime bootstrap binds an external authority and refuses overwrite, unsafe layout and wrong lineage', t => {
  const f = fixture(t);
  const binding = readRuntimeDeletionBinding(f.auth.db);
  assert.equal(binding.lineage, f.ledger.head().lineage);
  assert.equal(binding.accountIdHighWater, f.other.user.id);
  assert.deepEqual(openRuntimeDeletionLedger({ db: f.auth.db, dataDir: f.dataDir, directory: f.ledgerDirectory }).head(), f.ledger.head());
  assert.throws(() => initializeRuntimeDeletionLedger({ db: f.auth.db, dataDir: f.dataDir, directory: f.ledgerDirectory }), error => error.code === 'RUNTIME_LEDGER_ALREADY_BOUND');
  assert.throws(() => openRuntimeDeletionLedger({ db: f.auth.db, dataDir: f.dataDir, directory: path.join(f.dataDir, 'ledger') }), error => error.code === 'LEDGER_NOT_INDEPENDENT');
  const otherLedger = DeletionLedger.create({ directory: path.join(f.directory, 'other-ledger'), lineage: 'different-lineage' });
  assert.throws(() => openRuntimeDeletionLedger({ db: f.auth.db, dataDir: f.dataDir, directory: otherLedger.directory }), error => error.code === 'LEDGER_LINEAGE_MISMATCH');
  const alias = path.join(f.directory, 'symlink-parent'); fs.symlinkSync(f.directory, alias, 'dir');
  assert.throws(() => DeletionLedger.create({ directory: path.join(alias, 'forbidden-ledger'), lineage: 'unsafe' }), error => error.code === 'LEDGER_STORAGE_UNSAFE');
  assert.equal(fs.existsSync(path.join(f.directory, 'forbidden-ledger')), false);
});

test('S5 backup checkpoint is bound to SQLite, excludes authority and refuses a changing or missing ledger', t => {
  const f = fixture(t);
  const snapshot = f.capture();
  assert.deepEqual(snapshot.deletionLedgerHead, f.ledger.head());
  assert.equal(snapshot.files.some(entry => entry.name.includes('deletion-ledger.json')), false);
  assert.throws(() => captureRuntime({ db: f.auth.db, dataDir: f.dataDir }), error => error.code === 'DELETION_LEDGER_REQUIRED');
  const withoutHead = structuredClone(snapshot); delete withoutHead.deletionLedgerHead;
  assert.throws(() => verifySnapshot(withoutHead), error => error.code === 'BACKUP_LEDGER_HEAD_REQUIRED');
  const wrong = structuredClone(snapshot); wrong.deletionLedgerHead.lineage = 'wrong-lineage';
  assert.throws(() => verifySnapshot(wrong), error => error.code === 'BACKUP_LEDGER_LINEAGE_MISMATCH');
  assert.throws(() => captureRuntime({ db: f.auth.db, dataDir: f.dataDir, deletionLedger: f.ledger,
    extraFiles: { 'secret-copy': f.ledger.filePath } }), error => error.code === 'BACKUP_CONTAINS_DELETION_LEDGER');
  const copy = Buffer.from(JSON.stringify(f.ledger.snapshot()));
  const malicious = structuredClone(snapshot); malicious.files.push({ name: 'data/nested/deletion-ledger.json', bytes: copy.length, sha256: digest(copy), base64: copy.toString('base64') });
  assert.throws(() => f.restore(malicious), error => error.code === 'BACKUP_CONTAINS_DELETION_LEDGER');
  malicious.files.at(-1).name = 'config/renamed-private-config';
  assert.throws(() => verifySnapshot(malicious), error => error.code === 'BACKUP_CONTAINS_DELETION_LEDGER');
  const whitespaceCopy = Buffer.from(`\n  ${JSON.stringify(f.ledger.snapshot())}`);
  Object.assign(malicious.files.at(-1), { bytes: whitespaceCopy.length, sha256: digest(whitespaceCopy), base64: whitespaceCopy.toString('base64') });
  assert.throws(() => verifySnapshot(malicious), error => error.code === 'BACKUP_CONTAINS_DELETION_LEDGER');
  for (const name of ['data/restore-deletion-proof.json', 'data/restore-deletion-replay-jobs.json', 'data/restore-result.json']) {
    const artifact = structuredClone(snapshot); const bytes = Buffer.from('{}');
    artifact.files.push({ name, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') });
    assert.throws(() => verifySnapshot(artifact), error => error.code === 'BACKUP_CONTAINS_RECOVERY_ARTIFACT');
  }
  for (const name of ['data/RESTORE-DELETION-PROOF.JSON', 'data/nested/DELETION-LEDGER.JSON']) {
    const artifact = structuredClone(snapshot); const bytes = Buffer.from('{}');
    artifact.files.push({ name, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') });
    assert.throws(() => verifySnapshot(artifact), error => /^BACKUP_CONTAINS_/.test(error.code));
  }
  assert.throws(() => captureRuntime({ db: f.auth.db, dataDir: f.dataDir, deletionLedger: f.ledger,
    fault: phase => { if (phase === 'afterSqlite') f.ledger.append(f.intent()); } }), error => error.code === 'LEDGER_CHANGED_DURING_CAPTURE');
});

test('S5 snapshots reject case, Unicode and file/ancestor collisions before a restore can overwrite content', t => {
  const f = fixture(t); const snapshot = f.capture();
  const bytes = Buffer.from('{}');
  const append = (value, name) => value.files.push({ name, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') });
  for (const additions of [
    ['data/Reviews.json'],
    ['data/Nested/first.json', 'data/nested/second.json'],
    ['data/é.json', 'data/e\u0301.json'],
    ['data/ancestor.json', 'data/ancestor.json/child.json'],
  ]) {
    const collision = structuredClone(snapshot);
    for (const name of additions) append(collision, name);
    assert.throws(() => verifySnapshot(collision), error => error.code === 'BACKUP_PATH_COLLISION');
    const destination = path.join(f.directory, 'collision-must-not-restore');
    assert.throws(() => restoreSnapshot({ snapshot: collision, destination }), error => error.code === 'BACKUP_PATH_COLLISION');
    assert.equal(fs.existsSync(destination), false);
  }
  fs.renameSync(path.join(f.dataDir, 'reviews.json'), path.join(f.dataDir, 'Reviews.JSON'));
  const uppercase = captureRuntime({ db: f.auth.db, dataDir: f.dataDir, deletionLedger: f.ledger, requiredFiles: ['Reviews.JSON'] });
  assert.equal(uppercase.files.some(entry => entry.name === 'data/Reviews.JSON'), true);
  // On case-sensitive systems the lower-case path is missing; on insensitive
  // systems it exists but cannot count as an exact-name required capture.
  assert.throws(() => captureRuntime({ db: f.auth.db, dataDir: f.dataDir, deletionLedger: f.ledger, requiredFiles: ['reviews.json'] }));
});

test('S5 encrypted old backup replays later deletion, preserves content/accounting/logs and keeps both quarantine markers', async t => {
  const f = fixture(t);
  const snapshot = f.capture();
  const password = 'synthetic-backup-password';
  const archive = saveEncryptedBackup({ snapshot, password, directory: path.join(f.dataDir, 'private-backups') });
  f.ledger.append(f.intent());
  const destination = f.restore(decryptSnapshot(archive.bytes, password));
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result));
  assert.equal(result.localCleanupVerified, true);
  assert.equal(result.applied, 1);
  assert.equal(result.legacyDonationRecords, 1);
  for (const field of ['externalFreshnessVerified', 'quarantineReleased', 'avatarSourceDeletionVerified', 'cacheVerified', 'fullRecoveryVerified']) assert.equal(result[field], false);
  assert.equal(fs.existsSync(path.join(destination, '.restore-quarantine')), true);
  assert.equal(fs.existsSync(path.join(destination, 'data/.restore-quarantine')), true);
  assert.equal(verifyRestoreReplayProof({ destination, ledger: f.ledger, freshHead: f.ledger.head() }).verified, true);
  const restored = new Database(path.join(destination, 'state.sqlite'));
  try {
    const user = restored.prepare('SELECT * FROM mp_users WHERE id=?').get(f.first.user.id);
    assert.equal(user.created_at, f.now); assert.equal(user.deleted_at, f.now + 5000);
    assert.match(user.nickname, /^已注销用户_/);
    for (const field of ['phone', 'email', 'avatar_url']) assert.equal(user[field], '');
    for (const field of ['openid', 'web_password_hash', 'phone_verified_at']) assert.equal(user[field], null);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM mp_auth_tokens').get().n, 0);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM admin_sessions').get().n, 0);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM mp_favorites').get().n, 0);
    assert.equal(restored.prepare('SELECT detail FROM user_security_logs').get().detail, 'retained restricted evidence');
    const order = restored.prepare('SELECT * FROM donate_orders WHERE out_trade_no=?').get(f.ownKey);
    assert.equal(order.user_id, 0); assert.equal(order.nickname, ''); assert.equal(order.remark, '');
    assert.equal(order.status, 'paid'); assert.equal(order.amount_total, 500); assert.equal(order.transaction_id, 'synthetic-paid-transaction');
  } finally { restored.close(); }
  const reviews = JSON.parse(fs.readFileSync(path.join(destination, 'data/reviews.json'))).reviews;
  assert.equal(Object.hasOwn(reviews[0], 'user_id'), false); assert.equal(Object.hasOwn(reviews[0], 'nickname'), false);
  assert.equal(reviews[0].content, 'retained review'); assert.equal(reviews[0].status, 'approved'); assert.equal(reviews[0].hidden, false);
  assert.deepEqual(reviews[0].helpfulBy, [f.other.user.id]); assert.equal(reviews[1].status, 'pending');
  const complaint = JSON.parse(fs.readFileSync(path.join(destination, 'data/feedback.json'))).items[0];
  assert.equal(complaint.private, true); assert.equal(complaint.publicationState, 'pending'); assert.equal(complaint.reply, 'retained reply');
  assert.equal(Object.hasOwn(complaint, 'user_id'), false); assert.equal(Object.hasOwn(complaint, 'contact'), false);
  const donations = JSON.parse(fs.readFileSync(path.join(destination, 'data/donate.json'))).records;
  assert.equal(donations[0].nickname, '好心人'); assert.equal(donations[1].nickname, 'unattributed legacy');
  const again = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(again.replayVerified, true, JSON.stringify(again));
});

test('S5 replays accepted intents already at the backup watermark, not just newer sequence entries', async t => {
  const f = fixture(t); f.ledger.append(f.intent());
  const destination = f.restore(f.capture());
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result)); assert.equal(result.applied, 1);
});

test('S5 stale or missing fresh heads and legacy checkpoints leave restored business data unchanged', async t => {
  const f = fixture(t); const snapshot = f.capture(); const old = f.ledger.head(); f.ledger.append(f.intent());
  const destination = f.restore(snapshot); const before = tree(destination);
  for (const freshHead of [undefined, old, { ...f.ledger.head(), lineage: 'other-runtime' }]) {
    const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead });
    assert.equal(result.replayVerified, false); assert.deepEqual(tree(destination), before);
  }
  const legacy = fixture(t, { bind: false });
  const legacyDestination = legacy.restore(legacy.capture());
  const legacyBefore = tree(legacyDestination);
  const result = await replayRestoredDeletions({ destination: legacyDestination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, false); assert.ok(codes(result).includes('BACKUP_LEDGER_HEAD_REQUIRED'));
  assert.deepEqual(tree(legacyDestination), legacyBefore);
});

test('S5 account-instance mismatch and unsupported policy refuse cleanup before business changes', async t => {
  const f = fixture(t); const snapshot = f.capture(); f.ledger.append(f.intent({ userCreatedAt: f.now - 1 }));
  const destination = f.restore(snapshot); const before = tree(destination);
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, false); assert.ok(codes(result).includes('RESTORE_ACCOUNT_INSTANCE_MISMATCH'));
  assert.deepEqual(tree(destination), before);
  const policy = fixture(t); const policySnapshot = policy.capture(); policy.ledger.append(policy.intent({ mode: 'withdraw-content' }));
  const policyDestination = policy.restore(policySnapshot);
  assert.ok(codes(await replayRestoredDeletions({ destination: policyDestination, ledger: policy.ledger, freshHead: policy.ledger.head() })).includes('RESTORE_DELETION_POLICY_UNSUPPORTED'));
});

test('S5 SQL-first replay faults preserve exact order keys for JSON cleanup on restart', async t => {
  const f = fixture(t); const snapshot = f.capture(); f.ledger.append(f.intent());
  const destination = f.restore(snapshot);
  const failed = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head(), fault: phase => { if (phase === 'afterSqlCleanup') throw new Error('synthetic interruption'); } });
  assert.equal(failed.replayVerified, false);
  const jobs = readEnvelope(path.join(destination, RESTORE_DELETION_JOBS_FILENAME), 'restore-deletion-jobs');
  assert.deepEqual(jobs.entries[0].orderKeys, [f.ownKey]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'data/donate.json'))).records[0].nickname, 'synthetic-first');
  const recovered = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(recovered.replayVerified, true, JSON.stringify(recovered));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'data/donate.json'))).records[0].nickname, '好心人');
});

test('S5 restores persisted coordinator order keys even if the snapshot SQL ownership was already cleared', async t => {
  const f = fixture(t); f.ledger.append(f.intent());
  f.auth.db.exec('CREATE TABLE account_deletion_jobs(event_id TEXT PRIMARY KEY,user_id INTEGER,user_created_at INTEGER,order_keys TEXT)');
  f.auth.db.prepare('INSERT INTO account_deletion_jobs VALUES (?,?,?,?)').run('synthetic-job-one', f.first.user.id, f.now, JSON.stringify([f.ownKey]));
  f.orders.cleanupUser(f.first.user.id, { now: f.now + 5000 });
  const destination = f.restore(f.capture());
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'data/donate.json'))).records[0].nickname, '好心人');
});

test('S5 missing post-snapshot accounts still reserve known ledger IDs and changing heads invalidate proofs', async t => {
  const f = fixture(t); const snapshot = f.capture();
  const createdAfter = Date.parse(snapshot.createdAt) + 10;
  f.ledger.append(f.intent({ eventId: 'future-user-delete', userId: 500, userCreatedAt: createdAfter, requestedAt: createdAfter + 10 }));
  const destination = f.restore(snapshot);
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.replayVerified, true, JSON.stringify(result)); assert.equal(result.absentPostSnapshotAccounts, 1); assert.equal(result.accountIdHighWater, 500);
  const restored = new Database(path.join(destination, 'state.sqlite'));
  try { assert.equal(restored.prepare("INSERT INTO mp_users(openid,created_at) VALUES(NULL,?)").run(createdAfter + 20).lastInsertRowid, 501); }
  finally { restored.close(); }
  assert.ok(codes(verifyRestoreReplayProof({ destination, ledger: f.ledger, freshHead: f.ledger.head() })).includes('RESTORE_PROOF_STATE_CHANGED'));
  const next = f.restore(snapshot);
  const freshHead = f.ledger.head();
  const raced = await replayRestoredDeletions({ destination: next, ledger: f.ledger, freshHead,
    fault: phase => { if (phase === 'beforeProof') f.ledger.append(f.intent()); } });
  assert.equal(raced.replayVerified, false); assert.ok(codes(raced).includes('FRESH_LEDGER_HEAD_MISMATCH'));
  assert.equal(fs.existsSync(path.join(next, RESTORE_DELETION_PROOF_FILENAME)), false);
});

test('S5 offline avatar work stays pending and prevents a complete replay proof', async t => {
  const f = fixture(t, { avatar: true }); const snapshot = f.capture(); f.ledger.append(f.intent());
  const destination = f.restore(snapshot);
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head() });
  assert.equal(result.localCleanupVerified, true, JSON.stringify(result)); assert.equal(result.replayVerified, false); assert.equal(result.avatarsPending, 1);
  assert.ok(codes(result).includes('RESTORE_AVATAR_SOURCE_PENDING'));
  assert.equal(verifyRestoreReplayProof({ destination, ledger: f.ledger, freshHead: f.ledger.head() }).verified, false);
  const restored = new Database(path.join(destination, 'state.sqlite'));
  try { assert.equal(restored.prepare('SELECT status FROM avatars').get().status, 'cleanup_pending'); assert.equal(restored.prepare('SELECT COUNT(*) n FROM avatar_deletion_intents').get().n, 1); }
  finally { restored.close(); }
});

test('S5 initialization and replay CLIs use explicit private independent paths and never activate recovery', t => {
  const f = fixture(t, { bind: false });
  const initialize = spawnSync(process.execPath, ['scripts/initialize-deletion-ledger.mjs', '--offline', `--state-db=${f.dbPath}`, `--data-dir=${f.dataDir}`, `--ledger-dir=${f.ledgerDirectory}`, '--lineage=synthetic-cli-lineage'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialize.status, 0, initialize.stderr);
  assert.equal(JSON.parse(initialize.stdout).historicalDeletionCoverageVerified, false);
  const ledger = openRuntimeDeletionLedger({ db: f.auth.db, dataDir: f.dataDir, directory: f.ledgerDirectory });
  const snapshot = captureRuntime({ db: f.auth.db, dataDir: f.dataDir, deletionLedger: ledger });
  ledger.append(f.intent()); const destination = f.restore(snapshot);
  const freshFile = path.join(f.directory, 'independent-head.json'); privateJson(freshFile, ledger.head());
  const args = ['scripts/replay-restored-deletions.mjs', 'replay', '--offline', `--destination=${destination}`, `--ledger-dir=${f.ledgerDirectory}`, `--fresh-head-file=${freshFile}`];
  const replay = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout); assert.equal(JSON.parse(replay.stdout).quarantineReleased, false);
  args[1] = 'verify';
  const verify = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout); assert.equal(JSON.parse(verify.stdout).externalFreshnessVerified, false);
  const packagedHead = path.join(destination, 'fresh-from-old-package.json'); privateJson(packagedHead, ledger.head());
  args[args.length - 1] = `--fresh-head-file=${packagedHead}`;
  assert.equal(spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' }).status, 1);
  args[args.length - 1] = `--fresh-head-file=${freshFile}`; fs.chmodSync(freshFile, 0o644);
  assert.equal(spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' }).status, 1);
  fs.chmodSync(freshFile, 0o600);
  fs.writeFileSync(freshFile, '{"private-synthetic-identifier-917":broken}');
  const malformed = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr.trim(), 'Restore deletion reconciliation failed: RESTORE_DELETION_RECONCILIATION_FAILED');
  assert.equal(malformed.stderr.includes(f.directory), false);
  assert.equal(malformed.stderr.includes('private-synthetic-identifier-917'), false);
  const invalidInitialize = spawnSync(process.execPath, ['scripts/initialize-deletion-ledger.mjs', '--offline',
    `--state-db=${path.join(f.directory, 'private-synthetic-missing-db')}`, `--data-dir=${f.dataDir}`, `--ledger-dir=${f.ledgerDirectory}`], { cwd: root, encoding: 'utf8' });
  assert.equal(invalidInitialize.status, 1);
  assert.equal(invalidInitialize.stderr.trim(), 'Deletion ledger initialization failed: DELETION_LEDGER_INITIALIZATION_FAILED');
  const passwordFile = path.join(f.directory, 'synthetic-password-file');
  fs.writeFileSync(passwordFile, 'synthetic-long-private-password', { mode: 0o600 });
  const invalidBackup = spawnSync(process.execPath, ['scripts/runtime-backup.mjs', 'verify', path.join(f.directory, 'private-synthetic-missing-backup')],
    { cwd: root, encoding: 'utf8', env: { ...process.env, BACKUP_PASSWORD_FILE: passwordFile } });
  assert.equal(invalidBackup.status, 1);
  assert.equal(invalidBackup.stderr.trim(), 'Backup verification/recovery failed: BACKUP_OPERATION_FAILED');
  assert.equal(fs.existsSync(path.join(destination, '.restore-quarantine')), true);
});

test('S5 replay reports fixed codes instead of private injected error contents', async t => {
  const f = fixture(t); const snapshot = f.capture(); f.ledger.append(f.intent());
  const destination = f.restore(snapshot);
  const result = await replayRestoredDeletions({ destination, ledger: f.ledger, freshHead: f.ledger.head(),
    fault: () => { throw Object.assign(new Error(`${f.directory}/private-synthetic-account-918`), { code: 'PRIVATE_SYNTHETIC_ACCOUNT_918' }); } });
  assert.equal(result.replayVerified, false);
  assert.deepEqual(codes(result), ['RESTORE_DELETION_REPLAY_FAILED']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SYNTHETIC_ACCOUNT_918'), false);
  assert.equal(JSON.stringify(result).includes(f.directory), false);
});
