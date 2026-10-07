const RECORD_LIMIT = 500;

function exactOrderKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

/** 捐赠记录行（公开表：时间/昵称/去向），追加到 donate.json 的 records 数组。 */
function normalizeRows(value, includeOrderKey) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => ({
      date: String(row?.date || "").slice(0, 10),
      nickname: String(row?.nickname || "").trim().slice(0, 32) || "好心人",
      usage: String(row?.usage || "").trim().slice(0, 40) || "待定",
      ...(includeOrderKey && exactOrderKey(row?.order_key) ? { order_key: row.order_key } : {}),
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .slice(-RECORD_LIMIT);
}

/** Public whitelist: internal order keys must never enter the public DTO. */
export function normalizeRecords(value) { return normalizeRows(value, false); }

/** Internal persistence keeps the exact key needed for account cleanup. */
export function normalizeStoredRecords(value) { return normalizeRows(value, true); }

/** Pure helper for the content writer's queue; unattributed legacy rows stay unchanged. */
export function cleanupDonateRecords(current, orderKeys = []) {
  const keys = new Set((Array.isArray(orderKeys) ? orderKeys : []).filter(key => exactOrderKey(key)));
  let cleared = 0;
  let legacyUnattributed = 0;
  const records = (Array.isArray(current?.records) ? current.records : []).map(row => {
    const key = exactOrderKey(row?.order_key);
    if (!key) legacyUnattributed += 1;
    if (!key || !keys.has(key)) return row;
    if (row.nickname !== "好心人") cleared += 1;
    return { ...row, nickname: "好心人" };
  });
  return { document: { ...current, records }, cleared, legacyUnattributed };
}

/** 北京时区年月日（支付入账时间）。 */
export function beijingDateLabel(timestampMs) {
  const shifted = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 支付成功后把一条记录追加进 donate.json（仅记录数据，不触发静态重建——
 * 网页与小程序的记录表都走 API 实时渲染）。追加失败不影响入账结果。
 */
export async function appendDonateRecord({ store, filePath, nickname = "", paidAtMs, orderKey = null, readOrder = null, assertActiveUser = null }) {
  const key = exactOrderKey(orderKey);
  if (orderKey !== null && (!key || typeof readOrder !== "function")) throw new TypeError("An exact orderKey and readOrder callback are required.");
  let appended;
  await store.update(filePath, (current) => {
    // Resolve identity only after entering the JSON writer queue. A captured nickname
    // from before deletion must not be copied by a late payment notification.
    let effectiveNickname = nickname;
    let clearedIdentity = false;
    if (key) {
      const order = readOrder(key);
      clearedIdentity = !order || order.identity_cleared_at !== null && order.identity_cleared_at !== undefined;
      if (!clearedIdentity && Number(order.user_id) > 0 && assertActiveUser) {
        try { assertActiveUser(Number(order.user_id)); }
        catch { clearedIdentity = true; }
      }
      effectiveNickname = clearedIdentity ? "" : order.nickname || "";
    }
    const records = normalizeStoredRecords(current.records);
    const existing = key ? records.find(row => row.order_key === key) : null;
    if (existing) {
      if (clearedIdentity) existing.nickname = "好心人";
      appended = existing;
      current.records = records;
    } else {
      const next = normalizeStoredRecords([...records, { date: beijingDateLabel(paidAtMs), nickname: effectiveNickname, usage: "待定", ...(key ? { order_key: key } : {}) }]);
      current.records = next;
      appended = next[next.length - 1] || null;
    }
    return current;
  }, { initialize: { version: 1, title: "", content: "", amounts: [5, 10, 15], records: [] }, mode: 0o600 });
  return appended;
}
