import fs from 'node:fs';
import path from 'node:path';
import { digest, durableWrite, syncDir } from './durable-log.mjs';

export const DELETION_LEDGER_FORMAT = 'nkustudy-deletion-ledger-v1';
export const DELETION_LEDGER_FILENAME = 'deletion-ledger.json';
export const DELETION_MODES = Object.freeze(['retain-published', 'withdraw-content']);

const eventFields = ['eventId', 'userId', 'userCreatedAt', 'requestedAt', 'policyVersion', 'mode'];
const entryFields = ['sequence', 'previousHash', 'hash', ...eventFields];
const opening = Symbol('open-deletion-ledger');

function failure(code, message = code) { return Object.assign(new Error(message), { code }); }
function exactFields(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw failure(code);
}
function reference(value, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw failure(code);
  return value;
}
function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(code);
  return value;
}
function hash(value, code) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw failure(code);
  return value;
}
function event(value) {
  exactFields(value, eventFields, 'LEDGER_EVENT_INVALID');
  if (!DELETION_MODES.includes(value.mode)) throw failure('LEDGER_MODE_REQUIRED');
  const normalized = {
    eventId: reference(value.eventId, 'LEDGER_EVENT_ID_INVALID'),
    userId: positiveInteger(value.userId, 'LEDGER_USER_ID_INVALID'),
    userCreatedAt: positiveInteger(value.userCreatedAt, 'LEDGER_USER_CREATED_AT_INVALID'),
    requestedAt: positiveInteger(value.requestedAt, 'LEDGER_REQUESTED_AT_INVALID'),
    policyVersion: reference(value.policyVersion, 'LEDGER_POLICY_VERSION_REQUIRED'),
    mode: value.mode,
  };
  if (normalized.requestedAt < normalized.userCreatedAt) throw failure('LEDGER_REQUEST_BEFORE_CREATION');
  return normalized;
}
function eventOf(entry) { return event(Object.fromEntries(eventFields.map(field => [field, entry[field]]))); }
function genesis(lineage) { return digest(JSON.stringify({ format: DELETION_LEDGER_FORMAT, lineage, sequence: 0 })); }
function entryHash(lineage, sequence, previousHash, value) {
  return digest(JSON.stringify({ format: DELETION_LEDGER_FORMAT, lineage, sequence, previousHash, event: value }));
}

/** Checks content integrity only. A valid hash chain does not establish freshness. */
export function validateDeletionLedgerSnapshot(value, { lineage } = {}) {
  exactFields(value, ['format', 'lineage', 'entries'], 'LEDGER_SNAPSHOT_INVALID');
  if (value.format !== DELETION_LEDGER_FORMAT || !Array.isArray(value.entries)) throw failure('LEDGER_SNAPSHOT_INVALID');
  const actualLineage = reference(value.lineage, 'LEDGER_LINEAGE_REQUIRED');
  if (lineage !== undefined && reference(lineage, 'LEDGER_LINEAGE_REQUIRED') !== actualLineage) throw failure('LEDGER_LINEAGE_MISMATCH');
  let previousHash = genesis(actualLineage);
  const ids = new Set();
  const entries = value.entries.map((entry, index) => {
    exactFields(entry, entryFields, 'LEDGER_ENTRY_INVALID');
    if (entry.sequence !== index + 1 || !Number.isSafeInteger(entry.sequence)) throw failure('LEDGER_SEQUENCE_GAP');
    if (hash(entry.previousHash, 'LEDGER_HASH_INVALID') !== previousHash) throw failure('LEDGER_CHAIN_MISMATCH');
    const normalized = eventOf(entry);
    if (ids.has(normalized.eventId)) throw failure('LEDGER_DUPLICATE_EVENT');
    ids.add(normalized.eventId);
    const expected = entryHash(actualLineage, entry.sequence, previousHash, normalized);
    if (hash(entry.hash, 'LEDGER_HASH_INVALID') !== expected) throw failure('LEDGER_HASH_MISMATCH');
    previousHash = expected;
    return { sequence: entry.sequence, previousHash: entry.previousHash, hash: expected, ...normalized };
  });
  return { format: DELETION_LEDGER_FORMAT, lineage: actualLineage, entries };
}

export function deletionLedgerHead(snapshot) {
  const value = validateDeletionLedgerSnapshot(snapshot);
  return { lineage: value.lineage, sequence: value.entries.length, hash: value.entries.at(-1)?.hash ?? genesis(value.lineage) };
}

export function validateDeletionLedgerHead(value) {
  exactFields(value, ['lineage', 'sequence', 'hash'], 'LEDGER_HEAD_INVALID');
  const lineage = reference(value.lineage, 'LEDGER_HEAD_INVALID');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw failure('LEDGER_HEAD_INVALID');
  return { lineage, sequence: value.sequence, hash: hash(value.hash, 'LEDGER_HEAD_INVALID') };
}

function directoryPath(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('LEDGER_DIRECTORY_REQUIRED');
  return path.resolve(directory);
}
function privateStorage(file, directory) {
  // POSIX mode bits cannot attest Windows ACLs. Do not silently claim privacy.
  if (process.platform === 'win32') throw failure('LEDGER_PRIVATE_STORAGE_UNVERIFIABLE');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw failure('LEDGER_STORAGE_UNSAFE');
  if (stat.mode & 0o077) throw failure('LEDGER_STORAGE_NOT_PRIVATE');
}

/**
 * A dedicated, single-process writer. Keep this directory outside runtime data,
 * backup archives and restore destinations: this class cannot infer that layout.
 * Every access rereads disk; a write fault never leaves a fictional cached head.
 * No retention or pruning policy is selected here.
 */
export class DeletionLedger {
  #directory;
  #lineage;
  #fault;

  constructor({ directory, lineage, fault = () => {} }, token) {
    if (token !== opening) throw failure('LEDGER_EXPLICIT_OPEN_REQUIRED', 'Use DeletionLedger.create() or DeletionLedger.open().');
    this.#directory = directoryPath(directory);
    this.#lineage = reference(lineage, 'LEDGER_LINEAGE_REQUIRED');
    if (typeof fault !== 'function') throw failure('LEDGER_FAULT_HOOK_INVALID');
    this.#fault = fault;
    this.snapshot();
  }

  static create({ directory, lineage, fault = () => {} } = {}) {
    const target = directoryPath(directory);
    const normalizedLineage = reference(lineage, 'LEDGER_LINEAGE_REQUIRED');
    if (typeof fault !== 'function') throw failure('LEDGER_FAULT_HOOK_INVALID');
    if (process.platform === 'win32') throw failure('LEDGER_PRIVATE_STORAGE_UNVERIFIABLE');
    // An explicit bootstrap must never replace an existing (even empty) ledger.
    try { fs.mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw failure('LEDGER_ALREADY_EXISTS'); throw error; }
    syncDir(path.dirname(target));
    durableWrite(path.join(target, DELETION_LEDGER_FILENAME), `${JSON.stringify({ format: DELETION_LEDGER_FORMAT, lineage: normalizedLineage, entries: [] }, null, 2)}\n`, fault);
    return DeletionLedger.open({ directory: target, lineage: normalizedLineage, fault });
  }

  static open(options = {}) { return new DeletionLedger(options, opening); }
  get directory() { return this.#directory; }
  get filePath() { return path.join(this.#directory, DELETION_LEDGER_FILENAME); }

  snapshot() {
    privateStorage(this.#directory, true);
    privateStorage(this.filePath, false);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw failure('LEDGER_JSON_INVALID'); throw error; }
    return validateDeletionLedgerSnapshot(parsed, { lineage: this.#lineage });
  }
  head() { return deletionLedgerHead(this.snapshot()); }
  entries() { return this.snapshot().entries; }

  append(input) {
    const normalized = event(input);
    const snapshot = this.snapshot();
    const existing = snapshot.entries.find(entry => entry.eventId === normalized.eventId);
    if (existing) {
      if (JSON.stringify(eventOf(existing)) !== JSON.stringify(normalized)) throw failure('LEDGER_EVENT_CONFLICT');
      return { appended: false, entry: structuredClone(existing), head: deletionLedgerHead(snapshot) };
    }
    const previous = deletionLedgerHead(snapshot);
    const sequence = positiveInteger(previous.sequence + 1, 'LEDGER_SEQUENCE_EXHAUSTED');
    const next = { sequence, previousHash: previous.hash, hash: entryHash(snapshot.lineage, sequence, previous.hash, normalized), ...normalized };
    snapshot.entries.push(next);
    // durableWrite fsyncs the file and directory. If it throws after rename,
    // append still fails; the next read/retry sees the actual committed entry.
    durableWrite(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, this.#fault);
    const persisted = this.snapshot();
    if (JSON.stringify(persisted) !== JSON.stringify(snapshot)) throw failure('LEDGER_READBACK_MISMATCH');
    return { appended: true, entry: structuredClone(next), head: deletionLedgerHead(persisted) };
  }
}
