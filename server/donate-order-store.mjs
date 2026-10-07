import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { PublicApiError } from "./public-api-errors.mjs";

/** 捐助订单：金额以分为单位；状态 pending → paid（回调幂等）。 */
export class DonateOrderStore {
  constructor({ dbPath, assertActiveUser = null }) {
    if (!dbPath) throw new Error("DonateOrderStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    if (assertActiveUser !== null && typeof assertActiveUser !== "function") throw new TypeError("assertActiveUser must be a function.");
    this.assertActiveUser = assertActiveUser;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS donate_orders (
        out_trade_no TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        amount_total INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_id TEXT,
        created_at INTEGER NOT NULL,
        paid_at INTEGER,
        nickname TEXT NOT NULL DEFAULT '',
        remark TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS donate_orders_user_idx ON donate_orders(user_id, created_at);
    `);
    // 旧表迁移：补齐新列（已存在则忽略）
    const columns = new Set(this.db.prepare("PRAGMA table_info(donate_orders)").all().map(row => row.name));
    for (const [column, definition] of [["nickname", "TEXT NOT NULL DEFAULT ''"], ["remark", "TEXT NOT NULL DEFAULT ''"], ["source", "TEXT NOT NULL DEFAULT ''"], ["identity_cleared_at", "INTEGER"]]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE donate_orders ADD COLUMN ${column} ${definition}`);
    }
    this.insertOrder = this.db.prepare(
      "INSERT INTO donate_orders (out_trade_no, user_id, amount_total, status, created_at, nickname, remark, source) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)"
    );
    this.selectOrder = this.db.prepare("SELECT * FROM donate_orders WHERE out_trade_no = ?");
    this.markPaidStmt = this.db.prepare(
      "UPDATE donate_orders SET status = 'paid', transaction_id = COALESCE(?, transaction_id), paid_at = COALESCE(paid_at, ?) WHERE out_trade_no = ? AND status = 'pending'"
    );
  }

  create({ outTradeNo, userId, amountTotal, now = Date.now(), nickname = "", remark = "", source = "" }) {
    return this.db.transaction(() => {
      const id = Number(userId);
      if (id > 0) this.#assertActiveUser(id);
      this.insertOrder.run(outTradeNo, id, Math.round(amountTotal), now, String(nickname).slice(0, 32), String(remark).slice(0, 200), String(source).slice(0, 16));
      return this.selectOrder.get(outTradeNo);
    }).immediate();
  }

  #assertActiveUser(userId) {
    if (this.assertActiveUser) return this.assertActiveUser(userId);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mp_users'").get()) return;
    const row = this.db.prepare("SELECT * FROM mp_users WHERE id=?").get(userId);
    if (!row || row.deleted_at !== null && row.deleted_at !== undefined) throw new PublicApiError(401, "账号已注销。", "AUTH_ACCOUNT_DELETED");
    if (row.blocked) throw new PublicApiError(403, "账号已停用。", "AUTH_ACCOUNT_BLOCKED");
  }

  listUserOrderKeys(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return this.db.prepare("SELECT out_trade_no FROM donate_orders WHERE user_id=? ORDER BY out_trade_no").all(id).map(row => row.out_trade_no);
  }

  /** Persist these keys in the deletion job before clearing the business association. */
  cleanupUser(userId, { now = Date.now() } = {}) {
    return this.db.transaction(() => {
      const keys = this.listUserOrderKeys(userId);
      this.cleanupOrders(keys, { now });
      return keys;
    }).immediate();
  }

  /** Exact-key replay preserves all transaction/accounting facts, including late payments. */
  cleanupOrders(orderKeys, { now = Date.now() } = {}) {
    const keys = [...new Set((Array.isArray(orderKeys) ? orderKeys : []).filter(key => typeof key === "string" && key.length))];
    return this.db.transaction(() => {
      const clear = this.db.prepare("UPDATE donate_orders SET user_id=0, nickname='', remark='', identity_cleared_at=COALESCE(identity_cleared_at, ?) WHERE out_trade_no=?");
      let changed = 0;
      for (const key of keys) changed += clear.run(Number(now), key).changes;
      return changed;
    }).immediate();
  }

  get(outTradeNo) {
    return this.selectOrder.get(outTradeNo) || null;
  }

  /** 幂等：已 paid 直接返回 true；金额不符返回 false。 */
  markPaid({ outTradeNo, amountTotal, transactionId, now = Date.now() }) {
    const order = this.get(outTradeNo);
    if (!order) return false;
    if (order.amount_total !== Math.round(amountTotal)) return false;
    if (order.status === "paid") return true;
    this.markPaidStmt.run(transactionId || null, now, outTradeNo);
    return true;
  }

  listRecent(limit = 50) {
    return this.db.prepare("SELECT * FROM donate_orders ORDER BY created_at DESC LIMIT ?").all(Math.min(2000, Math.max(1, Number(limit) || 50)));
  }

  summary() {
    const paid = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_total), 0) AS total FROM donate_orders WHERE status = 'paid'").get();
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM donate_orders WHERE status = 'pending'").get();
    const bySource = this.db.prepare("SELECT source, COUNT(*) AS count, COALESCE(SUM(amount_total), 0) AS total FROM donate_orders WHERE status = 'paid' GROUP BY source").all();
    return {
      paid_count: paid.count,
      paid_total_fen: paid.total,
      pending_count: pending.count,
      by_source: bySource.reduce((acc, row) => ({ ...acc, [row.source || "unknown"]: { count: row.count, total_fen: row.total } }), {}),
    };
  }

  close() {
    this.db.close();
  }
}
