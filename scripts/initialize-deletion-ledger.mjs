import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeRuntimeDeletionLedger, readRuntimeDeletionBinding } from '../server/deletion-ledger.mjs';

const usage = 'Usage: node scripts/initialize-deletion-ledger.mjs --offline --state-db=<ABSOLUTE-EXISTING-DB> --data-dir=<ABSOLUTE-DATA-DIR> --ledger-dir=<ABSOLUTE-NEW-EXTERNAL-DIR> [--lineage=<ID>]';
let db;
try {
  if (process.argv.slice(2).includes('--help')) { console.log(usage); process.exit(0); }
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(offline|state-db|data-dir|ledger-dir|lineage)(?:=(.*))?$/.exec(arg);
    if (!match || args.has(match[1]) || match[1] === 'offline' && match[2] !== undefined) throw new Error(usage);
    args.set(match[1], match[2] ?? true);
  }
  if (!args.has('offline')) throw new Error('Stop the runtime first and explicitly pass --offline. This is an operator assertion, not a process-state verification.');
  for (const key of ['state-db', 'data-dir', 'ledger-dir']) if (typeof args.get(key) !== 'string' || !path.isAbsolute(args.get(key))) throw new Error(usage);
  for (const [key, directory] of [['state-db', false], ['data-dir', true]]) {
    const file = path.resolve(args.get(key));
    let cursor = path.parse(file).root;
    for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe runtime path'); }
    const stat = fs.lstatSync(file);
    if (process.platform === 'win32' || stat.mode & 0o077 || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Runtime paths must be private regular storage');
  }
  db = new Database(path.resolve(args.get('state-db')), { fileMustExist: true });
  const ledger = initializeRuntimeDeletionLedger({ db, dataDir: args.get('data-dir'), directory: args.get('ledger-dir'),
    ...(args.has('lineage') ? { lineage: args.get('lineage') } : {}) });
  console.log(JSON.stringify({ initialized: true, head: ledger.head(), binding: readRuntimeDeletionBinding(db),
    historicalDeletionCoverageVerified: false, offlineAssertionVerified: false }, null, 2));
} catch { console.error('Deletion ledger initialization failed: DELETION_LEDGER_INITIALIZATION_FAILED'); process.exitCode = 1; }
finally { db?.close(); }
