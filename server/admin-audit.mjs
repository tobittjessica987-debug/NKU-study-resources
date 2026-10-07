import { createHmac, randomUUID } from 'node:crypto';

export function queryAuditMetadata(url, secret) {
  const params = url.searchParams;
  const scope = url.pathname === '/admin-api/law-logs' ? 'history' : ['account', 'review', 'feedback'].includes(params.get('type') || 'account') ? params.get('type') || 'account' : 'invalid';
  const keys = ['type', 'value', 'id', 'from', 'to', 'action', 'audit_action', 'reference', 'actor', 'exported', 'review_page', 'feedback_page', 'content_page_size', 'log_page', 'log_page_size', 'audit_page', 'audit_page_size', 'page', 'page_size'];
  // Hash full criteria, including repeated values, without copying raw identity or query text.
  const criteria = keys.map(key => [key, params.getAll(key)]);
  const numericKeys = ['review_page', 'feedback_page', 'content_page_size', 'log_page', 'log_page_size', 'audit_page', 'audit_page_size', 'page', 'page_size'];
  const range = Object.fromEntries(numericKeys.filter(key => params.has(key)).map(key => [key, /^\d+$/.test(params.get(key)) && Number.isSafeInteger(Number(params.get(key))) ? Number(params.get(key)) : null]));
  for (const key of ['from', 'to']) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    const value = /^\d+$/.test(raw) ? Number(raw) : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN;
    range[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const reference = url.searchParams.get('reference') || '';
  const filters = Object.fromEntries(['action', 'audit_action'].filter(key => params.has(key)).map(key => [key, /^[a-zA-Z0-9._:-]{1,128}$/.test(params.get(key)) ? params.get(key) : null]));
  return { scope, range, filters, reference: /^[a-zA-Z0-9._:-]{1,80}$/.test(reference) ? reference : null, criteriaHash: createHmac('sha256', secret).update(JSON.stringify(criteria)).digest('hex').slice(0, 32) };
}

/** Describe the effective service filters without copying free-form query text. */
export function lawResultAuditMetadata(result, secret) {
  const filter = value => {
    if (!value) return { match: 'all', value: null, hash: null };
    return {
      match: 'exact',
      value: /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : null,
      hash: createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 32),
    };
  };
  return {
    scope: result.query.type,
    reference: result.query.reference,
    effectiveRange: { from: result.range.from_ms, to: result.range.to_ms, inclusive: result.range.inclusive, scope: result.range.scope },
    effectiveFilters: { action: filter(result.query.filters.action), audit_action: filter(result.query.filters.audit_action) },
  };
}

const storageCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'LOG_IO_FAILED';
const auditUnavailable = (failedSink, cause, secondary = {}) => Object.assign(new Error('调取操作审计保存失败，未发送调取结果。'), {
  statusCode: 503, code: 'LAW_AUDIT_UNAVAILABLE', failedSink, storageCode: storageCode(cause), ...secondary,
});

/**
 * Both sinks must durably accept evidence before response headers are emitted.
 * The law entry is a preparation, not proof of delivery. A later failure uses a
 * fresh event id linked to the preparation; immutable SQLite rows are not patched.
 */
export function recordLawResponseAudit({ accountsStore, lawLogStore, base, event, actor, status, queryType, exported }) {
  const lawBase = { queriedBy: actor, queryType, queryValue: event.target || `hash:${event.summary.criteriaHash}`, exported };
  const adminBase = { ...base, username: actor, action: event.action, target: event.target };
  const failedDetail = (failedSink, cause) => ({
    ...event.summary, outcome: 'error', delivery: 'not_delivered', intendedStatus: status,
    code: 'LAW_AUDIT_UNAVAILABLE', failedSink, storageCode: storageCode(cause), relatedEventId: event.eventId,
  });
  try {
    lawLogStore.record({ ...lawBase, eventId: event.eventId, resultSummary: JSON.stringify({
      ...event.summary, status: 0, intendedStatus: status, outcome: 'prepared', delivery: 'not_confirmed',
    }) });
  } catch (error) {
    let secondary;
    try {
      accountsStore.audit({ ...adminBase, status: 503, eventId: event.eventId, detail: JSON.stringify(failedDetail('law', error)) });
    } catch (adminError) { secondary = { secondarySink: 'admin', secondaryStorageCode: storageCode(adminError) }; }
    throw auditUnavailable('law', error, secondary);
  }

  try {
    accountsStore.audit({ ...adminBase, status, eventId: event.eventId, detail: JSON.stringify({
      ...event.summary, outcome: status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'ok', delivery: 'response_ready',
    }) });
  } catch (error) {
    const detail = failedDetail('admin', error);
    const secondary = {};
    try {
      const persisted = accountsStore.db.prepare('SELECT id FROM admin_audit_log WHERE event_id = ?').get(event.eventId);
      // Outcome-save failures can happen after rename, before SQLite insertion.
      // Only a not-yet-inserted original may have its replay queue corrected. If a
      // row is already immutable, append a distinct linked failure instead.
      accountsStore.audit({ ...adminBase, status: 503, eventId: persisted ? randomUUID() : event.eventId, detail: JSON.stringify(detail) });
    } catch (adminError) {
      secondary.recoveryStorageCode = storageCode(adminError);
      // A failed correction can leave the earlier response-ready outcome queued
      // (for example: first afterRename, then beforeRename). Make one bounded
      // attempt with a new id so account evidence also contains the linked 503.
      try {
        accountsStore.audit({ ...adminBase, status: 503, eventId: randomUUID(), detail: JSON.stringify(detail) });
      } catch (failureError) { secondary.failureAuditStorageCode = storageCode(failureError); }
    }
    try {
      lawLogStore.record({ ...lawBase, eventId: randomUUID(), resultSummary: JSON.stringify({ ...detail, status: 503, preparationEventId: event.eventId }) });
    } catch (lawError) { secondary.secondarySink = 'law'; secondary.secondaryStorageCode = storageCode(lawError); }
    throw auditUnavailable('admin', error, secondary);
  }
}

// Log changed field names. Only small status/boolean enums get before/after values.
// Text, account identity, reply bodies, URLs and credentials never enter the log.
export function contentChanges(previous, next, key) {
  const before = new Map((previous[key] || []).map(row => [String(row.id), row]));
  const after = new Map((next[key] || []).map(row => [String(row.id), row]));
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id);
    const known = new Set(['id','status','hidden','private','blocked','title','content','type','contact','user_id','reply','rating','tags','teacher','courseTitle','updatedBy','updatedAt','repliedBy','repliedAt','handledBy','handledAt','reviewedBy','reviewedAt','createdAt','reportUrl','reportTarget','handlingStatus','publicationState','publicationBlocked','replyVisibility','decisionSource','ruleHash','ruleSnapshot','rulesProvenance']);
    const rawFields = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(name => JSON.stringify(a?.[name]) !== JSON.stringify(b?.[name]));
    const fields = [...new Set(rawFields.map(name => known.has(name) ? name : 'other_fields'))];
    if (!fields.length) continue;
    const states = {};
    for (const name of ['status', 'handlingStatus', 'publicationState', 'hidden', 'private', 'blocked', 'publicationBlocked', 'replyVisibility', 'decisionSource']) {
      const safe = value => typeof value === 'boolean' || ['pending', 'approved', 'rejected', 'open', 'completed', 'processing', 'parked', 'submitter', 'public', 'manual', 'automatic', 'legacy_visibility_import'].includes(value) ? value : null;
      if (fields.includes(name)) states[name] = { before: safe(a?.[name]), after: safe(b?.[name]) };
    }
    changes.push({ id, operation: !b ? 'delete' : !a ? 'create' : 'update', fields, states });
  }
  return changes;
}

export function stampContentActor(incoming, previous, key, username, now = new Date().toISOString()) {
  const next = structuredClone(incoming);
  const before = new Map((previous[key] || []).map(row => [String(row.id), row]));
  next[key] = (next[key] || []).map(row => {
    const old = before.get(String(row.id));
    const value = { ...row };
    for (const field of ['handled_by','handled_at','updated_by','updated_at','replied_by','replied_at','reviewed_by','reviewed_at']) delete value[field];
    for (const field of ['updatedBy', 'updatedAt', 'repliedBy', 'repliedAt', 'handledBy', 'handledAt', 'reviewedBy', 'reviewedAt']) {
      if (old && Object.hasOwn(old, field)) value[field] = old[field]; else delete value[field];
    }
    if (contentChanges({ rows: old ? [old] : [] }, { rows: [value] }, 'rows').length) {
      value.updatedBy = username; value.updatedAt = now;
      if (value.reply !== old?.reply) { value.repliedBy = username; value.repliedAt = now; }
      if (value.status !== old?.status || value.hidden !== old?.hidden) { value.handledBy = username; value.handledAt = now; }
    }
    return value;
  });
  return next;
}
