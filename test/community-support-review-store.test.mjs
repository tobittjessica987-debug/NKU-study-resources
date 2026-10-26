import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { CommunitySupportReviewStore } from "../server/community-support-review-store.mjs";
import { normalizeReviewsDocument } from "../server/moderation-model.mjs";

const FIELD = "community_support_ledger";
const source = () => ({ version: 1, rules: {}, reviews: [{ id: "historical", status: "approved", body: "Historical content" }] });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "community-support-reviews-"));
  const filePath = path.join(directory, "reviews.json");
  const otherPath = path.join(directory, "other.json");
  const store = new CommunitySupportReviewStore({ allowedRoot: directory, reviewsFilePath: filePath, ...options });
  t.after(async () => {
    // Only the two exact fixture files are removed; unexpected files preserve
    // their directory as evidence instead of recursive cleanup.
    await fs.unlink(filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.unlink(otherPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(directory);
  });
  await store.write(filePath, source());
  return { directory, filePath, otherPath, store, read: () => store.read(filePath) };
}

test("disabled store leaves legacy reviews untouched and initialization records a stable historical baseline", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read())[FIELD], undefined);
  const first = await f.store.initializeCommunitySupport();
  assert.deepEqual(first[FIELD].baseline_review_ids, ["historical"]);
  assert.equal(first[FIELD].sequence, 0);
  assert.match(first[FIELD].epoch, /^[0-9a-f-]{36}$/);
  const bytes = await fs.readFile(f.filePath, "utf8");
  const repeated = await f.store.initializeCommunitySupport(f.filePath);
  assert.deepEqual(repeated[FIELD], first[FIELD]);
  assert.equal(await fs.readFile(f.filePath, "utf8"), bytes);
  assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
});

test("review creation and moderation atomically advance sequence while metadata tampering cannot reset enrollment", async (t) => {
  const f = await fixture(t);
  const initial = await f.store.initializeCommunitySupport();
  await f.store.update(f.filePath, (document) => {
    document.reviews.push({ id: "new-review", user_id: 7, status: "pending" });
    document[FIELD] = { version: 999, epoch: "forged", sequence: -1, baseline_review_ids: [] };
    return document;
  });
  let current = await f.read();
  assert.deepEqual(current[FIELD], { ...initial[FIELD], sequence: 1 });
  await f.store.update(f.filePath, (document) => {
    document.reviews[1].status = "approved";
    delete document[FIELD];
    return document;
  });
  current = await f.read();
  assert.deepEqual(current[FIELD], { ...initial[FIELD], sequence: 2 });
  await f.store.write(f.filePath, { ...current, [FIELD]: { ...initial[FIELD], sequence: 0 } });
  assert.deepEqual((await f.read())[FIELD], current[FIELD], "metadata-only changes are ignored without inventing a new revision");
  const restart = new CommunitySupportReviewStore({ allowedRoot: f.directory, reviewsFilePath: f.filePath });
  await restart.update(f.filePath, (document) => { document.reviews[1].hidden = true; return document; });
  assert.equal((await f.read())[FIELD].sequence, 3, "existing metadata is maintained even without enabling the feature again");
});

test("duplicate review IDs fail while corrupt optional metadata is preserved and isolates only statistics", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  let before = await fs.readFile(f.filePath, "utf8");
  await assert.rejects(f.store.update(f.filePath, (document) => {
    document.reviews.push(structuredClone(document.reviews[0]));
    return document;
  }), { code: "SUPPORT_UNAVAILABLE", statusCode: 503 });
  assert.equal(await fs.readFile(f.filePath, "utf8"), before);
  const invalid = await f.read();
  invalid[FIELD].baseline_review_ids.push("historical");
  await new AtomicJsonStore({ allowedRoot: f.directory }).write(f.filePath, invalid);
  before = await fs.readFile(f.filePath, "utf8");
  await assert.rejects(f.store.initializeCommunitySupport(), { code: "SUPPORT_UNAVAILABLE" });
  assert.equal(await fs.readFile(f.filePath, "utf8"), before);
  const reports = [];
  let projected = 0;
  f.store.onProjectionError = error => reports.push(error.code);
  f.store.afterReviewsWrite = () => { projected++; };
  await f.store.update(f.filePath, document => { document.reviews[0].hidden = true; return document; });
  assert.equal((await f.read()).reviews[0].hidden, true);
  assert.deepEqual((await f.read())[FIELD], invalid[FIELD], "damaged evidence is neither repaired nor discarded");
  await f.store.write(f.filePath, source());
  assert.deepEqual((await f.read())[FIELD], invalid[FIELD]);
  assert.throws(() => f.store.assertProjectionReadable(), { code: "SUPPORT_UNAVAILABLE" });
  assert.equal(projected, 0);
  assert.deepEqual(reports, ["SUPPORT_UNAVAILABLE"], "optional metadata failure is reported once");
});

test("normalization retains metadata and no-op writes do not advance its sequence", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  const normalize = (document) => normalizeReviewsDocument(document, { nowIso: "2026-10-23T00:00:00Z" });
  await f.store.update(f.filePath, normalize);
  const first = await f.read();
  assert.equal(first[FIELD].sequence, 1);
  await f.store.update(f.filePath, normalize);
  assert.deepEqual((await f.read())[FIELD], first[FIELD]);
});

test("projection failure preserves a durable snapshot and callbacks observe actual committed metadata", async (t) => {
  const reports = [];
  const f = await fixture(t, { onProjectionError: (error) => { reports.push(error.code); } });
  await f.store.initializeCommunitySupport();
  const stages = [];
  f.store.afterReviewsWrite = () => { stages.push("projection"); throw new Error("private database path must not escape"); };
  const committed = await f.store.update(f.filePath, (document) => {
    document.reviews.push({ id: "new-review", status: "approved" });
    return document;
  }, {
    afterWrite: async (next) => { stages.push("readback"); assert.deepEqual(await f.read(), next); },
    afterCommit: (next) => { stages.push("journal"); assert.equal(next[FIELD].sequence, 1); },
  });
  assert.deepEqual(stages, ["readback", "journal", "projection"]);
  assert.deepEqual(reports, ["SUPPORT_UNAVAILABLE"]);
  assert.deepEqual(await f.read(), committed);
  let projected;
  f.store.afterReviewsWrite = (document) => { projected = document; };
  await f.store.update(f.filePath, (document) => document);
  assert.deepEqual(projected, committed, "the complete persisted snapshot supports idempotent projection recovery");
});

test("original afterWrite rollback is preserved and never sends an aborted snapshot to the projection", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  const before = await f.read();
  let projected = 0;
  f.store.afterReviewsWrite = () => { projected++; };
  await assert.rejects(f.store.update(f.filePath, (document) => {
    document.reviews[0].hidden = true;
    return document;
  }, { afterWrite: () => { throw new Error("intentional readback failure"); }, rollbackOnAfterWriteError: true }), { atomicJsonRolledBack: true });
  assert.deepEqual(await f.read(), before);
  assert.equal(projected, 0);
});

test("failure before atomic rename preserves both review state and sequence", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  const bytes = await fs.readFile(f.filePath, "utf8");
  let projected = 0;
  f.store.afterReviewsWrite = () => { projected++; };
  f.store.faultHook = (phase) => { if (phase === "beforeRename") throw new Error("controlled write interruption"); };
  await assert.rejects(f.store.update(f.filePath, (document) => {
    document.reviews.push({ id: "never-committed", status: "approved" });
    return document;
  }), /controlled write interruption/);
  assert.equal(await fs.readFile(f.filePath, "utf8"), bytes);
  assert.equal(projected, 0);
  f.store.faultHook = undefined;
  await f.store.update(f.filePath, (document) => { document.reviews[0].hidden = true; return document; });
  assert.equal((await f.read())[FIELD].sequence, 1);
});

test("original journal commit failure keeps its quarantine and does not project unconfirmed state", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  let projected = 0;
  f.store.afterReviewsWrite = () => { projected++; };
  await assert.rejects(f.store.update(f.filePath, (document) => {
    document.reviews[0].hidden = true;
    return document;
  }, { afterCommit: () => { throw new Error("original journal unresolved"); } }), /original journal unresolved/);
  const committed = await f.read();
  assert.equal(committed.reviews[0].hidden, true);
  assert.equal(committed[FIELD].sequence, 1);
  assert.equal(projected, 0);
  assert.throws(() => f.store.assertProjectionReadable(), { code: "SUPPORT_UNAVAILABLE" });
  await assert.rejects(f.store.update(f.filePath, (document) => document), { code: "PUBLISH_RECOVERY_REQUIRED" });
});

test("statistics cannot project a renamed snapshot while its readback hook can still roll it back", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  const before = await f.read();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const write = f.store.update(f.filePath, (document) => {
    document.reviews[0].hidden = true;
    return document;
  }, { rollbackOnAfterWriteError: true, afterWrite: async () => {
    entered();
    await gate;
    throw new Error("controlled rollback after rename");
  } });
  const rejected = assert.rejects(write, { atomicJsonRolledBack: true });
  await started;
  assert.equal((await f.read())[FIELD].sequence, 1, "business readback can inspect the pending rename");
  assert.throws(() => f.store.assertProjectionReadable(), { code: "SUPPORT_UNAVAILABLE", statusCode: 503 });
  resume();
  await rejected;
  assert.doesNotThrow(() => f.store.assertProjectionReadable());
  assert.deepEqual(await f.read(), before);
});

test("concurrent updates preserve every new review and advance exactly once per change", async (t) => {
  const f = await fixture(t);
  await f.store.initializeCommunitySupport();
  let updaterCalls = 0;
  const observed = [];
  f.store.afterReviewsWrite = (document) => { observed.push(document[FIELD].sequence); };
  await Promise.all(Array.from({ length: 30 }, (_, index) => f.store.update(f.filePath, async (document) => {
    updaterCalls++;
    await Promise.resolve();
    document.reviews.push({ id: `review-${index}`, status: "pending" });
    return document;
  })));
  const current = await f.read();
  assert.equal(updaterCalls, 30);
  assert.equal(current.reviews.length, 31);
  assert.equal(current[FIELD].sequence, 30);
  assert.deepEqual(observed, Array.from({ length: 30 }, (_, index) => index + 1));
});

test("writes share the file queue with updates and cannot erase ledger metadata", async (t) => {
  const f = await fixture(t);
  const initial = await f.store.initializeCommunitySupport();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const first = f.store.update(f.filePath, async (document) => {
    entered();
    await gate;
    document.reviews.push({ id: "first", status: "pending" });
    return document;
  });
  await started;
  const replacement = f.store.write(f.filePath, { ...source(), reviews: [{ id: "second", status: "pending" }] });
  resume();
  await Promise.all([first, replacement]);
  const current = await f.read();
  assert.deepEqual(current[FIELD], { ...initial[FIELD], sequence: 2 });
  assert.deepEqual(current.reviews.map((review) => review.id), ["second"], "whole-document write retains its intentional replacement semantics");
});

test("sequence overflow isolates statistics while retaining business writes and unrelated JSON semantics", async (t) => {
  const f = await fixture(t);
  const current = await f.store.initializeCommunitySupport();
  current[FIELD].sequence = Number.MAX_SAFE_INTEGER;
  await new AtomicJsonStore({ allowedRoot: f.directory }).write(f.filePath, current);
  let projected = 0;
  f.store.afterReviewsWrite = () => { projected++; };
  await f.store.update(f.filePath, (document) => { document.reviews[0].hidden = true; return document; });
  assert.equal((await f.read()).reviews[0].hidden, true);
  assert.deepEqual((await f.read())[FIELD], current[FIELD]);
  assert.throws(() => f.store.assertProjectionReadable(), { code: "SUPPORT_UNAVAILABLE" });
  assert.equal(projected, 0);
  await f.store.write(f.otherPath, { [FIELD]: { unrelated: true } });
  await f.store.update(f.otherPath, (document) => ({ ...document, value: 2 }));
  assert.deepEqual(await f.store.read(f.otherPath), { [FIELD]: { unrelated: true }, value: 2 });
});
