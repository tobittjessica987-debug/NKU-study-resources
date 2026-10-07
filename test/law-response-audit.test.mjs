import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { AdminAccountsStore } from '../server/admin-accounts-store.mjs';
import { LawEnforcementLogStore } from '../server/law-enforcement-store.mjs';
import { readEnvelope } from '../server/durable-log.mjs';
import { queryAuditMetadata, lawResultAuditMetadata, recordLawResponseAudit } from '../server/admin-audit.mjs';

const BASE = 1_790_000_000_000;
const diskFull = () => Object.assign(new Error('synthetic storage failure'), { code: 'ENOSPC' });

function fixture(t, route = '/admin-api/law-export') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'law-audit-synthetic-'));
  const dbPath = path.join(directory, 'state.sqlite');
  const accountsStore = new AdminAccountsStore({ dbPath, alert: () => {} });
  const lawLogStore = new LawEnforcementLogStore({ dbPath });
  lawLogStore.writer.alert = () => {};
  t.after(() => { accountsStore.close(); lawLogStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = { username: 'synthetic-admin', action: `GET ${route}`, method: 'GET', path: route, now: BASE };
  const summary = { scope: 'account', criteriaHash: 'synthetic-criteria-hash', effectiveRange: { from: 0, to: BASE, inclusive: true, scope: ['security_logs', 'admin_audit'] }, counts: { account: 1, reviews: 345, feedback: 0, security_logs: 455, admin_audit: 455 }, complete: true, sha256: 'a'.repeat(64) };
  const event = { eventId: accountsStore.begin({ ...base, detail: JSON.stringify(summary) }), action: base.action, target: 'user:1', summary };
  const record = () => recordLawResponseAudit({ accountsStore, lawLogStore, base, event, actor: base.username, status: 200, queryType: 'account', exported: route.endsWith('export') });
  const adminRows = () => accountsStore.db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all();
  const lawRows = () => lawLogStore.db.prepare('SELECT * FROM law_enforcement_logs ORDER BY id').all();
  return { accountsStore, lawLogStore, event, record, adminRows, lawRows };
}

test('law response audits persist a shared preparation and response decision before a successful response', t => {
  const f = fixture(t);
  let sent = false;
  f.record(); sent = true;
  assert.equal(sent, true);
  assert.equal(f.adminRows().length, 1); assert.equal(f.adminRows()[0].status, 200);
  assert.equal(f.adminRows()[0].event_id, f.event.eventId);
  assert.equal(JSON.parse(f.adminRows()[0].detail).delivery, 'response_ready');
  const preparation = JSON.parse(f.lawRows()[0].result_summary);
  assert.equal(f.lawRows()[0].event_id, f.event.eventId);
  assert.equal(preparation.status, 0); assert.equal(preparation.intendedStatus, 200);
  assert.equal(preparation.outcome, 'prepared'); assert.equal(preparation.delivery, 'not_confirmed');
  assert.equal(preparation.sha256, 'a'.repeat(64));
  assert.equal(f.accountsStore.writer.health().pending, 0); assert.equal(f.lawLogStore.writer.health().pending, 0);
});

for (const phase of ['beforeRename', 'afterRename']) {
  test(`law outcome ${phase} failure refuses response and records admin 503 under the original event id`, t => {
    const f = fixture(t);
    f.lawLogStore.writer.fault = current => { if (current === phase) throw diskFull(); };
    let sent = false;
    assert.throws(() => { f.record(); sent = true; }, error => error.statusCode === 503 && error.code === 'LAW_AUDIT_UNAVAILABLE' && error.failedSink === 'law');
    assert.equal(sent, false);
    const rows = f.adminRows(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 503); assert.equal(rows[0].event_id, f.event.eventId);
    const detail = JSON.parse(rows[0].detail);
    assert.equal(detail.outcome, 'error'); assert.equal(detail.delivery, 'not_delivered');
    assert.equal(detail.failedSink, 'law'); assert.equal(detail.code, 'LAW_AUDIT_UNAVAILABLE');
    assert.equal(detail.storageCode, 'LOG_OUTCOME_UNKNOWN');
    f.lawLogStore.writer.fault = () => {};
    f.lawLogStore.writer.replay();
    assert.ok(f.lawRows().every(row => JSON.parse(row.result_summary).outcome === 'prepared'));
    assert.ok(f.lawRows().every(row => JSON.parse(row.result_summary).status === 0));
    assert.equal(f.adminRows().some(row => row.status === 200), false);
  });

  test(`admin outcome ${phase} failure leaves a new correlated law failure and recovery never reports 200`, t => {
    const f = fixture(t);
    f.accountsStore.writer.fault = current => { if (current === phase) throw diskFull(); };
    let sent = false;
    assert.throws(() => { f.record(); sent = true; }, error => error.statusCode === 503 && error.code === 'LAW_AUDIT_UNAVAILABLE' && error.failedSink === 'admin');
    assert.equal(sent, false); assert.equal(f.adminRows().length, 0);
    const rows = f.lawRows(); assert.equal(rows.length, 2);
    assert.equal(rows[0].event_id, f.event.eventId); assert.notEqual(rows[1].event_id, f.event.eventId);
    const failure = JSON.parse(rows[1].result_summary);
    assert.equal(failure.relatedEventId, f.event.eventId); assert.equal(failure.preparationEventId, f.event.eventId);
    assert.equal(failure.status, 503); assert.equal(failure.delivery, 'not_delivered'); assert.equal(failure.outcome, 'error');
    const queued = readEnvelope(f.accountsStore.writer.file(f.event.eventId), 'admin');
    if (phase === 'afterRename') { assert.equal(queued.pending, false); assert.equal(queued.row[5], 503); }
    else assert.equal(queued.pending, true);
    f.accountsStore.writer.fault = () => {};
    f.accountsStore.writer.replay();
    assert.equal(f.accountsStore.writer.health().pending, 0);
    assert.equal(f.adminRows().length, phase === 'afterRename' ? 2 : 1);
    assert.equal(f.adminRows().find(row => row.event_id === f.event.eventId).status, phase === 'afterRename' ? 503 : 0);
    assert.equal(f.adminRows().some(row => row.status === 200), false);
    if (phase === 'afterRename') assert.ok(f.adminRows().every(row => JSON.parse(row.detail).outcome === 'error'));
    else assert.ok(f.adminRows()[0].detail.startsWith('outcome=interrupted;'));
  });
}

test('an already immutable administrator row receives a new failure event instead of an ineffective same-id overwrite', t => {
  const f = fixture(t);
  const original = f.accountsStore.audit.bind(f.accountsStore);
  let calls = 0;
  f.accountsStore.audit = value => { original(value); if (calls++ === 0) throw diskFull(); };
  assert.throws(f.record, error => error.statusCode === 503);
  const rows = f.adminRows(); assert.equal(rows.length, 2);
  assert.equal(rows[0].event_id, f.event.eventId); assert.equal(rows[0].status, 200);
  assert.notEqual(rows[1].event_id, f.event.eventId); assert.equal(rows[1].status, 503);
  assert.equal(JSON.parse(rows[1].detail).relatedEventId, f.event.eventId);
  const lawFailure = JSON.parse(f.lawRows()[1].result_summary);
  assert.equal(lawFailure.relatedEventId, f.event.eventId); assert.equal(lawFailure.delivery, 'not_delivered');
});

test('mixed admin afterRename then correction beforeRename failures append a new linked 503 visible in account evidence', t => {
  const f = fixture(t);
  let writes = 0;
  f.accountsStore.writer.fault = phase => {
    if (phase === 'beforeRename') {
      writes++;
      if (writes === 2) throw diskFull();
    }
    if (phase === 'afterRename' && writes === 1) throw diskFull();
  };
  assert.throws(f.record, error => error.statusCode === 503 && error.recoveryStorageCode === 'LOG_OUTCOME_UNKNOWN' && !error.failureAuditStorageCode);
  assert.equal(writes, 3, 'the additional failure event is a bounded third attempt');
  const queued = readEnvelope(f.accountsStore.writer.file(f.event.eventId), 'admin');
  assert.equal(queued.pending, false); assert.equal(queued.row[5], 200, 'the failed correction cannot pretend the original queue changed');
  const failures = f.adminRows(); assert.equal(failures.length, 1); assert.equal(failures[0].status, 503);
  assert.notEqual(failures[0].event_id, f.event.eventId); assert.equal(JSON.parse(failures[0].detail).relatedEventId, f.event.eventId);
  f.accountsStore.writer.fault = () => {}; f.accountsStore.writer.replay();
  const accountEvidence = f.accountsStore.queryAudit({ target: 'user:1', includeArchived: true });
  assert.equal(accountEvidence.total, 2);
  const original = accountEvidence.items.find(row => row.event_id === f.event.eventId);
  const failure = accountEvidence.items.find(row => row.status === 503);
  assert.equal(original.status, 200); assert.equal(JSON.parse(failure.detail).relatedEventId, original.event_id);
  assert.equal(JSON.parse(failure.detail).delivery, 'not_delivered');
  assert.equal(JSON.parse(f.lawRows()[1].result_summary).relatedEventId, original.event_id);
});

test('persistent administrator journal failure has bounded attempts and keeps correlated law evidence rather than claiming a stored admin result', t => {
  const f = fixture(t);
  let attempts = 0;
  f.accountsStore.writer.fault = phase => { if (phase === 'beforeRename') { attempts++; throw diskFull(); } };
  assert.throws(f.record, error => error.statusCode === 503 && error.recoveryStorageCode === 'LOG_OUTCOME_UNKNOWN' && error.failureAuditStorageCode === 'LOG_OUTCOME_UNKNOWN');
  assert.equal(attempts, 3); assert.equal(f.adminRows().length, 0);
  assert.equal(readEnvelope(f.accountsStore.writer.file(f.event.eventId), 'admin').pending, true);
  assert.equal(JSON.parse(f.lawRows()[1].result_summary).delivery, 'not_delivered');
  assert.equal(JSON.parse(f.lawRows()[1].result_summary).relatedEventId, f.event.eventId);
});

test('both unwritable sinks refuse response with bounded attempts and preserve the initial recoverable intent', t => {
  const f = fixture(t);
  let adminAttempts = 0, lawAttempts = 0;
  f.accountsStore.writer.fault = phase => { if (phase === 'beforeRename') { adminAttempts++; throw diskFull(); } };
  f.lawLogStore.writer.fault = phase => { if (phase === 'beforeRename') { lawAttempts++; throw diskFull(); } };
  assert.throws(f.record, error => error.statusCode === 503 && error.secondarySink === 'admin');
  assert.equal(adminAttempts, 1); assert.equal(lawAttempts, 1);
  assert.equal(f.adminRows().length, 0); assert.equal(f.lawRows().length, 0);
  assert.equal(readEnvelope(f.accountsStore.writer.file(f.event.eventId), 'admin').pending, true);
  f.accountsStore.writer.fault = () => {}; f.accountsStore.writer.replay();
  assert.equal(f.adminRows()[0].status, 0); assert.ok(f.adminRows()[0].detail.includes('interrupted'));
});

test('effective default times and exact action hashes are auditable without logging free-form query text', () => {
  const raw = new URL('http://127.0.0.1/admin-api/law-export?type=account&value=synthetic-private-openid&audit_action=GET%20%2Fadmin-api%2Freviews&action=%20review.submit%20');
  const initial = queryAuditMetadata(raw, 'synthetic-audit-secret');
  const effective = lawResultAuditMetadata({
    query: { type: 'account', reference: null, filters: { action: 'review.submit', audit_action: 'GET /admin-api/reviews' } },
    range: { from_ms: 0, to_ms: BASE, inclusive: true, scope: ['security_logs', 'admin_audit'] },
  }, 'synthetic-audit-secret');
  const output = { ...initial, ...effective };
  assert.deepEqual(output.effectiveRange, { from: 0, to: BASE, inclusive: true, scope: ['security_logs', 'admin_audit'] });
  assert.equal(output.effectiveFilters.action.match, 'exact'); assert.equal(output.effectiveFilters.action.value, 'review.submit');
  assert.equal(output.effectiveFilters.audit_action.value, null); assert.match(output.effectiveFilters.audit_action.hash, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(output).includes('synthetic-private-openid'), false);
  assert.equal(JSON.stringify(output).includes('GET /admin-api/reviews'), false);
  assert.equal(typeof output.criteriaHash, 'string');
  const unfiltered = lawResultAuditMetadata({ query: { type: 'review', reference: 'SYNTHETIC-CASE', filters: {} }, range: { from_ms: 0, to_ms: BASE, inclusive: true, scope: ['security_logs', 'admin_audit'] } }, 'synthetic-secret');
  assert.equal(unfiltered.effectiveFilters.action.match, 'all'); assert.equal(unfiltered.effectiveFilters.audit_action.match, 'all');
});

for (const sink of ['law', 'admin']) {
  test(`real local HTTP ${sink} journal failure sends 503 without export headers or payload`, async t => {
    const f = fixture(t);
    const failedWriter = sink === 'law' ? f.lawLogStore.writer : f.accountsStore.writer;
    failedWriter.fault = phase => { if (phase === 'beforeRename') throw diskFull(); };
    let successfulHeaders = 0;
    const server = http.createServer((req, res) => {
      const original = res.writeHead.bind(res);
      let recorded = false;
      res.writeHead = (status, ...args) => {
        if (!recorded) { recorded = true; f.record(); }
        if (status === 200) successfulHeaders++;
        return original(status, ...args);
      };
      try {
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="synthetic.json"' });
        res.end('{"syntheticPrivatePayload":"must-not-be-delivered"}');
      } catch (error) {
        res.writeHead(error.statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: error.code, audit_event_id: f.event.eventId }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin-api/law-export`);
    const body = await response.text();
    assert.equal(response.status, 503); assert.equal(response.headers.has('content-disposition'), false);
    assert.equal(body.includes('syntheticPrivatePayload'), false); assert.equal(successfulHeaders, 0);
    assert.equal(JSON.parse(body).code, 'LAW_AUDIT_UNAVAILABLE');
    assert.equal(JSON.parse(body).audit_event_id, f.event.eventId);
  });
}
