const TIME_SCOPE = Object.freeze(["security_logs", "admin_audit"]);
const MAX_PAGE_SIZE = 1000;
export const LAW_EXPORT_MAX_ROWS = 50_000;

function failure(message, statusCode = 400, code = "LAW_INVALID_QUERY") {
  return Object.assign(new Error(message), { statusCode, code });
}

function parameter(params, key) {
  const value = typeof params?.get === "function" ? params.get(key) : params?.[key];
  return value == null ? "" : String(value).trim();
}

export function parseLawTime(value, fallback, label = "时间") {
  const text = value == null ? "" : String(value).trim();
  if (!text) return fallback;
  let milliseconds;
  if (/^\d+$/.test(text)) milliseconds = Number(text);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    // Date.parse normalizes impossible dates such as February 30; reject those.
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw failure(`${label}无效。`);
    const [hour, minute, second = "0"] = text.slice(11).split(/[:Z+\-]/);
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) >= 60) throw failure(`${label}无效。`);
    milliseconds = Date.parse(text);
  } else throw failure(`${label}需为非负毫秒时间戳或含时区的 ISO 时间。`);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) throw failure(`${label}无效。`);
  return milliseconds;
}

export function parseLawPage(value, fallback, label, max = 1_000_000) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > max) throw failure(`${label}需为 1 至 ${max} 的整数。`);
  return Number(text);
}

function boundedText(value, label, max) {
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure(`${label}无效。`);
  return value;
}

function identity(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function publicAccount(row) {
  if (!row) return null;
  // Explicit whitelist: never return password hashes, sessions, or token columns.
  return {
    id: row.id,
    nickname: row.nickname || "",
    phone: row.phone || "",
    phone_verified_at: row.phone_verified_at ?? null,
    openid: row.openid ?? null,
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
    blocked: row.blocked === 1 || row.blocked === true,
    deleted_at: row.deleted_at ?? null,
    login_count: row.login_count ?? 0,
  };
}

function pagination(rows, page, pageSize) {
  const items = rows.slice((page - 1) * pageSize, page * pageSize);
  return {
    items,
    metadata: {
      total: rows.length, page, page_size: pageSize, returned: items.length,
      total_pages: Math.ceil(rows.length / pageSize), has_more: page * pageSize < rows.length,
      truncated: items.length < rows.length,
    },
  };
}

function newestFirst(a, b) {
  return Number(b.at) - Number(a.at) || Number(b.id) - Number(a.id);
}

function completeLogStore(store) {
  if (!store?.writer?.health) return;
  const health = store.writer.health();
  // Completed events in the durable replay queue are part of retained evidence.
  // An in-flight intent (including this query's own audit) is not a finished event.
  if (!Number.isFinite(health.pending) || health.pending > 0) throw failure("日志仍待恢复，暂时不能提供完整调取结果。", 503, "LAW_LOG_RECOVERY_PENDING");
}

/**
 * Collect each source once, synchronously, then filter/page in memory. This avoids
 * page-to-page changes inside an export, but does not claim a transaction across
 * the JSON files, SQLite connections, or writes from another process.
 */
export function createLawQueryService({ db, readReviews, readFeedback, securityLogStore, accountsStore, now = Date.now, maxExportRows = LAW_EXPORT_MAX_ROWS } = {}) {
  if (!db?.prepare || typeof readReviews !== "function" || typeof readFeedback !== "function" || typeof securityLogStore?.snapshot !== "function" || typeof accountsStore?.snapshotAudit !== "function") throw new Error("Law query service requires synchronous database, content readers, and log snapshots.");
  if (!Number.isSafeInteger(maxExportRows) || maxExportRows < 1) throw new Error("maxExportRows must be a positive safe integer.");

  function collect(params, exporting) {
    const collectedAt = Number(now());
    if (!Number.isSafeInteger(collectedAt) || collectedAt < 0 || collectedAt > 8_640_000_000_000_000) throw new Error("Law query clock is invalid.");
    const type = parameter(params, "type") || "account";
    if (!["account", "review", "feedback"].includes(type)) throw failure("查询类型无效。");
    const from = parseLawTime(parameter(params, "from"), 0, "开始时间");
    const to = parseLawTime(parameter(params, "to"), collectedAt, "结束时间");
    if (from > to) throw failure("开始时间不得晚于结束时间。");
    const action = boundedText(parameter(params, "action"), "安全日志动作", 64);
    const auditAction = boundedText(parameter(params, "audit_action"), "处置审计动作", 128);
    const rawReference = typeof params?.get === "function" ? params.get("reference") : params?.reference;
    const reference = rawReference == null ? "" : String(rawReference);
    if (reference && !/^[a-zA-Z0-9._:-]{1,80}$/.test(reference)) throw failure("调取编号只能包含 1 至 80 位英文字母、数字、点、下划线、冒号或横线。");

    // Page parameters never constrain an export, including a stale invalid page.
    const pages = exporting ? null : {
      reviews: parseLawPage(parameter(params, "review_page"), 1, "评价页码"),
      feedback: parseLawPage(parameter(params, "feedback_page"), 1, "反馈页码"),
      contentSize: parseLawPage(parameter(params, "content_page_size"), 100, "内容每页条数", MAX_PAGE_SIZE),
      logs: parseLawPage(parameter(params, "log_page"), 1, "日志页码"),
      logSize: parseLawPage(parameter(params, "log_page_size"), 100, "日志每页条数", MAX_PAGE_SIZE),
      audit: parseLawPage(parameter(params, "audit_page"), 1, "审计页码"),
      auditSize: parseLawPage(parameter(params, "audit_page_size") || parameter(params, "log_page_size"), 100, "审计每页条数", MAX_PAGE_SIZE),
    };

    const lookup = boundedText(parameter(params, type === "account" ? "value" : "id"), "查询标识", type === "account" ? 128 : 80);
    if (!lookup) throw failure(type === "account" ? "请输入账号标识。" : "请输入内容 ID。");

    let allReviews, allFeedback, user, selectedReviews, selectedFeedback, selectedUserId, target;
    let securityRows, auditRows;
    try {
      const reviewsDocument = readReviews();
      const feedbackDocument = readFeedback();
      if (!Array.isArray(reviewsDocument?.reviews) || !Array.isArray(feedbackDocument?.items)) throw new Error("Invalid content document");
      allReviews = structuredClone(reviewsDocument.reviews);
      allFeedback = structuredClone(feedbackDocument.items);
      if (type === "account") {
        if (/^1\d{10}$/.test(lookup)) {
          const matches = db.prepare("SELECT * FROM mp_users WHERE phone = ? LIMIT 2").all(lookup);
          if (matches.length > 1) throw failure("该手机号关联多个账号，请使用用户 ID 调取。", 409, "LAW_AMBIGUOUS_ACCOUNT");
          user = matches[0];
        }
        else if (/^\d+$/.test(lookup)) {
          if (!identity(lookup)) throw failure("用户 ID 无效。");
          user = db.prepare("SELECT * FROM mp_users WHERE id = ?").get(Number(lookup));
        } else user = db.prepare("SELECT * FROM mp_users WHERE openid = ?").get(lookup);
        if (!user) throw failure("未找到该账号。", 404, "LAW_NOT_FOUND");
        selectedUserId = identity(user.id);
        selectedReviews = allReviews.filter(row => identity(row.user_id) === selectedUserId);
        selectedFeedback = allFeedback.filter(row => identity(row.user_id) === selectedUserId);
        target = `user:${selectedUserId}`;
      } else {
        const row = (type === "review" ? allReviews : allFeedback).find(row => String(row.id) === lookup);
        if (!row) throw failure(type === "review" ? "未找到该评价。" : "未找到该反馈/举报。", 404, "LAW_NOT_FOUND");
        selectedReviews = type === "review" ? [row] : [];
        selectedFeedback = type === "feedback" ? [row] : [];
        selectedUserId = identity(row.user_id);
        user = selectedUserId ? db.prepare("SELECT * FROM mp_users WHERE id = ?").get(selectedUserId) : null;
        target = `${type}:${lookup}`;
      }
      completeLogStore(securityLogStore);
      completeLogStore(accountsStore);
      securityRows = securityLogStore.snapshot();
      auditRows = accountsStore.snapshotAudit({ includeArchived: true });
      if (!Array.isArray(securityRows) || !Array.isArray(auditRows)) throw new Error("Invalid log snapshot");
    } catch (error) {
      if (error?.statusCode) throw error;
      throw failure("调取数据读取失败，请稍后重试。", 503, "LAW_DATA_UNAVAILABLE");
    }

    const contentTargets = new Set([
      ...selectedReviews.map(row => `review:${String(row.id)}`),
      ...selectedFeedback.map(row => `feedback:${String(row.id)}`),
    ]);
    if (type === "account") {
      const currentOwners = new Map([
        ...allReviews.map(row => [`review:${String(row.id)}`, identity(row.user_id)]),
        ...allFeedback.map(row => [`feedback:${String(row.id)}`, identity(row.user_id)]),
      ]);
      // Deleted content can still be linked from a retained successful submission.
      // Never infer ownership from arbitrary actions or override a current owner.
      for (const row of securityRows) {
        const expectedType = row.action === "review.submit" ? "review" : ["feedback.submit", "report.submit"].includes(row.action) ? "feedback" : null;
        const contentTarget = `${row.target_type}:${String(row.target_id)}`;
        if (identity(row.user_id) === selectedUserId && expectedType && row.target_type === expectedType && row.target_id && ["ok", "pending"].includes(row.result) && (!currentOwners.has(contentTarget) || currentOwners.get(contentTarget) === selectedUserId)) contentTargets.add(contentTarget);
      }
    }
    const auditTargets = new Set(type === "account" ? [target, ...contentTargets] : [target]);
    const inRange = row => Number.isFinite(Number(row.at)) && Number(row.at) >= from && Number(row.at) <= to;
    const securityLogs = securityRows.filter(row => {
      const linked = type === "account"
        ? identity(row.user_id) === selectedUserId || contentTargets.has(`${row.target_type}:${String(row.target_id)}`)
        : row.target_type === type && String(row.target_id) === lookup;
      return linked && inRange(row) && (!action || row.action === action);
    }).sort(newestFirst);
    const adminAudit = auditRows.filter(row => auditTargets.has(row.target) && inRange(row) && (!auditAction || row.action === auditAction)).sort(newestFirst);
    const collections = { reviews: selectedReviews, feedback: selectedFeedback, security_logs: securityLogs, admin_audit: adminAudit };
    const counts = { account: user ? 1 : 0, ...Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.length])) };
    if (exporting && Object.entries(collections).some(([, rows]) => rows.length > maxExportRows)) throw failure(`导出单类记录超过 ${maxExportRows} 条，请缩小调取范围。`, 413, "LAW_EXPORT_TOO_LARGE");

    const generatedAt = new Date(collectedAt).toISOString();
    const result = {
      generatedAt,
      query: { type, target, at: generatedAt, reference: reference || null, filters: { from, to, action, audit_action: auditAction }, time_scope: [...TIME_SCOPE] },
      range: { from_ms: from, to_ms: to, from: new Date(from).toISOString(), to: new Date(to).toISOString(), inclusive: true, scope: [...TIME_SCOPE] },
      account: publicAccount(user), counts,
      snapshot: { scope: "synchronous_collection", atomic_across_sources: false },
      scopeNotes: ["完整性仅指本次筛选命中的现有留存证据；缺失的历史内容或作者映射不会重建。", "账号及内容为关联上下文；时间范围只筛安全日志与管理员处置审计。", "各数据源同步收集，未建立跨文件、跨数据库连接的原子快照。"],
      complete: true,
    };
    const settings = exporting ? null : {
      reviews: [pages.reviews, pages.contentSize], feedback: [pages.feedback, pages.contentSize],
      security_logs: [pages.logs, pages.logSize], admin_audit: [pages.audit, pages.auditSize],
    };
    const names = { reviews: "reviews_pagination", feedback: "feedback_pagination", security_logs: "log_pagination", admin_audit: "audit_pagination" };
    for (const [key, rows] of Object.entries(collections)) {
      const [page, pageSize] = exporting ? [1, Math.max(1, rows.length)] : settings[key];
      const { items, metadata } = pagination(rows, page, pageSize);
      result[key] = items;
      result[names[key]] = metadata;
      if (metadata.truncated) result.complete = false;
    }
    if (exporting) result.export_limit = { max_rows_per_collection: maxExportRows };
    return result;
  }

  return { query: params => collect(params, false), export: params => collect(params, true) };
}
