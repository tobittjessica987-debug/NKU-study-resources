import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CommunitySupportService } from '../server/community-support-service.mjs';
import { normalizeReviewsDocument, moderationHash } from '../server/moderation-model.mjs';
import { publicResourceDto } from '../server/public-api-dto.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ROOT, 'scripts/migrate-community-support-baseline.mjs');
const DATE = '2026-10-24T00:00:00.000Z';
const RULES = { submissionOpen: true, moderationRequired: true, turnstileEnabled: false, hourlyLimit: 3, dailyLimit: 10, minLength: 12,
  submissionOptions: { allowCustomCourse: false, allowCustomTeacher: true },
  announcement: '评价按当前规则决定是否自动公开。请尽量描述授课风格、作业考试情况与适合人群，避免人身攻击或泄露隐私。', notes: '' };
function approved(id, changes = {}) {
  return { id, schemaVersion: 2, courseTitle: 'Synthetic course', teacher: 'Teacher', content: 'PRIVATE synthetic content',
    user_id: 501, publicationState: 'approved', status: 'approved', decisionSource: 'admin_decision',
    reviewedBy: 'PRIVATE administrator', reviewedAt: DATE, hidden: false, ...changes };
}
function makeManifest() {
  return { resourceRoot: 'https://resources.nkustudy.top/resources/', courses: [{ uid: 'course-a', title: 'Synthetic course', basePath: 'synthetic/',
    sections: [{ title: 'Files', files: [{ path: 'one.pdf', title: 'One.pdf' }, { path: 'two.pdf', title: 'Two.pdf' }, { path: '.openlist', title: 'Placeholder' }] }] }] };
}
function fixture(t, { ledger = true, wal = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'support-baseline-cli-'));
  fs.chmodSync(directory, 0o700);
  const dataDir = path.join(directory, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const dbPath = path.join(directory, 'state.sqlite');
  const manifestPath = path.join(dataDir, 'manifest.json'), reviewsPath = path.join(dataDir, 'reviews.json');
  const manifest = makeManifest();
  const marker = { version: 1, epoch: randomUUID(), sequence: 0, baseline_review_ids: ['historical', 'historical-hidden'] };
  let reviews = normalizeReviewsDocument({ reviews: [approved('historical'), approved('historical-hidden', { hidden: true })], community_support_ledger: marker }, { rulesDefaults: RULES, nowIso: DATE });
  let db = new Database(dbPath);
  if (wal) db.pragma('journal_mode=WAL');
  if (ledger) {
    const service = new CommunitySupportService({ db, readReviews: () => reviews, assertActiveUser: id => ({ id }), enabled: true,
      downloadReporting: true, personalStats: true, validateResource: () => true });
    service.initializeReviews(reviews);
    reviews = { ...reviews, community_support_ledger: { ...marker, sequence: 1 }, reviews: [...reviews.reviews, approved('later')] };
    service.reconcileReviews(reviews);
    service.recordDownload({ event_id: 'private_synthetic_download_001', kind: 'resource', resource_id: 'one', course_id: 'course-a', attribution: 'account' }, { userId: 501 });
  }
  db.close(); db = null;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(reviewsPath, JSON.stringify(reviews), { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    PUBLIC_RESOURCE_ORIGIN: 'https://resources.nkustudy.top', ADMIN_SECRET_FILE: '/nonexistent/private-secret-must-not-be-read' };
  return { directory, dataDir, dbPath, manifestPath, reviewsPath, manifest, reviews, env,
    run(args, changes = {}) { return spawnSync(process.execPath, [CLI, ...(Array.isArray(args) ? args : [args])], { cwd: ROOT, env: { ...env, ...changes }, encoding: 'utf8', timeout: 10000 }); },
    sql(fn) { const handle = new Database(dbPath, { fileMustExist: true }); try { return fn(handle); } finally { handle.close(); } },
    writeManifest(value) { fs.writeFileSync(manifestPath, JSON.stringify(value)); },
    writeReviews(value) { fs.writeFileSync(reviewsPath, JSON.stringify(value)); },
  };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'one JSON receipt per line for stopped-service orchestration');
  return JSON.parse(result.stdout);
}
function failed(result, code) {
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
  const value = JSON.parse(result.stderr);
  assert.equal(value.ok, false);
  if (code) assert.equal(value.error.code, code);
  for (const privateValue of ['PRIVATE', 'private_synthetic_download_001', '501', '/nonexistent/', 'state.sqlite', 'reviews.json']) {
    assert.equal(result.stderr.includes(privateValue), false, `Error output leaked ${privateValue}`);
  }
  return value;
}
function databaseFingerprint(f) {
  return f.sql(db => {
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const rows = schema.filter(item => item.type === 'table').map(item => [item.name, db.prepare(`SELECT * FROM "${item.name}" ORDER BY rowid`).all()]);
    return moderationHash({ schema, rows });
  });
}

test('CLI preview/status are real process read-only business/schema checks with sanitized counts', t => {
  const f = fixture(t, { wal: true });
  const before = databaseFingerprint(f);
  const source = fs.readFileSync(f.reviewsPath, 'utf8');
  const preview = success(f.run('--preview'));
  assert.equal(preview.wouldApply, true);
  assert.deepEqual(preview.counts, { resourceCount: 2, publicReviewCount: 2, historicalPublicReviewCount: 1, successfulDownloadCount: 1 });
  assert.deepEqual(preview.proposedPublic, { flowers: 3, coins: 2 });
  assert.equal(preview.evidence.readOnly, true);
  assert.equal(preview.evidence.sqliteLockSidecarsMayChange, true);
  const ids = f.manifest.courses[0].sections[0].files.slice(0, 2).map(file => publicResourceDto({ manifest: f.manifest, course: f.manifest.courses[0], section: f.manifest.courses[0].sections[0], file, configuredOrigin: 'https://resources.nkustudy.top' }).id).sort();
  assert.equal(preview.source.resourceIdsSha256, moderationHash(ids));
  const status = success(f.run('--status'));
  assert.equal(status.applied, false); assert.equal(status.receipt, null);
  assert.equal(databaseFingerprint(f), before);
  assert.equal(fs.readFileSync(f.reviewsPath, 'utf8'), source);
  const serialized = JSON.stringify({ preview, status });
  for (const value of ['PRIVATE', 'private_synthetic_download_001', '501', f.directory, 'historical-hidden']) assert.equal(serialized.includes(value), false);
});

test('CLI apply migrates once, keeps personal totals and replay returns the original fixed receipt', t => {
  const f = fixture(t);
  const before = f.sql(db => db.prepare('SELECT user_id,COUNT(*) n FROM community_support_downloads GROUP BY user_id').all());
  const applied = success(f.run('--apply'));
  assert.equal(applied.applied, true); assert.equal(applied.replayed, false);
  assert.equal(applied.receipt.counts.resourceCount, 2);
  assert.equal(applied.receipt.counts.publicReviewCount, 2);
  assert.equal(applied.receipt.publicAfter.flowers, 3);
  assert.equal(applied.receipt.publicAfter.coins, 2);
  assert.equal(applied.evidence.readOnly, false);
  assert.match(applied.receipt.personalStatsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.sql(db => db.prepare('SELECT user_id,COUNT(*) n FROM community_support_downloads GROUP BY user_id').all()), before);
  assert.equal(f.sql(db => db.prepare('SELECT user_id FROM community_support_reviews WHERE review_id=?').get('historical').user_id), null);
  assert.equal(f.sql(db => db.prepare('SELECT COUNT(*) n FROM community_support_reviews WHERE active=1 AND user_id=501').get().n), 1);
  const fingerprint = databaseFingerprint(f);
  f.manifest.courses[0].sections[0].files.push({ path: 'third.pdf', title: 'Third.pdf' });
  f.writeManifest(f.manifest);
  const replay = success(f.run('--apply'));
  assert.equal(replay.replayed, true); assert.equal(replay.evidence.readOnly, true);
  assert.deepEqual(replay.receipt, applied.receipt);
  assert.equal(databaseFingerprint(f), fingerprint);
  const status = success(f.run('--status'));
  assert.equal(status.applied, true); assert.equal(status.resource_baseline, 2);
  assert.deepEqual(status.receipt, applied.receipt);
});

test('CLI rejects invalid/missing IDs and unsafe resource paths before ledger mutation', t => {
  const variants = [
    [m => { delete m.courses[0].uid; }, 'INVALID_COURSE_ID'],
    [m => { m.courses.push(structuredClone(m.courses[0])); }, 'DUPLICATE_COURSE_ID'],
    [m => { m.courses[0].sections[0].files.push({ path: 'one.pdf', title: 'Duplicate' }); }, 'DUPLICATE_RESOURCE_ID'],
    [m => { m.courses[0].sections[0].files[0].path = '../PRIVATE.pdf'; }, 'INVALID_PUBLIC_RESOURCE'],
    [m => { m.resourceRoot = 'https://example.invalid/private/'; }, 'INVALID_PUBLIC_RESOURCE'],
  ];
  for (const [mutate, expected] of variants) {
    const f = fixture(t), fingerprint = databaseFingerprint(f);
    mutate(f.manifest); f.writeManifest(f.manifest);
    failed(f.run('--apply'), expected);
    assert.equal(databaseFingerprint(f), fingerprint);
  }
});

test('CLI never bootstraps missing or partially installed ledgers or a missing source marker', t => {
  const empty = fixture(t, { ledger: false }), emptyBefore = databaseFingerprint(empty);
  failed(empty.run('--apply'), 'LEDGER_NOT_INSTALLED');
  failed(empty.run('--status'), 'LEDGER_NOT_INSTALLED');
  assert.equal(databaseFingerprint(empty), emptyBefore);
  const partial = fixture(t); partial.sql(db => db.exec('DROP TABLE community_support_reviews'));
  const partialBefore = databaseFingerprint(partial);
  failed(partial.run('--apply'), 'LEDGER_INCOMPLETE');
  assert.equal(databaseFingerprint(partial), partialBefore);
  const marker = fixture(t); delete marker.reviews.community_support_ledger; marker.writeReviews(marker.reviews);
  const markerBefore = databaseFingerprint(marker);
  failed(marker.run('--apply'), 'SUPPORT_UNAVAILABLE');
  assert.equal(databaseFingerprint(marker), markerBefore);
});

test('CLI rejects duplicate review IDs, same-sequence source drift and wrong epoch without ALTER', t => {
  const changes = [
    doc => doc.reviews.push(structuredClone(doc.reviews[0])),
    doc => { doc.reviews[0].content = 'PRIVATE changed body'; },
    doc => { doc.community_support_ledger.epoch = randomUUID(); },
  ];
  for (const mutate of changes) {
    const f = fixture(t), fingerprint = databaseFingerprint(f);
    mutate(f.reviews); f.writeReviews(f.reviews);
    failed(f.run('--apply'));
    assert.equal(databaseFingerprint(f), fingerprint);
    assert.equal(f.sql(db => db.prepare('PRAGMA table_info(community_support_meta)').all().some(row => row.name === 'public_resource_baseline')), false);
  }
});

test('CLI errors are sanitized for invalid arguments, absent paths, malformed source and quarantine', t => {
  const f = fixture(t), fingerprint = databaseFingerprint(f);
  failed(f.run(['--apply', '--migration-id', 'PRIVATE']), 'INVALID_ARGUMENTS');
  failed(f.run('--preview', { DATA_DIR: '' }), 'RUNTIME_PATHS_REQUIRED');
  failed(f.run('--apply', { STATE_DB_PATH: 'relative-PRIVATE.sqlite' }), 'RUNTIME_PATHS_REQUIRED');
  fs.writeFileSync(f.manifestPath, '{PRIVATE malformed data');
  failed(f.run('--apply'), 'INVALID_JSON');
  fs.writeFileSync(path.join(f.dataDir, '.restore-quarantine'), 'PRIVATE quarantine');
  failed(f.run('--apply'), 'RESTORE_QUARANTINED');
  assert.equal(databaseFingerprint(f), fingerprint);
});

test('CLI status validates persisted receipt integrity without initializing or rewriting it', t => {
  const f = fixture(t);
  success(f.run('--apply'));
  f.sql(db => db.prepare('UPDATE community_support_meta SET public_baseline_receipt_hash=?').run('0'.repeat(64)));
  const fingerprint = databaseFingerprint(f);
  failed(f.run('--status'), 'SUPPORT_UNAVAILABLE');
  failed(f.run('--apply'), 'SUPPORT_UNAVAILABLE');
  assert.equal(databaseFingerprint(f), fingerprint);
});
