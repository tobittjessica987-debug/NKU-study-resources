import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PublicApiError } from './public-api-errors.mjs';
import { isReviewPublicEligible } from './moderation-model.mjs';
import { validateCommunitySupportReviewMetadata } from './community-support-review-store.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const TABLES = ['community_support_meta', 'community_support_downloads', 'community_support_reviews', 'community_support_cleared_accounts', 'community_support_rate_limits'];
const EVENT_KEYS = new Set(['event_id', 'kind', 'resource_id', 'course_id', 'attribution']);
const BASELINE_COLUMNS = ['public_baseline_rule', 'public_resource_baseline', 'public_baseline_receipt', 'public_baseline_receipt_hash'];
const SHA256 = /^[a-f0-9]{64}$/;

export const COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID = 'community-baseline-20261024-v1';

export const COMMUNITY_SUPPORT_LIMITS = Object.freeze({
  account: Object.freeze({ minute: 30, day: 200, resourceMinute: 5, resourceDay: 50 }),
  community: Object.freeze({ minute: 10, day: 60, resourceMinute: 3, resourceDay: 20 }),
});

function unavailable() { return new PublicApiError(503, '共建统计暂不可用，请稍后再试。', 'SUPPORT_UNAVAILABLE'); }
function invalid() { return new PublicApiError(400, '下载事件信息无效。', 'INVALID_SUPPORT_EVENT'); }
function conflict() { return new PublicApiError(409, '该事件已绑定其他下载信息。', 'EVENT_CONFLICT'); }
function authRequired() { return new PublicApiError(401, '请先登录。', 'AUTH_REQUIRED'); }
function safeCount(value) { if (!Number.isSafeInteger(value) || value < 0) throw unavailable(); return value; }
function accountId(value) { if (!Number.isSafeInteger(value) || value <= 0) throw authRequired(); return value; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identity(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function checkedTime(now) { return safeCount(now()); }
function controlled(operation) {
  try { return operation(); } catch (error) {
    if (error instanceof PublicApiError) throw error;
    throw unavailable();
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
    || typeof value === 'number' && !Number.isFinite(value)) throw unavailable();
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function presentTables(db) {
  return TABLES.filter(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function legacyBaseline() {
  return { applied: false, rule_version: 1, resource_baseline: 0, migration_id: null, receipt: null };
}

function exactKeys(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw unavailable();
}

/** Pure read, including on a read-only SQLite handle. Never initializes a missing baseline. */
export function readCommunitySupportPublicBaselineStatus(db, { required = false } = {}) {
  return controlled(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(community_support_meta)').all().map(row => row.name));
    const present = BASELINE_COLUMNS.filter(name => columns.has(name));
    if (!present.length) { if (required) throw unavailable(); return legacyBaseline(); }
    if (present.length !== BASELINE_COLUMNS.length) throw unavailable();
    const meta = db.prepare('SELECT * FROM community_support_meta WHERE singleton=1').get();
    if (!meta) throw unavailable();
    if (meta.public_baseline_rule === 1) {
      if (meta.public_resource_baseline !== 0 || meta.public_baseline_receipt !== null || meta.public_baseline_receipt_hash !== null || required) throw unavailable();
      return legacyBaseline();
    }
    if (meta.public_baseline_rule !== 2 || typeof meta.public_baseline_receipt !== 'string'
      || !SHA256.test(meta.public_baseline_receipt_hash || '')) throw unavailable();
    const receipt = JSON.parse(meta.public_baseline_receipt);
    exactKeys(receipt, ['schemaVersion', 'migrationId', 'projectionRuleVersion', 'appliedAt', 'source', 'counts', 'publicBefore', 'publicAfter', 'personalStatsSha256']);
    exactKeys(receipt.source, ['epoch', 'sequence', 'reviewsSha256', 'resourceIdsSha256', 'publicReviewIdsSha256', 'personalExclusionIdsSha256']);
    exactKeys(receipt.counts, ['resourceCount', 'publicReviewCount', 'historicalPublicReviewCount', 'successfulDownloadCount']);
    exactKeys(receipt.publicBefore, ['flowers', 'coins', 'revision']);
    exactKeys(receipt.publicAfter, ['flowers', 'coins', 'revision']);
    if (receipt.schemaVersion !== 1 || receipt.migrationId !== COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID || receipt.projectionRuleVersion !== 2
      || typeof receipt.appliedAt !== 'string' || !Number.isFinite(Date.parse(receipt.appliedAt))
      || new Date(receipt.appliedAt).toISOString() !== receipt.appliedAt
      || receipt.source.epoch !== meta.epoch || safeCount(receipt.source.sequence) > safeCount(meta.review_sequence)
      || !SHA256.test(receipt.personalStatsSha256)
      || Object.entries(receipt.source).some(([key, value]) => key.endsWith('Sha256') && !SHA256.test(value))
      || receipt.source.personalExclusionIdsSha256 !== hash(meta.baseline_ids)
      || hash(canonical(receipt)) !== meta.public_baseline_receipt_hash) throw unavailable();
    for (const value of Object.values(receipt.counts)) safeCount(value);
    for (const snapshot of [receipt.publicBefore, receipt.publicAfter]) for (const value of Object.values(snapshot)) safeCount(value);
    const resourceBaseline = safeCount(meta.public_resource_baseline);
    const currentDownloads = safeCount(db.prepare('SELECT COUNT(*) n FROM community_support_downloads').get().n);
    if (receipt.counts.resourceCount !== resourceBaseline
      || receipt.counts.successfulDownloadCount > currentDownloads
      || receipt.publicBefore.flowers !== receipt.counts.successfulDownloadCount
      || receipt.publicAfter.flowers !== safeCount(resourceBaseline + receipt.counts.successfulDownloadCount)
      || receipt.publicAfter.coins !== receipt.counts.publicReviewCount
      || receipt.publicAfter.coins !== safeCount(receipt.publicBefore.coins + receipt.counts.historicalPublicReviewCount)
      || receipt.publicAfter.revision !== safeCount(receipt.publicBefore.revision + 1)
      || receipt.publicAfter.revision > safeCount(meta.revision)
      || receipt.source.sequence === meta.review_sequence && receipt.source.reviewsSha256 !== meta.review_digest) throw unavailable();
    return { applied: true, rule_version: 2, resource_baseline: resourceBaseline,
      migration_id: receipt.migrationId, receipt: structuredClone(receipt) };
  });
}

function addBaselineColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(community_support_meta)').all().map(row => row.name));
  const present = BASELINE_COLUMNS.filter(name => columns.has(name));
  if (present.length && present.length !== BASELINE_COLUMNS.length) throw unavailable();
  if (present.length) return;
  db.exec(`ALTER TABLE community_support_meta ADD COLUMN public_baseline_rule INTEGER NOT NULL DEFAULT 1 CHECK(public_baseline_rule IN (1,2));
    ALTER TABLE community_support_meta ADD COLUMN public_resource_baseline INTEGER NOT NULL DEFAULT 0 CHECK(public_resource_baseline>=0);
    ALTER TABLE community_support_meta ADD COLUMN public_baseline_receipt TEXT;
    ALTER TABLE community_support_meta ADD COLUMN public_baseline_receipt_hash TEXT;`);
}

function personalState(db) {
  const rows = new Map();
  for (const [table, field, where] of [['community_support_downloads', 'flowers', ''], ['community_support_reviews', 'coins', 'AND active=1']]) {
    for (const row of db.prepare(`SELECT user_id, COUNT(*) n FROM ${table} WHERE user_id IS NOT NULL ${where} GROUP BY user_id`).all()) {
      const id = accountId(row.user_id);
      const value = rows.get(id) || { userId: id, flowers: 0, coins: 0 };
      value[field] = safeCount(row.n);
      rows.set(id, value);
    }
  }
  return [...rows.values()].sort((left, right) => left.userId - right.userId);
}

/** Read-only: a partially installed ledger also counts, so callers cannot silently reset it. */
export function hasCommunitySupportLedger(db) { return controlled(() => presentTables(db).length > 0); }

function bumpRevision(db) {
  const row = db.prepare('SELECT revision FROM community_support_meta WHERE singleton=1').get();
  if (!row || safeCount(row.revision) === MAX) throw unavailable();
  db.prepare('UPDATE community_support_meta SET revision=? WHERE singleton=1').run(row.revision + 1);
}

/** No schema creation; used both by live S5 cleanup and isolated restore reconciliation. */
export function scrubCommunitySupportAccount(db, userId, { now = Date.now, fault = () => {} } = {}) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError('A positive safe account ID is required.');
  return controlled(() => {
    const tables = presentTables(db);
    if (!tables.length) return { installed: false, cleared: false };
    if (tables.length !== TABLES.length) throw unavailable();
    return db.transaction(() => {
      const time = checkedTime(now);
      const tombstone = db.prepare('INSERT OR IGNORE INTO community_support_cleared_accounts(user_id,cleared_at) VALUES(?,?)').run(userId, time);
      const downloads = db.prepare('UPDATE community_support_downloads SET user_id=NULL,identity_cleared=1 WHERE user_id=?').run(userId);
      const reviews = db.prepare('UPDATE community_support_reviews SET user_id=NULL,identity_cleared=1 WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM community_support_rate_limits WHERE actor_user_id=?').run(userId);
      fault('afterAccountScrub');
      // Before the first metadata initialization there can be no contributions to revise.
      const meta = db.prepare('SELECT singleton FROM community_support_meta WHERE singleton=1').get();
      if (meta && (downloads.changes || reviews.changes)) bumpRevision(db);
      return { installed: true, cleared: true, changed: !!(tombstone.changes || downloads.changes || reviews.changes) };
    }).immediate();
  });
}

export function validateSupportDownloadEvent(body) {
  if (!plain(body) || Object.keys(body).some(key => !EVENT_KEYS.has(key))) throw invalid();
  if (typeof body.event_id !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(body.event_id)) throw invalid();
  if (!['resource', 'guide_source'].includes(body.kind) || !['account', 'community'].includes(body.attribution)) throw invalid();
  if (typeof body.resource_id !== 'string' || !body.resource_id.trim() || body.resource_id.length > 200
    || /[\u0000-\u001f\u007f]/.test(body.resource_id)) throw invalid();
  if (Object.hasOwn(body, 'course_id') && typeof body.course_id !== 'string') throw invalid();
  const courseId = body.course_id ?? '';
  if (typeof courseId !== 'string' || courseId.length > 200 || /[\u0000-\u001f\u007f]/.test(courseId)) throw invalid();
  if (body.kind === 'resource' && !courseId.trim() || body.kind === 'guide_source' && courseId !== '') throw invalid();
  return { event_id: body.event_id, kind: body.kind, resource_id: body.resource_id, course_id: courseId, attribution: body.attribution };
}

function reviewSnapshot(document, { includeHistorical = false } = {}) {
  const marker = validateCommunitySupportReviewMetadata(document);
  const baseline = new Set(marker.baseline_review_ids);
  const rows = [];
  for (const item of document.reviews) {
    if (!plain(item)) throw unavailable();
    const historical = baseline.has(item.id);
    if (historical && !includeHistorical) continue;
    if (!historical && item.user_id !== undefined && item.user_id !== null && identity(item.user_id) === null) throw unavailable();
    rows.push({ id: item.id, userId: historical ? null : identity(item.user_id), historical, active: isReviewPublicEligible(item) ? 1 : 0 });
  }
  return { epoch: marker.epoch, sequence: marker.sequence, baseline: JSON.stringify([...baseline].sort()), digest: hash(canonical(document)), rows };
}

/**
 * reviews.json is the durable complete desired-state snapshot, not an SQL transaction.
 * Its writer must atomically advance sequence with every mutation. Before exposing any
 * accounting result we project that snapshot in a SQLite transaction. A failed projection
 * returns 503; old data is never exposed as an up-to-date count. Only one JSON writer is supported.
 */
export class CommunitySupportService {
  constructor({ db, readReviews, assertActiveUser, enabled = false, downloadReporting = false, personalStats = false,
    requirePublicBaseline = false, now = Date.now, validateResource, fault = () => {} } = {}) {
    if (!db || typeof readReviews !== 'function' || typeof assertActiveUser !== 'function'
      || typeof now !== 'function' || typeof fault !== 'function') throw new TypeError('Community support requires database, review reader and account validator.');
    if (validateResource !== undefined && typeof validateResource !== 'function') throw new TypeError('Resource validator must be synchronous.');
    Object.assign(this, { db, readReviews, assertActiveUser, enabled: enabled === true, downloadReporting: downloadReporting === true,
      personalStats: personalStats === true, requirePublicBaseline: requirePublicBaseline === true, now, validateResource, fault });
    controlled(() => {
      const tables = presentTables(db);
      if (tables.length && tables.length !== TABLES.length) throw unavailable();
      db.transaction(() => db.exec(`
        CREATE TABLE IF NOT EXISTS community_support_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1),
          epoch TEXT NOT NULL, review_sequence INTEGER NOT NULL CHECK(review_sequence>=0),
          review_digest TEXT NOT NULL, baseline_ids TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=0), rate_secret TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS community_support_downloads (
          event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL, course_id TEXT NOT NULL,
          attribution TEXT NOT NULL CHECK(attribution IN ('account','community')), user_id INTEGER,
          identity_cleared INTEGER NOT NULL DEFAULT 0 CHECK(identity_cleared IN (0,1)), created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_support_downloads_user_idx ON community_support_downloads(user_id);
        CREATE TABLE IF NOT EXISTS community_support_reviews (
          review_id TEXT PRIMARY KEY, user_id INTEGER, active INTEGER NOT NULL CHECK(active IN (0,1)),
          identity_cleared INTEGER NOT NULL DEFAULT 0 CHECK(identity_cleared IN (0,1))
        );
        CREATE INDEX IF NOT EXISTS community_support_reviews_user_idx ON community_support_reviews(user_id,active);
        CREATE TABLE IF NOT EXISTS community_support_cleared_accounts (user_id INTEGER PRIMARY KEY, cleared_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS community_support_rate_limits (
          scope TEXT NOT NULL, subject_key TEXT NOT NULL, window_ms INTEGER NOT NULL,
          window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>=0), actor_user_id INTEGER,
          PRIMARY KEY(scope,subject_key,window_ms,window_start)
        );
        CREATE INDEX IF NOT EXISTS community_support_rate_actor_idx ON community_support_rate_limits(actor_user_id);
      `))();
    });
  }

  initializeReviews(document) { return this.reconcileReviews(document); }

  reconcileReviews(document) { return this.#reconcileDocument(document); }

  #reconcileDocument(document, { force = false, required = this.requirePublicBaseline } = {}) {
    return controlled(() => {
      return this.db.transaction(() => {
        const baseline = readCommunitySupportPublicBaselineStatus(this.db, { required });
        const source = reviewSnapshot(document, { includeHistorical: baseline.applied });
        let meta = this.db.prepare('SELECT * FROM community_support_meta WHERE singleton=1').get();
        if (meta) {
          safeCount(meta.revision); safeCount(meta.review_sequence);
          if (meta.version !== 1 || meta.epoch !== source.epoch || meta.baseline_ids !== source.baseline || source.sequence < meta.review_sequence) throw unavailable();
          if (source.sequence === meta.review_sequence) {
            if (source.digest !== meta.review_digest) throw unavailable();
            if (!force) return { revision: meta.revision, sequence: source.sequence };
          }
        } else {
          if (this.db.prepare('SELECT 1 FROM community_support_downloads LIMIT 1').get()
            || this.db.prepare('SELECT 1 FROM community_support_reviews LIMIT 1').get()) throw unavailable();
          this.db.prepare(`INSERT INTO community_support_meta(singleton,version,epoch,review_sequence,review_digest,baseline_ids,revision,rate_secret)
            VALUES(1,1,?,?,?,?,0,?)`).run(source.epoch, source.sequence, source.digest, source.baseline, randomBytes(32).toString('hex'));
        }
        const changed = this.#applyReviewProjection(source);
        this.fault('afterReviewProjection');
        this.db.prepare('UPDATE community_support_meta SET review_sequence=?,review_digest=? WHERE singleton=1').run(source.sequence, source.digest);
        if (changed) bumpRevision(this.db);
        const revision = this.db.prepare('SELECT revision FROM community_support_meta WHERE singleton=1').get().revision;
        return { revision, sequence: source.sequence };
      }).immediate();
    });
  }

  #applyReviewProjection(source) {
    const existing = new Map(this.db.prepare('SELECT * FROM community_support_reviews').all().map(row => [row.review_id, row]));
    const cleared = new Set(this.db.prepare('SELECT user_id FROM community_support_cleared_accounts').all().map(row => row.user_id));
    const upsert = this.db.prepare(`INSERT INTO community_support_reviews(review_id,user_id,active,identity_cleared) VALUES(?,?,?,?)
      ON CONFLICT(review_id) DO UPDATE SET user_id=excluded.user_id, active=excluded.active, identity_cleared=excluded.identity_cleared`);
    let changed = false;
    for (const row of source.rows) {
      const previous = existing.get(row.id);
      existing.delete(row.id);
      const scrubbed = !!(row.historical || previous?.identity_cleared || row.userId !== null && cleared.has(row.userId) || previous?.user_id != null && row.userId === null);
      const userId = scrubbed ? null : row.userId;
      if (previous?.user_id != null && userId != null && previous.user_id !== userId) throw unavailable();
      const identityCleared = scrubbed ? 1 : 0;
      if (!previous || previous.active !== row.active || previous.user_id !== userId || previous.identity_cleared !== identityCleared) {
        upsert.run(row.id, userId, row.active, identityCleared); changed = true;
      }
    }
    for (const row of existing.values()) {
      if (row.active) { this.db.prepare('UPDATE community_support_reviews SET active=0 WHERE review_id=?').run(row.review_id); changed = true; }
    }
    return changed;
  }

  publicBaselineStatus() { return readCommunitySupportPublicBaselineStatus(this.db); }
  publicBaselineReceipt() { return this.publicBaselineStatus().receipt; }

  /** Rebuild only the derived review rows. Preserve downloads, baseline receipt,
   * personal exclusions, cleared-account tombstones and the monotonic revision.
   */
  rebuildReviewProjection() {
    const document = this.readReviews();
    if (document?.then) throw unavailable();
    return this.#reconcileDocument(document, { force: true });
  }

  /** Explicit, one-time maintenance operation. Call with JSON writers frozen;
   * BEGIN IMMEDIATE serializes this transaction with successful download writes.
   * Constructor/startup never invokes this operation or adds the public baseline.
   */
  migratePublicBaseline({ resourceIds, migrationId = COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID } = {}) {
    if (migrationId !== COMMUNITY_SUPPORT_BASELINE_MIGRATION_ID) throw new PublicApiError(409, '公共基数迁移标识不匹配。', 'BASELINE_MIGRATION_CONFLICT');
    return controlled(() => this.db.transaction(() => {
      const existing = this.publicBaselineStatus();
      if (existing.applied) return { applied: true, replayed: true, receipt: existing.receipt };
      const originalMeta = this.db.prepare('SELECT * FROM community_support_meta WHERE singleton=1').get();
      if (!originalMeta) throw unavailable();
      if (!Array.isArray(resourceIds) || resourceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id))) throw invalid();
      const resources = [...new Set(resourceIds)].sort();
      const document = this.readReviews();
      if (document?.then) throw unavailable();
      // First reconcile any ordinary pre-migration changes with the old rule.
      // This remains inside this transaction and rolls back with the migration.
      this.#reconcileDocument(document, { required: false });
      const source = reviewSnapshot(document, { includeHistorical: true });
      const personalBefore = canonical(personalState(this.db));
      const publicBefore = this.#publicCounts(0);
      this.#applyReviewProjection(source); // deliberately bypass same-sequence fast path
      this.fault('afterPublicBaselineProjection');
      if (canonical(personalState(this.db)) !== personalBefore) throw unavailable();
      addBaselineColumns(this.db);
      bumpRevision(this.db);
      const publicAfter = this.#publicCounts(resources.length);
      const publicIds = source.rows.filter(row => row.active).map(row => row.id).sort();
      const receipt = {
        schemaVersion: 1, migrationId, projectionRuleVersion: 2, appliedAt: new Date(checkedTime(this.now)).toISOString(),
        source: { epoch: source.epoch, sequence: source.sequence, reviewsSha256: source.digest,
          resourceIdsSha256: hash(canonical(resources)), publicReviewIdsSha256: hash(canonical(publicIds)),
          personalExclusionIdsSha256: hash(source.baseline) },
        counts: { resourceCount: resources.length, publicReviewCount: publicIds.length,
          historicalPublicReviewCount: source.rows.filter(row => row.historical && row.active).length,
          successfulDownloadCount: publicBefore.flowers },
        publicBefore, publicAfter, personalStatsSha256: hash(personalBefore),
      };
      this.db.prepare(`UPDATE community_support_meta SET public_baseline_rule=2,public_resource_baseline=?,
        public_baseline_receipt=?,public_baseline_receipt_hash=? WHERE singleton=1`)
        .run(resources.length, canonical(receipt), hash(canonical(receipt)));
      this.fault('afterPublicBaselineReceipt');
      const checked = readCommunitySupportPublicBaselineStatus(this.db, { required: true });
      return { applied: true, replayed: false, receipt: checked.receipt };
    }).immediate());
  }

  #reconcile() {
    const document = this.readReviews();
    if (document?.then) throw unavailable();
    return this.reconcileReviews(document);
  }

  #active(userId) {
    const id = accountId(userId);
    if (this.db.prepare('SELECT 1 FROM community_support_cleared_accounts WHERE user_id=?').get(id)) throw authRequired();
    const result = this.assertActiveUser(id);
    if (result?.then || result === false || result === null) throw authRequired();
    return id;
  }

  #publicCounts(resourceBaseline) {
    const meta = this.db.prepare('SELECT revision FROM community_support_meta WHERE singleton=1').get();
    if (!meta) throw unavailable();
    const flowers = safeCount(safeCount(resourceBaseline) + safeCount(this.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n));
    const coins = safeCount(this.db.prepare('SELECT COUNT(*) AS n FROM community_support_reviews WHERE active=1').get().n);
    return { flowers, coins, revision: safeCount(meta.revision) };
  }

  #capability() {
    const baseline = readCommunitySupportPublicBaselineStatus(this.db, { required: this.requirePublicBaseline });
    const { flowers, coins, revision } = this.#publicCounts(baseline.resource_baseline);
    return { version: 1, enabled: true, revision, flowers, coins, review_rule: 'approved',
      download_reporting: this.downloadReporting, personal_stats: this.personalStats };
  }

  snapshot() {
    if (!this.enabled) return controlled(() => {
      if (this.db.prepare('SELECT 1 FROM community_support_meta WHERE singleton=1').get()) this.#reconcile();
      return { version: 1, enabled: false };
    });
    return controlled(() => this.db.transaction(() => { this.#reconcile(); return this.#capability(); }).immediate());
  }

  myStats(userId) {
    if (!this.enabled || !this.personalStats) throw unavailable();
    return controlled(() => this.db.transaction(() => {
      const id = this.#active(userId);
      this.#reconcile();
      return {
        flowers: safeCount(this.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads WHERE user_id=?').get(id).n),
        coins: safeCount(this.db.prepare('SELECT COUNT(*) AS n FROM community_support_reviews WHERE user_id=? AND active=1').get(id).n),
      };
    }).immediate());
  }

  #consumeLimits(event, userId, ip) {
    const meta = this.db.prepare('SELECT rate_secret FROM community_support_meta WHERE singleton=1').get();
    if (!meta || !/^[0-9a-f]{64}$/.test(meta.rate_secret)) throw unavailable();
    if (userId === null && (typeof ip !== 'string' || !ip.trim() || ip.length > 200)) throw unavailable();
    const source = userId === null ? `ip:${ip}` : `account:${userId}`;
    const digest = value => createHmac('sha256', meta.rate_secret).update(value).digest('hex');
    const sourceKey = digest(source);
    const resourceKey = digest(canonical([source, event.kind, event.resource_id, event.course_id]));
    const limits = COMMUNITY_SUPPORT_LIMITS[event.attribution];
    const now = checkedTime(this.now);
    const windows = [
      ['source', sourceKey, 60_000, limits.minute], ['source', sourceKey, 86_400_000, limits.day],
      ['resource', resourceKey, 60_000, limits.resourceMinute], ['resource', resourceKey, 86_400_000, limits.resourceDay],
    ];
    this.db.prepare('DELETE FROM community_support_rate_limits WHERE expires_at<=?').run(now);
    for (const [scope, key, width, limit] of windows) {
      const start = Math.floor(now / width) * width;
      const row = this.db.prepare('SELECT count FROM community_support_rate_limits WHERE scope=? AND subject_key=? AND window_ms=? AND window_start=?').get(scope, key, width, start);
      if (row && safeCount(row.count) >= limit) throw new PublicApiError(429, '下载记录过于频繁，请稍后再试。', 'RATE_LIMITED');
      this.db.prepare(`INSERT INTO community_support_rate_limits(scope,subject_key,window_ms,window_start,expires_at,count,actor_user_id)
        VALUES(?,?,?,?,?,1,?) ON CONFLICT(scope,subject_key,window_ms,window_start) DO UPDATE SET count=count+1`)
        .run(scope, key, width, start, safeCount(start + width), userId);
    }
  }

  recordDownload(body, { userId = null, ip = '' } = {}) {
    if (!this.enabled || !this.downloadReporting) throw unavailable();
    const event = validateSupportDownloadEvent(body);
    return controlled(() => this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM community_support_downloads WHERE event_id=?').get(event.event_id);
      if (previous?.identity_cleared) throw conflict();
      const actor = event.attribution === 'account' ? this.#active(userId) : null;
      if (event.attribution === 'community' && userId !== null) throw invalid();
      if (previous && (previous.kind !== event.kind || previous.resource_id !== event.resource_id || previous.course_id !== event.course_id
        || previous.attribution !== event.attribution || previous.user_id !== actor)) throw conflict();
      if (!previous) {
        if (!this.validateResource) throw unavailable();
        const valid = this.validateResource(event);
        if (valid?.then) throw unavailable();
        if (valid !== true) throw new PublicApiError(404, '资料不存在或不可公开访问。', 'RESOURCE_NOT_FOUND');
      }
      this.#reconcile();
      if (!previous) {
        this.#consumeLimits(event, actor, ip);
        // Keep the final account check adjacent to the actual write, including deletion-ledger policy.
        if (actor !== null) this.#active(actor);
        this.db.prepare(`INSERT INTO community_support_downloads(event_id,kind,resource_id,course_id,attribution,user_id,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(event.event_id, event.kind, event.resource_id, event.course_id, event.attribution, actor, checkedTime(this.now));
        this.fault('afterDownloadInsert');
        bumpRevision(this.db);
        this.fault('afterDownloadRevision');
      }
      return { event_id: event.event_id, recorded: true, community_support: this.#capability() };
    }).immediate());
  }

  clearAccount(userId) { return scrubCommunitySupportAccount(this.db, userId, { now: this.now, fault: this.fault }); }
}
