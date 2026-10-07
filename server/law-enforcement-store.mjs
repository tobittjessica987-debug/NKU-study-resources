import { DurableLog, ensureEventId, archiveRows, archivedRows, pruneArchives } from "./durable-log.mjs";
import { parseLawTime, parseLawPage } from "./law-query-service.mjs";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** 依法调取留痕：每一次内部查询/导出都必须记录（查询人、条件、结果概要）。 */
export class LawEnforcementLogStore {
  constructor({ dbPath, archiveDir = path.join(path.dirname(dbPath), "law-archive"), journalDir = path.join(path.dirname(dbPath), "log-queue", "law") }) {
    if (!dbPath) throw new Error("LawEnforcementLogStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.archiveDir = archiveDir;
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS law_enforcement_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        queried_by TEXT NOT NULL,
        query_type TEXT NOT NULL,
        query_value TEXT NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS lel_at_idx ON law_enforcement_logs(at);
    `);
    ensureEventId(this.db, "law_enforcement_logs");
    this.insert = this.db.prepare(
      "INSERT OR IGNORE INTO law_enforcement_logs (at, queried_by, query_type, query_value, exported, result_summary, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this.writer = new DurableLog({ directory: journalDir, kind: "law", insert: (row, id) => this.insert.run(...row, id) });
  }

  record({ at = Date.now(), queriedBy, queryType, queryValue, exported = false, resultSummary = "", eventId }) {
    return this.writer.write([at, String(queriedBy).slice(0, 64), String(queryType).slice(0, 32), String(queryValue).slice(0, 120), exported ? 1 : 0, String(resultSummary).slice(0, 2000)], eventId);
  }

  maintain(now = Date.now()) {
    this.writer.replay();
    archiveRows({ db: this.db, table: "law_enforcement_logs", directory: this.archiveDir, keepRows: 10000, threshold: 20000 });
    const cutoff = now - 400 * 86400000;
    pruneArchives(this.archiveDir, "law_enforcement_logs", cutoff);
    this.db.prepare("DELETE FROM law_enforcement_logs WHERE at < ?").run(cutoff);
    this.writer.maintenanceError = null;
  }

  listRecent(limit = 100) {
    return this.query({ pageSize: Math.min(500, Math.max(1, Math.floor(Number(limit) || 100))) }).items;
  }

  query({ actor = "", type = "", exported, from = 0, to = Date.now(), page = 1, pageSize = 50 } = {}) {
    const invalid = () => Object.assign(new Error("调取历史筛选无效。"), { statusCode: 400, code: "LAW_INVALID_QUERY" });
    actor = String(actor || "").trim(); type = String(type || "").trim();
    if (actor.length > 64 || type.length > 32 || /[\u0000-\u001f\u007f]/.test(actor + type)) throw invalid();
    let selectedExported = null;
    if (exported !== undefined && exported !== null && exported !== "") {
      if ([true, 1, "1", "true"].includes(exported)) selectedExported = 1;
      else if ([false, 0, "0", "false"].includes(exported)) selectedExported = 0;
      else throw invalid();
    }
    from = parseLawTime(from, 0, "开始时间"); to = parseLawTime(to, Date.now(), "结束时间");
    if (from > to) throw invalid();
    page = parseLawPage(page, 1, "历史页码"); pageSize = parseLawPage(pageSize, 50, "历史每页条数", 1000);
    const health = this.writer.health();
    if (!Number.isFinite(health.pending) || health.pending > 0) throw Object.assign(new Error("调取日志仍待恢复，请稍后重试。"), { statusCode: 503, code: "LAW_LOG_RECOVERY_PENDING" });
    const unique = new Map();
    const hot = this.db.prepare("SELECT * FROM law_enforcement_logs").all();
    for (const row of [...archivedRows(this.archiveDir, "law_enforcement_logs"), ...hot]) {
      const { event_id, ...legacy } = row;
      unique.set(event_id || `legacy:${JSON.stringify(legacy)}`, row);
    }
    const rows = [...unique.values()].filter(row => (!actor || row.queried_by === actor) && (!type || row.query_type === type) && (selectedExported === null || Number(row.exported) === selectedExported) && Number(row.at) >= from && Number(row.at) <= to).sort((a, b) => Number(b.at) - Number(a.at) || Number(b.id) - Number(a.id));
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return {
      items, total: rows.length, page, page_size: pageSize, returned: items.length,
      total_pages: Math.ceil(rows.length / pageSize), has_more: page * pageSize < rows.length,
      truncated: items.length < rows.length,
      filters: { actor, type, exported: selectedExported === null ? null : Boolean(selectedExported), from, to },
    };
  }

  close() {
    this.db.close();
  }
}
