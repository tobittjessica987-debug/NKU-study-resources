// Read-only operator checks. Never import admin-server or instantiate a store:
// their constructors initialize tables, replay queues and normalize permissions.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { backupPreflight } from './backup-preflight.mjs';
import { projectRoot, preflightProductionRuntime, resolveAdminSecretPath, resolveDataDir, resolveStateDbPath,
  resolvePublicDir, resolvePublicReleasesDir } from './runtime-config.mjs';
import { trustedProxyRules } from './client-identity.mjs';
import { StaticReleasePublisher } from './static-release-publisher.mjs';
import { assertIndependentLedgerDirectory, openRuntimeDeletionLedger,
  readRuntimeDeletionBinding } from './deletion-ledger.mjs';

const logColumns = Object.freeze({
  user_security_logs: ['id', 'at', 'user_id', 'action', 'target_type', 'target_id', 'path', 'ip', 'ip_hash', 'user_agent', 'result', 'detail', 'event_id'],
  admin_audit_log: ['id', 'at', 'username', 'action', 'method', 'path', 'status', 'target', 'detail', 'ip', 'user_agent', 'event_id'],
  law_enforcement_logs: ['id', 'at', 'queried_by', 'query_type', 'query_value', 'exported', 'result_summary', 'event_id'],
});
const ownCodes = new Set([
  'CONFIGURATION_REQUIRED', 'PRODUCTION_ENV_REQUIRED', 'RUNTIME_PREFLIGHT_FAILED',
  'PATH_REQUIRED', 'PATH_NOT_ABSOLUTE', 'PATH_MISSING', 'PATH_INSIDE_RELEASE', 'PRIVATE_STORAGE_INSIDE_PUBLICATION',
  'SYMLINK_REFUSED', 'UNSAFE_PARENT', 'DIRECTORY_REQUIRED', 'REGULAR_FILE_REQUIRED',
  'PRIVATE_PERMISSIONS_REQUIRED', 'WRITABLE_CONFIGURATION_REFUSED', 'NOT_WRITABLE',
  'RESTORE_QUARANTINE_PRESENT', 'ORIGIN_INVALID', 'LISTENER_NOT_LOOPBACK',
  'LISTENER_PORT_INVALID', 'TRUSTED_PROXIES_INVALID', 'NODE_VERSION_UNSUPPORTED',
  'STATIC_PUBLICATION_MISSING', 'STATIC_PUBLICATION_INVALID', 'DATABASE_OPEN_FAILED',
  'DATABASE_INTEGRITY_FAILED', 'DATABASE_RECOVERY_REQUIRED', 'LOG_TABLE_MISSING',
  'LOG_COLUMNS_MISSING', 'LOG_EVENT_INDEX_MISSING', 'LOG_QUEUE_NOT_EMPTY',
  'ENTRY_ARCHIVE_NOT_INDEPENDENT', 'LEDGER_BINDING_REQUIRED', 'LEDGER_BINDING_INVALID',
  'LEDGER_CHECK_FAILED', 'LEDGER_NOT_INDEPENDENT', 'DELETION_JOBS_TABLE_MISSING',
  'DELETION_JOBS_COLUMNS_MISSING', 'CAPACITY_BUDGET_REQUIRED', 'CAPACITY_BUDGET_INVALID',
  'CAPACITY_BELOW_BUDGET', 'SYNTHETIC_ORIGIN_INVALID', 'SYNTHETIC_REQUEST_FAILED',
  'SYNTHETIC_RESPONSE_TOO_LARGE', 'SYNTHETIC_RESPONSE_INVALID', 'SYNTHETIC_CACHE_INVALID',
  'SYNTHETIC_HEADERS_INVALID', 'SYNTHETIC_DELETION_UNAVAILABLE', 'SYNTHETIC_DELETION_PENDING',
]);
const pendingCodes = new Set(['CAPACITY_UNSUPPORTED', 'WINDOWS_ACL_UNVERIFIED', 'PLATFORM_UNSUPPORTED', 'DATABASE_WAL_SIDECARS_REQUIRED']);
const refuse = code => { throw Object.assign(new Error('Deployment readiness check failed'), { readinessCode: code }); };
const within = (root, target) => {
  const relative = path.relative(root.normalize('NFC').toLowerCase(), target.normalize('NFC').toLowerCase());
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
function absolute(value) {
  if (typeof value !== 'string' || !value) refuse('PATH_REQUIRED');
  if (!path.isAbsolute(value) || value.includes('\0')) refuse('PATH_NOT_ABSOLUTE');
  return path.resolve(value);
}
function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function inspect(file, { directory = false, privateMode = true, writable = false, platform } = {}) {
  const absoluteFile = absolute(file);
  let current = path.parse(absoluteFile).root;
  const parts = absoluteFile.slice(current.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(current);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) refuse('SYMLINK_REFUSED');
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) refuse('DIRECTORY_REQUIRED');
      if (platform !== 'win32' && (stat.mode & 0o022) && !(stat.mode & 0o1000)) refuse('UNSAFE_PARENT');
    }
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) refuse(directory ? 'DIRECTORY_REQUIRED' : 'REGULAR_FILE_REQUIRED');
  if (platform === 'win32') refuse('WINDOWS_ACL_UNVERIFIED');
  if (privateMode && (stat.mode & 0o077)) refuse('PRIVATE_PERMISSIONS_REQUIRED');
  if (!privateMode && (stat.mode & 0o022)) refuse('WRITABLE_CONFIGURATION_REFUSED');
  // access(W_OK) alone can pass for privileged operators on a read-only mode.
  if (writable && !(stat.mode & 0o222)) refuse('NOT_WRITABLE');
  fs.accessSync(absoluteFile, fs.constants.R_OK | (directory ? fs.constants.X_OK : 0) | (writable ? fs.constants.W_OK : 0));
  return stat;
}
function httpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { refuse('ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') refuse('ORIGIN_INVALID');
}
function sqliteHeader(file) {
  const bytes = Buffer.alloc(20);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') refuse('DATABASE_OPEN_FAILED');
    return bytes[18] === 2 || bytes[19] === 2;
  } finally { fs.closeSync(descriptor); }
}
function tableColumns(db, table, missingCode, columnsCode, expected) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) refuse(missingCode);
  const columns = db.pragma(`table_info(${table})`).map(column => column.name);
  if (expected.some(name => !columns.includes(name))) refuse(columnsCode);
}
function eventIndex(db, table) {
  const safe = value => `"${String(value).replaceAll('"', '""')}"`;
  if (!db.pragma(`index_list(${table})`).some(index => index.unique && !index.partial
    && db.pragma(`index_info(${safe(index.name)})`).map(column => column.name).join(',') === 'event_id')) refuse('LOG_EVENT_INDEX_MISSING');
}

/** This argument is an explicit assertion that the target is a synthetic service.
 * Only literal loopback HTTP origins are supported; no DNS, redirects or cookies. */
export function validateSyntheticLocalhostOrigin(value) {
  const match = typeof value === 'string' && /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match || Number(match[1]) > 65535) refuse('SYNTHETIC_ORIGIN_INVALID');
  const url = new URL(value);
  // URL normalizes an explicitly supplied default port 80 to an empty .port.
  return url.origin;
}
function syntheticGet(origin, route, body = false) {
  return new Promise((resolve, reject) => {
    let deadline;
    const finish = (error, value) => {
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const request = http.get(new URL(route, origin), { agent: false, headers: {
      'User-Agent': 'NKUStudy-S6-synthetic-readiness', 'If-None-Match': '"s6-synthetic-old-etag"',
    } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8192) {
          finish(Object.assign(new Error('Synthetic response rejected'), { readinessCode: 'SYNTHETIC_RESPONSE_TOO_LARGE' }));
          request.destroy();
        } else if (body) chunks.push(chunk);
      });
      response.on('error', () => finish(Object.assign(new Error('Synthetic response failed'), { readinessCode: 'SYNTHETIC_REQUEST_FAILED' })));
      response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers,
        ...(body ? { body: Buffer.concat(chunks).toString('utf8') } : {}) }));
    });
    deadline = setTimeout(() => {
      finish(Object.assign(new Error('Synthetic request timed out'), { readinessCode: 'SYNTHETIC_REQUEST_FAILED' }));
      request.destroy();
    }, 3000);
    request.on('error', () => finish(Object.assign(new Error('Synthetic request failed'), { readinessCode: 'SYNTHETIC_REQUEST_FAILED' })));
  });
}

export async function deploymentReadiness({ env = process.env, platform = process.platform,
  nodeVersion = process.versions.node, syntheticLocalhostOrigin } = {}) {
  const checks = [];
  const check = async (id, operation, { scope = 'static', skip = false, success = 'CHECK_PASSED', failure = 'UNREADABLE_OR_UNSAFE' } = {}) => {
    if (skip) { checks.push({ id, scope, status: 'pending', code: 'DEPENDENCY_UNAVAILABLE' }); return; }
    try {
      const value = await operation();
      checks.push({ id, scope, status: 'pass', code: success });
      return value;
    } catch (error) {
      const proposed = error?.readinessCode;
      const code = ownCodes.has(proposed) || pendingCodes.has(proposed) ? proposed : error?.code === 'ENOENT' ? 'PATH_MISSING' : failure;
      checks.push({ id, scope, status: pendingCodes.has(code) ? 'pending' : 'fail', code });
    }
  };
  await check('runtime.production_environment', () => { if (env.NODE_ENV !== 'production') refuse('PRODUCTION_ENV_REQUIRED'); });
  await check('runtime.node_version', () => {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(nodeVersion))) refuse('NODE_VERSION_UNSUPPORTED');
    const [major, minor] = String(nodeVersion).split('.').map(Number);
    if (!Number.isInteger(major) || major < 22 || major === 22 && minor < 12) refuse('NODE_VERSION_UNSUPPORTED');
  });
  await check('permissions.platform', () => {
    if (platform === 'win32') refuse('WINDOWS_ACL_UNVERIFIED');
    if (!['linux', 'darwin'].includes(platform)) refuse('PLATFORM_UNSUPPORTED');
  });
  const strictEnv = { ...env, NODE_ENV: 'production' };
  const dataDir = await check('runtime.data_path', () => resolveDataDir(strictEnv), { failure: 'CONFIGURATION_REQUIRED' });
  const stateDbPath = await check('runtime.state_path', () => resolveStateDbPath(strictEnv), { failure: 'CONFIGURATION_REQUIRED' });
  const publicDir = await check('runtime.public_path', () => resolvePublicDir(strictEnv), { failure: 'CONFIGURATION_REQUIRED' });
  const releaseRoot = await check('runtime.public_releases_path', () => resolvePublicReleasesDir(strictEnv), { failure: 'CONFIGURATION_REQUIRED' });
  await check('runtime.private_public_layout', () => {
    const publishRoot = path.dirname(publicDir);
    for (const privatePath of [dataDir, stateDbPath, resolveAdminSecretPath(strictEnv),
      env.BACKUP_SECRET_FILE ? absolute(env.BACKUP_SECRET_FILE) : path.join(dataDir, 'backup-secrets.json')]) {
      if (within(publishRoot, privatePath) || within(privatePath, publishRoot)) refuse('PRIVATE_STORAGE_INSIDE_PUBLICATION');
    }
  }, { skip: !dataDir || !stateDbPath || !publicDir, failure: 'CONFIGURATION_REQUIRED' });
  await check('runtime.startup_preflight', () => preflightProductionRuntime(strictEnv), { failure: 'RUNTIME_PREFLIGHT_FAILED' });
  // Reuse the backup contract, including its secret isolation and destination
  // selection. Only its already-redacted checks leave the module.
  const backup = backupPreflight({ env: strictEnv, platform });
  for (const item of backup.checks) checks.push({ ...item, id: `backup.${item.id}`, scope: 'static',
    status: item.status === 'unknown' ? 'pending' : item.status });
  await check('network.admin_origin', () => { if (!env.ADMIN_ORIGIN) refuse('CONFIGURATION_REQUIRED'); httpsOrigin(env.ADMIN_ORIGIN); });
  await check('network.public_resource_origin', () => { if (!env.PUBLIC_RESOURCE_ORIGIN) refuse('CONFIGURATION_REQUIRED'); httpsOrigin(env.PUBLIC_RESOURCE_ORIGIN); });
  await check('network.trusted_proxies', () => trustedProxyRules(strictEnv), { failure: 'TRUSTED_PROXIES_INVALID' });
  await check('network.listener', () => {
    if (env.ADMIN_HOST && !['127.0.0.1', '::1'].includes(env.ADMIN_HOST)) refuse('LISTENER_NOT_LOOPBACK');
    const port = env.ADMIN_PORT === undefined ? 8787 : Number(env.ADMIN_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('LISTENER_PORT_INVALID');
  }, { success: 'LOOPBACK_CONFIGURATION_ONLY' });
  await check('runtime.restore_quarantine', () => {
    if ([path.join(dataDir, '.restore-quarantine'), path.join(path.dirname(stateDbPath), '.restore-quarantine')].some(exists)) refuse('RESTORE_QUARANTINE_PRESENT');
  }, { skip: !dataDir || !stateDbPath });
  await check('state.parent_directory', () => inspect(path.dirname(stateDbPath), { directory: true, writable: true, platform }), { skip: !stateDbPath });
  const stateFile = await check('state.database_file', () => { inspect(stateDbPath, { writable: true, platform }); return stateDbPath; }, { skip: !stateDbPath });
  for (const suffix of ['-wal', '-shm', '-journal']) await check(`state.sidecar${suffix}`, () => {
    if (exists(stateDbPath + suffix)) inspect(stateDbPath + suffix, { platform });
    if (suffix === '-journal' && exists(stateDbPath + suffix)) refuse('DATABASE_RECOVERY_REQUIRED');
  }, { skip: !stateFile, success: 'ABSENT_OR_PRIVATE_SIDECAR' });
  for (const [kind, archive] of [['user', 'security-archive'], ['admin', 'audit-archive'], ['law', 'law-archive']]) {
    const queue = dataDir && path.join(dataDir, 'log-queue', kind);
    const available = await check(`logs.${kind}.queue_directory`, () => { inspect(queue, { directory: true, writable: true, platform }); return queue; }, { skip: !dataDir });
    await check(`logs.${kind}.queue_drained`, () => {
      if (fs.readdirSync(queue).some(name => name.endsWith('.json'))) refuse('LOG_QUEUE_NOT_EMPTY');
    }, { skip: !available, success: 'NO_QUEUED_JSON_FILES' });
    await check(`logs.${kind}.archive_directory`, () => inspect(path.join(dataDir, archive), { directory: true, writable: true, platform }), { skip: !dataDir });
  }
  const entryFile = await check('entry_log.file', () => {
    const file = absolute(env.S2_ACCESS_LOG);
    if (within(projectRoot, file) || publicDir && within(path.dirname(publicDir), file)) refuse('PATH_INSIDE_RELEASE');
    inspect(file, { platform }); return file;
  });
  const entryArchive = await check('entry_log.archive_directory', () => {
    const directory = absolute(env.ENTRY_LOG_ARCHIVE_DIR);
    if (within(projectRoot, directory) || publicDir && within(path.dirname(publicDir), directory)) refuse('PATH_INSIDE_RELEASE');
    if (entryFile && (within(path.dirname(entryFile), directory) || within(directory, path.dirname(entryFile)))) refuse('ENTRY_ARCHIVE_NOT_INDEPENDENT');
    inspect(directory, { directory: true, writable: true, platform }); return directory;
  });
  const publicLayout = await check('publication.active_release', () => {
    const publisher = new StaticReleasePublisher({ publicDir, releaseRoot, distDir: path.join(projectRoot, 'dist'), production: true });
    inspect(publisher.publishRoot, { directory: true, privateMode: false, writable: true, platform });
    const releases = inspect(releaseRoot, { directory: true, privateMode: false, writable: true, platform });
    const proof = publisher.readDeploymentProof();
    if (!proof) refuse('STATIC_PUBLICATION_MISSING');
    const active = inspect(proof.activeTarget, { directory: true, privateMode: false, platform });
    if (active.dev !== releases.dev) refuse('STATIC_PUBLICATION_INVALID');
    return publisher.publishRoot;
  }, { skip: !publicDir || !releaseRoot, failure: 'STATIC_PUBLICATION_INVALID' });

  let db;
  const opened = await check('state.readonly_database', () => {
    if (sqliteHeader(stateDbPath) && (!exists(stateDbPath + '-wal') || !exists(stateDbPath + '-shm'))) refuse('DATABASE_WAL_SIDECARS_REQUIRED');
    if (exists(stateDbPath + '-journal')) refuse('DATABASE_RECOVERY_REQUIRED');
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    db.pragma('query_only = ON');
    db.exec('BEGIN');
    return true;
  }, { skip: !stateFile || checks.some(item => item.id.startsWith('state.sidecar') && item.status !== 'pass'), failure: 'DATABASE_OPEN_FAILED' });
  let ledgerDir;
  try {
    await check('state.integrity', () => { if (db.pragma('integrity_check', { simple: true }) !== 'ok') refuse('DATABASE_INTEGRITY_FAILED'); }, { skip: !opened });
    for (const [table, columns] of Object.entries(logColumns)) await check(`logs.schema.${table}`, () => {
      tableColumns(db, table, 'LOG_TABLE_MISSING', 'LOG_COLUMNS_MISSING', columns);
      eventIndex(db, table);
    }, { skip: !opened });
    const binding = await check('deletion.runtime_binding', () => {
      const value = readRuntimeDeletionBinding(db);
      if (!value) refuse('LEDGER_BINDING_REQUIRED');
      return value;
    }, { skip: !opened, failure: 'LEDGER_BINDING_INVALID' });
    ledgerDir = await check('deletion.ledger_directory', () => {
      const directory = absolute(env.DELETION_LEDGER_DIR);
      // Reuse S5 portable alias/symlink checks for every excluded tree.
      for (const excluded of [dataDir, path.dirname(stateDbPath), projectRoot, publicLayout, entryArchive,
        dataDir && path.join(dataDir, 'private-backups')].filter(Boolean)) {
        assertIndependentLedgerDirectory({ directory, dataDir: excluded });
      }
      inspect(directory, { directory: true, writable: true, platform }); return directory;
    }, { skip: !dataDir || !stateDbPath, failure: 'LEDGER_NOT_INDEPENDENT' });
    await check('deletion.bound_ledger', () => {
      const ledger = openRuntimeDeletionLedger({ db, dataDir, directory: ledgerDir });
      inspect(ledger.filePath, { platform });
      ledger.head(); // Integrity/lineage only; never return identifiers or entries.
    }, { skip: !binding || !ledgerDir, failure: 'LEDGER_CHECK_FAILED', success: 'BOUND_LEDGER_CHAIN_ONLY' });
    await check('deletion.jobs_schema', () => tableColumns(db, 'account_deletion_jobs', 'DELETION_JOBS_TABLE_MISSING',
      'DELETION_JOBS_COLUMNS_MISSING', ['event_id', 'user_id', 'user_created_at', 'requested_at', 'status', 'order_keys', 'summary', 'last_error', 'completed_at']), { skip: !opened });
  } finally { db?.close(); }
  const budget = await check('capacity.budget', () => {
    if (!env.DEPLOYMENT_MIN_FREE_BYTES) refuse('CAPACITY_BUDGET_REQUIRED');
    if (!/^[1-9][0-9]*$/.test(env.DEPLOYMENT_MIN_FREE_BYTES) || !Number.isSafeInteger(Number(env.DEPLOYMENT_MIN_FREE_BYTES))) refuse('CAPACITY_BUDGET_INVALID');
    return Number(env.DEPLOYMENT_MIN_FREE_BYTES);
  });
  for (const [id, directory] of [['runtime', dataDir], ['state', stateDbPath && path.dirname(stateDbPath)],
    ['publication', publicLayout], ['entry_archive', entryArchive], ['ledger', ledgerDir]]) await check(`capacity.${id}`, () => {
    let stat;
    try { stat = fs.statfsSync(directory); }
    catch (error) { if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) refuse('CAPACITY_UNSUPPORTED'); throw error; }
    if (!Number.isSafeInteger(stat.bavail * stat.bsize) || stat.bavail * stat.bsize < budget) refuse('CAPACITY_BELOW_BUDGET');
  }, { skip: !directory || !budget, success: 'OPERATOR_BUDGET_MET' });

  let syntheticOrigin;
  if (syntheticLocalhostOrigin !== undefined) {
    syntheticOrigin = await check('synthetic.origin', () => validateSyntheticLocalhostOrigin(syntheticLocalhostOrigin), { scope: 'synthetic' });
    await check('synthetic.health', async () => {
      const response = await syntheticGet(syntheticOrigin, '/api/v1/health', true);
      if (response.status !== 200) refuse('SYNTHETIC_RESPONSE_INVALID');
      if (response.headers['cache-control'] !== 'no-store') refuse('SYNTHETIC_CACHE_INVALID');
      if (response.headers['x-content-type-options'] !== 'nosniff') refuse('SYNTHETIC_HEADERS_INVALID');
      let value;
      try { value = JSON.parse(response.body); } catch { refuse('SYNTHETIC_RESPONSE_INVALID'); }
      if (value?.code !== 0 || value?.data?.status !== 'ok') refuse('SYNTHETIC_RESPONSE_INVALID');
      if (value.data.accountDeletion?.configured !== true || !Number.isSafeInteger(value.data.accountDeletion?.ledgerSequence)
        || value.data.accountDeletion.ledgerSequence < 0) refuse('SYNTHETIC_DELETION_UNAVAILABLE');
      if (value.data.accountDeletion.pending !== 0) refuse('SYNTHETIC_DELETION_PENDING');
    }, { scope: 'synthetic', skip: !syntheticOrigin });
    await check('synthetic.unauthenticated_me', async () => {
      const response = await syntheticGet(syntheticOrigin, '/api/v1/me');
      if (response.status !== 401) refuse('SYNTHETIC_RESPONSE_INVALID');
      if (response.headers['cache-control'] !== 'no-store') refuse('SYNTHETIC_CACHE_INVALID');
      if (response.headers['x-content-type-options'] !== 'nosniff') refuse('SYNTHETIC_HEADERS_INVALID');
    }, { scope: 'synthetic', skip: !syntheticOrigin });
  } else checks.push({ id: 'synthetic.http_probe', scope: 'synthetic', status: 'pending', code: 'EXPLICIT_SYNTHETIC_ORIGIN_REQUIRED' });
  for (const [id, code] of [
    ['service_identity_and_single_writer', 'ACTUAL_SERVICE_IDENTITY_AND_SINGLE_WRITER_UNVERIFIED'],
    ['https_headers_and_firewall', 'PRODUCTION_EDGE_RESPONSE_AND_NETWORK_UNVERIFIED'],
    ['trusted_proxy_topology', 'PRODUCTION_PROXY_TOPOLOGY_UNVERIFIED'],
    ['private_and_public_cache', 'PRODUCTION_CACHE_AND_CDN_UNVERIFIED'],
    ['entry_log_redaction_and_retention', 'ACTUAL_CADDY_CONFIG_LOG_AND_TIMER_UNVERIFIED'],
    ['log_write_replay_and_archives', 'SYNTHETIC_LOG_PERSISTENCE_AND_PRODUCTION_LOG_UNVERIFIED'],
    ['capacity_and_monitoring', 'RETENTION_CAPACITY_AND_EXTERNAL_MONITORING_UNVERIFIED'],
    ['backup_and_isolated_restore', 'BACKUP_RESTORE_AND_FRESH_LEDGER_HEAD_UNVERIFIED'],
    ['deletion_history_and_jobs', 'DELETION_COVERAGE_JOBS_AND_REMOTE_CLEANUP_UNVERIFIED'],
    ['remote_backup_permissions', backup.remoteEnabled ? 'REMOTE_STORAGE_ACCESS_AND_PRIVACY_UNVERIFIED' : 'REMOTE_STORAGE_DISABLED_NOT_ACCEPTANCE'],
    ['notifications', 'USER_DEFERRED_NOTIFICATIONS_NOT_TESTED'],
  ]) checks.push({ id: `production.${id}`, scope: 'production', status: 'pending', code });
  const localStaticReady = checks.filter(item => item.scope === 'static').every(item => item.status === 'pass' || item.status === 'skip' && item.code === 'DESTINATION_DISABLED');
  const syntheticRequested = syntheticLocalhostOrigin !== undefined;
  const syntheticReady = syntheticRequested ? checks.filter(item => item.scope === 'synthetic').every(item => item.status === 'pass') : null;
  return {
    schema: 'nkustudy-deployment-readiness-v1', readOnly: true,
    scope: 'CURRENT_PROCESS_LOCAL_STATIC_AND_EXPLICIT_SYNTHETIC_ONLY',
    localStaticReady, syntheticRequested, syntheticReady,
    localChecksPassed: localStaticReady && (!syntheticRequested || syntheticReady),
    productionReady: false, ops20Accepted: false,
    productionStatus: 'pending',
    limitations: ['NO_PERMISSION_REPAIR_OR_DATABASE_WRITES', 'SQLITE_WAL_READ_LOCKS_MAY_TOUCH_SHM_METADATA',
      'NO_BUSINESS_OR_LOG_ROW_EXPORT', 'NO_SERVER_STARTUP_OR_LOG_WRITE_PROBE',
      'NO_CLOUD_NOTIFICATION_OR_PRODUCTION_HTTP_ACCESS', 'CURRENT_PATHS_NOT_EFFECTIVE_SERVICE_OR_CADDY_ATTESTATION',
      'READS_MAY_UPDATE_ATIME_NOT_A_FROZEN_CROSS_FILE_SNAPSHOT', 'LEDGER_CHAIN_DOES_NOT_ESTABLISH_FRESHNESS_OR_HISTORY_COVERAGE'],
    checks,
  };
}
