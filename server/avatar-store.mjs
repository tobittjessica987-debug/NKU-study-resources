import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * 头像资源登记表（SQLite）：
 * - upload：登记归属用户与审核状态，产出不可猜的版本化资源 ID；
 * - 绑定校验：avatar_url 必须指向本站 avatars 根且登记为本人已过审资源；
 * - 孤立回收：未绑定超期的登记条目由 avatar-service 懒清理。
 */
export class AvatarStore {
  constructor({ dbPath }) {
    if (!dbPath) throw new Error("AvatarStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS avatars (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        content_type TEXT NOT NULL DEFAULT 'image/jpeg',
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        bound_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_avatars_user ON avatars(user_id);
      CREATE INDEX IF NOT EXISTS idx_avatars_created ON avatars(created_at);
      CREATE TABLE IF NOT EXISTS avatar_deletion_intents (
        user_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(avatars)").all().map((row) => row.name));
    for (const [column, definition] of [
      ["cleanup_error", "TEXT NOT NULL DEFAULT ''"],
      ["cleanup_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["cleanup_last_attempt_at", "INTEGER"],
      ["upload_state", "TEXT NOT NULL DEFAULT 'settled'"],
    ]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE avatars ADD COLUMN ${column} ${definition}`);
    }
    if (!columns.has("upload_state")) {
      // Older cleanup rows cannot prove whether their PUT ever finished. Keep
      // this ambiguity after migration rather than inferring success from age.
      this.db.prepare("UPDATE avatars SET upload_state='uncertain' WHERE status IN ('pending_upload', 'cleanup_pending')").run();
    }
    fs.chmodSync(dbPath, 0o600);
  }

  register({ id, userId, bytes, contentType = "image/jpeg", now = Date.now(), status = "approved" }) {
    return this.db.transaction(() => {
      const state = this.isDeletionPending(userId) ? "cleanup_pending" : status;
      const uploadState = status === "approved" ? "settled" : "uncertain";
      this.db.prepare("INSERT INTO avatars (id, user_id, status, content_type, bytes, created_at, upload_state) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(String(id), Number(userId), state, contentType, Number(bytes) || 0, Number(now), uploadState);
      return this.getById(id);
    }).immediate();
  }

  getById(id) {
    return this.db.prepare("SELECT * FROM avatars WHERE id = ?").get(String(id || "")) || null;
  }

  markBound(id, { now = Date.now() } = {}) {
    this.db.prepare("UPDATE avatars SET bound_at = ? WHERE id = ? AND status = 'approved' AND upload_state = 'settled' AND user_id NOT IN (SELECT user_id FROM avatar_deletion_intents)").run(Number(now), String(id));
  }

  /** 校验可绑定：返回登记行或 null（非本站资源 / 不存在 / 未过审 / 非本人）。 */
  bindable({ userId, id }) {
    const row = this.getById(id);
    if (!row) return null;
    if (row.user_id !== Number(userId)) return null;
    if (row.status !== "approved") return null;
    if (row.upload_state !== "settled") return null;
    if (this.isDeletionPending(userId)) return null;
    return row;
  }

  isDeletionPending(userId) {
    return Boolean(this.db.prepare("SELECT 1 FROM avatar_deletion_intents WHERE user_id = ?").get(Number(userId)));
  }

  /** Deletion intent survives restart and immediately prevents binding or new uploads. */
  markUserDeletion(userId, { now = Date.now() } = {}) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("A positive userId is required.");
    return this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO avatar_deletion_intents (user_id, created_at) VALUES (?, ?)").run(id, Number(now));
      return this.db.prepare("UPDATE avatars SET status = 'cleanup_pending' WHERE user_id = ?").run(id).changes;
    }).immediate();
  }

  listForUser(userId) {
    return this.db.prepare("SELECT * FROM avatars WHERE user_id = ? ORDER BY created_at, id").all(Number(userId));
  }

  markUploaded(id) {
    this.db.prepare("UPDATE avatars SET status = 'approved' WHERE id = ? AND status = 'pending_upload' AND upload_state = 'settled' AND user_id NOT IN (SELECT user_id FROM avatar_deletion_intents)").run(String(id));
    return this.getById(id);
  }

  /** Internal upload path only: a fulfilled PUT proves this request has finished. */
  markUploadSettled(id) {
    this.db.prepare("UPDATE avatars SET upload_state='settled' WHERE id=?").run(String(id));
  }

  /** Restricted maintenance only, after independent evidence that the old PUT
   * has terminated. Neither elapsed time nor a single HEAD/DELETE proves that. */
  confirmUploadSettledForCleanup(id) {
    return this.db.transaction(() => {
      const row = this.getById(id);
      const hasUsers = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mp_users'").get();
      const account = hasUsers && row ? this.db.prepare("SELECT * FROM mp_users WHERE id=?").get(row.user_id) : null;
      if (!row || row.status !== "cleanup_pending" || !this.isDeletionPending(row.user_id) || account?.deleted_at == null) {
        throw Object.assign(new Error("Only a deleted account's pending avatar cleanup may be confirmed."), { code: "AVATAR_SETTLEMENT_CONFIRMATION_INELIGIBLE" });
      }
      this.markUploadSettled(row.id);
      return this.getById(row.id);
    }).immediate();
  }

  markCleanupPending(id, { error = "", now = Date.now(), attempted = false } = {}) {
    this.db.prepare("UPDATE avatars SET status = 'cleanup_pending', cleanup_error = ?, cleanup_attempts = cleanup_attempts + ?, cleanup_last_attempt_at = CASE WHEN ? THEN ? ELSE cleanup_last_attempt_at END WHERE id = ?")
      .run(String(error || "").slice(0, 200), attempted ? 1 : 0, attempted ? 1 : 0, Number(now), String(id));
  }

  pendingCleanupRows({ limit = 1000 } = {}) {
    return this.db.prepare("SELECT * FROM avatars WHERE status IN ('cleanup_pending', 'pending_upload') ORDER BY created_at, id LIMIT ?")
      .all(Math.max(1, Math.min(10000, Number(limit) || 1000)));
  }

  /** 未绑定且超过 ttlMs 的登记（孤立资源候选），最多 limit 条。 */
  orphanIds({ before, ttlMs = 24 * 60 * 60 * 1000, limit = 20 } = {}) {
    const cutoff = (before ?? Date.now()) - ttlMs;
    return this.db.prepare("SELECT id FROM avatars WHERE bound_at IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT ?")
      .all(cutoff, Number(limit) || 20).map((row) => row.id);
  }

  remove(id) {
    this.db.prepare("DELETE FROM avatars WHERE id = ?").run(String(id));
  }

  close() { this.db.close(); }
}
