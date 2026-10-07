import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { LawEnforcementLogStore } from "../server/law-enforcement-store.mjs";
import { archiveRows, writeEnvelope } from "../server/durable-log.mjs";

const BASE = 1_750_000_000_000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "law-history-synthetic-"));
  const store = new LawEnforcementLogStore({ dbPath: path.join(directory, "state.sqlite") });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test("law history queries cross archives with exact actor/type/export filters and complete pagination", t => {
  const { store } = fixture(t);
  const insert = store.db.prepare("INSERT INTO law_enforcement_logs(at,queried_by,query_type,query_value,exported,result_summary,event_id) VALUES(?,?,?,?,?,?,?)");
  store.db.transaction(() => {
    for (let i = 0; i < 420; i++) insert.run(BASE + i, i % 2 ? "synthetic-admin" : "synthetic-admin2", i % 3 ? "account" : "review", `user:${i}`, i % 4 ? 0 : 1, "synthetic-metadata", `event-${i}`);
  })();
  archiveRows({ db: store.db, table: "law_enforcement_logs", directory: store.archiveDir, keepRows: 70, threshold: 300 });
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const result = store.query({ page, pageSize: 100, to: BASE + 1000 });
    assert.equal(result.total, 420); assert.equal(result.returned, result.items.length);
    assert.equal(result.has_more, page < 5); assert.equal(result.total_pages, 5);
    all.push(...result.items);
  }
  assert.equal(all.length, 420); assert.equal(new Set(all.map(row => row.event_id)).size, 420);
  const selected = store.query({ actor: "synthetic-admin2", type: "review", exported: "true", from: BASE + 12, to: BASE + 120, pageSize: 100 });
  assert.equal(selected.total, 10); assert.equal(selected.items.length, 10);
  assert.ok(selected.items.every(row => row.queried_by === "synthetic-admin2" && row.query_type === "review" && row.exported === 1 && row.at >= BASE + 12 && row.at <= BASE + 120));
  assert.equal(store.query({ actor: "synthetic", to: BASE + 1000 }).total, 0, "actors match exactly");
  assert.equal(store.query({ type: "acc", to: BASE + 1000 }).total, 0, "types match exactly");
  assert.equal(store.query({ exported: false, to: BASE + 1000, pageSize: 1000 }).total, 315);
});

test("latest 20 compatibility includes archives and orders by event time with deterministic id tie breaking", t => {
  const { store } = fixture(t);
  for (let i = 0; i < 25; i++) store.record({ at: BASE + i, queriedBy: "synthetic-admin", queryType: "account", queryValue: "user:1" });
  archiveRows({ db: store.db, table: "law_enforcement_logs", directory: store.archiveDir, keepRows: 2, threshold: 25 });
  const latest = store.listRecent(20);
  assert.equal(latest.length, 20); assert.equal(latest[0].at, BASE + 24); assert.equal(latest.at(-1).at, BASE + 5);
  const insert = store.db.prepare("INSERT INTO law_enforcement_logs(at,queried_by,query_type,query_value) VALUES(?,'synthetic-admin','account','user:1')");
  insert.run(BASE + 100); insert.run(BASE + 100);
  const tied = store.listRecent(2); assert.ok(tied[0].id > tied[1].id);
});

test("record accepts a shared audit event id, deduplicates replay, and retains summary metadata up to 2000 characters", t => {
  const { store } = fixture(t);
  const eventId = randomUUID();
  const record = { at: BASE, queriedBy: "synthetic-admin", queryType: "account", queryValue: "user:1", exported: true, resultSummary: "x".repeat(1800), eventId };
  store.record(record); store.record(record);
  const result = store.query({ exported: true });
  assert.equal(result.total, 1); assert.equal(result.items[0].event_id, eventId); assert.equal(result.items[0].result_summary.length, 1800);
  store.record({ ...record, eventId: randomUUID(), resultSummary: "x".repeat(2300) });
  assert.equal(store.listRecent(1)[0].result_summary.length, 2000);
});

test("archive plus hot duplicates collapse by event id, and legacy id collisions preserve distinct events", t => {
  const { store } = fixture(t);
  store.record({ at: BASE, queriedBy: "synthetic-admin", queryType: "account", queryValue: "user:1", eventId: randomUUID() });
  const current = store.db.prepare("SELECT * FROM law_enforcement_logs").get();
  fs.mkdirSync(store.archiveDir, { recursive: true });
  writeEnvelope(path.join(store.archiveDir, "law_enforcement_logs-1-3.json"), "law_enforcement_logs", { rows: [current, { id: 1, at: BASE - 1, queried_by: "synthetic-legacy", query_type: "review", query_value: "review:x", exported: 0, result_summary: "legacy" }] });
  const result = store.query();
  assert.equal(result.total, 2); assert.equal(result.items[0].event_id, current.event_id);
  assert.equal(result.items[1].queried_by, "synthetic-legacy");
});

test("illegal historical filters reject with 400 and corrupted archives never yield partial history", t => {
  const { store } = fixture(t);
  for (const invalid of [
    { page: "0" }, { page: "bad" }, { pageSize: 1001 }, { pageSize: "1.5" },
    { exported: "maybe" }, { from: "yesterday" }, { from: "-1" }, { from: 3, to: 2 },
    { actor: "x".repeat(65) }, { type: "x".repeat(33) }, { actor: "x\ny" },
  ]) assert.throws(() => store.query(invalid), error => error.statusCode === 400);
  store.record({ at: BASE, queriedBy: "synthetic-admin", queryType: "account", queryValue: "user:1" });
  fs.mkdirSync(store.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(store.archiveDir, "law_enforcement_logs-1-1.json"), "{synthetic-broken");
  assert.throws(() => store.query()); assert.throws(() => store.listRecent(20));
});

test("completed queued events make history unavailable until replay rather than silently reducing totals", t => {
  const { store } = fixture(t);
  store.writer.health = () => ({ pending: 1 });
  assert.throws(() => store.query(), error => error.statusCode === 503 && error.code === "LAW_LOG_RECOVERY_PENDING");
  store.writer.health = () => ({ pending: 0 });
  assert.equal(store.query().total, 0);
});
