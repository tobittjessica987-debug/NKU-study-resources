import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { cleanupAccountContent } from "../server/account-content-cleanup.mjs";
import { ModerationService } from "../server/moderation-service.mjs";
import { isFeedbackPublicEligible, isReviewPublicEligible, newFeedbackModerationFields, normalizeFeedbackDocument, normalizeReviewsDocument } from "../server/moderation-model.mjs";

const now = "2026-10-07T12:00:00.000Z";
const subject = 7;
const identity = { user_id: subject, userId: subject, contact: "synthetic contact", phone: "13800001234", phone_verified_at: 123,
  phone_verified: true, openid: "synthetic-openid", unionid: "synthetic-unionid", nickname: "合成原昵称", nickName: "合成别名", email: "synthetic@example.test",
  avatar_url: "https://example.test/synthetic.jpg", avatarUrl: "https://example.test/synthetic.jpg", ip: "192.0.2.7", ipHash: "synthetic-ip-hash", ip_hash: "synthetic-ip-hash", userAgent: "Synthetic Browser", user_agent: "Synthetic Browser" };
const identityKeys = Object.keys(identity);
const review = (id, extra = {}) => ({ id, user_id: subject, courseTitle: "合成课程", teacher: "合成教师", content: "原正文主动写了13800001234，保留此原文", rating: 5,
  tags: ["合成标签"], status: "approved", helpfulBy: [], helpfulCount: 0, createdAt: now, ...extra });
const feedback = (id, extra = {}) => ({ id, ...newFeedbackModerationFields({ now }), user_id: subject, title: "合成反馈", content: "保留原反馈和举报正文",
  contact: "synthetic contact", reply: "保留处理回复", repliedBy: "real-admin", repliedAt: now, createdAt: now, ...extra });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { reviews, feedback: feedbackData, donate, raw = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nku-s5-content-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new AtomicJsonStore({ allowedRoot: dataDir });
  const documents = {
    reviews: reviews || { rules: {}, reviews: [review("owned-review", identity)] },
    feedback: feedbackData || { title: "反馈", rules: {}, items: [feedback("owned-feedback")] },
  };
  await store.write(path.join(dataDir, "reviews.json"), raw ? documents.reviews : normalizeReviewsDocument(documents.reviews, { nowIso: now }));
  await store.write(path.join(dataDir, "feedback.json"), raw ? documents.feedback : normalizeFeedbackDocument(documents.feedback, { nowIso: now }));
  if (donate) await store.write(path.join(dataDir, "donate.json"), donate);
  return { dataDir, store,
    read: (kind) => store.read(path.join(dataDir, `${kind}.json`)),
    cleanup: (options = {}) => cleanupAccountContent({ store, dataDir, userId: subject, ...options }) };
}

function expectedIdentityRemoval(row) {
  const next = structuredClone(row);
  for (const key of identityKeys) delete next[key];
  next.accountIdentityRemoved = true;
  return next;
}

test("S5 retains all texts, scores, statuses and public replies while clearing only the subject's identity and votes", async (t) => {
  const f = await fixture(t, {
    reviews: { rules: {}, reviews: [
      review("approved", { ...identity, helpfulBy: [7, 70], helpfulCount: 2 }),
      review("pending", { ...identity, status: "pending" }),
      review("hidden", { ...identity, hidden: true }),
      review("rejected", { ...identity, status: "rejected" }),
      review("other", { ...identity, user_id: 70, userId: 7, helpfulBy: [7, "7", 70, "71"], helpfulCount: 4 }),
      review("untouched", { ...identity, user_id: 71, userId: 71, helpfulBy: [70], helpfulCount: 1 }),
    ] },
    feedback: { rules: {}, items: [
      feedback("public", { ...identity, publicationState: "approved", decisionSource: "admin_decision", reviewedBy: "real-reviewer", reviewedAt: now, replyVisibility: "public", handledBy: "real-handler" }),
      feedback("private", { ...identity, ...newFeedbackModerationFields({ type: "report", now }), type: "report", reply: "私密原回复", report_target: "第三人的合成账号", report_url: "https://example.test/third-party" }),
      feedback("pending", identity),
      feedback("hidden", { ...identity, hidden: true }),
      feedback("other", { ...identity, user_id: 70, userId: 70 }),
    ] },
  });
  const beforeReviews = await f.read("reviews");
  const beforeFeedback = await f.read("feedback");
  const visibility = beforeReviews.reviews.map(isReviewPublicEligible);
  const feedbackVisibility = beforeFeedback.items.map(isFeedbackPublicEligible);
  const stats = await f.cleanup();
  assert.deepEqual(stats, { reviews: 4, feedback: 4, reactions: 3, donations: 0, legacyDonationRecords: 0 });
  const afterReviews = await f.read("reviews");
  const afterFeedback = await f.read("feedback");
  const expectedReviews = structuredClone(beforeReviews);
  expectedReviews.reviews = expectedReviews.reviews.map((row, index) => index < 4 ? expectedIdentityRemoval(row) : row);
  expectedReviews.reviews[0].helpfulBy = [70];
  expectedReviews.reviews[0].helpfulCount = 1;
  expectedReviews.reviews[4].helpfulBy = [70, "71"];
  expectedReviews.reviews[4].helpfulCount = 2;
  assert.deepEqual(afterReviews, expectedReviews);
  assert.deepEqual(afterFeedback, { ...beforeFeedback, items: beforeFeedback.items.map((row, index) => index < 4 ? expectedIdentityRemoval(row) : row) });
  assert.deepEqual(afterReviews.reviews.map(isReviewPublicEligible), visibility);
  assert.deepEqual(afterFeedback.items.map(isFeedbackPublicEligible), feedbackVisibility);
  assert.equal(afterFeedback.items[1].private, true);
  assert.equal(afterFeedback.items[0].replyVisibility, "public");
  assert.equal(afterFeedback.items[0].reviewedBy, "real-reviewer");
  assert.equal(afterFeedback.items[0].handledBy, "real-handler");
  assert.equal(afterFeedback.items[0].repliedBy, "real-admin");
  assert.equal(afterFeedback.items[1].report_target, "第三人的合成账号");
  for (const kind of ["reviews", "feedback"]) assert.equal((await fs.stat(path.join(f.dataDir, `${kind}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await f.cleanup(), { reviews: 0, feedback: 0, reactions: 0, donations: 0, legacyDonationRecords: 0 });
  assert.deepEqual(await f.read("reviews"), afterReviews);
  assert.deepEqual(await f.read("feedback"), afterFeedback);
});

test("S5 legacy feedback array aliases are cleared without migration or increased visibility", async (t) => {
  const raw = { title: "原标题", feedback: [
    { id: "legacy-own", ...identity, status: "completed", hidden: true, private: true, content: "原文", reply: "原回复" },
    { id: "legacy-other", ...identity, user_id: 70, content: "他人原文" },
  ] };
  const f = await fixture(t, { raw: true, reviews: { reviews: [] }, feedback: raw });
  assert.equal((await f.cleanup()).feedback, 1);
  assert.deepEqual(await f.read("feedback"), { ...raw, feedback: [expectedIdentityRemoval(raw.feedback[0]), raw.feedback[1]] });
  assert.equal((await f.read("feedback")).items, undefined);
});

test("S5 only exact donation order keys clear nicknames and keep unkeyed legacy records for manual review", async (t) => {
  const donate = { title: "捐助", content: "原说明", amounts: [5], records: [
    { date: "2026-10-07", nickname: "合成同名", usage: "原去向", order_key: "order-7" },
    { date: "2026-10-07", nickname: "合成同名", usage: "他人去向", order_key: "order-70" },
    { date: "2026-10-07", nickname: "合成同名", usage: "无键旧记录" },
    { date: "2026-10-07", nickname: "另一个昵称", usage: "另一旧记录" },
  ] };
  const f = await fixture(t, { donate });
  const stats = await f.cleanup({ donationOrderKeys: ["order-7"] });
  assert.equal(stats.donations, 1);
  assert.equal(stats.legacyDonationRecords, 2);
  assert.deepEqual(await f.read("donate"), { ...donate, records: [{ ...donate.records[0], nickname: "好心人" }, ...donate.records.slice(1)] });
  const retried = await f.cleanup({ donationOrderKeys: ["order-7"] });
  assert.equal(retried.donations, 0);
  assert.equal(retried.legacyDonationRecords, 2);
});

test("S5 stale single-item and whole-document drafts cannot restore cleared ownership with old or forged revisions", async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  for (const kind of ["reviews", "feedback"]) {
    const service = new ModerationService({ store: f.store, filePath: path.join(f.dataDir, `${kind}.json`), kind, nowIso: () => now });
    snapshots.push({ kind, service, old: await service.read() });
  }
  await f.cleanup();
  for (const { kind, service, old } of snapshots) {
    const key = kind === "reviews" ? "reviews" : "items";
    const id = old.data[key][0].id;
    await assert.rejects(service.patchItem(id, { expectedItemRevision: old.itemRevisions[id], changes: { hidden: true } }, "real-admin"), { code: "ITEM_CONFLICT", statusCode: 409 });
    await assert.rejects(service.patchLegacy({ expectedRevision: old.revision, data: old.data }, "real-admin"), { code: "LEGACY_DOCUMENT_CONFLICT", statusCode: 409 });
    const fresh = await service.read();
    await assert.rejects(service.patchLegacy({ expectedRevision: fresh.revision, data: old.data }, "real-admin"), { code: "IMMUTABLE_FIELD", statusCode: 400 });
    await assert.rejects(service.patchItem(id, { expectedItemRevision: fresh.itemRevisions[id], changes: { user_id: subject } }, "real-admin"), { code: "IMMUTABLE_FIELD", statusCode: 400 });
    const allowed = await service.patchItem(id, { expectedItemRevision: fresh.itemRevisions[id], changes: { hidden: true } }, "real-admin");
    assert.equal(allowed.data.accountIdentityRemoved, true);
    assert.equal(allowed.data.user_id, undefined);
    assert.equal(allowed.data.contact, undefined);
  }
});

test("S5 removing the subject's vote on another review keeps moderation usable without letting old drafts restore reactions", async (t) => {
  const otherId = "other-review";
  const f = await fixture(t, {
    reviews: { rules: {}, reviews: [review(otherId, {
      user_id: 70, nickname: "他人合成昵称", helpfulBy: [subject, 70], helpfulCount: 2,
    })] },
    feedback: { rules: {}, items: [] },
  });
  const service = new ModerationService({ store: f.store, filePath: path.join(f.dataDir, "reviews.json"), kind: "reviews", nowIso: () => now });
  const old = await service.read();
  const oldItem = old.data.reviews[0];
  assert.deepEqual(oldItem.helpfulBy, [subject, 70]);
  assert.equal((await f.cleanup()).reactions, 1);
  const fresh = await service.read();
  assert.equal(fresh.itemRevisions[otherId], old.itemRevisions[otherId], "reaction-only removal deliberately keeps the ordinary moderation token usable");
  assert.notEqual(fresh.revision, old.revision, "whole-document CAS includes reactions");
  assert.deepEqual(fresh.data.reviews[0].helpfulBy, [70]);
  assert.equal(fresh.data.reviews[0].helpfulCount, 1);
  assert.equal(fresh.data.reviews[0].accountIdentityRemoved, undefined, "another author's identity is not cleared to invalidate its token");

  const cleanDocument = await f.read("reviews");
  for (const field of ["helpfulBy", "helpfulCount"]) {
    await assert.rejects(service.patchItem(otherId, {
      expectedItemRevision: old.itemRevisions[otherId],
      changes: { hidden: true, [field]: structuredClone(oldItem[field]) },
    }, "real-admin"), { code: "IMMUTABLE_FIELD", statusCode: 400 });
    assert.deepEqual(await f.read("reviews"), cleanDocument);
  }
  const oldWholeDraft = structuredClone(old.data);
  oldWholeDraft.reviews[0].hidden = true;
  await assert.rejects(service.patchLegacy({ expectedRevision: old.revision, data: oldWholeDraft }, "real-admin"), { code: "LEGACY_DOCUMENT_CONFLICT", statusCode: 409 });
  await assert.rejects(service.patchLegacy({ expectedRevision: fresh.revision, data: oldWholeDraft }, "real-admin"), { code: "IMMUTABLE_FIELD", statusCode: 400 });
  assert.deepEqual(await f.read("reviews"), cleanDocument);

  // A stale item token may still change the allowed moderation state because the
  // mutation is applied to the latest stored item, rather than the old snapshot.
  const allowed = await service.patchItem(otherId, {
    expectedItemRevision: old.itemRevisions[otherId], changes: { hidden: true },
  }, "real-admin");
  assert.equal(allowed.data.hidden, true);
  assert.deepEqual(allowed.data.helpfulBy, [70]);
  assert.equal(allowed.data.helpfulCount, 1);
  assert.equal(allowed.data.user_id, 70);
  assert.equal(allowed.data.nickname, "他人合成昵称");
  assert.equal(allowed.data.content, oldItem.content);
  assert.equal(allowed.data.rating, oldItem.rating);
  const current = await service.read();
  const ordinaryWholeDraft = structuredClone(current.data);
  ordinaryWholeDraft.reviews[0].hidden = false;
  const wholeEdit = await service.patchLegacy({ expectedRevision: current.revision, data: ordinaryWholeDraft }, "real-admin");
  assert.equal(wholeEdit.data.hidden, false);
  assert.deepEqual(wholeEdit.data.helpfulBy, [70]);
  assert.equal(wholeEdit.data.helpfulCount, 1);
  const persisted = (await f.read("reviews")).reviews[0];
  assert.deepEqual(persisted.helpfulBy, [70]);
  assert.equal(persisted.helpfulCount, 1);
  assert.equal(persisted.user_id, 70);
  assert.equal(persisted.nickname, "他人合成昵称");
});

test("S5 cleanup queues after a submission already paused before rename and leaves no ownership or vote", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let paused = false;
  let active = true;
  f.store.faultHook = async (stage, { target }) => {
    if (stage === "beforeRename" && target.endsWith("reviews.json") && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  };
  const earlierWrite = f.store.update(path.join(f.dataDir, "reviews.json"), (current) => {
    assert.equal(active, true, "submission passed its account guard before the deletion intent");
    current.reviews.unshift(review("in-flight", { ...identity, helpfulBy: [subject, 70], helpfulCount: 2 }));
    return current;
  });
  await entered.promise;
  active = false;
  let completed = false;
  const cleanup = f.cleanup().then((result) => { completed = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "cleanup waits for the earlier queue entry rather than reading an old snapshot");
  release.resolve();
  await earlierWrite;
  const stats = await cleanup;
  assert.equal(stats.reviews, 2);
  const persisted = await f.read("reviews");
  assert.equal(persisted.reviews.length, 2);
  for (const item of persisted.reviews) {
    assert.equal(item.user_id, undefined);
    assert.equal(item.contact, undefined);
    assert.equal(item.accountIdentityRemoved, true);
    assert.equal(item.helpfulBy.includes(subject), false);
  }
  assert.equal(persisted.reviews[0].content, review("in-flight").content);
  assert.deepEqual(persisted.reviews[0].helpfulBy, [70]);
});

test("S5 a failure between JSON files cannot report complete and retry finishes the remaining file", async (t) => {
  const f = await fixture(t);
  f.store.faultHook = async (stage, { target }) => {
    if (stage === "beforeRename" && target.endsWith("feedback.json")) throw new Error("synthetic feedback persistence failure");
  };
  await assert.rejects(f.cleanup(), /synthetic feedback persistence failure/);
  assert.equal((await f.read("reviews")).reviews[0].user_id, undefined);
  assert.equal((await f.read("feedback")).items[0].user_id, subject);
  f.store.faultHook = null;
  const retry = await f.cleanup();
  assert.equal(retry.reviews, 0);
  assert.equal(retry.feedback, 1);
  assert.equal((await f.read("feedback")).items[0].user_id, undefined);
});

test("S5 readback errors or mismatches fail the cleanup result, including missing optional donation after write", async (t) => {
  const f = await fixture(t, { donate: { records: [{ order_key: "order-7", nickname: "合成昵称", date: "2026-10-07", usage: "待定" }] } });
  const badReadback = { update: f.store.update.bind(f.store), read: async (filePath) => {
    const current = await f.store.read(filePath);
    if (filePath.endsWith("reviews.json")) current.reviews[0].user_id = subject;
    return current;
  } };
  await assert.rejects(f.cleanup({ store: badReadback }), { code: "ACCOUNT_CONTENT_READBACK_MISMATCH" });
  const missingDonateReadback = { update: f.store.update.bind(f.store), read: async (filePath) => {
    if (filePath.endsWith("donate.json")) throw Object.assign(new Error("synthetic lost file after write"), { code: "ENOENT" });
    return f.store.read(filePath);
  } };
  await assert.rejects(f.cleanup({ store: missingDonateReadback, donationOrderKeys: ["order-7"] }), { code: "ENOENT" });
  const retried = await f.cleanup({ donationOrderKeys: ["order-7"] });
  assert.equal(retried.donations, 0, "already-cleared public record remains cleared after readback retry");
});

test("S5 missing required or malformed content fails closed without replacing it with an empty document", async (t) => {
  const f = await fixture(t);
  const reviewsPath = path.join(f.dataDir, "reviews.json");
  await fs.unlink(reviewsPath);
  await assert.rejects(f.cleanup(), { code: "ENOENT" });
  await assert.rejects(fs.stat(reviewsPath), { code: "ENOENT" });
  await fs.writeFile(reviewsPath, "{broken");
  await assert.rejects(f.cleanup(), SyntaxError);
  assert.equal(await fs.readFile(reviewsPath, "utf8"), "{broken");
  await f.store.write(reviewsPath, { reviews: "must be an array" });
  await assert.rejects(f.cleanup(), { code: "ACCOUNT_CONTENT_INVALID" });
  assert.deepEqual(await f.read("reviews"), { reviews: "must be an array" });
});
