import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeRuntimeDeletionLedger } from '../server/deletion-ledger.mjs';
import { decryptSnapshot } from '../server/runtime-backup.mjs';
import { backupCommunitySupportBaseline, runBaselineBackupCli } from '../scripts/backup-community-support-baseline.mjs';

const password = 'synthetic-backup-passphrase-2026';
const adminSecret = 'synthetic-admin-secret-value-0123456789';
const privateRow = 'synthetic-private-ledger-body';
const names = ['manifest', 'about', 'home', 'participate', 'links', 'footer', 'reviews', 'feedback', 'visit-stats', 'editor-settings', 'backup-settings'];

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nku-community-backup-test-')));
  fs.chmodSync(directory, 0o700);
  const dataDir = path.join(directory, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  for (const name of names) fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify({ synthetic: name }), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, '.nkustudy-data-root'), 'NKUSTUDY_RUNTIME_DATA_V1', { mode: 0o600 });
  const admin = path.join(directory, 'admin-secret'); fs.writeFileSync(admin, adminSecret, { mode: 0o600 });
  const secret = path.join(dataDir, 'backup-secrets.json');
  fs.writeFileSync(secret, JSON.stringify({ encryptionPassword: password, webdav: { synthetic: { password: 'synthetic-webdav-secret' } } }), { mode: 0o600 });
  const dbPath = path.join(directory, 'state.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
  db.exec('CREATE TABLE mp_users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); CREATE TABLE community_support_downloads(event_id TEXT PRIMARY KEY, detail TEXT); CREATE TABLE unrelated_runtime_records(id INTEGER PRIMARY KEY, detail TEXT);');
  db.prepare('INSERT INTO mp_users(name) VALUES(?)').run('synthetic account');
  db.prepare('INSERT INTO community_support_downloads VALUES(?,?)').run('synthetic-download', privateRow);
  db.prepare('INSERT INTO unrelated_runtime_records(detail) VALUES(?)').run('synthetic unrelated record');
  fs.chmodSync(dbPath, 0o600);
  const ledgerDirectory = path.join(directory, 'deletion-ledger');
  initializeRuntimeDeletionLedger({ db, dataDir, directory: ledgerDirectory });
  t.after(() => db.close()); // Synthetic fixture retained; no new cleanup workflow.
  const env = { NODE_ENV: 'production', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_SECRET_FILE: admin, BACKUP_SECRET_FILE: secret, DELETION_LEDGER_DIR: ledgerDirectory,
    PUBLIC_DIR: path.join(directory, 'public/current'), PUBLIC_RELEASES_DIR: path.join(directory, 'public/releases'),
    BACKUP_ENV_FILE: '/not-readable-root-config/admin.env', BACKUP_CADDY_FILE: '/not-readable-root-config/Caddyfile',
    BACKUP_SERVICE_FILE: '/not-readable-root-config/nkustudy-admin.service' };
  return { env, directory, dataDir, db, secret, assertStopped: () => {} };
}

test('offline backup encrypts full SQLite tables and runtime JSON then verifies exact readback', t => {
  const f = fixture(t);
  const reviewsBefore = fs.readFileSync(path.join(f.dataDir, 'reviews.json'));
  let stoppedChecks = 0;
  const result = backupCommunitySupportBaseline({ ...f, assertStopped: () => { stoppedChecks++; } });
  assert.equal(stoppedChecks, 3);
  assert.equal(result.code, 'BASELINE_RUNTIME_BACKUP_VERIFIED');
  assert.equal(result.readbackVerified, true); assert.equal(result.sqliteTableCountsVerified, true);
  assert.equal(result.deletionLedgerCheckpointIncluded, true);
  assert.equal(result.externalServerConfigIncluded, false);
  assert.equal(result.externalAssetsIncluded, false);
  const bytes = fs.readFileSync(result.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
  for (const secret of [password, adminSecret, privateRow, 'synthetic-webdav-secret']) {
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.file)).mode & 0o777, 0o700);
  const snapshot = decryptSnapshot(bytes, password);
  assert.equal(snapshot.tables.community_support_downloads, 1);
  assert.equal(snapshot.tables.unrelated_runtime_records, 1);
  assert.equal(snapshot.tables.mp_users, 1);
  assert.equal(snapshot.tables.account_deletion_runtime, 1);
  for (const name of names) assert.ok(snapshot.files.some(entry => entry.name === `data/${name}.json`));
  assert.equal(Buffer.from(snapshot.files.find(entry => entry.name === 'config/admin-secret').base64, 'base64').toString(), adminSecret);
  assert.equal(snapshot.files.some(entry => entry.name.includes('deletion-ledger.json')), false);
  assert.equal(snapshot.files.some(entry => entry.name === 'config/admin.env'), false);
  const restoreDbFile = path.join(f.directory, 'isolated-readback.sqlite');
  fs.writeFileSync(restoreDbFile, Buffer.from(snapshot.files.find(entry => entry.name === 'state.sqlite').base64, 'base64'), { mode: 0o600 });
  const restored = new Database(restoreDbFile);
  try {
    assert.equal(restored.prepare('SELECT detail FROM community_support_downloads').get().detail, privateRow);
    assert.equal(restored.prepare('SELECT detail FROM unrelated_runtime_records').get().detail, 'synthetic unrelated record');
  } finally { restored.close(); }
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir, 'reviews.json')), reviewsBefore);
});

test('missing or short password never creates a plaintext or encrypted archive', t => {
  const f = fixture(t);
  for (const encryptionPassword of [undefined, '', 'short']) {
    fs.writeFileSync(f.secret, JSON.stringify({ encryptionPassword }), { mode: 0o600 });
    assert.throws(() => backupCommunitySupportBaseline(f), { code: 'BASELINE_BACKUP_PASSWORD_NOT_CONFIGURED' });
    assert.equal(fs.existsSync(path.join(f.dataDir, 'private-backups')), false);
  }
});

test('active service is refused before reading runtime paths', () => {
  let writes = '';
  const result = runBaselineBackupCli({ env: {},
    assertStopped: () => { throw Object.assign(new Error('sensitive diagnostic must not leak'), { code: 'BASELINE_BACKUP_SERVICE_NOT_STOPPED' }); },
    stdout: text => { writes += text; }, stderr: text => { writes += text; } });
  assert.equal(result, 1);
  assert.equal(JSON.parse(writes).code, 'BASELINE_BACKUP_SERVICE_NOT_STOPPED');
  assert.equal(writes.includes('sensitive diagnostic'), false);
});

test('service returning during snapshot fails before any archive is saved', t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => backupCommunitySupportBaseline({ ...f, assertStopped: () => {
    if (++calls === 2) throw Object.assign(new Error('not stopped'), { code: 'BASELINE_BACKUP_SERVICE_NOT_STOPPED' });
  } }), { code: 'BASELINE_BACKUP_SERVICE_NOT_STOPPED' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'private-backups')), false);
});

test('invalid JSON and missing required runtime files return sanitized failure without archive', t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.dataDir, 'reviews.json'), path.join(f.directory, 'reviews-preserved.json'));
  let output = '';
  assert.equal(runBaselineBackupCli({ ...f, stdout: text => { output += text; }, stderr: text => { output += text; } }), 1);
  assert.equal(JSON.parse(output).code, 'BASELINE_BACKUP_FAILED');
  assert.equal(output.includes(f.directory), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'private-backups')), false);
});

test('backup secret symlink and public permissions are refused', t => {
  const f = fixture(t);
  fs.chmodSync(f.secret, 0o644);
  assert.throws(() => backupCommunitySupportBaseline(f), { code: 'BASELINE_BACKUP_PRIVATE_PATH_REQUIRED' });
  fs.chmodSync(f.secret, 0o600);
  fs.renameSync(f.secret, path.join(f.directory, 'preserved-secret.json'));
  fs.symlinkSync(path.join(f.directory, 'preserved-secret.json'), f.secret);
  assert.throws(() => backupCommunitySupportBaseline(f), { code: 'BASELINE_BACKUP_PRIVATE_PATH_REQUIRED' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'private-backups')), false);
});

test('bad secret JSON and missing S5 authority never expose raw values or declare backup success', t => {
  const f = fixture(t);
  fs.writeFileSync(f.secret, '{"encryptionPassword":"synthetic-private-unfinished', { mode: 0o600 });
  let output = '';
  const capture = text => { output += text; };
  assert.equal(runBaselineBackupCli({ ...f, stdout: capture, stderr: capture }), 1);
  assert.equal(JSON.parse(output).code, 'BASELINE_BACKUP_FAILED');
  assert.equal(output.includes('synthetic-private-unfinished'), false);
  fs.writeFileSync(f.secret, JSON.stringify({ encryptionPassword: password }), { mode: 0o600 });
  const env = { ...f.env }; delete env.DELETION_LEDGER_DIR;
  assert.throws(() => backupCommunitySupportBaseline({ ...f, env }), { code: 'BASELINE_BACKUP_PRIVATE_PATH_REQUIRED' });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'private-backups')), false);
});
