import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cleanupDonateRecords } from "./donate-records.mjs";

// User submission fields only. Administrator decision/reply actors, timestamps,
// rule provenance, course/teacher names and text remain as restricted evidence.
const IDENTITY_FIELDS = Object.freeze([
  "user_id", "userId", "contact", "phone", "phone_verified_at", "phone_verified",
  "openid", "unionid", "nickname", "nickName", "email", "avatar_url", "avatarUrl",
  "ip", "ipHash", "ip_hash", "userAgent", "user_agent",
]);
const TOMBSTONE_FIELD = "accountIdentityRemoved";

function failure(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 503 });
}

function numericIdentity(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function ownedBy(item, userId) {
  // The persisted model uses user_id. Do not override an explicit canonical
  // owner with a conflicting alias from an old draft.
  const value = Object.hasOwn(item, "user_id") ? item.user_id : item.userId;
  return numericIdentity(value) === userId;
}

function documentRows(document, kind) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw failure("ACCOUNT_CONTENT_INVALID", "Account content cleanup requires a JSON document object.");
  }
  // Current feedback is items[]. Keep the old fixture/backup feedback[] alias
  // in place rather than normalizing it and changing historical visibility.
  const keys = kind === "reviews" ? ["reviews"] : ["items", "feedback"];
  const rows = [];
  for (const key of keys) {
    if (document[key] === undefined) continue;
    if (!Array.isArray(document[key])) throw failure("ACCOUNT_CONTENT_INVALID", "Account content rows must be arrays.");
    for (const item of document[key]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw failure("ACCOUNT_CONTENT_INVALID", "Account content rows must be objects.");
      rows.push(item);
    }
  }
  return rows;
}

function scrubContent(document, kind, userId) {
  let cleared = 0;
  let reactions = 0;
  for (const item of documentRows(document, kind)) {
    if (ownedBy(item, userId)) {
      for (const field of IDENTITY_FIELDS) delete item[field];
      // This marker contains no account identifier and participates in item CAS.
      item[TOMBSTONE_FIELD] = true;
      cleared++;
    }
    if (kind === "reviews" && Array.isArray(item.helpfulBy)) {
      const retained = item.helpfulBy.filter((id) => numericIdentity(id) !== userId);
      const removed = item.helpfulBy.length - retained.length;
      if (removed) {
        item.helpfulBy = retained;
        item.helpfulCount = new Set(retained.map(Number)).size;
        reactions += removed;
      }
    }
  }
  return { cleared, reactions };
}

function verifyContent(document, expected, kind, userId) {
  if (!isDeepStrictEqual(document, expected)) throw failure("ACCOUNT_CONTENT_READBACK_MISMATCH", "Account content cleanup readback differs from the committed document.");
  for (const item of documentRows(document, kind)) {
    if (ownedBy(item, userId) || kind === "reviews" && Array.isArray(item.helpfulBy) && item.helpfulBy.some((id) => numericIdentity(id) === userId)) {
      throw failure("ACCOUNT_CONTENT_CLEANUP_INCOMPLETE", "Account content cleanup left an account association.");
    }
  }
}

/** Retain content and visibility exactly as stored; remove only the subject's
 * business identity and votes. The coordinator must first persist a deletion
 * intent and stop new account writes. Using the same AtomicJsonStore queues
 * places this cleanup after earlier writes, including ones paused before rename.
 * No live service, environment, notification or remote storage is accessed. */
export async function cleanupAccountContent({ store, dataDir, userId, donationOrderKeys = [] } = {}) {
  const subject = numericIdentity(userId);
  if (!subject) throw new Error("cleanupAccountContent requires a positive account ID.");
  if (!store || typeof store.update !== "function" || typeof store.read !== "function") throw new Error("cleanupAccountContent requires an injected JSON store with update/read.");
  if (typeof dataDir !== "string" || !dataDir) throw new Error("cleanupAccountContent requires dataDir.");
  if (!Array.isArray(donationOrderKeys) || donationOrderKeys.some((key) => typeof key !== "string" || !key)) throw new Error("donationOrderKeys must contain exact nonempty order keys.");
  const directory = path.resolve(dataDir);
  const result = { reviews: 0, feedback: 0, reactions: 0, donations: 0, legacyDonationRecords: 0 };
  for (const kind of ["reviews", "feedback"]) {
    const filePath = path.join(directory, `${kind}.json`);
    await store.update(filePath, (current) => {
      const stats = scrubContent(current, kind, subject);
      result[kind] = stats.cleared;
      result.reactions += stats.reactions;
      return current;
    }, { mode: 0o600, afterWrite: async (next) => verifyContent(await store.read(filePath), next, kind, subject) });
  }
  const donatePath = path.join(directory, "donate.json");
  let donationDocumentLoaded = false;
  try {
    await store.update(donatePath, (current) => {
      donationDocumentLoaded = true;
      const cleaned = cleanupDonateRecords(current, donationOrderKeys);
      result.donations = cleaned.cleared;
      result.legacyDonationRecords = cleaned.legacyUnattributed;
      return cleaned.document;
    }, { mode: 0o600, afterWrite: async (next) => {
      const readback = await store.read(donatePath);
      if (!isDeepStrictEqual(readback, next)) throw failure("ACCOUNT_CONTENT_READBACK_MISMATCH", "Donation cleanup readback differs from the committed document.");
      const exactKeys = new Set(donationOrderKeys);
      if ((readback.records || []).some((record) => exactKeys.has(record.order_key) && record.nickname !== "好心人")) {
        throw failure("ACCOUNT_CONTENT_CLEANUP_INCOMPLETE", "Donation cleanup left an attributed nickname.");
      }
    } });
  } catch (error) {
    // Public donation records are optional. Missing content is not initialized;
    // malformed records, unsafe paths and failed readback must still fail closed.
    if (error.code !== "ENOENT" || donationDocumentLoaded) throw error;
  }
  return result;
}
