// Offline consistency checks for delivery registers. Never collects or sends data.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCES = new Set(['account', 'reviews', 'feedback', 'security_logs', 'admin_audit', 'entry_logs']);
const SELECTORS = new Set(['user_id', 'review_id', 'feedback_id', 'request_id', 'source_ip']);
const TIMED_SOURCES = new Set(['security_logs', 'admin_audit', 'entry_logs']);
const SHA256 = /^[a-f0-9]{64}$/;
const textValue = value => typeof value === 'string' && value.trim().length > 0;
const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const countValue = value => Number.isSafeInteger(value) && value >= 0;

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const local = new Date(0);
  local.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  local.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(9, '0').slice(0, 3)));
  if (local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day)
    || local.getUTCHours() !== Number(hour) || local.getUTCMinutes() !== Number(minute) || local.getUTCSeconds() !== Number(second)) return NaN;
  if (zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3)), zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes !== 0)) return NaN;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3)) : NaN;
}

/** Checks declarations and references only; it does not verify their real-world truth. */
export function validateControlledDelivery(record) {
  const failures = [];
  const requireValue = (condition, field, code) => { if (!condition) failures.push({ field, code }); return condition; };
  const ref = (value, field) => requireValue(textValue(value), field, 'REFERENCE_REQUIRED');
  const at = (value, field) => requireValue(typeof timestamp(value) === 'bigint', field, 'TIMESTAMP_WITH_ZONE_REQUIRED');
  const order = (earlier, later, field) => requireValue(typeof timestamp(earlier) === 'bigint' && typeof timestamp(later) === 'bigint' && timestamp(earlier) <= timestamp(later), field, 'EVENT_ORDER_INVALID');
  const stringList = (value, field, allowed = null, allowEmpty = false) => requireValue(Array.isArray(value)
    && (allowEmpty || value.length > 0) && value.every(item => textValue(item) && (!allowed || allowed.has(item)))
    && new Set(value).size === value.length, field, 'UNIQUE_EXACT_VALUES_REQUIRED');
  function scope(value, field) {
    if (!requireValue(objectValue(value), field, 'SCOPE_REQUIRED')) return false;
    const initial = failures.length;
    at(value.from, `${field}.from`); at(value.to, `${field}.to`);
    order(value.from, value.to, `${field}.time_range`);
    let validTimeZone = false;
    try { if (textValue(value.timeZone)) { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); validTimeZone = true; } } catch {}
    requireValue(validTimeZone, `${field}.timeZone`, 'TIME_ZONE_REQUIRED');
    requireValue(value.inclusive === true, `${field}.inclusive`, 'INCLUSIVE_BOUNDARIES_REQUIRED');
    for (const key of ['sites', 'fields']) stringList(value[key], `${field}.${key}`);
    stringList(value.sources, `${field}.sources`, SOURCES);
    stringList(value.timeAppliesTo, `${field}.timeAppliesTo`, TIMED_SOURCES, true);
    requireValue(Array.isArray(value.timeAppliesTo) && Array.isArray(value.sources) && value.timeAppliesTo.every(source => value.sources.includes(source)), `${field}.timeAppliesTo`, 'TIME_SOURCE_MISMATCH');
    requireValue(Array.isArray(value.selectors) && value.selectors.length > 0 && value.selectors.every(item => objectValue(item) && SELECTORS.has(item.kind) && textValue(item.value))
      && new Set(value.selectors.map(item => `${item?.kind}\0${item?.value}`)).size === value.selectors.length, `${field}.selectors`, 'EXACT_SELECTORS_REQUIRED');
    return failures.length === initial;
  }
  function subset(child, parent, field) {
    if (!objectValue(child) || !objectValue(parent)) return;
    requireValue(timestamp(child.from) >= timestamp(parent.from) && timestamp(child.to) <= timestamp(parent.to), `${field}.time_range`, 'OUT_OF_SCOPE');
    for (const key of ['sites', 'fields', 'sources']) requireValue(Array.isArray(child[key]) && Array.isArray(parent[key]) && child[key].every(value => parent[key].includes(value)), `${field}.${key}`, 'OUT_OF_SCOPE');
    const parentSelectors = new Set((Array.isArray(parent.selectors) ? parent.selectors : []).map(item => `${item?.kind}\0${item?.value}`));
    requireValue(Array.isArray(child.selectors) && child.selectors.every(item => parentSelectors.has(`${item?.kind}\0${item?.value}`)), `${field}.selectors`, 'OUT_OF_SCOPE');
    requireValue(Array.isArray(child.sources) && Array.isArray(child.timeAppliesTo) && Array.isArray(parent.timeAppliesTo)
      && child.sources.every(source => !parent.timeAppliesTo.includes(source) || child.timeAppliesTo.includes(source)), `${field}.timeAppliesTo`, 'TIME_FILTER_REMOVED');
  }
  const report = () => ({
    schemaVersion: 1, ok: failures.length === 0,
    recordKind: record?.synthetic === true ? 'synthetic' : 'operator_record',
    outcome: failures.length ? 'invalid_record' : record.decision.outcome === 'refuse' ? 'archived_refusal_record' : 'archived_delivery_record',
    evidenceBoundary: 'record_consistency_only', externalDeliveryVerified: false,
    productionDataRead: false, dataSent: false, failures,
  });
  if (!requireValue(objectValue(record), 'record', 'OBJECT_REQUIRED')) return report();
  requireValue(record.schemaVersion === 1, 'schemaVersion', 'UNSUPPORTED_SCHEMA');
  requireValue(typeof record.synthetic === 'boolean', 'synthetic', 'RECORD_KIND_REQUIRED');
  const request = record.request || {}, verification = record.verification || {}, decision = record.decision || {}, archive = record.archive || {};
  ref(request.requestRef, 'request.requestRef'); at(request.registeredAt, 'request.registeredAt');
  scope(request.scope, 'request.scope');
  ref(verification.verifierRef, 'verification.verifierRef'); at(verification.at, 'verification.at');
  order(request.registeredAt, verification.at, 'verification.at');
  for (const kind of ['subject', 'document', 'agent', 'basis']) {
    requireValue(typeof verification[kind] === 'boolean', `verification.${kind}`, 'VERIFICATION_RESULT_REQUIRED');
    if (verification[kind] === true) ref(request[`${kind}Ref`], `request.${kind}Ref`);
  }
  ref(decision.actorRef, 'decision.actorRef'); ref(decision.reasonRef, 'decision.reasonRef'); at(decision.at, 'decision.at');
  order(verification.at, decision.at, 'decision.at');
  requireValue(['approve', 'refuse'].includes(decision.outcome), 'decision.outcome', 'DECISION_REQUIRED');
  at(archive.at, 'archive.at'); ref(archive.custodianRef, 'archive.custodianRef');
  ref(archive.recordRef, 'archive.recordRef'); ref(archive.retentionPolicyRef, 'archive.retentionPolicyRef');
  requireValue(archive.restricted === true, 'archive.restricted', 'RESTRICTED_ARCHIVE_REQUIRED');
  if (decision.outcome === 'refuse') {
    ref(decision.refusalCode, 'decision.refusalCode');
    requireValue(decision.approvedScope == null, 'decision.approvedScope', 'REFUSAL_MUST_NOT_APPROVE_SCOPE');
    requireValue(record.collection == null && record.delivery == null && record.receipt == null, 'refusal', 'REFUSAL_MUST_NOT_DELIVER');
    order(decision.at, archive.at, 'archive.at');
    return report();
  }
  for (const kind of ['subject', 'document', 'agent', 'basis']) requireValue(verification[kind] === true, `verification.${kind}`, 'UNVERIFIED_REQUEST');
  scope(decision.approvedScope, 'decision.approvedScope'); subset(decision.approvedScope, request.scope, 'decision.approvedScope');
  const collection = record.collection || {}, artifact = collection.artifact || {}, source = collection.exportEvidence || {}, completeness = collection.completeness || {};
  at(collection.at, 'collection.at'); order(decision.at, collection.at, 'collection.at');
  for (const key of ['operatorRef', 'queryAuditRef', 'exportAuditRef']) ref(collection[key], `collection.${key}`);
  stringList(collection.sourceRefs, 'collection.sourceRefs');
  scope(collection.scope, 'collection.scope'); subset(collection.scope, decision.approvedScope, 'collection.scope');
  requireValue(Array.isArray(collection.scope?.fields) && collection.scope.fields.every(field => typeof field === 'string' && !/(password|authorization|cookie|token|appsecret|credential|secret|one.?time.?code)/i.test(field)), 'collection.scope.fields', 'CREDENTIAL_FIELD_FORBIDDEN');
  for (const [value, field] of [[artifact, 'collection.artifact'], [source, 'collection.exportEvidence']]) {
    requireValue(typeof value.sha256 === 'string' && SHA256.test(value.sha256), `${field}.sha256`, 'SHA256_REQUIRED');
    requireValue(countValue(value.bytes), `${field}.bytes`, 'BYTE_COUNT_REQUIRED');
  }
  ref(artifact.storageRef, 'collection.artifact.storageRef');
  requireValue(artifact.credentialsExcluded === true, 'collection.artifact.credentialsExcluded', 'CREDENTIAL_EXCLUSION_REQUIRED');
  if (collection.transformationRef != null) ref(collection.transformationRef, 'collection.transformationRef');
  else requireValue(artifact.sha256 === source.sha256 && artifact.bytes === source.bytes, 'collection.artifact', 'UNRECORDED_TRANSFORMATION');
  requireValue(['complete', 'partial'].includes(completeness.state), 'collection.completeness.state', 'COMPLETENESS_REQUIRED');
  requireValue(countValue(completeness.matchedCount) && countValue(completeness.exportedCount) && completeness.exportedCount <= completeness.matchedCount, 'collection.completeness.counts', 'COUNT_MISMATCH');
  requireValue(typeof completeness.truncated === 'boolean', 'collection.completeness.truncated', 'TRUNCATION_RESULT_REQUIRED');
  stringList(completeness.gaps, 'collection.completeness.gaps', null, true);
  requireValue(countValue(artifact.recordCount) && artifact.recordCount === completeness.exportedCount, 'collection.artifact.recordCount', 'COUNT_MISMATCH');
  if (completeness.state === 'complete') requireValue(completeness.truncated === false && completeness.matchedCount === completeness.exportedCount && Array.isArray(completeness.gaps) && completeness.gaps.length === 0, 'collection.completeness', 'FALSE_COMPLETENESS');
  const delivery = record.delivery || {}, receipt = record.receipt || {};
  at(delivery.at, 'delivery.at'); order(collection.at, delivery.at, 'delivery.at');
  requireValue(textValue(delivery.recipientSubjectRef) && delivery.recipientSubjectRef === request.subjectRef, 'delivery.recipientSubjectRef', 'RECIPIENT_MISMATCH');
  requireValue(textValue(delivery.recipientAgentRef) && delivery.recipientAgentRef === request.agentRef, 'delivery.recipientAgentRef', 'RECIPIENT_MISMATCH');
  ref(delivery.methodRef, 'delivery.methodRef'); ref(delivery.transferRef, 'delivery.transferRef');
  requireValue(typeof delivery.sha256 === 'string' && SHA256.test(delivery.sha256) && delivery.sha256 === artifact.sha256, 'delivery.sha256', 'DELIVERY_HASH_MISMATCH');
  if (completeness.state === 'partial') {
    const acceptance = completeness.acceptance || {};
    at(acceptance.at, 'collection.completeness.acceptance.at'); ref(acceptance.actorRef, 'collection.completeness.acceptance.actorRef'); ref(acceptance.noteRef, 'collection.completeness.acceptance.noteRef');
    order(collection.at, acceptance.at, 'collection.completeness.acceptance.at'); order(acceptance.at, delivery.at, 'delivery.at');
    requireValue(textValue(delivery.limitationsRef) && delivery.limitationsRef === acceptance.noteRef, 'delivery.limitationsRef', 'PARTIAL_DELIVERY_NOT_ACKNOWLEDGED');
  }
  at(receipt.at, 'receipt.at'); order(delivery.at, receipt.at, 'receipt.at');
  requireValue(textValue(receipt.recipientAgentRef) && receipt.recipientAgentRef === delivery.recipientAgentRef, 'receipt.recipientAgentRef', 'RECIPIENT_MISMATCH');
  requireValue(typeof receipt.sha256 === 'string' && SHA256.test(receipt.sha256) && receipt.sha256 === artifact.sha256, 'receipt.sha256', 'RECEIPT_HASH_MISMATCH');
  ref(receipt.confirmationRef, 'receipt.confirmationRef');
  order(receipt.at, archive.at, 'archive.at');
  return report();
}

export function syntheticDeliveryRecord(outcome = 'approve') {
  const scope = {
    from: '2026-10-07T10:00:00+08:00', to: '2026-10-07T10:04:59+08:00', timeZone: 'Asia/Shanghai', inclusive: true,
    sites: ['synthetic.invalid'], selectors: [{ kind: 'user_id', value: 'synthetic-user-1' }],
    sources: ['security_logs'], timeAppliesTo: ['security_logs'], fields: ['occurred_at', 'user_id', 'action'],
  };
  const payload = Buffer.from('{"synthetic":true,"records":[{"occurred_at":"2026-10-07T10:01:00+08:00","user_id":"synthetic-user-1","action":"synthetic.login"}]}\n');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const record = {
    schemaVersion: 1, synthetic: true,
    request: { requestRef: 'synthetic-request', registeredAt: '2026-10-07T10:05:00+08:00', subjectRef: 'synthetic-unit', documentRef: 'synthetic-document', agentRef: 'synthetic-agent', basisRef: 'synthetic-basis', scope },
    verification: { at: '2026-10-07T10:06:00+08:00', verifierRef: 'synthetic-responsible-role', subject: true, document: true, agent: true, basis: true },
    decision: { at: '2026-10-07T10:07:00+08:00', actorRef: 'synthetic-responsible-role', outcome, reasonRef: 'synthetic-minimal-scope-review', approvedScope: structuredClone(scope) },
    archive: { at: '2026-10-07T10:12:00+08:00', custodianRef: 'synthetic-archive-role', recordRef: 'synthetic-private-register', retentionPolicyRef: 'synthetic-policy-pending-real-owner', restricted: true },
  };
  if (outcome === 'refuse') {
    record.request.subjectRef = null;
    record.verification.subject = false;
    record.decision.refusalCode = 'unverified_subject';
    record.decision.reasonRef = 'synthetic-refusal-review';
    delete record.decision.approvedScope;
    return record;
  }
  record.collection = {
    at: '2026-10-07T10:08:00+08:00', operatorRef: 'synthetic-admin', queryAuditRef: 'synthetic-query-event', exportAuditRef: 'synthetic-export-event',
    sourceRefs: ['synthetic-local-records'], scope: structuredClone(scope), exportEvidence: { sha256, bytes: payload.length }, transformationRef: null,
    artifact: { sha256, bytes: payload.length, recordCount: 1, storageRef: 'synthetic-private-artifact', credentialsExcluded: true },
    completeness: { state: 'complete', matchedCount: 1, exportedCount: 1, truncated: false, gaps: [] },
  };
  record.delivery = { at: '2026-10-07T10:09:00+08:00', recipientSubjectRef: 'synthetic-unit', recipientAgentRef: 'synthetic-agent', methodRef: 'synthetic-offline-tabletop-no-send', transferRef: 'synthetic-transfer-record', sha256 };
  record.receipt = { at: '2026-10-07T10:10:00+08:00', recipientAgentRef: 'synthetic-agent', sha256, confirmationRef: 'synthetic-receipt-no-real-recipient' };
  return record;
}

function cliFailure(code, exitCode) {
  console.log(JSON.stringify({ ok: false, evidenceBoundary: 'record_consistency_only', externalDeliveryVerified: false, productionDataRead: false, dataSent: false, failures: [{ field: 'input', code }] }));
  process.exitCode = exitCode;
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/verify-controlled-delivery.mjs --record <JSON-file> | --demo | --example [approve|refuse]\nOffline record checks only. No production collection, file hashing or sending.\nExit 0: consistent archived record; 1: invalid record/input; 2: invalid arguments.');
    return;
  }
  if (args.length === 1 && args[0] === '--demo') {
    const reports = ['approve', 'refuse'].map(outcome => validateControlledDelivery(syntheticDeliveryRecord(outcome)));
    console.log(JSON.stringify({ demo: 'synthetic_offline_tabletop', ok: reports.every(report => report.ok), reports }));
    process.exitCode = reports.every(report => report.ok) ? 0 : 1;
    return;
  }
  if (args[0] === '--example' && args.length <= 2 && (args[1] === undefined || ['approve', 'refuse'].includes(args[1]))) {
    console.log(JSON.stringify(syntheticDeliveryRecord(args[1]), null, 2));
    return;
  }
  if (args.length !== 2 || args[0] !== '--record' || !textValue(args[1])) { cliFailure('INVALID_ARGUMENTS', 2); return; }
  let record;
  try {
    const descriptor = fs.openSync(args[1], fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 1024 * 1024) { cliFailure('REGULAR_RECORD_UNDER_1_MIB_REQUIRED', 1); return; }
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length > 1024 * 1024) { cliFailure('REGULAR_RECORD_UNDER_1_MIB_REQUIRED', 1); return; }
      record = JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(descriptor); }
  } catch { cliFailure('RECORD_UNREADABLE_OR_INVALID_JSON', 1); return; }
  const report = validateControlledDelivery(record);
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
