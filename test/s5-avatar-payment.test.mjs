import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { AvatarStore } from "../server/avatar-store.mjs";
import { createAvatarService, cleanupUserAvatars } from "../server/avatar-service.mjs";
import { DonateOrderStore } from "../server/donate-order-store.mjs";
import { appendDonateRecord, cleanupDonateRecords, normalizeRecords, normalizeStoredRecords } from "../server/donate-records.mjs";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { MpAuthService } from "../server/mp-auth-service.mjs";
import { PublicApiService } from "../server/public-api-service.mjs";
import { AccountDeletionService } from "../server/account-deletion-service.mjs";
import { initializeRuntimeDeletionLedger } from "../server/deletion-ledger.mjs";

const image = Buffer.from([0xff, 0xd8, 0xff]);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function sharpStub({ metadata = async () => ({ format: "jpeg", width: 8, height: 8 }) } = {}) {
  return () => ({ metadata, resize() { return this; }, jpeg() { return this; }, async toBuffer() { return Buffer.from("synthetic normalized JPEG"); } });
}
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nku-s5-avatar-pay-")));
  const resources = [];
  t.after(async () => { for (const resource of resources.reverse()) if (resource.db?.open) resource.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, dbPath: path.join(dir, "state.sqlite"), keep: resource => { resources.push(resource); return resource; } };
}
function avatarService(store, options = {}) {
  return createAvatarService({ store, moderation: { check: async () => ({ approved: true }) }, putObject: async () => {}, publicRoot: "https://avatar.example.invalid/avatars/", sharpImpl: sharpStub(), ...options });
}

test("S5 legacy avatar and payment schemas migrate without losing resource or accounting facts", async t => {
  const f = await fixture(t);
  const legacy = new Database(f.dbPath);
  legacy.exec(`
    CREATE TABLE avatars (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'approved', content_type TEXT NOT NULL DEFAULT 'image/jpeg', bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, bound_at INTEGER);
    INSERT INTO avatars VALUES ('legacy-avatar',7,'approved','image/jpeg',12,10,20);
    INSERT INTO avatars VALUES ('legacy-uncertain',7,'cleanup_pending','image/jpeg',12,10,NULL);
    CREATE TABLE donate_orders (out_trade_no TEXT PRIMARY KEY,user_id INTEGER NOT NULL,amount_total INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',transaction_id TEXT,created_at INTEGER NOT NULL,paid_at INTEGER);
    INSERT INTO donate_orders VALUES ('LEGACY',7,500,'paid','legacy-transaction',10,20);
  `);
  legacy.close();
  const store = f.keep(new AvatarStore({ dbPath: f.dbPath })), orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath }));
  assert.equal(store.getById("legacy-avatar").bound_at, 20);
  assert.equal(store.getById("legacy-avatar").cleanup_attempts, 0);
  assert.equal(store.getById("legacy-avatar").upload_state, "settled");
  assert.equal(store.getById("legacy-uncertain").upload_state, "uncertain");
  assert.deepEqual(orders.cleanupUser(7), ["LEGACY"]);
  assert.equal(orders.get("LEGACY").transaction_id, "legacy-transaction");
  assert.equal(orders.get("LEGACY").paid_at, 20);
  assert.equal(orders.get("LEGACY").amount_total, 500);
  store.markUserDeletion(7);
  assert.equal(store.getById("legacy-avatar").status, "cleanup_pending");
  assert.equal(store.getById("legacy-avatar").bound_at, 20);
});

test("S5 avatar registers before PUT and retains ambiguous PUT/delete failures across restart", async t => {
  const f = await fixture(t);
  const auth = f.keep(new MpAuthService({ dbPath: f.dbPath }));
  const userId = auth.webRegister({ nickname: "synthetic uncertain upload", password: "synthetic-test-password" }).user.id;
  let store = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  let failedId;
  const service = avatarService(store, {
    putObject: async key => {
      failedId = key.slice("avatars/".length, -4);
      assert.equal(store.getById(failedId).status, "pending_upload");
      assert.equal(store.getById(failedId).upload_state, "uncertain");
      throw Object.assign(new Error("synthetic ambiguous PUT"), { code: "PUT_UNKNOWN" });
    },
    deleteObject: async () => { throw Object.assign(new Error("synthetic delete unavailable"), { code: "REMOTE_DOWN" }); },
  });
  await assert.rejects(service.upload({ userId, buffer: image }), e => e.code === "AVATAR_UPLOAD_UNAVAILABLE");
  assert.equal(store.getById(failedId).status, "cleanup_pending");
  assert.equal(store.getById(failedId).cleanup_error, "REMOTE_DOWN");
  assert.equal(store.getById(failedId).cleanup_attempts, 1);
  store.register({ id: "other-history", userId: 8, bytes: 1 });
  store.markBound("other-history");
  store.close();
  store = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  assert.equal(store.pendingCleanupRows().some(row => row.id === failedId), true);
  await assert.rejects(cleanupUserAvatars({ store, userId }), e => e.code === "AVATAR_CLEANUP_PENDING" && e.remaining === 1 && e.cacheCleared === false);
  assert.equal(store.getById(failedId).cleanup_attempts, 2);
  const removed = [];
  await assert.rejects(cleanupUserAvatars({ store, userId, deleteObject: async key => removed.push(key) }), e => e.code === "AVATAR_CLEANUP_PENDING" && e.uncertainUploads === 1);
  assert.ok(store.getById(failedId), "a successful DELETE does not settle the prior unknown PUT");
  assert.equal(store.getById(failedId).cleanup_error, "AVATAR_UPLOAD_OUTCOME_UNKNOWN");
  assert.throws(() => store.confirmUploadSettledForCleanup(failedId), e => e.code === "AVATAR_SETTLEMENT_CONFIRMATION_INELIGIBLE");
  auth.deleteAccount(userId);
  assert.equal(store.confirmUploadSettledForCleanup(failedId).upload_state, "settled");
  const result = await cleanupUserAvatars({ store, userId, deleteObject: async key => removed.push(key) });
  assert.deepEqual(removed, [`avatars/${failedId}.jpg`, `avatars/${failedId}.jpg`]);
  assert.deepEqual(result, { deletedCount: 1, remaining: 0, sourceDeleted: true, cacheCleared: false });
  assert.ok(store.getById("other-history"));
  assert.equal(store.getById(failedId), null);
  await assert.rejects(avatarService(store).upload({ userId, buffer: image }), e => e.code === "AUTH_ACCOUNT_DELETED");
});

test("S5 avatar deletion waits for a PUT in flight and clears bound, unbound and pending history", async t => {
  const f = await fixture(t), store = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  for (const id of ["old-bound", "old-unbound", "old-pending"]) store.register({ id, userId: 7, bytes: 1, status: id === "old-pending" ? "pending_upload" : "approved" });
  store.markUploadSettled("old-pending"); // PUT acknowledged, approval/binding never finished.
  store.markBound("old-bound");
  store.register({ id: "other-user", userId: 8, bytes: 1 });
  const reached = deferred(), release = deferred(), deleted = [];
  const service = avatarService(store, { putObject: async () => { reached.resolve(); await release.promise; }, deleteObject: async key => deleted.push(key) });
  const upload = service.upload({ userId: 7, buffer: image });
  const rejected = assert.rejects(upload, e => e.code === "AUTH_ACCOUNT_DELETED");
  await reached.promise;
  let finished = false;
  const cleanup = service.deleteForUser(7).then(result => { finished = true; return result; });
  assert.equal(store.isDeletionPending(7), true);
  assert.equal(store.bindable({ userId: 7, id: "old-bound" }), null);
  await assert.rejects(service.upload({ userId: 7, buffer: image }), e => e.code === "AUTH_ACCOUNT_DELETED");
  await new Promise(r => setImmediate(r));
  assert.equal(finished, false, "cleanup must wait for the outstanding PUT");
  release.resolve();
  await rejected;
  assert.equal((await cleanup).sourceDeleted, true);
  assert.equal(store.listForUser(7).length, 0);
  assert.equal(deleted.length, 4);
  assert.ok(store.getById("other-user"));
});

test("S5 avatar rechecks deletion after decoding and moderation before any remote write", async t => {
  for (const stage of ["metadata", "moderation"]) {
    const f = await fixture(t), store = f.keep(new AvatarStore({ dbPath: f.dbPath }));
    const reached = deferred(), release = deferred(); let puts = 0;
    const options = { putObject: async () => { puts++; }, deleteObject: async () => {} };
    if (stage === "metadata") options.sharpImpl = sharpStub({ metadata: async () => { reached.resolve(); await release.promise; return { format: "jpeg", width: 8, height: 8 }; } });
    else options.moderation = { check: async () => { reached.resolve(); await release.promise; return { approved: true }; } };
    const service = avatarService(store, options);
    const upload = service.upload({ userId: 7, buffer: image });
    const rejected = assert.rejects(upload, e => e.code === "AUTH_ACCOUNT_DELETED");
    await reached.promise;
    const cleanup = service.deleteForUser(7);
    release.resolve();
    await rejected; await cleanup;
    assert.equal(puts, 0, stage);
    assert.equal(store.listForUser(7).length, 0);
  }
});

test("S5 avatar cleanup failure cannot report source success and is idempotently retryable", async t => {
  const f = await fixture(t), store = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  store.register({ id: "owned-history", userId: 7, bytes: 1 });
  store.markBound("owned-history");
  let unavailable = true;
  const service = avatarService(store, { deleteObject: async () => { if (unavailable) throw Object.assign(new Error("synthetic"), { code: "REMOTE_DOWN" }); } });
  await assert.rejects(service.deleteForUser(7), e => e.code === "AVATAR_CLEANUP_PENDING" && e.sourceDeleted === false && e.remaining === 1);
  assert.equal(store.getById("owned-history").cleanup_error, "REMOTE_DOWN");
  unavailable = false;
  assert.equal((await service.deleteForUser(7)).remaining, 0);
  assert.equal((await service.deleteForUser(7)).deletedCount, 0);
});

test("S5 restart retains an uncertain PUT key when DELETE succeeds before the old remote PUT commits", async t => {
  const f = await fixture(t), dataDir = path.join(f.dir, "data");
  await fs.mkdir(dataDir);
  const auth = f.keep(new MpAuthService({ dbPath: f.dbPath }));
  const session = auth.webRegister({ nickname: "synthetic crashed PUT", password: "synthetic-test-password" });
  const ledger = initializeRuntimeDeletionLedger({ db: auth.db, dataDir, directory: path.join(f.dir, "authority") });
  auth.isDeletionPending = id => ledger.entries().some(entry => entry.userId === id);
  const orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath, assertActiveUser: id => auth.assertActiveUser(id) }));
  let avatars = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  const id = "synthetic-crashed-put", key = `avatars/${id}.jpg`;
  avatars.register({ id, userId: session.user.id, bytes: 1, status: "pending_upload" });
  avatars.close(); // Former process never persisted the remote PUT's result.
  avatars = f.keep(new AvatarStore({ dbPath: f.dbPath }));
  const remote = new Set(); let deletes = 0;
  const deleteObject = async requested => { deletes++; remote.delete(requested); };
  const store = new AtomicJsonStore({ allowedRoot: dataDir });
  await store.write(path.join(dataDir, "reviews.json"), { reviews: [] });
  await store.write(path.join(dataDir, "feedback.json"), { items: [] });
  const coordinator = new AccountDeletionService({ auth, ledger, orders, store, dataDir,
    cleanupAvatars: userId => cleanupUserAvatars({ store: avatars, userId, deleteObject }) });
  const first = await coordinator.request(session.user);
  assert.deepEqual([first.deleted, first.pending], [false, true]);
  assert.equal(deletes, 1); assert.equal(remote.has(key), false);
  assert.equal(avatars.getById(id).upload_state, "uncertain");
  assert.equal(avatars.getById(id).cleanup_error, "AVATAR_UPLOAD_OUTCOME_UNKNOWN");
  assert.equal(coordinator.health().pending, 1);
  remote.add(key); // Mock upstream completes its accepted pre-crash PUT after DELETE.
  assert.deepEqual(await coordinator.resume(), { complete: 0, pending: 1 });
  assert.equal(remote.has(key), false, "retry still knows and deletes the late object");
  assert.ok(avatars.getById(id), "DELETE and absence do not prove the old PUT has terminated");
  assert.equal(avatars.pendingCleanupRows().length, 1);
  // This explicit maintenance step represents independently obtained completion
  // evidence; no clock, timeout or HEAD result invokes it automatically.
  avatars.confirmUploadSettledForCleanup(id);
  assert.deepEqual(await coordinator.resume(), { complete: 1, pending: 0 });
  assert.equal(deletes, 3); assert.equal(avatars.getById(id), null);
  assert.equal(remote.has(key), false);
});

test("S5 payment cleanup is atomic and preserves accounting facts and unrelated orders", async t => {
  const f = await fixture(t), orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath }));
  for (const [key, id] of [["A1", 7], ["A2", 7], ["B", 8]]) orders.create({ outTradeNo: key, userId: id, amountTotal: 500, nickname: "same nickname", remark: "private remark", source: "jsapi", now: 10 });
  orders.markPaid({ outTradeNo: "A1", amountTotal: 500, transactionId: "transaction-A1", now: 20 });
  const before = orders.listRecent(), other = orders.get("B");
  orders.db.exec("CREATE TRIGGER synthetic_cleanup_failure BEFORE UPDATE ON donate_orders WHEN OLD.out_trade_no='A2' BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END");
  assert.throws(() => orders.cleanupUser(7));
  assert.deepEqual(orders.listRecent(), before);
  orders.db.exec("DROP TRIGGER synthetic_cleanup_failure");
  const keys = orders.listUserOrderKeys(7);
  assert.deepEqual(keys, ["A1", "A2"]);
  assert.deepEqual(orders.cleanupUser(7, { now: 30 }), keys);
  for (const key of keys) {
    const row = orders.get(key), original = before.find(row => row.out_trade_no === key);
    assert.equal(row.user_id, 0); assert.equal(row.nickname, ""); assert.equal(row.remark, ""); assert.equal(row.identity_cleared_at, 30);
    for (const field of ["out_trade_no", "amount_total", "status", "transaction_id", "created_at", "paid_at", "source"]) assert.equal(row[field], original[field], field);
  }
  assert.deepEqual(orders.get("B"), other);
  assert.deepEqual(orders.cleanupUser(7), []);
  assert.equal(orders.cleanupOrders(keys, { now: 99 }), 2);
  assert.equal(orders.get("A1").identity_cleared_at, 30);
  assert.equal(orders.markPaid({ outTradeNo: "A2", amountTotal: 500, transactionId: "late-transaction", now: 40 }), true);
  assert.equal(orders.get("A2").status, "paid");
  assert.equal(orders.get("A2").nickname, "");
  assert.equal(orders.summary().paid_total_fen, 1000);
});

test("S5 order creation after an upstream wait cannot recreate a deleted account association", async t => {
  const f = await fixture(t), auth = f.keep(new MpAuthService({ dbPath: f.dbPath }));
  const session = auth.webRegister({ nickname: "synthetic donor", password: "synthetic-test-password" });
  const orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath, assertActiveUser: id => auth.assertActiveUser(id) }));
  const reached = deferred(), release = deferred();
  const service = new PublicApiService({ readManifest: () => ({}), readReviews: () => ({}), readHome: () => ({}), reviewSubmissionService: {}, donateOrderStore: orders,
    donatePayStore: { config: () => ({ mchid: "synthetic", appid: "synthetic", serialNo: "synthetic", privateKey: "" }) },
    wxpayFetch: async () => { reached.resolve(); await release.promise; return { ok: true, text: async () => '{"code_url":"weixin://synthetic"}' }; } });
  // Native prepay signs before fetch, so provide a synthetic signing key.
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  service.donatePayStore.config = () => ({ mchid: "synthetic", appid: "synthetic", serialNo: "synthetic", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const operation = service.createDonateOrderNative({ userId: session.user.id, amount: 5, nickname: "old nickname", remark: "old remark" });
  const rejected = assert.rejects(operation, e => e.code === "AUTH_ACCOUNT_DELETED");
  await reached.promise; auth.deleteAccount(session.user.id); release.resolve(); await rejected;
  assert.equal(orders.listRecent().length, 0);
});

test("S5 precise donation cleanup leaves same-name legacy and other-user records unchanged", () => {
  const input = { title: "keep", content: "keep body", records: [
    { date: "2026-10-07", nickname: "same nickname", usage: "servers", order_key: "A", extra: "keep" },
    { date: "2026-10-07", nickname: "same nickname", usage: "servers", order_key: "B" },
    { date: "2026-10-07", nickname: "same nickname", usage: "legacy" },
  ] };
  const { document, cleared, legacyUnattributed } = cleanupDonateRecords(input, ["A"]);
  assert.equal(cleared, 1); assert.equal(legacyUnattributed, 1);
  assert.deepEqual(document.records[0], { ...input.records[0], nickname: "好心人" });
  assert.deepEqual(document.records.slice(1), input.records.slice(1));
  assert.equal(document.content, input.content); assert.equal(input.records[0].nickname, "same nickname");
  assert.equal(cleanupDonateRecords(document, ["A"]).cleared, 0);
  assert.equal(normalizeStoredRecords(document.records)[0].order_key, "A");
  assert.equal("order_key" in normalizeRecords(document.records)[0], false);
  const publicService = new PublicApiService({ readManifest: () => ({}), readReviews: () => ({}), readHome: () => ({}), reviewSubmissionService: {}, readDonate: () => document });
  assert.deepEqual(publicService.donate().records, normalizeRecords(document.records));
  assert.equal(JSON.stringify(publicService.donate()).includes("order_key"), false);
});

test("S5 donation append reads identity inside the queue, handles late payment and is keyed idempotent", async t => {
  const f = await fixture(t), orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath }));
  const store = new AtomicJsonStore({ allowedRoot: f.dir }), filePath = path.join(f.dir, "donate.json");
  await store.write(filePath, { title: "keep", records: [] });
  orders.create({ outTradeNo: "A", userId: 7, amountTotal: 500, nickname: "old nickname", remark: "private" });
  const reached = deferred(), release = deferred();
  const blocker = store.update(filePath, async current => { reached.resolve(); await release.promise; return current; });
  await reached.promise;
  const append = () => appendDonateRecord({ store, filePath, orderKey: "A", readOrder: key => orders.get(key), nickname: "captured old nickname", paidAtMs: Date.UTC(2026, 9, 6, 18) });
  const queued = append();
  const keys = orders.listUserOrderKeys(7); orders.cleanupOrders(keys); orders.markPaid({ outTradeNo: "A", amountTotal: 500, transactionId: "late-paid" });
  release.resolve(); await blocker;
  assert.equal((await queued).nickname, "好心人");
  await append();
  const document = await store.read(filePath);
  assert.equal(document.records.length, 1); assert.equal(document.records[0].order_key, "A");
  assert.equal(document.records[0].nickname, "好心人");
  assert.equal("order_key" in normalizeRecords(document.records)[0], false);
  assert.equal(orders.get("A").transaction_id, "late-paid");
});

test("S5 pending deletion blocks new payment identities and callback nickname before SQL cleanup", async t => {
  const f = await fixture(t); let pending = false;
  const assertActiveUser = () => { if (pending) throw Object.assign(new Error("synthetic pending deletion"), { code: "AUTH_ACCOUNT_DELETED" }); };
  const orders = f.keep(new DonateOrderStore({ dbPath: f.dbPath, assertActiveUser }));
  orders.create({ outTradeNo: "A", userId: 7, amountTotal: 500, nickname: "old nickname" });
  pending = true;
  assert.throws(() => orders.create({ outTradeNo: "B", userId: 7, amountTotal: 500 }), e => e.code === "AUTH_ACCOUNT_DELETED");
  const store = new AtomicJsonStore({ allowedRoot: f.dir }), filePath = path.join(f.dir, "donate.json");
  const row = await appendDonateRecord({ store, filePath, orderKey: "A", readOrder: key => orders.get(key), assertActiveUser, paidAtMs: Date.now() });
  assert.equal(row.nickname, "好心人");
  assert.equal(orders.get("A").nickname, "old nickname", "callback projector must not silently mutate accounting rows");
});
