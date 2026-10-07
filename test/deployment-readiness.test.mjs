import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { deploymentReadiness, validateSyntheticLocalhostOrigin } from '../server/deployment-readiness.mjs';
import { UserSecurityLogStore } from '../server/user-security-log-store.mjs';
import { AdminAccountsStore } from '../server/admin-accounts-store.mjs';
import { LawEnforcementLogStore } from '../server/law-enforcement-store.mjs';
import { initializeRuntimeDeletionLedger } from '../server/deletion-ledger.mjs';
import { ensureAccountDeletionJobs } from '../server/account-deletion-service.mjs';

const cli = path.resolve(import.meta.dirname, '../scripts/check-deployment-readiness.mjs');
const password = 's6-synthetic-backup-password-do-not-export';
const userData = 's6-synthetic-user-content-do-not-export';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nku-s6-readiness-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const stateDir = path.join(directory, 'state');
  const configDir = path.join(directory, 'configuration');
  const publishDir = path.join(directory, 'publish');
  const releases = path.join(publishDir, 'releases');
  const active = path.join(releases, 'release-123456-abcd');
  const logs = path.join(directory, 'entry-logs');
  const entryArchive = path.join(directory, 'entry-archive');
  const ledgerDirectory = path.join(directory, 'independent-ledger');
  for (const file of [dataDir, stateDir, configDir, logs, entryArchive]) fs.mkdirSync(file, { mode: 0o700 });
  for (const file of [publishDir, releases, active]) fs.mkdirSync(file, { mode: 0o755 });
  fs.symlinkSync(active, path.join(publishDir, 'current'));
  const write = (file, value, mode = 0o600) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  write(path.join(dataDir, '.nkustudy-data-root'), 'NKUSTUDY_RUNTIME_DATA_V1\n');
  for (const name of ['manifest', 'about', 'home', 'participate', 'links', 'footer', 'reviews', 'feedback', 'visit-stats', 'editor-settings']) write(path.join(dataDir, `${name}.json`), { synthetic: userData });
  write(path.join(dataDir, 'backup-settings.json'), { r2DataBackup: false, webdavEnabled: false, includeCourseFiles: false, destinations: [] });
  write(path.join(dataDir, 'backup-secrets.json'), { encryptionPassword: password });
  const env = {
    NODE_ENV: 'production', DATA_DIR: dataDir, STATE_DB_PATH: path.join(stateDir, 'state.sqlite'),
    ADMIN_SECRET_FILE: path.join(configDir, 'admin-secret'),
    ADMIN_ORIGIN: 'https://s6-admin.invalid', PUBLIC_RESOURCE_ORIGIN: 'https://s6-resources.invalid',
    TRUSTED_PROXIES: '127.0.0.1/32,::1/128', PUBLIC_DIR: path.join(publishDir, 'current'),
    PUBLIC_RELEASES_DIR: releases, DELETION_LEDGER_DIR: ledgerDirectory,
    S2_ACCESS_LOG: path.join(logs, 'access.jsonl'), ENTRY_LOG_ARCHIVE_DIR: entryArchive,
    DEPLOYMENT_MIN_FREE_BYTES: '1', BACKUP_ENV_FILE: path.join(configDir, 'admin.env'),
    BACKUP_CADDY_FILE: path.join(configDir, 'Caddyfile'), BACKUP_SERVICE_FILE: path.join(configDir, 'service.conf'),
  };
  write(env.ADMIN_SECRET_FILE, 's6-synthetic-admin-secret-do-not-export'.repeat(2));
  write(env.BACKUP_ENV_FILE, 'SYNTHETIC_PRIVATE_ENV=do-not-export\n');
  write(env.BACKUP_CADDY_FILE, 'synthetic-not-attestation', 0o644);
  write(env.BACKUP_SERVICE_FILE, 'synthetic-not-attestation', 0o644);
  write(env.S2_ACCESS_LOG, JSON.stringify({ synthetic: userData }));
  const stores = [
    new UserSecurityLogStore({ dbPath: env.STATE_DB_PATH, journalDir: path.join(dataDir, 'log-queue', 'user'), archiveDir: path.join(dataDir, 'security-archive') }),
    new AdminAccountsStore({ dbPath: env.STATE_DB_PATH, journalDir: path.join(dataDir, 'log-queue', 'admin'), archiveDir: path.join(dataDir, 'audit-archive') }),
    new LawEnforcementLogStore({ dbPath: env.STATE_DB_PATH, journalDir: path.join(dataDir, 'log-queue', 'law'), archiveDir: path.join(dataDir, 'law-archive') }),
  ];
  // Actual store constructors provide the schema; the checker never creates it.
  stores[0].record({ action: 's6.synthetic', detail: userData });
  stores[1].audit({ username: 's6-synthetic-admin', action: 's6.synthetic', detail: userData });
  stores[2].record({ queriedBy: 's6-synthetic-admin', queryType: 'synthetic', queryValue: userData });
  for (const store of stores) store.close();
  for (const folder of ['security-archive', 'law-archive']) fs.mkdirSync(path.join(dataDir, folder), { recursive: true, mode: 0o700 });
  const db = new Database(env.STATE_DB_PATH);
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE mp_users (id INTEGER PRIMARY KEY, created_at INTEGER)');
  ensureAccountDeletionJobs(db);
  const ledger = initializeRuntimeDeletionLedger({ db, dataDir, directory: ledgerDirectory, lineage: 's6-synthetic-private-lineage', now: 1000 });
  db.close();
  return { directory, dataDir, configDir, env, write, ledger, active };
}
function byId(report, id) { return report.checks.find(item => item.id === id); }
function noLeaks(output, example) {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  for (const forbidden of [example.directory, password, userData, 's6-synthetic-admin-secret-do-not-export',
    'SYNTHETIC_PRIVATE_ENV', 's6-synthetic-private-lineage', 's6-admin.invalid', 's6-resources.invalid']) assert.equal(text.includes(forbidden), false);
}
function tree(directory) {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return { name, mode: stat.mode, mtime: stat.mtimeMs,
      content: stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? tree(file)
        : createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
}
function mutateDb(example, operation) {
  const db = new Database(example.env.STATE_DB_PATH);
  try { operation(db); } finally { db.close(); }
}
function runCli(env, args = []) {
  return spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('S6 CLI handles help, invalid arguments and production import failures without private stacks', () => {
  const incomplete = { NODE_ENV: 'production' };
  const help = runCli(incomplete, ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage:/);

  const invalid = runCli(incomplete, ['--token=s6-synthetic-private-argument']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr, '');
  assert.equal(JSON.parse(invalid.stdout).checks[0].code, 'UNSUPPORTED_ARGUMENTS');
  assert.equal(invalid.stdout.includes('s6-synthetic-private-argument'), false);

  for (const env of [incomplete, { ...incomplete, DATA_DIR: path.resolve(import.meta.dirname, '..') }]) {
    for (const args of [[], ['--synthetic-localhost-origin=http://127.0.0.1:8787']]) {
      const result = runCli(env, args);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout);
      assert.equal(report.localChecksPassed, false);
      assert.equal(report.productionReady, false);
      assert.equal(report.ops20Accepted, false);
      assert.equal(report.checks[0].code, 'READINESS_UNAVAILABLE');
      const root = path.resolve(import.meta.dirname, '..');
      assert.equal(result.stdout.includes(root) || result.stdout.includes(encodeURI(root)), false);
    }
  }
});

test('S6 local readiness reuses real schemas and remains read-only without claiming production acceptance', async t => {
  const example = fixture(t), before = tree(example.directory);
  const report = await deploymentReadiness({ env: example.env });
  assert.equal(report.localStaticReady, true, JSON.stringify(report.checks.filter(item => item.scope === 'static' && item.status !== 'pass' && item.status !== 'skip')));
  assert.equal(report.localChecksPassed, true);
  assert.equal(report.syntheticReady, null);
  assert.equal(report.productionReady, false);
  assert.equal(report.ops20Accepted, false);
  assert.ok(report.checks.filter(item => item.scope === 'production').every(item => item.status === 'pending'));
  assert.equal(byId(report, 'backup.destination.r2').code, 'DESTINATION_DISABLED');
  assert.deepEqual(tree(example.directory), before);
  noLeaks(report, example);
  const result = runCli(example.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), report);
  assert.deepEqual(tree(example.directory), before);
  noLeaks(result.stdout, example);
});

test('S6 missing tables, event columns and idempotent event indexes fail without repairing the database', async t => {
  const example = fixture(t);
  for (const table of ['user_security_logs', 'admin_audit_log', 'law_enforcement_logs']) {
    mutateDb(example, db => db.exec(`ALTER TABLE ${table} RENAME TO saved_${table}`));
    const before = tree(example.directory);
    let report = await deploymentReadiness({ env: example.env });
    assert.equal(report.localStaticReady, false);
    assert.equal(byId(report, `logs.schema.${table}`).code, 'LOG_TABLE_MISSING');
    assert.deepEqual(tree(example.directory), before);
    mutateDb(example, db => db.exec(`ALTER TABLE saved_${table} RENAME TO ${table}`));
    report = await deploymentReadiness({ env: example.env });
    assert.equal(report.localStaticReady, true);
  }
  mutateDb(example, db => db.exec('DROP INDEX user_security_logs_event_idx'));
  let report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'logs.schema.user_security_logs').code, 'LOG_EVENT_INDEX_MISSING');
  mutateDb(example, db => db.exec('ALTER TABLE user_security_logs DROP COLUMN event_id'));
  report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'logs.schema.user_security_logs').code, 'LOG_COLUMNS_MISSING');
  noLeaks(report, example);
});

test('S6 read-only archives, journals and missing entry configuration fail, then recover after operator correction', async t => {
  const example = fixture(t);
  for (const [folder, id] of [['security-archive', 'logs.user.archive_directory'], ['audit-archive', 'logs.admin.archive_directory'],
    ['law-archive', 'logs.law.archive_directory'], ['log-queue/user', 'logs.user.queue_directory']]) {
    const target = path.join(example.dataDir, folder);
    fs.chmodSync(target, 0o500);
    const before = tree(example.directory);
    const report = await deploymentReadiness({ env: example.env });
    assert.equal(report.localStaticReady, false);
    assert.equal(byId(report, id).code, 'NOT_WRITABLE');
    assert.equal(fs.statSync(target).mode & 0o777, 0o500);
    assert.deepEqual(tree(example.directory), before);
    fs.chmodSync(target, 0o700);
    assert.equal((await deploymentReadiness({ env: example.env })).localStaticReady, true);
  }
  for (const [field, id] of [['S2_ACCESS_LOG', 'entry_log.file'], ['ENTRY_LOG_ARCHIVE_DIR', 'entry_log.archive_directory'],
    ['DATA_DIR', 'runtime.data_path'], ['STATE_DB_PATH', 'runtime.state_path'], ['ADMIN_ORIGIN', 'network.admin_origin'],
    ['TRUSTED_PROXIES', 'network.trusted_proxies'], ['DEPLOYMENT_MIN_FREE_BYTES', 'capacity.budget']]) {
    const env = { ...example.env }; delete env[field];
    const report = await deploymentReadiness({ env });
    assert.equal(report.localStaticReady, false, field);
    assert.equal(byId(report, id).status, 'fail', field);
    noLeaks(report, example);
  }
  const result = runCli({ ...example.env, S2_ACCESS_LOG: '' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
});

test('S6 restoration quarantine and queued events are never consumed or cleared by readiness', async t => {
  const example = fixture(t);
  for (const directory of [example.dataDir, path.dirname(example.env.STATE_DB_PATH)]) {
    const marker = path.join(directory, '.restore-quarantine'); example.write(marker, 'synthetic quarantine');
    const before = tree(example.directory);
    const report = await deploymentReadiness({ env: example.env });
    assert.equal(report.localChecksPassed, false);
    assert.equal(byId(report, 'runtime.restore_quarantine').code, 'RESTORE_QUARANTINE_PRESENT');
    assert.deepEqual(tree(example.directory), before);
    fs.unlinkSync(marker);
  }
  const queueFile = path.join(example.dataDir, 'log-queue', 'user', 'synthetic-pending.json');
  example.write(queueFile, { privateRow: userData });
  const before = tree(example.directory);
  const report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'logs.user.queue_drained').code, 'LOG_QUEUE_NOT_EMPTY');
  assert.equal(report.localStaticReady, false);
  assert.deepEqual(tree(example.directory), before);
  noLeaks(report, example);
});

test('S6 bound deletion ledgers are mandatory, independent and matched, without bootstrap or permission repair', async t => {
  const example = fixture(t);
  const ledgerFile = example.ledger.filePath;
  for (const env of [{ ...example.env, DELETION_LEDGER_DIR: '' },
    { ...example.env, DELETION_LEDGER_DIR: path.join(example.directory, 'missing-ledger') },
    { ...example.env, DELETION_LEDGER_DIR: example.dataDir },
    { ...example.env, DELETION_LEDGER_DIR: path.dirname(example.env.PUBLIC_DIR) }]) {
    const before = tree(example.directory);
    const report = await deploymentReadiness({ env });
    assert.equal(report.localStaticReady, false);
    assert.equal(byId(report, 'deletion.ledger_directory').status, 'fail');
    assert.deepEqual(tree(example.directory), before);
    noLeaks(report, example);
  }
  fs.renameSync(ledgerFile, `${ledgerFile}.saved`);
  let report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'deletion.bound_ledger').code, 'PATH_MISSING');
  assert.equal(fs.existsSync(ledgerFile), false);
  fs.renameSync(`${ledgerFile}.saved`, ledgerFile);
  fs.chmodSync(ledgerFile, 0o640);
  report = await deploymentReadiness({ env: example.env });
  assert.equal(report.localStaticReady, false);
  assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o640);
  fs.chmodSync(ledgerFile, 0o600);
  mutateDb(example, db => db.exec("UPDATE account_deletion_runtime SET lineage='s6-other-private-lineage'"));
  report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'deletion.bound_ledger').code, 'LEDGER_CHECK_FAILED');
  assert.equal(JSON.stringify(report).includes('s6-other-private-lineage'), false);
  mutateDb(example, db => db.exec('DROP TABLE account_deletion_runtime'));
  report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'deletion.runtime_binding').code, 'LEDGER_BINDING_REQUIRED');
  noLeaks(report, example);
});

test('S6 unknown ACLs, missing WAL sidecars and insufficient budget remain incomplete without created files', async t => {
  const example = fixture(t);
  let report = await deploymentReadiness({ env: example.env, platform: 'win32' });
  assert.equal(byId(report, 'permissions.platform').status, 'pending');
  assert.equal(report.localStaticReady, false);
  report = await deploymentReadiness({ env: { ...example.env, DEPLOYMENT_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) } });
  assert.equal(report.localStaticReady, false);
  assert.equal(byId(report, 'capacity.runtime').code, 'CAPACITY_BELOW_BUDGET');
  mutateDb(example, db => db.pragma('journal_mode = WAL'));
  assert.equal(fs.existsSync(example.env.STATE_DB_PATH + '-shm'), false);
  const before = tree(example.directory);
  report = await deploymentReadiness({ env: example.env });
  assert.equal(byId(report, 'state.readonly_database').code, 'DATABASE_WAL_SIDECARS_REQUIRED');
  assert.equal(byId(report, 'state.readonly_database').status, 'pending');
  assert.equal(report.localStaticReady, false);
  assert.deepEqual(tree(example.directory), before);
  const writer = new Database(example.env.STATE_DB_PATH);
  t.after(() => writer.close());
  writer.exec("UPDATE account_deletion_runtime SET initialized_at=1001");
  for (const suffix of ['-wal', '-shm']) fs.chmodSync(example.env.STATE_DB_PATH + suffix, 0o600);
  const main = fs.readFileSync(example.env.STATE_DB_PATH);
  const wal = fs.readFileSync(example.env.STATE_DB_PATH + '-wal');
  report = await deploymentReadiness({ env: example.env });
  assert.equal(report.localStaticReady, true, JSON.stringify(report.checks.filter(item => item.status === 'fail')));
  assert.deepEqual(fs.readFileSync(example.env.STATE_DB_PATH), main);
  assert.deepEqual(fs.readFileSync(example.env.STATE_DB_PATH + '-wal'), wal);
  assert.ok(report.limitations.includes('SQLITE_WAL_READ_LOCKS_MAY_TOUCH_SHM_METADATA'));
});

test('S6 default checks do not access HTTP, cloud destinations or notifications', async t => {
  const example = fixture(t);
  const originalHttp = http.get, originalHttps = https.get, originalFetch = globalThis.fetch;
  let requests = 0;
  const blocked = () => { requests++; throw new Error('synthetic forbidden outbound request'); };
  http.get = blocked; https.get = blocked; globalThis.fetch = blocked;
  try {
    const report = await deploymentReadiness({ env: example.env });
    assert.equal(report.localStaticReady, true);
    assert.equal(requests, 0);
    assert.equal(report.syntheticRequested, false);
  } finally { http.get = originalHttp; https.get = originalHttps; globalThis.fetch = originalFetch; }
});

test('S6 private/public separation, explicit network boundaries and unavailable features cannot falsely pass', async t => {
  const example = fixture(t);
  for (const [overrides, id, expected] of [
    [{ ADMIN_HOST: '0.0.0.0' }, 'network.listener', 'LISTENER_NOT_LOOPBACK'],
    [{ ADMIN_PORT: '0' }, 'network.listener', 'LISTENER_PORT_INVALID'],
    [{ ADMIN_ORIGIN: 'http://private.invalid' }, 'network.admin_origin', 'ORIGIN_INVALID'],
    [{ TRUSTED_PROXIES: '0.0.0.0/0' }, 'network.trusted_proxies', 'TRUSTED_PROXIES_INVALID'],
    [{ PUBLIC_DIR: path.join(example.dataDir, 'current'), PUBLIC_RELEASES_DIR: path.join(example.dataDir, 'releases') },
      'runtime.private_public_layout', 'PRIVATE_STORAGE_INSIDE_PUBLICATION'],
    [{ ENTRY_LOG_ARCHIVE_DIR: path.dirname(example.env.S2_ACCESS_LOG) }, 'entry_log.archive_directory', 'ENTRY_ARCHIVE_NOT_INDEPENDENT'],
    [{ DEPLOYMENT_MIN_FREE_BYTES: 'NaN' }, 'capacity.budget', 'CAPACITY_BUDGET_INVALID'],
  ]) {
    const report = await deploymentReadiness({ env: { ...example.env, ...overrides } });
    assert.equal(report.localStaticReady, false);
    assert.equal(byId(report, id).code, expected);
    noLeaks(report, example);
  }
  const report = await deploymentReadiness({ env: example.env, platform: 'unsupported-platform' });
  assert.equal(byId(report, 'permissions.platform').status, 'pending');
  assert.equal(report.localStaticReady, false);
  for (const nodeVersion of ['20.99.0', '22.11.0', '22.private.0']) {
    assert.equal(byId(await deploymentReadiness({ env: example.env, nodeVersion }), 'runtime.node_version').code, 'NODE_VERSION_UNSUPPORTED');
  }
  fs.chmodSync(example.env.ENTRY_LOG_ARCHIVE_DIR, 0o500);
  assert.equal(byId(await deploymentReadiness({ env: example.env }), 'entry_log.archive_directory').code, 'NOT_WRITABLE');
  fs.chmodSync(example.env.ENTRY_LOG_ARCHIVE_DIR, 0o700);
  fs.unlinkSync(example.env.PUBLIC_DIR);
  assert.equal(byId(await deploymentReadiness({ env: example.env }), 'publication.active_release').code, 'STATIC_PUBLICATION_MISSING');
  fs.symlinkSync(example.active, example.env.PUBLIC_DIR);
  example.write(path.join(example.dataDir, 'backup-settings.json'), { r2DataBackup: true, webdavEnabled: false, includeCourseFiles: false, destinations: [] });
  const remote = await deploymentReadiness({ env: example.env });
  assert.equal(remote.localStaticReady, false, 'enabled but incomplete remote configuration still fails');
  assert.equal(byId(remote, 'backup.destination.r2').status, 'fail');
  assert.equal(byId(remote, 'production.remote_backup_permissions').status, 'pending');
});

test('S6 synthetic origin requires explicit literal loopback and rejects URLs or unsupported CLI arguments without echoing input', async t => {
  const example = fixture(t);
  assert.equal(validateSyntheticLocalhostOrigin('http://127.0.0.1:80'), 'http://127.0.0.1');
  assert.equal(validateSyntheticLocalhostOrigin('http://[::1]:80/'), 'http://[::1]');
  assert.equal(validateSyntheticLocalhostOrigin('http://127.0.0.1:65535'), 'http://127.0.0.1:65535');
  for (const value of ['https://127.0.0.1:8787', 'http://localhost:8787', 'http://production.invalid:8787',
    'http://127.0.0.1:8787/private?token=do-not-export', 'http://user:do-not-export@127.0.0.1:8787',
    'http://127.0.0.1:8787#private', 'http://127.0.0.1:65536', 'http://2130706433:8787',
    'http://127.0.0.1', 'http://[::1]', 'http://127.0.0.1:0']) {
    assert.throws(() => validateSyntheticLocalhostOrigin(value));
    const report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: value });
    assert.equal(report.localStaticReady, true);
    assert.equal(report.syntheticReady, false);
    assert.equal(report.localChecksPassed, false);
    assert.equal(JSON.stringify(report).includes(value), false);
  }
  for (const args of [['--production-origin=https://private.invalid/token'], ['--token=do-not-export'],
    ['--synthetic-localhost-origin=http://127.0.0.1:8787', '--synthetic-localhost-origin=http://127.0.0.1:8788']]) {
    const result = runCli(example.env, args);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    assert.equal(JSON.stringify(result.stdout).includes('do-not-export'), false);
    assert.equal(result.stdout.includes('private.invalid'), false);
  }
});

test('S6 explicit synthetic GET probe checks uncached health and unauthenticated private access without printing bodies', async t => {
  const example = fixture(t);
  const requests = [];
  let health = { code: 0, data: { status: 'ok', accountDeletion: { configured: true, pending: 0, ledgerSequence: 0 } } };
  let redirect = false, cache = 'no-store';
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    const status = redirect ? 302 : request.url === '/api/v1/health' ? 200 : 401;
    response.writeHead(status, { 'cache-control': cache, 'x-content-type-options': 'nosniff',
      ...(redirect ? { location: 'https://never-contact.invalid/private' } : {}) });
    response.end(request.url === '/api/v1/health' ? JSON.stringify(health) : JSON.stringify({ error: userData }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(report.localStaticReady, true);
  assert.equal(report.syntheticReady, true);
  assert.equal(report.productionReady, false);
  assert.deepEqual(requests, [{ path: '/api/v1/health', authorization: undefined, cookie: undefined },
    { path: '/api/v1/me', authorization: undefined, cookie: undefined }]);
  noLeaks(report, example);
  health.data.accountDeletion.pending = 1;
  report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(report.syntheticReady, false);
  assert.equal(byId(report, 'synthetic.health').code, 'SYNTHETIC_DELETION_PENDING');
  health.data.accountDeletion = { configured: false };
  report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(byId(report, 'synthetic.health').code, 'SYNTHETIC_DELETION_UNAVAILABLE');
  redirect = true;
  report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(byId(report, 'synthetic.health').code, 'SYNTHETIC_RESPONSE_INVALID');
  assert.equal(requests.length, 8, 'each run sends only the two original GETs; redirects are never followed');
  redirect = false; cache = 'public, max-age=60';
  health = { code: 0, data: { status: 'ok', accountDeletion: { configured: true, pending: 0, ledgerSequence: 0 } } };
  report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(byId(report, 'synthetic.health').code, 'SYNTHETIC_CACHE_INVALID');
  assert.equal(byId(report, 'synthetic.unauthenticated_me').code, 'SYNTHETIC_CACHE_INVALID');
  cache = 'no-store'; health.data.privateExample = userData.repeat(1000);
  report = await deploymentReadiness({ env: example.env, syntheticLocalhostOrigin: origin });
  assert.equal(byId(report, 'synthetic.health').code, 'SYNTHETIC_RESPONSE_TOO_LARGE');
  assert.equal(report.syntheticReady, false);
  noLeaks(report, example);
});
