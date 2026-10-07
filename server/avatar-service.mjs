import { randomBytes } from "node:crypto";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const AVATAR_MAX_DIM = 4096;
export const AVATAR_OUTPUT_SIZE = 256;
export const AVATAR_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function inputFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  return null;
}

export class AvatarError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanupFailure(error) {
  return String(error?.code || error?.name || "REMOTE_DELETE_FAILED").slice(0, 200);
}

async function deleteRegisteredAvatar({ store, deleteObject, id, now }) {
  store.markCleanupPending(id);
  try {
    if (typeof deleteObject !== "function") throw new AvatarError("AVATAR_DELETE_UNAVAILABLE", "头像源站删除暂不可用。", 503);
    await deleteObject(`avatars/${id}.jpg`);
    const row = store.getById(id);
    if (row && row.upload_state !== "settled") {
      throw new AvatarError("AVATAR_UPLOAD_OUTCOME_UNKNOWN", "旧头像上传结果尚未确认；资源键将保留，需独立确认远端请求已终结后再清理。", 503);
    }
    // The key must remain discoverable until the remote delete has succeeded.
    store.remove(id);
  } catch (error) {
    store.markCleanupPending(id, { error: cleanupFailure(error), now: now(), attempted: true });
    throw error;
  }
}

/** Cleanup is independent of upload/moderation configuration and is reusable after restore. */
export async function cleanupUserAvatars({ store, deleteObject, userId, now = () => Date.now() }) {
  store.markUserDeletion(userId, { now: now() });
  let deletedCount = 0;
  for (const row of store.listForUser(userId)) {
    try {
      await deleteRegisteredAvatar({ store, deleteObject, id: row.id, now });
      deletedCount += 1;
    } catch {
      // Continue attempting the other known keys, retaining every failed registration.
    }
  }
  const rows = store.listForUser(userId);
  const remaining = rows.length;
  const uncertainUploads = rows.filter(row => row.upload_state !== "settled").length;
  if (remaining) {
    const error = new AvatarError("AVATAR_CLEANUP_PENDING", "头像源站清理尚未完成，将保留资源登记供重试。", 503);
    Object.assign(error, { deletedCount, remaining, uncertainUploads, sourceDeleted: false, cacheCleared: false });
    throw error;
  }
  return { deletedCount, remaining: 0, sourceDeleted: true, cacheCleared: false };
}

/**
 * 头像上传服务：Busboy 接收（admin-server 注入）→ sharp 解码校验/重编码
 * （剥离 EXIF 等元信息、居中裁剪 256px JPEG）→ 微信同步图片审核 → R2 avatars/
 * 前缀直链。远端写入前登记归属，上传不自动绑定资料。
 */
export function createAvatarService({
  store,
  moderation,
  putObject,
  deleteObject = null,
  publicRoot,
  rateLimiter = null,
  rateLimit = { perUserPerDay: 5 },
  sharpImpl = null,
  assertActiveUser = null,
  now = () => Date.now(),
}) {
  if (!store || !moderation || typeof putObject !== "function" || !publicRoot) {
    throw new Error("AvatarService requires store, moderation, putObject and publicRoot.");
  }
  const sharp = sharpImpl;
  if (!sharp) throw new Error("AvatarService requires a sharp implementation.");
  if (assertActiveUser !== null && typeof assertActiveUser !== "function") throw new TypeError("assertActiveUser must be a function.");
  const inFlight = new Map();
  const activeResourceIds = new Set();
  const deletionIntents = new Set();
  const cleanupJobs = new Map();

  function assertCanUpload(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AvatarError("AUTH_REQUIRED", "请先登录。", 401);
    if (deletionIntents.has(id) || store.isDeletionPending?.(id)) {
      throw new AvatarError("AUTH_ACCOUNT_DELETED", "账号正在注销或已注销。", 401);
    }
    assertActiveUser?.(id);
  }

  function beginDeletion(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("A positive userId is required.");
    deletionIntents.add(id);
    store.markUserDeletion(id, { now: now() });
  }

  function assertQuota(userId) {
    if (!rateLimiter) return;
    const consumed = rateLimiter.consume({
      scope: "avatar-upload",
      actorHash: `u${Number(userId)}`,
      limits: [{ windowMs: 24 * 60 * 60 * 1000, max: rateLimit.perUserPerDay }],
      now: now(),
    });
    if (consumed.allowed !== true) {
      throw new AvatarError("RATE_LIMITED", "头像上传过于频繁，请明天再试。", 429);
    }
  }

  async function processImage(buffer, { userId = null } = {}) {
    const format = inputFormat(buffer);
    if (!format) throw new AvatarError("AVATAR_INVALID_IMAGE", "请上传有效的 JPEG 或 PNG 图片。", 400);
    try {
      const image = sharp(buffer, { failOn: "error", limitInputPixels: AVATAR_MAX_DIM * AVATAR_MAX_DIM });
      const meta = await image.metadata();
      if (userId !== null) assertCanUpload(userId);
      if (meta.format !== format) throw new Error("unexpected image format");
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      if (meta.width > AVATAR_MAX_DIM || meta.height > AVATAR_MAX_DIM) {
        throw new AvatarError("AVATAR_TOO_LARGE", `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM} 像素。`, 413);
      }
      // 重编码即剥离全部元信息（EXIF/GPS 等），并规范化为 256px 方形 JPEG
      const processed = await image
        .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: 82, progressive: false })
        .toBuffer();
      if (userId !== null) assertCanUpload(userId);
      return processed;
    } catch (error) {
      if (error instanceof AvatarError || String(error?.code || "").startsWith("AUTH_")) throw error;
      if (/pixel limit|exceeds/i.test(String(error?.message || ""))) {
        throw new AvatarError("AVATAR_TOO_LARGE", `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM} 像素。`, 413);
      }
      throw new AvatarError("AVATAR_INVALID_IMAGE", "请上传有效的 JPEG 或 PNG 图片。", 400);
    }
  }

  async function moderate(buffer) {
    try {
      const verdict = await moderation.check(buffer, { filename: "avatar.jpg", contentType: "image/jpeg" });
      if (!verdict.approved) {
        throw new AvatarError("AVATAR_CONTENT_REJECTED", "图片未通过安全审核，请更换图片。", 403);
      }
    } catch (error) {
      if (error instanceof AvatarError) throw error;
      throw new AvatarError("AVATAR_UPLOAD_UNAVAILABLE", "审核服务暂时不可用，请稍后重试。", 503);
    }
  }

  async function sweepOrphans({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    if (typeof deleteObject !== "function") return 0;
    let removed = 0;
    for (const id of store.orphanIds({ before: now(), ttlMs })) {
      if (activeResourceIds.has(id)) continue;
      try {
        await deleteRegisteredAvatar({ store, deleteObject, id, now });
        removed += 1;
      } catch (error) {
        if (error?.code === "AVATAR_UPLOAD_OUTCOME_UNKNOWN") continue;
        break; // 删除失败留待下轮
      }
    }
    return removed;
  }

  async function performUpload({ userId, buffer }) {
    assertCanUpload(userId);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AvatarError("AVATAR_INVALID_IMAGE", "缺少文件。", 400);
    if (buffer.length > AVATAR_MAX_BYTES) throw new AvatarError("AVATAR_TOO_LARGE", `图片不能超过 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)} MiB。`, 413);
    assertQuota(userId);
    const processed = await processImage(buffer, { userId });
    assertCanUpload(userId);
    await moderate(processed);
    assertCanUpload(userId);
    const id = randomBytes(16).toString("base64url");
    // Registration precedes the remote write: even an interrupted or ambiguous PUT
    // leaves a durable key that deletion/recovery can discover.
    store.register({ id, userId, bytes: processed.length, now: now(), status: "pending_upload" });
    activeResourceIds.add(id);
    let remoteStarted = false;
    try {
      assertCanUpload(userId);
      remoteStarted = true;
      try { await putObject(avatarKey(id), processed); }
      catch { throw new AvatarError("AVATAR_UPLOAD_UNAVAILABLE", "存储服务暂时不可用，请稍后重试。", 503); }
      // Persist the confirmed remote completion even if deletion started during
      // this PUT. This does not approve or rebind an inactive account's avatar.
      store.markUploadSettled?.(id);
      assertCanUpload(userId);
      store.markUploaded?.(id);
      assertCanUpload(userId);
      sweepOrphans().catch(() => {});
      return { avatar_url: urlOf(id), id };
    } catch (error) {
      if (!remoteStarted) store.markUploadSettled?.(id);
      store.markCleanupPending?.(id, { error: cleanupFailure(error), now: now() });
      if (typeof deleteObject === "function" && typeof store.markCleanupPending === "function") {
        await deleteRegisteredAvatar({ store, deleteObject, id, now }).catch(() => {});
      }
      throw error;
    } finally {
      activeResourceIds.delete(id);
    }
  }

  function avatarKey(id) {
    return `avatars/${id}.jpg`;
  }

  function urlOf(id) {
    return `${publicRoot}${id}.jpg`;
  }

  /** id → URL 反解（绑定校验用）；不匹配本站 avatars 根返回 null。 */
  function idFromUrl(url) {
    const text = String(url || "");
    if (!text.startsWith(publicRoot)) return null;
    const rest = text.slice(publicRoot.length);
    if (!/^[A-Za-z0-9_-]{16,64}\.jpg$/.test(rest)) return null;
    return rest.slice(0, -4);
  }

  return {
    configured: true,
    publicRoot,
    assertQuota,
    urlOf,
    idFromUrl,
    processImage,
    moderate,
    avatarKey,
    sweepOrphans,
    beginDeletion,

    deleteForUser(userId) {
      const id = Number(userId);
      beginDeletion(id);
      if (cleanupJobs.has(id)) return cleanupJobs.get(id);
      const operation = (async () => {
        while (inFlight.get(id)?.size) await Promise.allSettled([...inFlight.get(id)]);
        return cleanupUserAvatars({ store, deleteObject, userId: id, now });
      })();
      cleanupJobs.set(id, operation);
      return operation.finally(() => { if (cleanupJobs.get(id) === operation) cleanupJobs.delete(id); });
    },

    /** 完整上传：校验/处理 → 审核 → pending 登记 → R2 → approved。不自动绑定。 */
    async upload({ userId, buffer }) {
      const id = Number(userId);
      assertCanUpload(id);
      const operation = performUpload({ userId: id, buffer });
      const uploads = inFlight.get(id) || new Set();
      uploads.add(operation);
      inFlight.set(id, uploads);
      try {
        return await operation;
      } finally {
        uploads.delete(operation);
        if (!uploads.size) inFlight.delete(id);
      }
    },
  };
}
