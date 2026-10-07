import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DeletionLedger, deletionLedgerHead, validateDeletionLedgerHead, assertIndependentLedgerDirectory, readRuntimeDeletionBinding } from './deletion-ledger.mjs';
import { digest, readEnvelope, writeEnvelope } from './durable-log.mjs';
import { AtomicJsonStore, drainJsonWrites } from './atomic-json-store.mjs';
import { MpAuthService } from './mp-auth-service.mjs';
import { DonateOrderStore } from './donate-order-store.mjs';
import { AvatarStore } from './avatar-store.mjs';
import { cleanupAccountContent } from './account-content-cleanup.mjs';

export const RESTORE_DELETION_JOBS_FILENAME = 'restore-deletion-replay-jobs.json';
export const RESTORE_DELETION_PROOF_FILENAME = 'restore-deletion-proof.json';
const POLICY = 's5-retain-published-v1';

const equalHead = (first, second) => first.lineage === second.lineage && first.sequence === second.sequence && first.hash === second.hash;

/**
 * Read-only prerequisite check, not deletion replay or activation approval.
 * freshHead must come from an independent current source asserted by the caller.
 * Matching it checks consistency only: hashes/signatures cannot prove freshness,
 * and this function neither accesses nor verifies that external source.
 * It reads the caller-selected private ledger, whose production/test origin is
 * unknown here; it never opens restored SQLite, runtime JSON or a destination.
 */
export function verifyRestoreReconciliation({ ledger, freshHead, backupHead } = {}) {
  const report = {
    verified: false,
    evidenceBoundary: 'ledger_chain_and_caller_asserted_head_only',
    ledgerVerified: false,
    freshHeadMatched: false,
    backupPrefixVerified: false,
    externalFreshnessVerified: false,
    replayVerified: false,
    restoredDataVerified: false,
    quarantineReleased: false,
    restoreDestinationRead: false,
    restoreDestinationModified: false,
    onlyLedgerRead: true,
    failures: [],
  };
  const fail = code => report.failures.push({ code });
  let fresh;
  let backup;
  let snapshot;
  if (freshHead === undefined || freshHead === null) fail('FRESH_LEDGER_HEAD_REQUIRED');
  else {
    try { fresh = validateDeletionLedgerHead(freshHead); }
    catch { fail('FRESH_LEDGER_HEAD_INVALID'); }
  }
  // Legacy snapshots with no checkpoint have unknown coverage. No automatic pass.
  if (backupHead === undefined || backupHead === null) fail('BACKUP_LEDGER_HEAD_REQUIRED');
  else {
    try { backup = validateDeletionLedgerHead(backupHead); }
    catch { fail('BACKUP_LEDGER_HEAD_INVALID'); }
  }
  try {
    if (!(ledger instanceof DeletionLedger)) throw new Error('Dedicated ledger required');
    snapshot = ledger.snapshot();
    report.currentHead = deletionLedgerHead(snapshot);
    report.ledgerVerified = true;
  } catch { fail('DELETION_LEDGER_UNAVAILABLE'); }

  if (snapshot && fresh) {
    if (fresh.lineage !== snapshot.lineage) fail('FRESH_LEDGER_LINEAGE_MISMATCH');
    else if (!equalHead(fresh, report.currentHead)) fail('FRESH_LEDGER_HEAD_MISMATCH');
    else report.freshHeadMatched = true;
  }
  if (snapshot && backup) {
    if (backup.lineage !== snapshot.lineage) fail('BACKUP_LEDGER_LINEAGE_MISMATCH');
    else if (backup.sequence > report.currentHead.sequence) fail('BACKUP_LEDGER_HEAD_AHEAD');
    else {
      const prefix = backup.sequence === 0
        ? deletionLedgerHead({ ...snapshot, entries: [] })
        : { lineage: snapshot.lineage, sequence: backup.sequence, hash: snapshot.entries[backup.sequence - 1].hash };
      if (!equalHead(backup, prefix)) fail('BACKUP_LEDGER_NOT_PREFIX');
      else {
        report.backupPrefixVerified = true;
        report.entriesAfterBackup = report.currentHead.sequence - backup.sequence;
      }
    }
  }
  report.verified = report.ledgerVerified && report.freshHeadMatched && report.backupPrefixVerified && report.failures.length === 0;
  return report;
}

const failure = code => Object.assign(new Error(code), { code });
// Only fixed diagnostic codes leave this module. Filesystem, SQLite, parser and
// injected cleanup errors can carry private paths, identifiers or content.
const failureCodes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS',
  'RESTORE_ABSOLUTE_PATH_REQUIRED', 'RESTORE_PATH_UNSAFE', 'RESTORE_STORAGE_NOT_PRIVATE',
  'RESTORE_RECEIPT_INVALID', 'RESTORE_SNAPSHOT_TIME_INVALID', 'DELETION_LEDGER_UNAVAILABLE',
  'LEDGER_DIRECTORY_REQUIRED', 'LEDGER_STORAGE_UNSAFE', 'LEDGER_NOT_INDEPENDENT',
  'RESTORE_ORDER_KEYS_INVALID', 'RESTORE_JOBS_INVALID', 'RESTORE_SQLITE_NOT_CHECKPOINTED',
  'FRESH_LEDGER_HEAD_MISMATCH', 'RESTORE_RUNTIME_LINEAGE_MISMATCH', 'RESTORE_SQLITE_INVALID',
  'RESTORE_DELETION_POLICY_UNSUPPORTED', 'RESTORE_ACCOUNT_INSTANCE_CONFLICT',
  'RESTORE_ACCOUNT_INSTANCE_MISMATCH', 'RESTORE_ACCOUNT_MISSING', 'RESTORE_JOB_INTENT_MISMATCH',
  'RESTORE_ORDER_OWNER_MISMATCH', 'RESTORE_PAYMENT_CLEANUP_INCOMPLETE',
  'RESTORE_IDENTITY_CLEANUP_INCOMPLETE', 'RESTORE_CREDENTIAL_CLEANUP_INCOMPLETE',
  'RESTORE_ACCOUNT_HIGH_WATER_INVALID', 'RESTORE_ACCOUNT_SEQUENCE_REQUIRED',
  'ACCOUNT_CONTENT_INVALID', 'ACCOUNT_CONTENT_READBACK_MISMATCH', 'ACCOUNT_CONTENT_CLEANUP_INCOMPLETE',
  'RESTORE_REPLAY_INCOMPLETE', 'RESTORE_PROOF_HEAD_MISMATCH', 'RESTORE_PROOF_STATE_CHANGED',
]);
const failureCode = (error, fallback) => failureCodes.has(error?.code) ? error.code : fallback;
function privatePath(file, directory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('RESTORE_ABSOLUTE_PATH_REQUIRED');
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw failure('RESTORE_PATH_UNSAFE');
  }
  const stat = fs.lstatSync(absolute);
  if (process.platform === 'win32' || stat.mode & 0o077) throw failure('RESTORE_STORAGE_NOT_PRIVATE');
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw failure('RESTORE_PATH_UNSAFE');
  return absolute;
}
function restoredContext(destination, ledger) {
  const target = privatePath(destination, true);
  privatePath(path.join(target, '.restore-quarantine'));
  const dataDir = privatePath(path.join(target, 'data'), true);
  privatePath(path.join(dataDir, '.restore-quarantine'));
  const stateFile = privatePath(path.join(target, 'state.sqlite'));
  privatePath(path.join(target, 'restore-result.json'));
  const receipt = JSON.parse(fs.readFileSync(path.join(target, 'restore-result.json'), 'utf8'));
  if (receipt.restored !== true || receipt.quarantined !== true || receipt.sessionsRevoked !== true) throw failure('RESTORE_RECEIPT_INVALID');
  const snapshotAt = Date.parse(receipt.snapshotCreatedAt);
  if (!Number.isFinite(snapshotAt)) throw failure('RESTORE_SNAPSHOT_TIME_INVALID');
  if (!(ledger instanceof DeletionLedger)) throw failure('DELETION_LEDGER_UNAVAILABLE');
  assertIndependentLedgerDirectory({ directory: ledger.directory, dataDir, restoreDestination: target });
  return { target, dataDir, stateFile, receipt, snapshotAt };
}
function orderKeys(value) {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key))) throw failure('RESTORE_ORDER_KEYS_INVALID');
  return [...new Set(value)].sort();
}
function readJobs(file, lineage) {
  let jobs;
  try { privatePath(file); jobs = readEnvelope(file, 'restore-deletion-jobs'); }
  catch (error) { if (error.code === 'ENOENT') return { lineage, entries: [] }; throw error; }
  if (jobs?.lineage !== lineage || !Array.isArray(jobs.entries)) throw failure('RESTORE_JOBS_INVALID');
  const ids = new Set();
  for (const job of jobs.entries) {
    if (!job || typeof job.eventId !== 'string' || ids.has(job.eventId) || !Number.isSafeInteger(job.userId) || job.userId <= 0
      || !Number.isSafeInteger(job.userCreatedAt) || job.userCreatedAt <= 0 || !/^[a-f0-9]{64}$/.test(job.intentHash)) throw failure('RESTORE_JOBS_INVALID');
    ids.add(job.eventId); job.orderKeys = orderKeys(job.orderKeys);
  }
  return jobs;
}
function localHashes(context) {
  const files = ['state.sqlite', 'data/reviews.json', 'data/feedback.json'];
  if (fs.existsSync(path.join(context.dataDir, 'donate.json'))) files.push('data/donate.json');
  for (const suffix of ['-wal', '-shm']) {
    const file = context.stateFile + suffix;
    if (fs.existsSync(file) && fs.statSync(file).size !== 0) throw failure('RESTORE_SQLITE_NOT_CHECKPOINTED');
  }
  return Object.fromEntries(files.map(name => [name, digest(fs.readFileSync(privatePath(path.join(context.target, name))))]));
}

/**
 * Applies all accepted intents to a new quarantined restore. It deliberately
 * has no remote client and never removes quarantine. Indexed avatars remain
 * durable pending work; source/CDN/cache removal is not claimed by this tool.
 */
export async function replayRestoredDeletions({ destination, ledger, freshHead, cleanupContent = cleanupAccountContent, fault = () => {} } = {}) {
  const report = { replayVerified: false, localCleanupVerified: false, quarantined: true, quarantineReleased: false,
    externalFreshnessVerified: false, avatarSourceDeletionVerified: false, cacheVerified: false, fullRecoveryVerified: false,
    evidenceBoundary: 'quarantined_local_replay_with_caller_asserted_head', applied: 0, absentPostSnapshotAccounts: 0,
    avatarsPending: 0, legacyDonationRecords: 0, failures: [] };
  let context, db, auth, orders, avatars;
  try {
    context = restoredContext(destination, ledger);
    const prerequisite = verifyRestoreReconciliation({ ledger, freshHead, backupHead: context.receipt.backupDeletionLedgerHead });
    report.prerequisitesVerified = prerequisite.verified;
    if (!prerequisite.verified) { report.failures = prerequisite.failures; return report; }
    const snapshot = ledger.snapshot();
    const currentHead = deletionLedgerHead(snapshot);
    if (!equalHead(currentHead, validateDeletionLedgerHead(freshHead))) throw failure('FRESH_LEDGER_HEAD_MISMATCH');
    report.currentHead = currentHead;
    db = new Database(context.stateFile, { fileMustExist: true });
    db.pragma('synchronous = FULL');
    const binding = readRuntimeDeletionBinding(db);
    if (!binding || binding.lineage !== currentHead.lineage) throw failure('RESTORE_RUNTIME_LINEAGE_MISMATCH');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw failure('RESTORE_SQLITE_INVALID');
    const instances = new Map();
    const present = new Set();
    // Validate every instance and selected policy before changing any business row.
    for (const entry of snapshot.entries) {
      if (entry.policyVersion !== POLICY || entry.mode !== 'retain-published') throw failure('RESTORE_DELETION_POLICY_UNSUPPORTED');
      if (instances.has(entry.userId) && instances.get(entry.userId) !== entry.userCreatedAt) throw failure('RESTORE_ACCOUNT_INSTANCE_CONFLICT');
      instances.set(entry.userId, entry.userCreatedAt);
      const account = db.prepare('SELECT created_at FROM mp_users WHERE id=?').get(entry.userId);
      if (account) {
        if (account.created_at !== entry.userCreatedAt) throw failure('RESTORE_ACCOUNT_INSTANCE_MISMATCH');
        present.add(entry.eventId);
      } else if (entry.userCreatedAt <= context.snapshotAt) throw failure('RESTORE_ACCOUNT_MISSING');
    }
    const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    const jobsFile = path.join(context.target, RESTORE_DELETION_JOBS_FILENAME);
    const jobs = readJobs(jobsFile, currentHead.lineage);
    const store = new AtomicJsonStore({ allowedRoot: context.dataDir });
    auth = new MpAuthService({ dbPath: context.stateFile });
    auth.db.pragma('synchronous = FULL');
    if (hasTable('donate_orders')) { orders = new DonateOrderStore({ dbPath: context.stateFile }); orders.db.pragma('synchronous = FULL'); }
    if (hasTable('avatars')) { avatars = new AvatarStore({ dbPath: context.stateFile }); avatars.db.pragma('synchronous = FULL'); }
    for (const entry of snapshot.entries) {
      let job = jobs.entries.find(row => row.eventId === entry.eventId);
      if (job && (job.userId !== entry.userId || job.userCreatedAt !== entry.userCreatedAt || job.intentHash !== entry.hash)) throw failure('RESTORE_JOB_INTENT_MISMATCH');
      if (!present.has(entry.eventId)) { report.absentPostSnapshotAccounts++; continue; }
      const previousKeys = hasTable('account_deletion_jobs')
        ? db.prepare('SELECT order_keys FROM account_deletion_jobs WHERE user_id=? AND user_created_at=?').all(entry.userId, entry.userCreatedAt).flatMap(row => orderKeys(JSON.parse(row.order_keys))) : [];
      const keys = orderKeys([...(job?.orderKeys ?? []), ...previousKeys, ...(orders?.listUserOrderKeys(entry.userId) ?? [])]);
      for (const key of keys) {
        const order = orders?.get(key);
        if (order && order.user_id !== entry.userId && !(order.user_id === 0 && order.identity_cleared_at != null)) throw failure('RESTORE_ORDER_OWNER_MISMATCH');
      }
      if (!job) { job = { eventId: entry.eventId, userId: entry.userId, userCreatedAt: entry.userCreatedAt, intentHash: entry.hash, orderKeys: keys }; jobs.entries.push(job); }
      else job.orderKeys = keys;
      // Preserve exact order ownership across SQL cleanup and JSON/restart faults.
      writeEnvelope(jobsFile, 'restore-deletion-jobs', jobs);
      fault('afterJobPersisted', entry);
      auth.deleteAccount(entry.userId, { now: entry.requestedAt });
      orders?.cleanupOrders(keys, { now: entry.requestedAt });
      if (orders?.listUserOrderKeys(entry.userId).length) throw failure('RESTORE_PAYMENT_CLEANUP_INCOMPLETE');
      for (const key of keys) {
        const order = orders?.get(key);
        if (order && (order.user_id !== 0 || order.nickname || order.remark)) throw failure('RESTORE_PAYMENT_CLEANUP_INCOMPLETE');
      }
      fault('afterSqlCleanup', entry);
      const content = await cleanupContent({ store, dataDir: context.dataDir, userId: entry.userId, donationOrderKeys: keys });
      report.legacyDonationRecords = Math.max(report.legacyDonationRecords, content?.legacyDonationRecords ?? 0);
      avatars?.markUserDeletion(entry.userId, { now: entry.requestedAt });
      const account = db.prepare('SELECT * FROM mp_users WHERE id=?').get(entry.userId);
      if (account.deleted_at == null || account.openid != null || account.web_password_hash != null || account.phone || account.phone_verified_at != null
        || account.email || account.avatar_url || !/^已注销用户_[A-Za-z0-9_-]{16}$/.test(account.nickname)) throw failure('RESTORE_IDENTITY_CLEANUP_INCOMPLETE');
      if (hasTable('mp_auth_tokens') && db.prepare('SELECT 1 FROM mp_auth_tokens WHERE user_id=?').get(entry.userId)
        || hasTable('mp_favorites') && db.prepare('SELECT 1 FROM mp_favorites WHERE user_id=?').get(entry.userId)) throw failure('RESTORE_CREDENTIAL_CLEANUP_INCOMPLETE');
      report.applied++;
    }
    const originalSeq = hasTable('sqlite_sequence') ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name='mp_users'").get()?.seq ?? 0 : 0;
    const currentMax = db.prepare('SELECT COALESCE(MAX(id),0) n FROM mp_users').get().n;
    const highWater = snapshot.entries.reduce((maximum, entry) => Math.max(maximum, entry.userId), Math.max(originalSeq, currentMax, binding.accountIdHighWater));
    if (!Number.isSafeInteger(highWater)) throw failure('RESTORE_ACCOUNT_HIGH_WATER_INVALID');
    db.transaction(() => {
      if (!hasTable('sqlite_sequence')) throw failure('RESTORE_ACCOUNT_SEQUENCE_REQUIRED');
      if (db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='mp_users'").get()) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='mp_users'").run(highWater);
      else db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('mp_users',?)").run(highWater);
      db.prepare('UPDATE account_deletion_runtime SET account_id_high_water=MAX(account_id_high_water,?) WHERE singleton=1').run(highWater);
      for (const table of ['admin_sessions', 'mp_auth_tokens', 'web_login_tickets']) if (hasTable(table)) db.exec(`DELETE FROM ${table}`);
    }).immediate();
    report.accountIdHighWater = highWater;
    if (avatars) {
      for (const userId of instances.keys()) report.avatarsPending += avatars.listForUser(userId).length;
    }
    await drainJsonWrites();
    if (!equalHead(ledger.head(), currentHead)) throw failure('FRESH_LEDGER_HEAD_MISMATCH');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw failure('RESTORE_SQLITE_INVALID');
    auth.close(); auth = null; orders?.close(); orders = null; avatars?.close(); avatars = null;
    db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); db = null;
    report.localCleanupVerified = true;
    report.replayVerified = report.avatarsPending === 0;
    if (report.avatarsPending) report.failures.push({ code: 'RESTORE_AVATAR_SOURCE_PENDING' });
    report.localStateHashes = localHashes(context);
    report.backupHead = context.receipt.backupDeletionLedgerHead;
    fault('beforeProof');
    if (!equalHead(ledger.head(), currentHead)) throw failure('FRESH_LEDGER_HEAD_MISMATCH');
    writeEnvelope(path.join(context.target, RESTORE_DELETION_PROOF_FILENAME), 'restore-deletion-proof', report);
    return report;
  } catch (error) {
    report.replayVerified = false; report.localCleanupVerified = false;
    report.failures.push({ code: failureCode(error, 'RESTORE_DELETION_REPLAY_FAILED') });
    return report;
  } finally { auth?.close(); orders?.close(); avatars?.close(); db?.close(); }
}

/** Rechecks a saved proof against current local bytes and an independent head assertion. */
export function verifyRestoreReplayProof({ destination, ledger, freshHead } = {}) {
  const report = { verified: false, externalFreshnessVerified: false, quarantined: true, quarantineReleased: false, failures: [] };
  try {
    const context = restoredContext(destination, ledger);
    const prerequisite = verifyRestoreReconciliation({ ledger, freshHead, backupHead: context.receipt.backupDeletionLedgerHead });
    if (!prerequisite.verified) { report.failures = prerequisite.failures; return report; }
    const file = privatePath(path.join(context.target, RESTORE_DELETION_PROOF_FILENAME));
    const proof = readEnvelope(file, 'restore-deletion-proof');
    if (proof.replayVerified !== true || proof.localCleanupVerified !== true || proof.avatarsPending !== 0) throw failure('RESTORE_REPLAY_INCOMPLETE');
    if (!equalHead(validateDeletionLedgerHead(proof.currentHead), prerequisite.currentHead)
      || !equalHead(validateDeletionLedgerHead(proof.backupHead), validateDeletionLedgerHead(context.receipt.backupDeletionLedgerHead))) throw failure('RESTORE_PROOF_HEAD_MISMATCH');
    if (JSON.stringify(proof.localStateHashes) !== JSON.stringify(localHashes(context))) throw failure('RESTORE_PROOF_STATE_CHANGED');
    report.verified = true; report.currentHead = prerequisite.currentHead;
    report.proofSha256 = digest(fs.readFileSync(file));
    report.legacyDonationRecords = proof.legacyDonationRecords;
  } catch (error) { report.failures.push({ code: failureCode(error, 'RESTORE_PROOF_INVALID') }); }
  return report;
}
