import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { captureRuntime, saveEncryptedBackup, decryptSnapshot } from '../server/runtime-backup.mjs';
import { openRuntimeDeletionLedger } from '../server/deletion-ledger.mjs';
import { preflightProductionRuntime, projectRoot } from '../server/runtime-config.mjs';

const REQUIRED_JSON = ['manifest.json', 'about.json', 'home.json', 'participate.json', 'links.json',
  'footer.json', 'reviews.json', 'feedback.json', 'visit-stats.json', 'editor-settings.json', 'backup-settings.json'];
const safeCodes = new Set(['BASELINE_BACKUP_SERVICE_NOT_STOPPED', 'BASELINE_BACKUP_PASSWORD_NOT_CONFIGURED',
  'BASELINE_BACKUP_PRIVATE_PATH_REQUIRED', 'BASELINE_BACKUP_PRODUCTION_REQUIRED', 'BASELINE_BACKUP_READBACK_FAILED']);

function refuse(code) { throw Object.assign(new Error(code), { code }); }

function privatePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) refuse('BASELINE_BACKUP_PRIVATE_PATH_REQUIRED');
  const absolute = path.resolve(value);
  if (absolute === projectRoot || absolute.startsWith(projectRoot + path.sep)) refuse('BASELINE_BACKUP_PRIVATE_PATH_REQUIRED');
  let cursor = path.parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory()) refuse('BASELINE_BACKUP_PRIVATE_PATH_REQUIRED');
    if (index === parts.length - 1 && ((directory ? !info.isDirectory() : !info.isFile()) || info.mode & 0o077)) {
      refuse('BASELINE_BACKUP_PRIVATE_PATH_REQUIRED');
    }
  }
  return absolute;
}

/** Root orchestration stops the writer; this service-identity helper independently checks it. */
export function assertCommunityServiceStopped() {
  let output;
  try {
    output = execFileSync('systemctl', ['show', 'nkustudy-admin.service', '--no-pager',
      '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', SYSTEMD_PAGER: '' },
    });
  } catch { refuse('BASELINE_BACKUP_SERVICE_NOT_STOPPED'); }
  const rows = output.trim().split('\n').map(line => line.split('='));
  if (rows.some(row => row.length !== 2) || new Set(rows.map(row => row[0])).size !== rows.length) refuse('BASELINE_BACKUP_SERVICE_NOT_STOPPED');
  const state = Object.fromEntries(rows);
  if (state.ActiveState !== 'inactive' || state.MainPID !== '0' || state.ControlPID !== '0') refuse('BASELINE_BACKUP_SERVICE_NOT_STOPPED');
}

/** No HTTP, cloud upload, pruning, migration, service start or recovery activation. */
export function backupCommunitySupportBaseline({ env = process.env, assertStopped = assertCommunityServiceStopped } = {}) {
  assertStopped();
  if (env.NODE_ENV !== 'production') refuse('BASELINE_BACKUP_PRODUCTION_REQUIRED');
  // Validate every configured parent before the shared preflight reads any secret.
  const dataDir = privatePath(env.DATA_DIR, { directory: true });
  const dbPath = privatePath(env.STATE_DB_PATH);
  const adminSecretPath = privatePath(env.ADMIN_SECRET_FILE);
  const backupSecretPath = privatePath(env.BACKUP_SECRET_FILE || path.join(dataDir, 'backup-secrets.json'));
  const ledgerDirectory = privatePath(env.DELETION_LEDGER_DIR, { directory: true });
  preflightProductionRuntime(env);
  const directory = path.join(dataDir, 'private-backups');
  if (fs.existsSync(directory)) privatePath(directory, { directory: true });
  const secrets = JSON.parse(fs.readFileSync(backupSecretPath, 'utf8'));
  const password = secrets?.encryptionPassword;
  if (typeof password !== 'string' || password.length < 16) refuse('BASELINE_BACKUP_PASSWORD_NOT_CONFIGURED');
  let db;
  let snapshot;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10000 });
    db.pragma('query_only = ON');
    const deletionLedger = openRuntimeDeletionLedger({ db, dataDir, directory: ledgerDirectory });
    // Read transaction pins the table-count and serialized SQLite view. Root
    // orchestration must also keep every other JSON/SQLite writer stopped.
    db.exec('BEGIN');
    snapshot = captureRuntime({ db, dataDir, deletionLedger, requiredFiles: REQUIRED_JSON,
      extraFiles: { 'admin-secret': adminSecretPath, 'backup-secrets.json': backupSecretPath } });
    db.exec('ROLLBACK');
  } finally { db?.close(); }
  assertStopped();
  const result = saveEncryptedBackup({ snapshot, password, directory });
  // saveEncryptedBackup already verifies decryption; compare the readback to
  // the exact captured snapshot as well, without exposing any secret content.
  const restored = decryptSnapshot(fs.readFileSync(result.file), password);
  if (JSON.stringify(restored) !== JSON.stringify(snapshot)) refuse('BASELINE_BACKUP_READBACK_FAILED');
  assertStopped();
  return {
    status: 'PASS', code: 'BASELINE_RUNTIME_BACKUP_VERIFIED', file: result.file,
    filename: path.basename(result.file), sha256: result.sha256, bytes: result.bytes.length,
    createdAt: snapshot.createdAt, encrypted: true, readbackVerified: true,
    sqliteIntegrityVerified: true, sqliteTableCountsVerified: true,
    sqliteTables: Object.keys(snapshot.tables).length,
    runtimeJsonFiles: snapshot.files.filter(file => file.name.startsWith('data/') && file.name.endsWith('.json')).length,
    deletionLedgerCheckpointIncluded: snapshot.deletionLedgerHead !== null,
    authoritativeDeletionLedgerIncluded: false, externalServerConfigIncluded: false,
    externalAssetsIncluded: false, migrationApplied: false,
  };
}

export function runBaselineBackupCli({ env = process.env, assertStopped = assertCommunityServiceStopped,
  stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const result = backupCommunitySupportBaseline({ env, assertStopped });
    stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ status: 'FAIL', code: safeCodes.has(error?.code) ? error.code : 'BASELINE_BACKUP_FAILED',
      migrationApplied: false, keepServiceStopped: true }) + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write(JSON.stringify({ status: 'FAIL', code: 'BASELINE_BACKUP_NO_ARGUMENTS_ALLOWED', migrationApplied: false }) + '\n');
    process.exitCode = 1;
  } else process.exitCode = runBaselineBackupCli();
}
