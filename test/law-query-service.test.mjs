import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createLawQueryService, LAW_EXPORT_MAX_ROWS } from "../server/law-query-service.mjs";
import { UserSecurityLogStore } from "../server/user-security-log-store.mjs";
import { AdminAccountsStore } from "../server/admin-accounts-store.mjs";
import { archiveRows } from "../server/durable-log.mjs";

const BASE = 1_800_000_000_000;
const params = object => new URLSearchParams(object);

function fixture(t, { reviews = [], feedback = [], maxExportRows } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "law-query-synthetic-"));
  const dbPath = path.join(directory, "state.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE mp_users(id INTEGER PRIMARY KEY, openid TEXT, nickname TEXT, phone TEXT, phone_verified_at INTEGER, created_at INTEGER, last_login_at INTEGER, login_count INTEGER, blocked INTEGER, web_password_hash TEXT, session_token TEXT);
    INSERT INTO mp_users VALUES(1,'synthetic-openid-1','synthetic-one','13800000001',NULL,${BASE - 1000},NULL,2,0,'synthetic-secret-hash','synthetic-secret-token');
    INSERT INTO mp_users VALUES(10,'synthetic-openid-10','synthetic-ten','13800000010',NULL,${BASE - 1000},NULL,2,1,'synthetic-other-hash','synthetic-other-token');`);
  const securityLogStore = new UserSecurityLogStore({ dbPath });
  const accountsStore = new AdminAccountsStore({ dbPath, archiveDir: path.join(directory, "admin-archive") });
  t.after(() => { accountsStore.close(); securityLogStore.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const service = createLawQueryService({ db, readReviews: () => ({ reviews }), readFeedback: () => ({ items: feedback }), securityLogStore, accountsStore, now: () => BASE + 10_000, ...(maxExportRows === undefined ? {} : { maxExportRows }) });
  const security = db.prepare("INSERT INTO user_security_logs(at,user_id,action,target_type,target_id,result,event_id) VALUES(?,?,?,?,?,?,?)");
  const audit = db.prepare("INSERT INTO admin_audit_log(at,username,action,target,detail,event_id) VALUES(?,'synthetic-admin',?,?,?,?)");
  return { service, db, directory, securityLogStore, accountsStore, security, audit };
}

test("law query pages more than 300 content and log rows, including archived evidence, with exact totals", t => {
  const reviews = Array.from({ length: 375 }, (_, i) => ({ id: `r-${i}`, user_id: "1", createdAt: "2020-01-01T00:00:00Z" }));
  const feedback = Array.from({ length: 330 }, (_, i) => ({ id: `f-${i}`, user_id: 1, private: true }));
  reviews.push({ id: "r-0-other", user_id: 10 }); feedback.push({ id: "f-0-other", user_id: 10 });
  const f = fixture(t, { reviews, feedback });
  f.db.transaction(() => {
    for (let i = 0; i < 421; i++) f.security.run(BASE + i, 1, "review.submit", "review", `r-${i % 375}`, "ok", `security-${i}`);
    for (let i = 0; i < 451; i++) f.audit.run(BASE + i, "content.update", i < 80 ? "user:1" : i < 330 ? `review:r-${i % 375}` : `feedback:f-${i % 330}`, "synthetic-metadata", `audit-${i}`);
    f.security.run(BASE, 10, "review.submit", "review", "r-0-other", "ok", "other-security");
    f.audit.run(BASE, "content.update", "user:10", "synthetic-other", "other-audit");
  })();
  archiveRows({ db: f.db, table: "user_security_logs", directory: f.securityLogStore.archiveDir, keepRows: 70, threshold: 300 });
  archiveRows({ db: f.db, table: "admin_audit_log", directory: f.accountsStore.archiveDir, keepRows: 70, threshold: 300 });
  const collected = { reviews: [], feedback: [], security_logs: [], admin_audit: [] };
  for (let page = 1; page <= 4; page++) {
    const result = f.service.query(params({ value: "1", review_page: String(page), feedback_page: String(page), content_page_size: "123", log_page: String(page), log_page_size: "123", audit_page: String(page) }));
    assert.deepEqual(result.counts, { account: 1, reviews: 375, feedback: 330, security_logs: 421, admin_audit: 451 });
    assert.equal(result.complete, false);
    for (const [key, metadata] of [["reviews", "reviews_pagination"], ["feedback", "feedback_pagination"], ["security_logs", "log_pagination"], ["admin_audit", "audit_pagination"]]) {
      assert.equal(result[metadata].returned, result[key].length);
      assert.equal(result[metadata].total, result.counts[key]);
      assert.equal(result[metadata].has_more, page * 123 < result.counts[key]);
      assert.equal(result[metadata].truncated, result[key].length < result.counts[key]);
      collected[key].push(...result[key]);
    }
  }
  for (const key of Object.keys(collected)) assert.equal(new Set(collected[key].map(row => row.id)).size, collected[key].length);
  assert.equal(collected.reviews.length, 375); assert.equal(collected.feedback.length, 330);
  assert.equal(collected.security_logs.length, 421); assert.equal(collected.admin_audit.length, 451);
  assert.equal(f.securityLogStore.db.prepare("SELECT COUNT(*) c FROM user_security_logs").get().c, 70);
});

test("law export uses all matching rows regardless of selected pages and reports complete collection metadata", t => {
  const f = fixture(t, { reviews: Array.from({ length: 345 }, (_, i) => ({ id: `r-${i}`, user_id: 1 })) });
  f.db.transaction(() => { for (let i = 0; i < 455; i++) { f.security.run(BASE + i, 1, "review.submit", "review", `r-${i % 345}`, "ok", null); f.audit.run(BASE + i, "content.update", `review:r-${i % 345}`, "", null); } })();
  const request = params({ value: "1", log_page: "999", audit_page: "999", review_page: "999", content_page_size: "1", log_page_size: "1", reference: "SYNTHETIC-CASE:2026.10" });
  const query = f.service.query(request);
  assert.equal(query.reviews.length, 0); assert.equal(query.log_pagination.total, 455); assert.equal(query.complete, false);
  const output = f.service.export(request);
  assert.equal(output.complete, true); assert.equal(output.reviews.length, 345);
  assert.equal(output.security_logs.length, 455); assert.equal(output.admin_audit.length, 455);
  assert.deepEqual(output.counts, { account: 1, reviews: 345, feedback: 0, security_logs: 455, admin_audit: 455 });
  assert.equal(output.query.reference, "SYNTHETIC-CASE:2026.10"); assert.equal(output.query.target, "user:1");
  assert.equal(output.generatedAt, new Date(BASE + 10_000).toISOString());
  assert.deepEqual(output.snapshot, { scope: "synchronous_collection", atomic_across_sources: false });
  assert.equal(output.export_limit.max_rows_per_collection, LAW_EXPORT_MAX_ROWS);
  assert.equal(output.log_pagination.has_more, false); assert.equal(output.log_pagination.truncated, false);
  assert.equal(JSON.stringify(output.account).includes("synthetic-secret"), false);
  assert.equal(Object.hasOwn(output.account, "web_password_hash"), false); assert.equal(Object.hasOwn(output.account, "session_token"), false);
  assert.equal(f.service.export(params({ value: "1", log_page: "bad", content_page_size: "bad" })).complete, true);
});

test("user ids 1 and 10, and content ids x and x2, never use fuzzy matching", t => {
  const f = fixture(t, { reviews: [{ id: "x", user_id: 1 }, { id: "x2", user_id: 10 }], feedback: [{ id: "x", user_id: 1 }, { id: "x2", user_id: 10 }] });
  f.security.run(BASE, 1, "review.submit", "review", "x", "ok", null);
  f.security.run(BASE, 10, "review.submit", "review", "x2", "ok", null);
  f.security.run(BASE, null, "moderation.related", "feedback", "x", "ok", null);
  for (const target of ["user:1", "review:x", "feedback:x", "user:10", "review:x2", "feedback:x2"]) f.audit.run(BASE, "content.update", target, "", null);
  const user = f.service.export(params({ value: "1" }));
  assert.deepEqual(user.admin_audit.map(row => row.target).sort(), ["feedback:x", "review:x", "user:1"]);
  assert.equal(user.security_logs.length, 2); assert.ok(user.security_logs.every(row => row.target_id === "x"));
  const review = f.service.export(params({ type: "review", id: "x" }));
  assert.equal(review.query.target, "review:x"); assert.equal(review.account.id, 1); assert.equal(review.feedback.length, 0);
  assert.deepEqual(review.admin_audit.map(row => row.target), ["review:x"]); assert.equal(review.security_logs.length, 1);
  const feedback = f.service.export(params({ type: "feedback", id: "x" }));
  assert.equal(feedback.query.target, "feedback:x"); assert.equal(feedback.security_logs[0].target_type, "feedback");
});

test("time range is inclusive for logs, action filters are exact, and content remains complete context", t => {
  const f = fixture(t, { reviews: [{ id: "x", user_id: 1, createdAt: "2000-01-01T00:00:00Z" }] });
  for (const at of [BASE - 1, BASE, BASE + 1, BASE + 2]) {
    f.security.run(at, 1, "review.submit", "review", "x", "ok", null);
    f.audit.run(at, "content.update", "review:x", "", null);
  }
  f.security.run(BASE, 1, "review.submit.extra", "review", "x", "ok", null);
  f.audit.run(BASE, "content.update.extra", "review:x", "", null);
  const output = f.service.export(params({ value: "1", from: new Date(BASE).toISOString(), to: String(BASE + 1), action: "review.submit", audit_action: "content.update" }));
  assert.equal(output.security_logs.length, 2); assert.equal(output.admin_audit.length, 2); assert.equal(output.reviews.length, 1);
  assert.deepEqual(output.query.time_scope, ["security_logs", "admin_audit"]);
  assert.equal(output.range.inclusive, true); assert.equal(output.range.from_ms, BASE); assert.equal(output.range.to_ms, BASE + 1);
  assert.equal(output.query.filters.audit_action, "content.update");
});

test("deleted content is linked only through successful retained submission ownership evidence", t => {
  const f = fixture(t, { reviews: [{ id: "reused", user_id: 10 }] });
  f.security.run(BASE, 1, "review.submit", "review", "deleted", "ok", null);
  f.security.run(BASE, 1, "feedback.submit", "feedback", "removed", "pending", null);
  f.security.run(BASE, 1, "report.submit", "feedback", "removed-report", "ok", null);
  f.security.run(BASE, 1, "review.submit", "review", "failed", "error", null);
  f.security.run(BASE, 1, "review.helpful", "review", "another-author", "ok", null);
  f.security.run(BASE, 1, "review.submit", "review", "reused", "ok", null);
  for (const target of ["review:deleted", "feedback:removed", "feedback:removed-report", "review:failed", "review:another-author", "review:reused"]) f.audit.run(BASE + 100, "content.delete", target, "", null);
  const output = f.service.export(params({ value: "1", from: String(BASE + 100) }));
  assert.deepEqual(output.admin_audit.map(row => row.target).sort(), ["feedback:removed", "feedback:removed-report", "review:deleted"]);
  assert.equal(output.security_logs.length, 0, "ownership uses retained evidence outside selected log time range");
});

test("legacy anonymous content, numeric content ids, and legacy archives remain queryable without invented accounts", t => {
  const f = fixture(t, { reviews: [{ id: 7, user_id: null }], feedback: [{ id: "anonymous" }] });
  f.security.run(BASE, null, "review.submit", "review", "7", "ok", null);
  f.audit.run(BASE, "content.update", "review:7", "", null);
  fs.mkdirSync(f.accountsStore.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(f.accountsStore.archiveDir, "audit-1-1-1.json"), JSON.stringify({ rows: [{ id: 1, at: BASE - 1, username: "synthetic-legacy", action: "content.update", target: "review:7", detail: "" }] }));
  const output = f.service.export(params({ type: "review", id: "7" }));
  assert.equal(output.account, null); assert.equal(output.reviews[0].id, 7); assert.equal(output.security_logs.length, 1);
  assert.equal(output.admin_audit.length, 2, "distinct legacy rows with overlapping ids must not be erased");
  assert.equal(f.service.query(params({ type: "feedback", id: "anonymous" })).account, null);
});

test("exact phone/openid lookup works, while ambiguous phone lookup requires a user id", t => {
  const f = fixture(t);
  assert.equal(f.service.query(params({ value: "13800000001" })).account.id, 1);
  assert.equal(f.service.query(params({ value: "synthetic-openid-10" })).account.id, 10);
  f.db.prepare("UPDATE mp_users SET phone = '13800000001' WHERE id=10").run();
  assert.throws(() => f.service.query(params({ value: "13800000001" })), error => error.statusCode === 409 && error.code === "LAW_AMBIGUOUS_ACCOUNT");
});

test("invalid filters and empty/missing selectors are rejected instead of silently broadening scope", t => {
  const f = fixture(t);
  for (const invalid of [
    { type: "all", value: "1" }, { value: "" }, { value: "0" }, { value: "9007199254740993" },
    { value: "1", from: "yesterday" }, { value: "1", from: "-1" }, { value: "1", from: "2026-02-30T00:00:00Z" },
    { value: "1", from: "2026-10-07T00:00:00" }, { value: "1", from: "2026-10-07T24:00:00Z" }, { value: "1", from: "3", to: "2" },
    { value: "1", log_page: "1.5" }, { value: "1", log_page: "0" }, { value: "1", log_page_size: "1001" },
    { value: "1", audit_page_size: "-1" }, { value: "1", content_page_size: "0" },
    { value: "1", action: "x".repeat(65) }, { value: "1", audit_action: "x".repeat(129) },
    { value: "1", reference: "secret phone 13800000001" }, { value: "1", reference: " padded " }, { value: "1", reference: "x".repeat(81) },
    { type: "review", id: "" },
  ]) assert.throws(() => f.service.query(params(invalid)), error => error.statusCode === 400, JSON.stringify(invalid));
  assert.throws(() => f.service.query(params({ value: "999" })), error => error.statusCode === 404);
  assert.throws(() => f.service.query(params({ type: "review", id: "missing" })), error => error.statusCode === 404);
});

test("export row cap rejects the whole result while query totals and paging remain available", t => {
  const f = fixture(t, { reviews: [{ id: "a", user_id: 1 }, { id: "b", user_id: 1 }, { id: "c", user_id: 1 }], maxExportRows: 2 });
  assert.equal(f.service.query(params({ value: "1", content_page_size: "1" })).reviews_pagination.total, 3);
  assert.throws(() => f.service.export(params({ value: "1" })), error => error.statusCode === 413 && error.code === "LAW_EXPORT_TOO_LARGE");
  assert.equal(f.service.export(params({ type: "review", id: "a" })).complete, true);
});

test("default 50000 export cap permits exactly the bound and rejects the next record", t => {
  const f = fixture(t, { reviews: Array.from({ length: LAW_EXPORT_MAX_ROWS }, (_, i) => ({ id: `synthetic-${i}`, user_id: 1 })) });
  const complete = f.service.export(params({ value: "1" }));
  assert.equal(complete.reviews.length, LAW_EXPORT_MAX_ROWS); assert.equal(complete.complete, true);
  const oversized = createLawQueryService({ db: f.db, readReviews: () => ({ reviews: [...complete.reviews, { id: "extra", user_id: 1 }] }), readFeedback: () => ({ items: [] }), securityLogStore: f.securityLogStore, accountsStore: f.accountsStore, now: () => BASE + 10_000 });
  assert.throws(() => oversized.export(params({ value: "1", review_page: "9" })), error => error.statusCode === 413);
});

test("export collects each source once rather than rereading page-sized log results", t => {
  const f = fixture(t, { reviews: [{ id: "x", user_id: 1 }] });
  const called = { reviews: 0, feedback: 0, security: 0, audit: 0 };
  const service = createLawQueryService({
    db: f.db, readReviews: () => { called.reviews++; return { reviews: [{ id: "x", user_id: 1 }] }; },
    readFeedback: () => { called.feedback++; return { items: [] }; },
    securityLogStore: { snapshot: () => { called.security++; return Array.from({ length: 1305 }, (_, i) => ({ id: i, user_id: 1, at: BASE, action: "review.submit", target_type: "review", target_id: "x" })); } },
    accountsStore: { snapshotAudit: options => { called.audit++; assert.equal(options.includeArchived, true); return []; } }, now: () => BASE + 10_000,
  });
  const output = service.export(params({ value: "1", log_page_size: "1" }));
  assert.equal(output.security_logs.length, 1305); assert.deepEqual(called, { reviews: 1, feedback: 1, security: 1, audit: 1 });
});

test("corrupt archives and completed logs awaiting replay cannot be presented as complete exports", t => {
  const f = fixture(t);
  f.security.run(BASE, 1, "profile.update", "", "", "ok", "first");
  f.security.run(BASE + 1, 1, "profile.update", "", "", "ok", "second");
  const archive = archiveRows({ db: f.db, table: "user_security_logs", directory: f.securityLogStore.archiveDir, keepRows: 1, threshold: 2 });
  const bytes = fs.readFileSync(archive);
  fs.writeFileSync(archive, "{synthetic-broken");
  assert.throws(() => f.service.export(params({ value: "1" })), error => error.statusCode === 503 && error.code === "LAW_DATA_UNAVAILABLE" && !error.message.includes(f.directory));
  fs.writeFileSync(archive, bytes);
  f.securityLogStore.writer.health = () => ({ pending: 1, inFlight: 0 });
  assert.throws(() => f.service.export(params({ value: "1" })), error => error.statusCode === 503 && error.code === "LAW_LOG_RECOVERY_PENDING");
  f.securityLogStore.writer.health = () => ({ pending: 0, inFlight: 1 });
  assert.equal(f.service.export(params({ value: "1" })).complete, true, "the current request's audit intent does not block a collection");
});

test("audit exact target lists, action and time filters work for both hot and archived callers", t => {
  const f = fixture(t);
  f.audit.run(BASE - 1, "content.update", "user:1", "", null);
  f.audit.run(BASE, "content.update", "review:x", "", null);
  f.audit.run(BASE + 1, "content.update.extra", "feedback:x", "", null);
  f.audit.run(BASE + 2, "content.update", "user:10", "", null);
  const filters = { targets: ["user:1", "review:x", "feedback:x"], action: "content.update", actionExact: true, from: BASE, to: BASE + 1 };
  assert.equal(f.accountsStore.queryAudit(filters).total, 1);
  assert.equal(f.accountsStore.queryAudit({ ...filters, includeArchived: true }).total, 1);
  archiveRows({ db: f.db, table: "admin_audit_log", directory: f.accountsStore.archiveDir, keepRows: 1, threshold: 4 });
  assert.equal(f.accountsStore.queryAudit(filters).total, 0);
  assert.equal(f.accountsStore.queryAudit({ ...filters, includeArchived: true }).total, 1);
  assert.equal(f.accountsStore.queryAudit({ includeArchived: true, targets: [], to: BASE + 10_000 }).total, 0);
  assert.equal(f.accountsStore.queryAudit({ targets: [], to: BASE + 10_000 }).total, 0);
});

test("export cap covers each log/content collection, and snapshot deduplicates archived live overlap", t => {
  const f = fixture(t, { feedback: [{ id: "f1", user_id: 1 }, { id: "f2", user_id: 1 }, { id: "f3", user_id: 1 }], maxExportRows: 2 });
  assert.throws(() => f.service.export(params({ value: "1" })), error => error.statusCode === 413);
  const service = createLawQueryService({ db: f.db, readReviews: () => ({ reviews: [] }), readFeedback: () => ({ items: [] }), securityLogStore: f.securityLogStore, accountsStore: f.accountsStore, maxExportRows: 2, now: () => BASE + 10_000 });
  for (let i = 0; i < 3; i++) f.security.run(BASE + i, 1, "profile.update", "", "", "ok", `overlap-${i}`);
  assert.throws(() => service.export(params({ value: "1" })), error => error.statusCode === 413);
  // Archive copy succeeds but delete is interrupted: the hot and archive copies coexist.
  assert.throws(() => archiveRows({ db: f.db, table: "user_security_logs", directory: f.securityLogStore.archiveDir, keepRows: 1, threshold: 3, fault: phase => { if (phase === "beforeDelete") throw new Error("synthetic interruption"); } }));
  assert.equal(f.securityLogStore.snapshot().length, 3);
  f.db.prepare("DELETE FROM user_security_logs").run();
  fs.rmSync(f.securityLogStore.archiveDir, { recursive: true, force: true });
  for (let i = 0; i < 3; i++) f.audit.run(BASE + i, "user.block", "user:1", "", null);
  assert.throws(() => service.export(params({ value: "1" })), error => error.statusCode === 413);
});

test("archive rollover immediately before the hot selection cannot create a log collection gap", t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.security.run(BASE + i, 1, "profile.update", "", "", "ok", `rollover-${i}`);
  const original = f.securityLogStore.db.prepare.bind(f.securityLogStore.db);
  let rolled = false;
  f.securityLogStore.db.prepare = statement => {
    if (statement !== "SELECT * FROM user_security_logs") return original(statement);
    return { all: () => {
      if (!rolled) {
        rolled = true;
        archiveRows({ db: f.db, table: "user_security_logs", directory: f.securityLogStore.archiveDir, keepRows: 1, threshold: 5 });
      }
      return original(statement).all();
    } };
  };
  assert.equal(f.service.export(params({ value: "1" })).security_logs.length, 5);
  assert.equal(rolled, true);
});
