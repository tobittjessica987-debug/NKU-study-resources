import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { CommunitySupportService, hasCommunitySupportLedger, scrubCommunitySupportAccount } from '../server/community-support-service.mjs';
import { PublicApiError } from '../server/public-api-errors.mjs';

const serviceUrl = new URL('../server/community-support-service.mjs', import.meta.url).href;
const databaseUrl = import.meta.resolve('better-sqlite3');
const timestamp = '2026-10-23T00:00:00.000Z';

function review(id, userId = 1, changes = {}) {
  return { id, schemaVersion: 2, courseTitle: 'Course', teacher: 'Teacher', content: 'A useful course review.', rating: 5,
    publicationState: 'approved', status: 'approved', decisionSource: 'admin_decision', reviewedBy: 'reviewer', reviewedAt: timestamp,
    hidden: false, ...(userId === null ? {} : { user_id: userId }), ...changes };
}
function document(reviews = [], baseline = reviews.map(item => item.id)) {
  return { reviews, community_support_ledger: { version: 1, epoch: randomUUID(), sequence: 0, baseline_review_ids: baseline } };
}
function event(index = 0, changes = {}) {
  return { event_id: `mp_download_event_${index}`, kind: 'resource', resource_id: 'resource-1', course_id: 'course-1', attribution: 'account', ...changes };
}
function code(expected, status) { return error => error.code === expected && (status === undefined || error.statusCode === status); }

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nkustudy-community-support-'));
  const dbPath = path.join(directory, 'state.sqlite');
  let db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 10000');
  let current = options.document || document();
  let clock = Date.parse(timestamp);
  let faultStage = null;
  const deleted = new Set();
  let resourceAllowed = true;
  const dependencies = {
    readReviews: () => structuredClone(current),
    assertActiveUser: id => { if (deleted.has(id)) throw new PublicApiError(401, 'Unavailable', 'AUTH_REQUIRED'); return { id }; },
    enabled: true, downloadReporting: true, personalStats: true,
    validateResource: () => resourceAllowed,
    now: () => clock,
    fault: stage => { if (stage === faultStage) throw new Error('synthetic private storage fault'); },
    ...options,
  };
  delete dependencies.document;
  let service = new CommunitySupportService({ ...dependencies, db });
  if (options.initialize !== false) service.initializeReviews(current);
  t.after(() => { if (db.open) db.close(); });
  return {
    get service() { return service; }, get db() { return db; }, get document() { return current; }, dbPath, deleted,
    mutate(fn) { fn(current); current.community_support_ledger.sequence++; },
    replace(value) { current = value; }, setFault(value) { faultStage = value; }, advance(ms) { clock += ms; },
    allowResource(value) { resourceAllowed = value; },
    reopen() { db.close(); db = new Database(dbPath); db.pragma('busy_timeout = 10000'); service = new CommunitySupportService({ ...dependencies, db }); return service; },
  };
}

test('disabled capability discloses no counts and write/personal switches fail closed', t => {
  const f = fixture(t, { enabled: false });
  assert.deepEqual(f.service.snapshot(), { version: 1, enabled: false });
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE', 503));
  assert.throws(() => f.service.myStats(1), code('SUPPORT_UNAVAILABLE', 503));
  f.mutate(doc => doc.reviews.push(review('after-disabled')));
  f.service.snapshot();
  assert.equal(f.db.prepare('SELECT active FROM community_support_reviews').get().active, 1);
  const readOnly = fixture(t, { downloadReporting: false, personalStats: false });
  assert.throws(() => readOnly.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE'));
  assert.throws(() => readOnly.service.myStats(1), code('SUPPORT_UNAVAILABLE'));
});

test('download exact replay returns success once, conflicts preserve all accounting', t => {
  const f = fixture(t);
  const first = f.service.recordDownload(event(), { userId: 1 });
  assert.equal(first.recorded, true);
  assert.equal(first.community_support.flowers, 1);
  assert.equal(first.community_support.revision, 1);
  f.allowResource(false); // A previously accepted exact event is still an accepted event.
  assert.deepEqual(f.service.recordDownload(event(), { userId: 1 }), first);
  for (const [body, actor] of [[event(0, { resource_id: 'other' }), 1], [event(), 2], [event(0, { attribution: 'community' }), null]]) {
    assert.throws(() => f.service.recordDownload(body, { userId: actor, ip: '192.0.2.1' }), code('EVENT_CONFLICT', 409));
  }
  assert.deepEqual(f.service.myStats(1), { flowers: 1, coins: 0 });
  assert.deepEqual(f.service.myStats(2), { flowers: 0, coins: 0 });
  assert.equal(f.db.prepare('SELECT SUM(count) AS n FROM community_support_rate_limits').get().n, 4);
});

test('anonymous attribution remains public only and account bodies cannot select identity', t => {
  const f = fixture(t);
  f.service.recordDownload(event(0, { attribution: 'community' }), { ip: '198.51.100.1' });
  assert.deepEqual(f.service.myStats(1), { flowers: 0, coins: 0 });
  assert.equal(f.service.snapshot().flowers, 1);
  assert.throws(() => f.service.recordDownload(event(1), {}), code('AUTH_REQUIRED', 401));
  assert.throws(() => f.service.recordDownload(event(2, { attribution: 'community' }), { userId: 1, ip: '198.51.100.1' }), code('INVALID_SUPPORT_EVENT', 400));
  for (const addition of [{ user_id: 2 }, { flowers: 100 }, { url: 'https://example.invalid/private' }]) {
    assert.throws(() => f.service.recordDownload({ ...event(3), ...addition }, { userId: 1 }), code('INVALID_SUPPORT_EVENT', 400));
  }
  const rows = JSON.stringify(f.db.prepare('SELECT * FROM community_support_rate_limits').all());
  assert.equal(rows.includes('198.51.100.1'), false);
});

test('invalid event shapes and unknown resources never add flowers', t => {
  const f = fixture(t);
  for (const body of [null, [], {}, event(1, { event_id: 'short' }), event(1, { event_id: 'x'.repeat(97) }),
    event(1, { kind: 'payment' }), event(1, { resource_id: '' }), event(1, { resource_id: 'x'.repeat(201) }),
    event(1, { course_id: '' }), event(1, { course_id: null }), event(1, { attribution: 'anything' }),
    event(1, { kind: 'guide_source', course_id: 'unexpected' }), event(1, { kind: 'guide_source', course_id: null })]) {
    assert.throws(() => f.service.recordDownload(body, { userId: 1 }), code('INVALID_SUPPORT_EVENT', 400));
  }
  f.allowResource(false);
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('RESOURCE_NOT_FOUND', 404));
  assert.equal(f.service.snapshot().flowers, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_rate_limits').get().n, 0);
});

test('guide_source requires a known source and an empty course scope', t => {
  const f = fixture(t);
  const result = f.service.recordDownload(event(0, { kind: 'guide_source', resource_id: 'source-id', course_id: '' }), { userId: 1 });
  assert.equal(result.community_support.flowers, 1);
});

test('account validity is checked again at insertion and async validators cannot bypass admission', t => {
  let calls = 0;
  const f = fixture(t, { assertActiveUser: () => {
    if (++calls > 1) throw new PublicApiError(401, 'Unavailable', 'AUTH_REQUIRED');
    return { id: 1 };
  } });
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('AUTH_REQUIRED', 401));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_rate_limits').get().n, 0);
  const badResource = fixture(t, { validateResource: async () => true });
  assert.throws(() => badResource.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE', 503));
  assert.equal(badResource.service.snapshot().flowers, 0);
});

test('review lifecycle projects approved, repeat, hidden, restored and removed without duplicate coins', t => {
  const f = fixture(t, { document: document([review('historical')]) });
  assert.equal(f.service.snapshot().coins, 0);
  f.mutate(doc => doc.reviews.push(review('new', 1, { publicationState: 'pending', status: 'pending' })));
  assert.equal(f.service.snapshot().coins, 0);
  f.mutate(doc => Object.assign(doc.reviews[1], { publicationState: 'approved', status: 'approved' }));
  assert.equal(f.service.snapshot().coins, 1);
  const approvedRevision = f.service.snapshot().revision;
  assert.equal(f.service.snapshot().revision, approvedRevision);
  f.mutate(doc => { doc.reviews[1].content = 'Edited but still one review.'; });
  assert.equal(f.service.snapshot().coins, 1);
  f.mutate(doc => { doc.reviews[1].hidden = true; });
  assert.equal(f.service.snapshot().coins, 0);
  f.mutate(doc => { doc.reviews[1].hidden = false; });
  assert.equal(f.service.snapshot().coins, 1);
  assert.deepEqual(f.service.myStats(1), { flowers: 0, coins: 1 });
  f.mutate(doc => { doc.reviews = doc.reviews.filter(item => item.id !== 'new'); });
  assert.equal(f.service.snapshot().coins, 0);
  f.mutate(doc => doc.reviews.push(review('new')));
  assert.equal(f.service.snapshot().coins, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM community_support_reviews WHERE review_id='new'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM community_support_reviews WHERE review_id='historical'").get().n, 0);
});

test('canonical public gate excludes status-only approval and accounts remain isolated', t => {
  const f = fixture(t);
  f.mutate(doc => doc.reviews.push(review('a', 1), review('b', 2), review('status-only', 1, { decisionSource: 'forged' }),
    review('blocked', 1, { publicationBlocked: true }), review('anonymous', null)));
  assert.equal(f.service.snapshot().coins, 3);
  assert.deepEqual(f.service.myStats(1), { flowers: 0, coins: 1 });
  assert.deepEqual(f.service.myStats(2), { flowers: 0, coins: 1 });
  assert.throws(() => f.service.myStats('1'), code('AUTH_REQUIRED'));
});

test('projection rejects old sequence, altered same sequence, epoch changes and baseline edits', t => {
  const f = fixture(t);
  const before = structuredClone(f.document);
  f.mutate(doc => doc.reviews.push(review('new')));
  const good = structuredClone(f.document);
  const snapshot = f.service.snapshot();
  for (const bad of [before, { ...good, reviews: [review('different')] },
    { ...good, community_support_ledger: { ...good.community_support_ledger, epoch: randomUUID() } },
    { ...good, community_support_ledger: { ...good.community_support_ledger, sequence: 2, baseline_review_ids: ['new'] } },
    { reviews: good.reviews }]) {
    f.replace(bad);
    assert.throws(() => f.service.snapshot(), code('SUPPORT_UNAVAILABLE', 503));
    assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE', 503));
  }
  f.replace(good);
  assert.deepEqual(f.service.snapshot(), snapshot);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n, 0);
});

test('projection failure returns no stale counts and restart reconciles the durable complete snapshot', t => {
  const f = fixture(t);
  f.mutate(doc => doc.reviews.push(review('new')));
  f.setFault('afterReviewProjection');
  assert.throws(() => f.service.snapshot(), code('SUPPORT_UNAVAILABLE', 503));
  assert.throws(() => f.service.myStats(1), code('SUPPORT_UNAVAILABLE', 503));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_reviews').get().n, 0);
  assert.equal(f.db.prepare('SELECT review_sequence FROM community_support_meta').get().review_sequence, 0);
  f.setFault(null); f.reopen();
  assert.equal(f.service.snapshot().coins, 1);
  const previous = f.service.snapshot();
  f.reopen();
  assert.deepEqual(f.service.snapshot(), previous);
});

test('download write failure rolls back event, counters, revision and consumed limits', t => {
  const f = fixture(t);
  const original = f.service.snapshot();
  for (const stage of ['afterDownloadInsert', 'afterDownloadRevision']) {
    f.setFault(stage);
    assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE', 503));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_rate_limits').get().n, 0);
    assert.deepEqual(f.service.snapshot(), original);
  }
  f.setFault(null);
  assert.equal(f.service.recordDownload(event(), { userId: 1 }).community_support.flowers, 1);
});

test('per-source and per-resource limits persist across restart and replay uses no additional quota', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.service.recordDownload(event(i), { userId: 1 });
  const before = f.service.snapshot();
  f.reopen();
  assert.throws(() => f.service.recordDownload(event(5), { userId: 1 }), code('RATE_LIMITED', 429));
  assert.equal(f.service.recordDownload(event(0), { userId: 1 }).recorded, true);
  assert.deepEqual(f.service.snapshot(), before);
  f.advance(60_000);
  assert.equal(f.service.recordDownload(event(5), { userId: 1 }).community_support.flowers, 6);
  for (let i = 6; i < 35; i++) f.service.recordDownload(event(i, { resource_id: `resource-${i}` }), { userId: 1 });
  assert.throws(() => f.service.recordDownload(event(35, { resource_id: 'another' }), { userId: 1 }), code('RATE_LIMITED', 429));
  assert.equal(f.service.snapshot().flowers, 35);
});

test('anonymous minute and day limits apply to durable source and resource buckets', t => {
  const f = fixture(t);
  const anonymous = i => event(i, { attribution: 'community', resource_id: `resource-${i}` });
  for (let minute = 0; minute < 6; minute++) {
    for (let i = 0; i < 10; i++) f.service.recordDownload(anonymous(minute * 10 + i), { ip: '203.0.113.2' });
    assert.throws(() => f.service.recordDownload(anonymous(1000 + minute), { ip: '203.0.113.2' }), code('RATE_LIMITED'));
    f.advance(60_000);
  }
  f.reopen();
  assert.throws(() => f.service.recordDownload(anonymous(100), { ip: '203.0.113.2' }), code('RATE_LIMITED', 429));
  assert.equal(f.service.snapshot().flowers, 60);
  f.advance(86_400_000);
  assert.equal(f.service.recordDownload(anonymous(100), { ip: '203.0.113.2' }).community_support.flowers, 61);
});

test('account cleanup preserves public totals, removes linkage, rejects original replay and prevents source reattachment', t => {
  const f = fixture(t);
  f.mutate(doc => doc.reviews.push(review('a')));
  f.service.recordDownload(event(), { userId: 1 });
  const before = f.service.snapshot();
  assert.equal(f.service.clearAccount(1).cleared, true);
  const after = f.service.snapshot();
  assert.equal(after.flowers, before.flowers); assert.equal(after.coins, before.coins);
  assert.throws(() => f.service.myStats(1), code('AUTH_REQUIRED'));
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('EVENT_CONFLICT', 409));
  assert.throws(() => f.service.recordDownload(event(1), { userId: 1 }), code('AUTH_REQUIRED', 401));
  assert.equal(f.db.prepare('SELECT user_id FROM community_support_reviews').get().user_id, null);
  assert.equal(f.db.prepare('SELECT user_id FROM community_support_downloads').get().user_id, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_rate_limits WHERE actor_user_id=1').get().n, 0);
  f.mutate(doc => { doc.reviews[0].content = 'Still carries a stale user_id until the JSON cleanup resumes.'; });
  f.reopen();
  assert.equal(f.service.snapshot().coins, 1);
  assert.equal(f.db.prepare('SELECT user_id FROM community_support_reviews').get().user_id, null);
  assert.equal(f.service.clearAccount(1).changed, false);
});

test('account scrub failure is atomic and standalone restore helper never creates tables', t => {
  const empty = new Database(':memory:'); t.after(() => empty.close());
  assert.equal(hasCommunitySupportLedger(empty), false);
  assert.deepEqual(scrubCommunitySupportAccount(empty, 1), { installed: false, cleared: false });
  assert.equal(hasCommunitySupportLedger(empty), false);
  const f = fixture(t); f.service.recordDownload(event(), { userId: 1 });
  assert.equal(hasCommunitySupportLedger(f.db), true);
  f.setFault('afterAccountScrub');
  assert.throws(() => f.service.clearAccount(1), code('SUPPORT_UNAVAILABLE', 503));
  assert.deepEqual(f.service.myStats(1), { flowers: 1, coins: 0 });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_cleared_accounts').get().n, 0);
});

test('overflow and malformed snapshots fail closed without changing durable accounting', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE community_support_meta SET revision=?').run(Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.service.recordDownload(event(), { userId: 1 }), code('SUPPORT_UNAVAILABLE'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_rate_limits').get().n, 0);
  f.mutate(doc => doc.reviews.push(review('new')));
  assert.throws(() => f.service.snapshot(), code('SUPPORT_UNAVAILABLE'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_reviews').get().n, 0);
});

test('100 same-event calls on four concurrent SQLite connections record exactly one flower', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const barrier = new SharedArrayBuffer(4);
  const state = new Int32Array(barrier);
  const script = `
    import { parentPort, workerData } from 'node:worker_threads';
    import Database from ${JSON.stringify(databaseUrl)};
    import { CommunitySupportService } from ${JSON.stringify(serviceUrl)};
    const db = new Database(workerData.path); db.pragma('busy_timeout = 10000');
    const service = new CommunitySupportService({ db, readReviews: () => workerData.document,
      assertActiveUser: id => ({id}), validateResource: () => true, enabled:true,downloadReporting:true,personalStats:true });
    parentPort.postMessage({ready:true});
    Atomics.wait(new Int32Array(workerData.barrier),0,0);
    try {
      for(let i=0;i<25;i++) {
        const result=service.recordDownload(workerData.event,{userId:1});
        if(result.recorded!==true || result.community_support.flowers!==1) throw Error('Unexpected replay result');
      }
      db.close(); parentPort.postMessage({done:true});
    } catch(error) {db.close(); parentPort.postMessage({error:error.code||error.message});}
  `;
  let ready = 0;
  const completions = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, workerData: { path: f.dbPath, document: f.document, event: event(), barrier } });
    worker.on('message', message => {
      if (message.ready && ++ready === 4) { Atomics.store(state, 0, 1); Atomics.notify(state, 0); }
      if (message.error) reject(new Error(message.error));
      if (message.done) resolve();
    });
    worker.on('error', reject);
    worker.on('exit', exit => { if (exit) reject(new Error(`Worker exited ${exit}`)); });
    t.after(() => worker.terminate());
  }));
  await Promise.all(completions);
  assert.deepEqual(f.service.myStats(1), { flowers: 1, coins: 0 });
  assert.equal(f.service.snapshot().revision, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM community_support_downloads').get().n, 1);
});
