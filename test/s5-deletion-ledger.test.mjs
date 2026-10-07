import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DeletionLedger, DELETION_LEDGER_FORMAT, DELETION_LEDGER_FILENAME,
  deletionLedgerHead, validateDeletionLedgerSnapshot, assertIndependentLedgerDirectory,
} from '../server/deletion-ledger.mjs';
import { verifyRestoreReconciliation } from '../server/restore-reconciliation.mjs';

const lineage = 'synthetic-runtime-one';
const deletion = (overrides = {}) => ({
  eventId: 'synthetic-delete-one', userId: 1, userCreatedAt: 1000,
  requestedAt: 2000, policyVersion: 'synthetic-policy-one', mode: 'retain-published', ...overrides,
});
const code = expected => error => error.code === expected;
const failureCodes = report => report.failures.map(failure => failure.code);

test('external ledger layout rejects portable case aliases of runtime data', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 's5-ledger-case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(root, 'DATA'), { recursive: true });
  assert.throws(() => assertIndependentLedgerDirectory({ dataDir, directory: path.join(root, 'DATA', 'ledger') }), { code: 'LEDGER_NOT_INDEPENDENT' });
});
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nku-s5-ledger-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerDirectory = path.join(directory, 'independent-ledger');
  return { directory, ledgerDirectory, ledger: DeletionLedger.create({ directory: ledgerDirectory, lineage, ...options }) };
}
function tree(directory) {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return { name, mode: stat.mode, mtime: stat.mtimeMs, content: stat.isDirectory() ? tree(file) : fs.readFileSync(file).toString('base64') };
  });
}
function rehash(entry, runtimeLineage = lineage) {
  const { sequence, previousHash, hash: ignored, ...event } = entry;
  return createHash('sha256').update(JSON.stringify({ format: DELETION_LEDGER_FORMAT, lineage: runtimeLineage, sequence, previousHash, event })).digest('hex');
}

test('S5 explicit bootstrap creates private storage; open never creates missing or corrupt state', t => {
  const example = fixture(t);
  assert.equal(fs.statSync(example.ledgerDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(example.ledger.filePath).mode & 0o777, 0o600);
  assert.deepEqual(example.ledger.entries(), []);
  assert.equal(example.ledger.head().sequence, 0);
  assert.throws(() => new DeletionLedger({ directory: example.ledgerDirectory, lineage }), code('LEDGER_EXPLICIT_OPEN_REQUIRED'));
  assert.throws(() => DeletionLedger.create({ directory: example.ledgerDirectory, lineage }), code('LEDGER_ALREADY_EXISTS'));

  const missing = path.join(example.directory, 'missing');
  assert.throws(() => DeletionLedger.open({ directory: missing, lineage }), code('ENOENT'));
  assert.equal(fs.existsSync(missing), false);
  fs.mkdirSync(missing, { mode: 0o700 });
  assert.throws(() => DeletionLedger.open({ directory: missing, lineage }), code('ENOENT'));
  assert.deepEqual(fs.readdirSync(missing), []);

  fs.writeFileSync(example.ledger.filePath, '{broken');
  const before = tree(example.directory);
  assert.throws(() => DeletionLedger.open({ directory: example.ledgerDirectory, lineage }), code('LEDGER_JSON_INVALID'));
  assert.deepEqual(tree(example.directory), before);
});

test('S5 opens only the configured lineage and private regular files without repairing permissions', t => {
  const example = fixture(t);
  assert.throws(() => DeletionLedger.open({ directory: example.ledgerDirectory, lineage: 'different-runtime' }), code('LEDGER_LINEAGE_MISMATCH'));
  assert.throws(() => DeletionLedger.open({ directory: example.ledgerDirectory }), code('LEDGER_LINEAGE_REQUIRED'));
  fs.chmodSync(example.ledger.filePath, 0o640);
  assert.throws(() => DeletionLedger.open({ directory: example.ledgerDirectory, lineage }), code('LEDGER_STORAGE_NOT_PRIVATE'));
  assert.equal(fs.statSync(example.ledger.filePath).mode & 0o777, 0o640);
  fs.chmodSync(example.ledger.filePath, 0o600);
  fs.chmodSync(example.ledgerDirectory, 0o750);
  assert.throws(() => example.ledger.head(), code('LEDGER_STORAGE_NOT_PRIVATE'));
  fs.chmodSync(example.ledgerDirectory, 0o700);
  const alias = path.join(example.directory, 'ledger-alias');
  fs.symlinkSync(example.ledgerDirectory, alias, 'dir');
  assert.throws(() => DeletionLedger.open({ directory: alias, lineage }), code('LEDGER_STORAGE_UNSAFE'));
  fs.renameSync(example.ledger.filePath, path.join(example.ledgerDirectory, 'real.json'));
  fs.symlinkSync('real.json', example.ledger.filePath);
  assert.throws(() => example.ledger.snapshot(), code('LEDGER_STORAGE_UNSAFE'));
});

test('S5 appends continuous hashes, rereads across handles and returns independent copies', t => {
  const example = fixture(t);
  const zero = example.ledger.head();
  const secondHandle = DeletionLedger.open({ directory: example.ledgerDirectory, lineage });
  const first = example.ledger.append(deletion());
  assert.equal(first.appended, true);
  assert.equal(first.entry.sequence, 1);
  assert.equal(first.entry.previousHash, zero.hash);
  const second = secondHandle.append(deletion({ eventId: 'synthetic-delete-two', userId: 2, mode: 'withdraw-content' }));
  assert.equal(second.entry.sequence, 2);
  assert.equal(second.entry.previousHash, first.head.hash);
  assert.deepEqual(example.ledger.head(), second.head);
  assert.deepEqual(deletionLedgerHead(validateDeletionLedgerSnapshot(example.ledger.snapshot(), { lineage })), second.head);
  const copied = example.ledger.entries();
  copied[0].userId = 999;
  first.entry.policyVersion = 'changed';
  assert.equal(example.ledger.entries()[0].userId, 1);
  assert.equal(example.ledger.entries()[0].policyVersion, 'synthetic-policy-one');
  const bytes = fs.readFileSync(example.ledger.filePath, 'utf8');
  for (const field of ['phone', 'openid', 'nickname', 'name', 'password']) assert.equal(bytes.includes(`"${field}"`), false);
});

test('S5 accepts only an explicit policy and mode, positive typed identities and minimal fields', t => {
  const example = fixture(t);
  const mutations = [
    item => { delete item.mode; }, item => { item.mode = 'automatic'; }, item => { item.mode = null; },
    item => { item.policyVersion = ''; }, item => { delete item.policyVersion; },
    item => { item.userId = '1'; }, item => { item.userId = 0; }, item => { item.userCreatedAt = NaN; },
    item => { item.requestedAt = -1; }, item => { item.eventId = ''; }, item => { item.phone = 'synthetic-forbidden'; },
  ];
  for (const mutate of mutations) {
    const input = deletion(); mutate(input);
    assert.throws(() => example.ledger.append(input));
    assert.equal(example.ledger.head().sequence, 0);
  }
  assert.throws(() => example.ledger.append(deletion({ requestedAt: 999 })), code('LEDGER_REQUEST_BEFORE_CREATION'));
  assert.equal(example.ledger.head().sequence, 0);
  assert.equal(example.ledger.append(deletion({ requestedAt: 1000 })).appended, true, 'creation-time equality is valid');
});

test('S5 identical event retries are idempotent; changed identity, policy or intent conflicts', t => {
  const example = fixture(t);
  const first = example.ledger.append(deletion());
  const retry = example.ledger.append(deletion());
  assert.equal(retry.appended, false);
  assert.deepEqual(retry.entry, first.entry);
  assert.deepEqual(retry.head, first.head);
  for (const changed of [{ userId: 2 }, { userCreatedAt: 1001 }, { requestedAt: 2001 }, { policyVersion: 'different-policy' }, { mode: 'withdraw-content' }]) {
    assert.throws(() => example.ledger.append(deletion(changed)), code('LEDGER_EVENT_CONFLICT'));
    assert.deepEqual(example.ledger.head(), first.head);
  }
});

test('S5 corrupted chains reject gaps, changed hashes, duplicate ids and extra personal fields', t => {
  const example = fixture(t);
  example.ledger.append(deletion());
  example.ledger.append(deletion({ eventId: 'synthetic-delete-two', userId: 2 }));
  const original = example.ledger.snapshot();
  const cases = [
    [value => { value.entries[1].sequence = 3; }, 'LEDGER_SEQUENCE_GAP'],
    [value => { value.entries[1].previousHash = 'a'.repeat(64); }, 'LEDGER_CHAIN_MISMATCH'],
    [value => { value.entries[0].userId = 10; }, 'LEDGER_HASH_MISMATCH'],
    [value => { value.entries[1].eventId = value.entries[0].eventId; value.entries[1].hash = rehash(value.entries[1]); }, 'LEDGER_DUPLICATE_EVENT'],
    [value => { value.entries[0].phone = 'forbidden'; }, 'LEDGER_ENTRY_INVALID'],
    [value => { value.format = 'unknown-format'; }, 'LEDGER_SNAPSHOT_INVALID'],
  ];
  for (const [mutate, expected] of cases) {
    const corrupted = structuredClone(original); mutate(corrupted);
    fs.writeFileSync(example.ledger.filePath, JSON.stringify(corrupted));
    assert.throws(() => example.ledger.head(), code(expected));
    assert.throws(() => DeletionLedger.open({ directory: example.ledgerDirectory, lineage }), code(expected));
  }
});

test('S5 before-rename faults leave old state; after-rename faults fail but expose actual committed state on retry', t => {
  let failAt = '';
  const example = fixture(t, { fault: phase => { if (phase === failAt) throw Object.assign(new Error('synthetic disk fault'), { code: 'ENOSPC' }); } });
  const zero = example.ledger.head();
  failAt = 'beforeRename';
  assert.throws(() => example.ledger.append(deletion()), code('ENOSPC'));
  assert.deepEqual(example.ledger.head(), zero);
  assert.deepEqual(DeletionLedger.open({ directory: example.ledgerDirectory, lineage }).head(), zero);
  assert.deepEqual(fs.readdirSync(example.ledgerDirectory), [DELETION_LEDGER_FILENAME]);

  failAt = 'afterRename';
  assert.throws(() => example.ledger.append(deletion()), code('ENOSPC'));
  assert.equal(example.ledger.head().sequence, 1);
  const reopened = DeletionLedger.open({ directory: example.ledgerDirectory, lineage });
  assert.deepEqual(reopened.head(), example.ledger.head());
  assert.equal(example.ledger.append(deletion()).appended, false);
  assert.equal(reopened.entries().length, 1);
});

test('S5 interrupted bootstrap is never overwritten and a corrupted readback never becomes a cached success', t => {
  const example = fixture(t);
  const interrupted = path.join(example.directory, 'interrupted');
  assert.throws(() => DeletionLedger.create({ directory: interrupted, lineage, fault: phase => { if (phase === 'afterRename') throw new Error('synthetic crash'); } }), /synthetic crash/);
  assert.equal(DeletionLedger.open({ directory: interrupted, lineage }).head().sequence, 0);
  assert.throws(() => DeletionLedger.create({ directory: interrupted, lineage }), code('LEDGER_ALREADY_EXISTS'));
  const broken = DeletionLedger.open({ directory: example.ledgerDirectory, lineage, fault: phase => { if (phase === 'afterRename') fs.writeFileSync(example.ledger.filePath, '{broken'); } });
  assert.throws(() => broken.append(deletion()), code('LEDGER_JSON_INVALID'));
  assert.throws(() => broken.head(), code('LEDGER_JSON_INVALID'));
});

test('S5 restore prerequisite verification checks a chain prefix and only caller-asserted freshness without mutations', t => {
  const example = fixture(t);
  const backupHead = example.ledger.head();
  example.ledger.append(deletion());
  const firstHead = example.ledger.head();
  example.ledger.append(deletion({ eventId: 'synthetic-delete-two', userId: 2, mode: 'withdraw-content' }));
  const before = tree(example.directory);
  for (const checkpoint of [backupHead, firstHead, example.ledger.head()]) {
    const report = verifyRestoreReconciliation({ ledger: example.ledger, freshHead: example.ledger.head(), backupHead: checkpoint });
    assert.equal(report.verified, true);
    assert.equal(report.ledgerVerified, true);
    assert.equal(report.freshHeadMatched, true);
    assert.equal(report.backupPrefixVerified, true);
    assert.equal(report.entriesAfterBackup, 2 - checkpoint.sequence);
    assert.equal(report.evidenceBoundary, 'ledger_chain_and_caller_asserted_head_only');
    assert.equal(report.onlyLedgerRead, true);
    assert.equal(Object.hasOwn(report, 'productionDataRead'), false, 'the input ledger origin cannot be inferred');
    for (const field of ['externalFreshnessVerified', 'replayVerified', 'restoredDataVerified', 'quarantineReleased', 'restoreDestinationRead', 'restoreDestinationModified']) assert.equal(report[field], false, field);
    assert.deepEqual(report.failures, []);
  }
  assert.deepEqual(tree(example.directory), before);
});

test('S5 restore prerequisites reject missing, stale, malformed or unrelated fresh heads and legacy backup coverage', t => {
  const example = fixture(t);
  const old = example.ledger.head();
  example.ledger.append(deletion());
  const current = example.ledger.head();
  const options = { ledger: example.ledger, freshHead: current, backupHead: old };
  const cases = [
    [{ freshHead: undefined }, 'FRESH_LEDGER_HEAD_REQUIRED'],
    [{ freshHead: old }, 'FRESH_LEDGER_HEAD_MISMATCH'],
    [{ freshHead: { ...current, hash: 'bad' } }, 'FRESH_LEDGER_HEAD_INVALID'],
    [{ freshHead: { ...current, lineage: 'other-runtime' } }, 'FRESH_LEDGER_LINEAGE_MISMATCH'],
    [{ freshHead: { ...current, sequence: current.sequence + 1 } }, 'FRESH_LEDGER_HEAD_MISMATCH'],
    [{ backupHead: undefined }, 'BACKUP_LEDGER_HEAD_REQUIRED'],
    [{ backupHead: { ...old, sequence: '0' } }, 'BACKUP_LEDGER_HEAD_INVALID'],
    [{ backupHead: { ...old, lineage: 'other-runtime' } }, 'BACKUP_LEDGER_LINEAGE_MISMATCH'],
    [{ backupHead: { ...current, sequence: current.sequence + 1 } }, 'BACKUP_LEDGER_HEAD_AHEAD'],
    [{ backupHead: { ...old, hash: current.hash } }, 'BACKUP_LEDGER_NOT_PREFIX'],
    [{ ledger: undefined }, 'DELETION_LEDGER_UNAVAILABLE'],
  ];
  for (const [overrides, expected] of cases) {
    const report = verifyRestoreReconciliation({ ...options, ...overrides });
    assert.equal(report.verified, false);
    assert.ok(failureCodes(report).includes(expected), expected);
    assert.equal(report.quarantineReleased, false);
  }
  // Even a self-consistent truncated ledger is stale relative to an independent head.
  fs.writeFileSync(example.ledger.filePath, JSON.stringify({ format: DELETION_LEDGER_FORMAT, lineage, entries: [] }));
  const rolledBack = verifyRestoreReconciliation(options);
  assert.equal(rolledBack.ledgerVerified, true);
  assert.equal(rolledBack.verified, false);
  assert.ok(failureCodes(rolledBack).includes('FRESH_LEDGER_HEAD_MISMATCH'));
  fs.writeFileSync(example.ledger.filePath, '{broken');
  const corrupt = verifyRestoreReconciliation(options);
  assert.equal(corrupt.verified, false);
  assert.ok(failureCodes(corrupt).includes('DELETION_LEDGER_UNAVAILABLE'));
});
