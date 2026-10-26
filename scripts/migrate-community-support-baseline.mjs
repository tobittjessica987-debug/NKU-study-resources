import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { publicResourceDto } from '../server/public-api-dto.mjs';
import { isReviewPublicEligible, normalizeReviewsDocument, moderationHash } from '../server/moderation-model.mjs';
import { validateCommunitySupportReviewMetadata } from '../server/community-support-review-store.mjs';
import { CommunitySupportService, COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID,
  readCommunitySupportPublicBaselineStatus } from '../server/community-support-service.mjs';

// Offline maintenance only: the deployment orchestrator must stop all writers.
// Preview/status do not mutate business rows or schema. SQLite read-only handles
// may still create/update WAL/SHM lock sidecars; this is not a zero-file-write claim.
// No service startup, secret-file read, environment-file loading or backup occurs here.
const TABLES = ['community_support_meta', 'community_support_downloads', 'community_support_reviews',
  'community_support_cleared_accounts', 'community_support_rate_limits'];
const ERRORS = new Set(['INVALID_ARGUMENTS', 'RUNTIME_PATHS_REQUIRED', 'UNSAFE_RUNTIME_PATH', 'RESTORE_QUARANTINED',
  'INVALID_UTF8', 'INVALID_JSON', 'SOURCE_CHANGED', 'INVALID_MANIFEST', 'INVALID_COURSE_ID', 'DUPLICATE_COURSE_ID',
  'INVALID_RESOURCE_ID', 'DUPLICATE_RESOURCE_ID', 'INVALID_PUBLIC_RESOURCE', 'LEDGER_NOT_INSTALLED',
  'LEDGER_INCOMPLETE', 'SOURCE_BINDING_MISMATCH', 'REVIEWS_NOT_NORMALIZED', 'SUPPORT_UNAVAILABLE', 'BASELINE_MIGRATION_CONFLICT']);
const RULES = {
  submissionOpen: true, moderationRequired: true, turnstileEnabled: false, hourlyLimit: 3, dailyLimit: 10, minLength: 12,
  submissionOptions: { allowCustomCourse: false, allowCustomTeacher: true },
  announcement: '评价按当前规则决定是否自动公开。请尽量描述授课风格、作业考试情况与适合人群，避免人身攻击或泄露隐私。', notes: '',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stableId = value => typeof value === 'string' && value.trim() === value && !!value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const count = value => { if (!Number.isSafeInteger(value) || value < 0) fail('SUPPORT_UNAVAILABLE'); return value; };
const evidence = { serviceStopVerification: 'external-orchestrator-required', readOnlyScope: 'business-rows-and-schema', sqliteLockSidecarsMayChange: true };

function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH');
  return stat;
}

function readJson(filename) {
  const before = regularFile(filename);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (before.dev !== opened.dev || before.ino !== opened.ino) fail('SOURCE_CHANGED');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail('SOURCE_CHANGED');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_UTF8');
    let value;
    try { value = JSON.parse(text); } catch { fail('INVALID_JSON'); }
    return { value, sha256: hash(bytes), filename };
  } finally { fs.closeSync(descriptor); }
}

function readReviews(filename) {
  const source = readJson(filename);
  validateCommunitySupportReviewMetadata(source.value);
  // Startup already persists schema v2. Do not perform an implicit review-data
  // migration or invent provenance timestamps during this one-time accounting change.
  const normalized = normalizeReviewsDocument(source.value, {
    rulesDefaults: RULES, nowIso: source.value.rulesProvenance?.configuredAt || '1970-01-01T00:00:00.000Z',
  });
  if (source.value.schemaVersion !== 2 || moderationHash(normalized) !== moderationHash(source.value)) fail('REVIEWS_NOT_NORMALIZED');
  return { ...source, document: normalized };
}

function resourceIdsFrom(manifest, configuredOrigin) {
  if (!plain(manifest) || !Array.isArray(manifest.courses)) fail('INVALID_MANIFEST');
  const courses = new Set(), resources = new Set();
  for (const course of manifest.courses) {
    if (!plain(course) || !stableId(course.uid)) fail('INVALID_COURSE_ID');
    if (courses.has(course.uid)) fail('DUPLICATE_COURSE_ID');
    courses.add(course.uid);
    if (course.sections !== undefined && !Array.isArray(course.sections)) fail('INVALID_MANIFEST');
    for (const section of course.sections || []) {
      if (!plain(section) || section.files !== undefined && !Array.isArray(section.files)) fail('INVALID_MANIFEST');
      for (const file of section.files || []) {
        if (!plain(file)) fail('INVALID_MANIFEST');
        // Match cleanManifestResources before the public search-index projection.
        const raw = file.path || file.title || '';
        if (typeof raw !== 'string') fail('INVALID_PUBLIC_RESOURCE');
        const normalizedKey = raw.replaceAll('\\', '/').split('/').map(part => part.trim()).filter(Boolean).join('/');
        if (path.posix.basename(normalizedKey).toLowerCase() === '.openlist') continue;
        let dto;
        try { dto = publicResourceDto({ manifest, course, section, file, configuredOrigin }); }
        catch { fail('INVALID_PUBLIC_RESOURCE'); }
        if (!stableId(dto.id) || dto.course_id !== course.uid) fail('INVALID_RESOURCE_ID');
        if (resources.has(dto.id)) fail('DUPLICATE_RESOURCE_ID');
        resources.add(dto.id);
      }
    }
  }
  return [...resources].sort();
}

function requireInstalled(db) {
  const present = TABLES.filter(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!present.length) fail('LEDGER_NOT_INSTALLED');
  if (present.length !== TABLES.length) fail('LEDGER_INCOMPLETE');
  const meta = db.prepare('SELECT * FROM community_support_meta WHERE singleton=1').get();
  if (!meta || meta.version !== 1) fail('LEDGER_INCOMPLETE');
  count(meta.review_sequence); count(meta.revision);
  return meta;
}

function verifySourceBinding(meta, document) {
  const marker = validateCommunitySupportReviewMetadata(document);
  const baseline = JSON.stringify([...marker.baseline_review_ids].sort());
  if (meta.epoch !== marker.epoch || meta.baseline_ids !== baseline || meta.review_sequence > marker.sequence
    || meta.review_sequence === marker.sequence && meta.review_digest !== moderationHash(document)) fail('SOURCE_BINDING_MISMATCH');
}

function readProjection(db, status) {
  const downloads = count(db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n);
  const coins = count(db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE active=1').get().n);
  const { revision } = requireInstalled(db);
  return { flowers: count(downloads + status.resource_baseline), coins, revision, successfulDownloadCount: downloads };
}

function readonlyDatabase(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

async function main(args) {
  if (args.length !== 1 || !['--preview', '--apply', '--status'].includes(args[0])) fail('INVALID_ARGUMENTS');
  const mode = args[0].slice(2);
  if (!process.env.DATA_DIR || !process.env.STATE_DB_PATH || !path.isAbsolute(process.env.DATA_DIR) || !path.isAbsolute(process.env.STATE_DB_PATH)) fail('RUNTIME_PATHS_REQUIRED');
  // Dynamic import keeps path-validation errors inside our sanitized error boundary.
  const { resolveDataDir, resolveStateDbPath } = await import('../server/runtime-config.mjs');
  const explicit = { ...process.env, NODE_ENV: 'production' };
  const dataDir = resolveDataDir(explicit), stateDbPath = resolveStateDbPath(explicit);
  for (const directory of [dataDir, path.dirname(stateDbPath)]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH');
    if (fs.existsSync(path.join(directory, '.restore-quarantine'))) fail('RESTORE_QUARANTINED');
  }
  regularFile(stateDbPath);
  const readDb = readonlyDatabase(stateDbPath);
  let prepared;
  try {
    prepared = readDb.transaction(() => {
      const meta = requireInstalled(readDb);
      const status = readCommunitySupportPublicBaselineStatus(readDb);
      if (mode === 'status') return { status };
      const reviews = readReviews(path.join(dataDir, 'reviews.json'));
      verifySourceBinding(meta, reviews.document);
      if (mode === 'apply' && status.applied) return { status, reviews, replayed: true };
      const manifest = readJson(path.join(dataDir, 'manifest.json'));
      const resourceIds = resourceIdsFrom(manifest.value, process.env.PUBLIC_RESOURCE_ORIGIN || 'https://resources.nkustudy.top');
      const publicIds = reviews.document.reviews.filter(isReviewPublicEligible).map(review => review.id).sort();
      const historical = new Set(reviews.document.community_support_ledger.baseline_review_ids);
      return { status, reviews, manifest, resourceIds, projection: readProjection(readDb, status),
        publicIdsSha256: moderationHash(publicIds), publicReviewCount: publicIds.length,
        historicalPublicReviewCount: publicIds.filter(id => historical.has(id)).length };
    })();
  } finally { readDb.close(); }

  const base = { ok: true, mode, migrationId: COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID,
    evidence: { ...evidence, readOnly: mode !== 'apply' || prepared.replayed === true } };
  if (mode === 'status') return { ...base, ...prepared.status };
  if (prepared.replayed) return { ...base, applied: true, replayed: true, receipt: prepared.status.receipt };
  if (mode === 'preview') return { ...base, wouldApply: !prepared.status.applied, status: prepared.status,
    source: { manifestSha256: prepared.manifest.sha256, reviewsSha256: prepared.reviews.sha256,
      resourceIdsSha256: moderationHash(prepared.resourceIds), publicReviewIdsSha256: prepared.publicIdsSha256 },
    counts: { resourceCount: prepared.resourceIds.length, publicReviewCount: prepared.publicReviewCount,
      historicalPublicReviewCount: prepared.historicalPublicReviewCount, successfulDownloadCount: prepared.projection.successfulDownloadCount },
    currentPublic: prepared.projection,
    proposedPublic: prepared.status.applied ? null : { flowers: count(prepared.resourceIds.length + prepared.projection.successfulDownloadCount), coins: prepared.publicReviewCount },
    personalStatsPolicy: 'preserved-by-public-baseline-migration' };

  // Frozen writers are an external prerequisite. Detect source drift immediately
  // before opening the write connection; the migration itself is one SQL transaction.
  if (readJson(prepared.manifest.filename).sha256 !== prepared.manifest.sha256
    || readJson(prepared.reviews.filename).sha256 !== prepared.reviews.sha256) fail('SOURCE_CHANGED');
  const db = new Database(stateDbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    requireInstalled(db);
    const service = new CommunitySupportService({ db, readReviews: () => prepared.reviews.document,
      assertActiveUser: () => { throw new Error('Identity operations are unavailable in this maintenance command.'); },
      enabled: false, requirePublicBaseline: false });
    const result = service.migratePublicBaseline({ resourceIds: prepared.resourceIds, migrationId: COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID });
    return { ...base, ...result };
  } finally { db.close(); }
}

try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: ERRORS.has(error.code) ? error.code : 'BASELINE_OPERATION_FAILED' } })}\n`);
  process.exitCode = 1;
}
