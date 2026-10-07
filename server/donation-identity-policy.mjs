import { PublicApiError } from './public-api-errors.mjs';

/** Called within the content publication queue after revision validation. */
export function preserveDonationIdentity(next, current, readOrder) {
  const known = new Map((current.records || []).filter(row => row.order_key).map(row => [row.order_key, row]));
  const incoming = new Map();
  for (const row of next.records || []) {
    if (!row.order_key) continue;
    if (!known.has(row.order_key) || incoming.has(row.order_key)) throw new PublicApiError(409, '付款记录标识不可新增或重复，请刷新后重试。', 'DONATION_IDENTITY_CONFLICT');
    incoming.set(row.order_key, row);
    const order = readOrder(row.order_key);
    // A previously cleared record can never regain a nickname from an old draft.
    if (order?.identity_cleared_at != null) row.nickname = '好心人';
  }
  if ([...known.keys()].some(key => !incoming.has(key))) throw new PublicApiError(409, '付款记录的归属标识不可移除。需要处理记录时请联系维护者。', 'DONATION_IDENTITY_CONFLICT');
  return next;
}
