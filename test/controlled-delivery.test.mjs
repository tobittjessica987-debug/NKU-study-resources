import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syntheticDeliveryRecord, validateControlledDelivery } from '../scripts/verify-controlled-delivery.mjs';

const cli = path.resolve(import.meta.dirname, '../scripts/verify-controlled-delivery.mjs');
const codes = report => report.failures.map(failure => failure.code);
const runCli = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('synthetic archived delivery has a digest of the actual synthetic bytes and checks declarations only', () => {
  const record = syntheticDeliveryRecord();
  const before = structuredClone(record);
  const payload = Buffer.from('{"synthetic":true,"records":[{"occurred_at":"2026-10-07T10:01:00+08:00","user_id":"synthetic-user-1","action":"synthetic.login"}]}\n');
  assert.equal(record.collection.artifact.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.equal(record.collection.artifact.bytes, payload.length);
  const report = validateControlledDelivery(record);
  assert.equal(report.ok, true);
  assert.equal(report.outcome, 'archived_delivery_record');
  assert.equal(report.recordKind, 'synthetic');
  assert.equal(report.evidenceBoundary, 'record_consistency_only');
  for (const field of ['externalDeliveryVerified', 'productionDataRead', 'dataSent']) assert.equal(report[field], false);
  assert.deepEqual(record, before, 'validation must not change the register');
  record.synthetic = false;
  assert.equal(validateControlledDelivery(record).recordKind, 'operator_record');
  assert.equal(validateControlledDelivery(record).externalDeliveryVerified, false);
});

test('unverified and excessive requests can be archived as refusals without supplying data', () => {
  const unknown = syntheticDeliveryRecord('refuse');
  assert.equal(validateControlledDelivery(unknown).outcome, 'archived_refusal_record');
  const excessive = syntheticDeliveryRecord('refuse');
  excessive.verification.subject = true;
  excessive.request.subjectRef = 'synthetic-unit';
  excessive.decision.refusalCode = 'out_of_scope';
  excessive.decision.reasonRef = 'synthetic-request-demands-unrelated-users';
  excessive.request.scope.selectors.push({ kind: 'user_id', value: 'synthetic-unrelated-user' });
  assert.equal(validateControlledDelivery(excessive).ok, true);
  for (const field of ['collection', 'delivery', 'receipt']) {
    const failed = structuredClone(unknown);
    failed[field] = syntheticDeliveryRecord()[field];
    assert.ok(codes(validateControlledDelivery(failed)).includes('REFUSAL_MUST_NOT_DELIVER'), field);
  }
  unknown.decision.approvedScope = syntheticDeliveryRecord().decision.approvedScope;
  assert.ok(codes(validateControlledDelivery(unknown)).includes('REFUSAL_MUST_NOT_APPROVE_SCOPE'));
});

test('approval requires verification of the unit, document, agent and basis', () => {
  for (const field of ['subject', 'document', 'agent', 'basis']) {
    const failed = syntheticDeliveryRecord();
    failed.verification[field] = false;
    assert.ok(codes(validateControlledDelivery(failed)).includes('UNVERIFIED_REQUEST'), field);
    const missingReference = syntheticDeliveryRecord();
    missingReference.request[`${field}Ref`] = null;
    assert.ok(codes(validateControlledDelivery(missingReference)).includes('REFERENCE_REQUIRED'), field);
  }
});

test('approved and collected scope cannot exceed exact time, site, selector, fields or sources', () => {
  const mutations = [
    scope => { scope.from = '2026-10-07T09:59:59+08:00'; },
    scope => { scope.to = '2026-10-07T10:05:00+08:00'; },
    scope => { scope.sites.push('unrelated.synthetic.invalid'); },
    scope => { scope.selectors.push({ kind: 'user_id', value: 'synthetic-user-10' }); },
    scope => { scope.fields.push('unrequested_phone'); },
    scope => { scope.sources.push('entry_logs'); },
  ];
  for (const mutate of mutations) {
    for (const target of ['approval', 'collection']) {
      const record = syntheticDeliveryRecord();
      mutate(target === 'approval' ? record.decision.approvedScope : record.collection.scope);
      assert.ok(codes(validateControlledDelivery(record)).includes('OUT_OF_SCOPE'), target);
    }
  }
  const narrow = syntheticDeliveryRecord();
  for (const scope of [narrow.decision.approvedScope, narrow.collection.scope]) {
    scope.from = '2026-10-07T10:01:00+08:00'; scope.to = '2026-10-07T10:02:00+08:00';
    scope.fields = ['occurred_at', 'action'];
  }
  narrow.collection.transformationRef = 'synthetic-field-minimization-review';
  assert.equal(validateControlledDelivery(narrow).ok, true);
  const nanosecond = syntheticDeliveryRecord();
  nanosecond.collection.scope.to = '2026-10-07T10:04:59.000000001+08:00';
  assert.ok(codes(validateControlledDelivery(nanosecond)).includes('OUT_OF_SCOPE'), 'sub-millisecond expansion cannot disappear through Date rounding');
  nanosecond.collection.scope.to = '2026-10-07T10:04:58.999999999+08:00';
  assert.equal(validateControlledDelivery(nanosecond).ok, true);
});

test('removing a promised time filter is broader scope even when the range strings stay the same', () => {
  for (const target of ['approval', 'collection']) {
    const record = syntheticDeliveryRecord();
    (target === 'approval' ? record.decision.approvedScope : record.collection.scope).timeAppliesTo = [];
    assert.ok(codes(validateControlledDelivery(record)).includes('TIME_FILTER_REMOVED'));
  }
});

test('missing or mismatched file hashes and missing reception confirmation fail', () => {
  const mutations = [
    [record => { delete record.collection.artifact.sha256; }, 'SHA256_REQUIRED'],
    [record => { record.collection.artifact.sha256 = 'not-a-sha256'; }, 'SHA256_REQUIRED'],
    [record => { record.collection.exportEvidence.sha256 = 'a'.repeat(64); }, 'UNRECORDED_TRANSFORMATION'],
    [record => { record.delivery.sha256 = 'b'.repeat(64); }, 'DELIVERY_HASH_MISMATCH'],
    [record => { delete record.receipt.sha256; }, 'RECEIPT_HASH_MISMATCH'],
    [record => { record.receipt.sha256 = 'c'.repeat(64); }, 'RECEIPT_HASH_MISMATCH'],
    [record => { delete record.receipt.confirmationRef; }, 'REFERENCE_REQUIRED'],
    [record => { delete record.receipt; }, 'RECEIPT_HASH_MISMATCH'],
  ];
  for (const [mutate, code] of mutations) {
    const record = syntheticDeliveryRecord(); mutate(record);
    assert.equal(validateControlledDelivery(record).ok, false);
    assert.ok(codes(validateControlledDelivery(record)).includes(code), code);
  }
  const derivative = syntheticDeliveryRecord();
  derivative.collection.exportEvidence.sha256 = 'd'.repeat(64);
  derivative.collection.transformationRef = 'synthetic-source-to-minimal-artifact-record';
  assert.equal(validateControlledDelivery(derivative).ok, true, 'a recorded transformation retains distinct source and delivery digests');
});

test('truncation, missing rows or known gaps cannot be called complete', () => {
  const mutations = [
    completeness => { completeness.truncated = true; },
    completeness => { completeness.matchedCount = 2; },
    completeness => { completeness.gaps.push('synthetic-source-not-available'); },
  ];
  for (const mutate of mutations) {
    const record = syntheticDeliveryRecord(); mutate(record.collection.completeness);
    assert.ok(codes(validateControlledDelivery(record)).includes('FALSE_COMPLETENESS'));
  }
  const invalidCount = syntheticDeliveryRecord();
  invalidCount.collection.artifact.recordCount = 9;
  assert.ok(codes(validateControlledDelivery(invalidCount)).includes('COUNT_MISMATCH'));
});

test('partial delivery preserves the gap and requires a recorded review before delivery', () => {
  const record = syntheticDeliveryRecord();
  Object.assign(record.collection.completeness, { state: 'partial', matchedCount: 2, truncated: true, gaps: ['synthetic-closed-log-not-available'] });
  assert.ok(codes(validateControlledDelivery(record)).includes('PARTIAL_DELIVERY_NOT_ACKNOWLEDGED'));
  record.collection.completeness.acceptance = { at: '2026-10-07T10:08:30+08:00', actorRef: 'synthetic-responsible-role', noteRef: 'synthetic-gap-review' };
  record.delivery.limitationsRef = 'synthetic-gap-review';
  assert.equal(validateControlledDelivery(record).ok, true);
  assert.equal(record.collection.completeness.state, 'partial');
  record.collection.completeness.acceptance.at = '2026-10-07T10:09:30+08:00';
  assert.ok(codes(validateControlledDelivery(record)).includes('EVENT_ORDER_INVALID'));
});

test('recipient, chronology, credentials and restricted archive remain required', () => {
  const mutations = [
    [record => { record.delivery.recipientSubjectRef = 'synthetic-other-unit'; }, 'RECIPIENT_MISMATCH'],
    [record => { record.receipt.recipientAgentRef = 'synthetic-other-agent'; }, 'RECIPIENT_MISMATCH'],
    [record => { record.receipt.at = '2026-10-07T10:08:00+08:00'; }, 'EVENT_ORDER_INVALID'],
    [record => { record.archive.restricted = false; }, 'RESTRICTED_ARCHIVE_REQUIRED'],
    [record => { delete record.archive.retentionPolicyRef; }, 'REFERENCE_REQUIRED'],
    [record => { record.collection.artifact.credentialsExcluded = false; }, 'CREDENTIAL_EXCLUSION_REQUIRED'],
    [record => { for (const scope of [record.request.scope, record.decision.approvedScope, record.collection.scope]) scope.fields.push('authorization'); }, 'CREDENTIAL_FIELD_FORBIDDEN'],
  ];
  for (const [mutate, code] of mutations) {
    const record = syntheticDeliveryRecord(); mutate(record);
    assert.ok(codes(validateControlledDelivery(record)).includes(code), code);
  }
});

test('invalid dates, unzoned times, duplicate selectors and unknown schemas fail without throwing', () => {
  for (const value of [null, false, 1, [], {}, { schemaVersion: 2 }]) assert.equal(validateControlledDelivery(value).ok, false);
  for (const value of ['2026-02-30T10:05:00+08:00', '2026-10-07T10:05:00', '2026-10-07T10:05:00+14:59']) {
    const record = syntheticDeliveryRecord(); record.request.registeredAt = value;
    assert.ok(codes(validateControlledDelivery(record)).includes('TIMESTAMP_WITH_ZONE_REQUIRED'));
  }
  const record = syntheticDeliveryRecord();
  record.request.scope.selectors.push(structuredClone(record.request.scope.selectors[0]));
  assert.ok(codes(validateControlledDelivery(record)).includes('EXACT_SELECTORS_REQUIRED'));
});

test('offline checks do not read application paths, write files or request network transport', t => {
  let attempts = 0;
  const deny = () => { attempts++; throw new Error('unexpected side effect'); };
  try {
    for (const method of ['readFileSync', 'openSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync']) t.mock.method(fs, method, deny);
    t.mock.method(globalThis, 'fetch', deny);
    for (const transport of [http, https]) { t.mock.method(transport, 'request', deny); t.mock.method(transport, 'get', deny); }
    t.mock.method(net.Socket.prototype, 'connect', deny);
    assert.equal(validateControlledDelivery(syntheticDeliveryRecord()).ok, true);
    assert.equal(validateControlledDelivery(syntheticDeliveryRecord('refuse')).ok, true);
    assert.equal(attempts, 0);
  } finally { t.mock.restoreAll(); }
});

test('CLI checks only its explicit register and never echoes private input, paths or parsing errors', t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'controlled-delivery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private-register.json'), secret = 'SYNTHETIC_PRIVATE_INPUT_NEVER_ECHO';
  const record = syntheticDeliveryRecord(); record.request.documentRef = secret;
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  const before = fs.readFileSync(file), beforeStat = fs.statSync(file);
  const result = runCli(['--record', file], { DATA_DIR: directory, STATE_DB_PATH: '/must-not-read-production.sqlite', ADMIN_SECRET_FILE: '/must-not-read-admin-secret' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(result.stderr, '');
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(fs.readdirSync(directory), ['private-register.json']);
  for (const value of [secret, directory, record.request.subjectRef]) assert.equal(result.stdout.includes(value), false);
  fs.writeFileSync(file, `{"private":"${secret}" INVALID`);
  for (const args of [['--record', file], ['--record', path.join(directory, secret)]]) {
    const invalid = runCli(args);
    assert.equal(invalid.status, 1); assert.equal(invalid.stderr, '');
    for (const value of [secret, directory]) assert.equal(invalid.stdout.includes(value), false);
    assert.equal(JSON.parse(invalid.stdout).failures[0].code, 'RECORD_UNREADABLE_OR_INVALID_JSON');
  }
  fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
  const oversized = runCli(['--record', file]);
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stdout).failures[0].code, 'REGULAR_RECORD_UNDER_1_MIB_REQUIRED');
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'record-link.json');
    fs.symlinkSync(file, link);
    assert.equal(runCli(['--record', link]).status, 1);
  }
});

test('CLI provides fixed synthetic examples, an offline tabletop result and clear exits', () => {
  const demo = runCli(['--demo']);
  assert.equal(demo.status, 0); assert.equal(demo.stderr, '');
  const output = JSON.parse(demo.stdout);
  assert.equal(output.ok, true); assert.equal(output.demo, 'synthetic_offline_tabletop');
  assert.deepEqual(output.reports.map(report => report.outcome), ['archived_delivery_record', 'archived_refusal_record']);
  for (const outcome of ['approve', 'refuse']) {
    const example = runCli(['--example', outcome]);
    assert.equal(example.status, 0); assert.equal(validateControlledDelivery(JSON.parse(example.stdout)).ok, true);
  }
  assert.match(runCli(['--help']).stdout, /Exit 0:/);
  for (const args of [[], ['--record'], ['--send', 'SYNTHETIC_SECRET'], ['--example', 'unknown']]) {
    const invalid = runCli(args);
    assert.equal(invalid.status, 2); assert.equal(invalid.stderr, '');
    assert.equal(invalid.stdout.includes('SYNTHETIC_SECRET'), false);
  }
});
