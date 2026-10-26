import { randomUUID } from "node:crypto";
import path from "node:path";
import { AtomicJsonStore } from "./atomic-json-store.mjs";
import { moderationHash } from "./moderation-model.mjs";

export const COMMUNITY_SUPPORT_LEDGER_FIELD = "community_support_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METADATA_KEYS = new Set(["version", "epoch", "sequence", "baseline_review_ids"]);

function unavailable() {
  return Object.assign(new Error("Community support review state requires reconciliation."), {
    code: "SUPPORT_UNAVAILABLE", statusCode: 503,
  });
}

function reviewIds(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.reviews)) throw unavailable();
  const ids = document.reviews.map((review) => review?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw unavailable();
  return ids;
}

/** This envelope is private runtime metadata, not a client-writable API field. */
export function validateCommunitySupportReviewMetadata(document) {
  reviewIds(document);
  const metadata = document[COMMUNITY_SUPPORT_LEDGER_FIELD];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || Object.keys(metadata).some((key) => !METADATA_KEYS.has(key))
    || metadata.version !== 1 || typeof metadata.epoch !== "string" || !UUID.test(metadata.epoch)
    || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 0
    || !Array.isArray(metadata.baseline_review_ids)
    || metadata.baseline_review_ids.some((id) => typeof id !== "string" || !id.trim())
    || new Set(metadata.baseline_review_ids).size !== metadata.baseline_review_ids.length) throw unavailable();
  return structuredClone(metadata);
}

function contentHash(document) {
  const content = { ...document };
  delete content[COMMUNITY_SUPPORT_LEDGER_FIELD];
  return moderationHash(content);
}

/** The complete reviews document is the durable desired state for its SQLite
 * projection. Sequence and reviews change in the SAME JSON replacement. This
 * does not claim that JSON and SQLite share a native database transaction.
 * Reads of statistics must reconcile this snapshot before serving counts.
 */
export class CommunitySupportReviewStore extends AtomicJsonStore {
  constructor({ reviewsFilePath, afterReviewsWrite, onProjectionError, ...options } = {}) {
    super(options);
    this.reviewsFilePath = reviewsFilePath ? path.resolve(reviewsFilePath) : null;
    this.afterReviewsWrite = afterReviewsWrite;
    this.onProjectionError = onProjectionError;
    this.pendingReviewWrites = 0;
    this.reviewProjectionQuarantined = false;
    this.projectionErrorReported = false;
  }

  #isReviews(filePath) {
    return this.reviewsFilePath !== null && path.resolve(filePath) === this.reviewsFilePath;
  }

  /** Statistics use this gate before a synchronous read. A JSON rename may be
   * visible while its afterWrite hook can still roll back; do not project that
   * intermediate state. Ordinary business readback remains unaffected.
   */
  assertProjectionReadable() {
    if (this.pendingReviewWrites || this.reviewProjectionQuarantined) throw unavailable();
  }

  async #trackReviewWrite(operation) {
    this.pendingReviewWrites++;
    try {
      return await operation();
    } finally {
      this.pendingReviewWrites--;
    }
  }

  #reportProjectionError() {
    if (this.projectionErrorReported) return;
    this.projectionErrorReported = true;
    try { Promise.resolve(this.onProjectionError?.(unavailable())).catch(() => {}); } catch { /* reporting cannot undo a business commit */ }
  }

  #quarantineProjection() {
    this.reviewProjectionQuarantined = true;
    this.#reportProjectionError();
  }

  #prepare(current, proposed) {
    const next = structuredClone(proposed);
    if (current && Object.hasOwn(current, COMMUNITY_SUPPORT_LEDGER_FIELD)) {
      // Invalid business content remains an error. Damaged optional accounting
      // metadata instead stays verbatim as evidence while normal reviews work.
      reviewIds(current);
      reviewIds(next);
      let metadata;
      try { metadata = validateCommunitySupportReviewMetadata(current); }
      catch {
        this.#quarantineProjection();
        next[COMMUNITY_SUPPORT_LEDGER_FIELD] = structuredClone(current[COMMUNITY_SUPPORT_LEDGER_FIELD]);
        return next;
      }
      if (contentHash(current) !== contentHash(next)) {
        if (metadata.sequence === Number.MAX_SAFE_INTEGER) {
          this.#quarantineProjection();
          next[COMMUNITY_SUPPORT_LEDGER_FIELD] = metadata;
          return next;
        }
        metadata.sequence++;
      }
      // Callers may normalize or replace the document. Neither a missing field
      // nor a caller-supplied envelope may reset enrollment or the checkpoint.
      next[COMMUNITY_SUPPORT_LEDGER_FIELD] = metadata;
    } else if (next && Object.hasOwn(next, COMMUNITY_SUPPORT_LEDGER_FIELD)) {
      // Creation is possible only through the explicit startup initialization.
      throw unavailable();
    }
    return next;
  }

  #commitOptions(options = {}) {
    const originalAfterCommit = options.afterCommit;
    return {
      ...options,
      afterCommit: async (next, previous) => {
        try {
          await originalAfterCommit?.(structuredClone(next), structuredClone(previous));
        } catch (error) {
          this.#quarantineProjection();
          throw error;
        }
        if (this.reviewProjectionQuarantined || !next || typeof next !== "object" || !Object.hasOwn(next, COMMUNITY_SUPPORT_LEDGER_FIELD) || typeof this.afterReviewsWrite !== "function") return;
        try {
          await this.afterReviewsWrite(structuredClone(next));
          this.projectionErrorReported = false;
        } catch {
          // The review commit is already durable. Statistics fail closed or
          // recover from this snapshot on their next read; no false rollback.
          this.#reportProjectionError();
        }
      },
    };
  }

  /** Initialize before accepting traffic. Existing metadata is validated and
   * retained; historical review IDs never become newly earned contributions.
   */
  initializeCommunitySupport(filePath = this.reviewsFilePath) {
    if (!filePath) throw new Error("A reviews file path is required.");
    const target = path.resolve(filePath);
    if (this.reviewsFilePath && target !== this.reviewsFilePath) throw new Error("Community support initialization must use its configured reviews file.");
    this.reviewsFilePath = target;
    return this.#trackReviewWrite(() => super.update(target, (document) => {
      const ids = reviewIds(document);
      if (Object.hasOwn(document, COMMUNITY_SUPPORT_LEDGER_FIELD)) {
        validateCommunitySupportReviewMetadata(document);
        return document;
      }
      return { ...document, [COMMUNITY_SUPPORT_LEDGER_FIELD]: {
        version: 1, epoch: randomUUID(), sequence: 0, baseline_review_ids: ids,
      } };
    }, this.#commitOptions({ mode: 0o600 })));
  }

  update(filePath, updater, options = {}) {
    if (!this.#isReviews(filePath)) return super.update(filePath, updater, options);
    return this.#trackReviewWrite(() => super.update(filePath, async (current) => {
      const previous = structuredClone(current);
      return this.#prepare(previous, await updater(current));
    }, this.#commitOptions(options)));
  }

  write(filePath, value, options = {}) {
    if (!this.#isReviews(filePath)) return super.write(filePath, value, options);
    // Both the existence check and replacement happen inside AtomicJsonStore's
    // shared file queue. A separate read()/write() would lose concurrent changes.
    const missingKey = `missing-${randomUUID()}`;
    const missing = { [missingKey]: true };
    return this.#trackReviewWrite(() => super.update(filePath, (current) => {
      const absent = current && Object.keys(current).length === 1 && current[missingKey] === true;
      return this.#prepare(absent ? null : current, value);
    }, this.#commitOptions({ ...options, initialize: missing })));
  }
}
