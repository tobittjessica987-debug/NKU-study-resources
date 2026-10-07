const DATASETS = [
  ["reviews", "reviews_pagination", "review_page"],
  ["feedback", "feedback_pagination", "feedback_page"],
  ["security_logs", "log_pagination", "log_page"],
  ["admin_audit", "audit_pagination", "audit_page"],
];
const initialPages = () => ({ reviews: 1, feedback: 1, security_logs: 1, admin_audit: 1 });

export class LawRequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "LawRequestError";
    this.status = status;
  }
}

export function formatLawTime(value) {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "无效时间";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

// datetime-local inputs in this panel are explicitly Beijing time, independent of the device zone.
export function lawTimeParameter(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return String(Number(text));
  let timestamp;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    timestamp = Date.parse(`${text}+08:00`);
    if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 3600000).toISOString().slice(0, text.length) !== text) throw new LawRequestError("时间无效，请输入有效的北京时间。");
  } else if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    timestamp = Date.parse(text);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new LawRequestError("时间无效，请输入有效的北京时间。");
  return String(timestamp);
}

function rangeParameters(input) {
  const from = lawTimeParameter(input.from), to = lawTimeParameter(input.to);
  if (from && to && Number(from) > Number(to)) throw new LawRequestError("开始时间不能晚于结束时间。");
  return { from, to };
}

export function normalizeLawQuery(input = {}) {
  const type = String(input.type || "account");
  if (!["account", "review", "feedback"].includes(type)) throw new LawRequestError("查询类型无效。");
  const value = String(input.value ?? "").trim();
  if (!value) throw new LawRequestError("请输入账号或内容 ID。");
  const reference = String(input.reference ?? "").trim();
  if (reference && !/^[a-zA-Z0-9._:-]{1,80}$/.test(reference)) throw new LawRequestError("关联编号仅支持 1–80 位字母、数字及 . _ : -，也可留空。");
  return { type, value, ...rangeParameters(input), action: String(input.action ?? "").trim(), audit_action: String(input.audit_action ?? "").trim(), reference };
}

function appendNonempty(params, input, keys) {
  for (const key of keys) if (input[key] !== "" && input[key] !== undefined && input[key] !== null) params.set(key, String(input[key]));
}

export function buildLawQueryParams(input, pages = initialPages(), { exportJson = false, pageSize = 50 } = {}) {
  const filters = normalizeLawQuery(input);
  const params = new URLSearchParams({ type: filters.type, [filters.type === "account" ? "value" : "id"]: filters.value });
  appendNonempty(params, filters, ["from", "to", "action", "audit_action", "reference"]);
  if (!exportJson) {
    for (const [key, , parameter] of DATASETS) params.set(parameter, String(pages[key] || 1));
    params.set("content_page_size", String(pageSize));
    params.set("log_page_size", String(pageSize));
    params.set("audit_page_size", String(pageSize));
  }
  return params;
}

export function normalizeLawLogFilters(input = {}) {
  const type = String(input.type ?? "");
  const exported = String(input.exported ?? "");
  if (type && !["account", "review", "feedback"].includes(type)) throw new LawRequestError("调取记录类型无效。");
  if (exported && !["true", "false"].includes(exported)) throw new LawRequestError("调取记录操作类型无效。");
  return { actor: String(input.actor ?? "").trim(), type, exported, ...rangeParameters(input) };
}

function validatePagination(page, rows, requestedPage) {
  if (!page || !Number.isSafeInteger(page.total) || page.total < 0
    || !Number.isSafeInteger(page.page) || page.page < 1 || page.page !== requestedPage
    || !Number.isSafeInteger(page.page_size) || page.page_size < 1
    || !Number.isSafeInteger(page.returned) || page.returned !== rows.length
    || !Number.isSafeInteger(page.total_pages) || page.total_pages !== Math.ceil(page.total / page.page_size)
    || page.has_more !== (page.page * page.page_size < page.total)
    || page.truncated !== (page.total > rows.length)
    || rows.length !== Math.min(page.page_size, Math.max(0, page.total - (page.page - 1) * page.page_size))) {
    throw new LawRequestError("服务器返回的分页结果不完整，请重试。");
  }
}

function validateShape(data, filters) {
  const target = filters.type === "account" ? `user:${data?.account?.id}` : `${filters.type}:${filters.value}`;
  if (!data || data.query?.type !== filters.type || data.query?.target !== target || String(data.query?.reference ?? "") !== filters.reference
    || (data.account !== null && (!data.account || typeof data.account !== "object"))) throw new LawRequestError("服务器返回的查询结果不完整，请重试。");
  if (data.query.filters?.action !== filters.action || data.query.filters?.audit_action !== filters.audit_action
    || (filters.from && data.query.filters?.from !== Number(filters.from))
    || (filters.to && data.query.filters?.to !== Number(filters.to))) throw new LawRequestError("服务器返回的筛选范围不一致，请重试。");
  if (!data.range || data.range.inclusive !== true || !Array.isArray(data.range.scope)
    || !data.range.scope.includes("security_logs") || !data.range.scope.includes("admin_audit")) throw new LawRequestError("服务器返回的日志范围不完整，请重试。");
  if (data.counts?.account !== (data.account ? 1 : 0)) throw new LawRequestError("服务器返回的账号计数不一致，请重试。");
  for (const [key] of DATASETS) {
    if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.counts?.[key]) || data.counts[key] < 0) throw new LawRequestError("服务器返回的查询结果不完整，请重试。");
  }
}

export function validateLawQuery(data, filters, pages = initialPages()) {
  validateShape(data, filters);
  for (const [key, pagination] of DATASETS) {
    validatePagination(data[pagination], data[key], pages[key]);
    if (data.counts[key] !== data[pagination].total) throw new LawRequestError("服务器返回的计数不一致，请重试。");
  }
  if (data.complete !== DATASETS.every(([key]) => data[key].length === data.counts[key])) throw new LawRequestError("服务器返回的完整性标记无效，请重试。");
  return data;
}

export function validateLawExport(data, filters) {
  validateShape(data, filters);
  if (data.complete !== true || DATASETS.some(([key]) => data.counts[key] !== data[key].length)) throw new LawRequestError("导出结果未完整返回，未下载文件，请重试。");
  return data;
}

export function lawExportFilename(header) {
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(String(header || ""));
  const regular = /filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(String(header || ""));
  let filename = regular?.[1] || regular?.[2] || "";
  if (extended) { try { filename = decodeURIComponent(extended[1]); } catch { throw new LawRequestError("导出文件名无效，未下载文件。"); } }
  if (!filename || /[\x00-\x1f\x7f/\\]/.test(filename) || !/\.json$/i.test(filename)) throw new LawRequestError("服务器未提供有效的 JSON 文件名，未下载文件。");
  return filename;
}

/** Read-only requests retain the authenticated admin cookie and never reuse cached personal data. */
export async function requestLawJson(url, { fetch = globalThis.fetch, timeoutMs = 30000, attachment = false } = {}) {
  if (!/^\/admin-api\/(law-query|law-export|law-logs)\?/.test(url)) throw new LawRequestError("调取接口地址无效。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { "accept": "application/json", "x-nkustudy-admin-request": "1" }, signal: controller.signal });
    let result, body;
    try { body = await response.text(); result = JSON.parse(body); }
    catch { throw new LawRequestError(`服务器返回了无法读取的结果（HTTP ${response.status}），请重试。`, response.status); }
    if (!response.ok || result?.ok === false) throw new LawRequestError(response.status === 401 ? "登录已失效，请重新登录。" : result?.error || `请求失败（HTTP ${response.status}），请重试。`, response.status);
    if (attachment) {
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "")) throw new LawRequestError("导出文件格式无效，未下载文件。");
      return { data: result, filename: lawExportFilename(response.headers.get("content-disposition")), body };
    }
    return result;
  } catch (error) {
    if (error instanceof LawRequestError) throw error;
    throw new LawRequestError(controller.signal.aborted ? "请求超时，请重试。" : "网络连接失败，请检查连接后重试。");
  } finally { clearTimeout(timer); }
}

export function downloadLawExport({ body, filename }, { document = globalThis.document, URL = globalThis.URL, Blob = globalThis.Blob } = {}) {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/**
 * @param {{ request?: typeof requestLawJson, download?: (file: { body: string, filename: string, data?: any }) => void | Promise<void>, onState?: (state: any) => void, onUnauthorized?: () => void, pageSize?: number }} options
 */
export function createLawQueryController({ request = requestLawJson, download = downloadLawExport, onState = () => {}, onUnauthorized = () => {}, pageSize = 50 } = {}) {
  let generation = 0, exportGeneration = 0;
  let filters = null;
  let state = { phase: "idle", data: null, pages: initialPages(), error: "", exportPhase: "idle", exportMessage: "" };
  const emit = (next) => { state = { ...state, ...next }; onState({ ...state }); };
  const invalidate = (message = "条件已修改，请重新查询。") => {
    generation++; exportGeneration++; filters = null;
    emit({ phase: "idle", data: null, pages: initialPages(), error: message, exportPhase: "idle", exportMessage: "" });
  };
  async function load(input, nextPages = initialPages()) {
    const token = ++generation;
    emit({ phase: "loading", data: null, pages: { ...nextPages }, error: "" });
    try {
      const requestedFilters = normalizeLawQuery(input);
      filters = requestedFilters;
      const result = await request(`/admin-api/law-query?${buildLawQueryParams(requestedFilters, nextPages, { pageSize })}`);
      if (token !== generation) return false;
      if (result?.ok !== true) throw new LawRequestError("服务器尚未确认查询成功，请重试。");
      const data = validateLawQuery(result.data, requestedFilters, nextPages);
      emit({ phase: "ready", data, error: "" });
      return true;
    } catch (error) {
      if (token !== generation) return false;
      emit({ phase: "error", data: null, error: error?.message || "查询失败，请重试。" });
      if (error?.status === 401) onUnauthorized();
      return false;
    }
  }
  async function exportJson(input) {
    const token = ++exportGeneration;
    emit({ exportPhase: "loading", exportMessage: "正在生成并校验完整导出文件…" });
    try {
      const requestedFilters = normalizeLawQuery(input);
      const result = await request(`/admin-api/law-export?${buildLawQueryParams(requestedFilters, initialPages(), { exportJson: true })}`, { attachment: true });
      if (token !== exportGeneration) return false;
      validateLawExport(result?.data, requestedFilters);
      lawExportFilename(`filename="${result.filename}"`);
      if (typeof result.body !== "string") throw new LawRequestError("导出文件内容无效，未下载文件。");
      // The downloaded bytes must be the same JSON object whose completeness was checked.
      if (JSON.stringify(JSON.parse(result.body)) !== JSON.stringify(result.data)) throw new LawRequestError("导出文件内容不一致，未下载文件。");
      await download(result);
      if (token !== exportGeneration) return false;
      emit({ exportPhase: "ready", exportMessage: `已启动本机下载：${result.filename}。对外交付需另行记录。` });
      return true;
    } catch (error) {
      if (token !== exportGeneration) return false;
      emit({ exportPhase: "error", exportMessage: error?.message || "导出失败，未下载文件，请重试。" });
      if (error?.status === 401) onUnauthorized();
      return false;
    }
  }
  return { load, exportJson, invalidate, reset: () => invalidate(""), state: () => ({ ...state }), page: (key, page) => {
    if (!DATASETS.some(([dataset]) => key === dataset) || !filters || !Number.isSafeInteger(page) || page < 1) return Promise.resolve(false);
    return load(filters, { ...state.pages, [key]: page });
  } };
}

/** @param {{ request?: typeof requestLawJson, onState?: (state: any) => void, onUnauthorized?: () => void, pageSize?: number }} options */
export function createLawLogController({ request = requestLawJson, onState = () => {}, onUnauthorized = () => {}, pageSize = 50 } = {}) {
  let generation = 0, filters = {};
  let state = { phase: "idle", data: null, page: 1, error: "" };
  const emit = (next) => { state = { ...state, ...next }; onState({ ...state }); };
  function invalidate(message = "筛选已修改，请刷新调取记录。") { generation++; filters = {}; emit({ phase: "idle", data: null, page: 1, error: message }); }
  async function load(input = filters, page = 1) {
    const token = ++generation;
    emit({ phase: "loading", data: null, page, error: "" });
    try {
      filters = normalizeLawLogFilters(input);
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      appendNonempty(params, filters, ["actor", "type", "exported", "from", "to"]);
      const data = await request(`/admin-api/law-logs?${params}`);
      if (token !== generation) return false;
      if (data?.ok !== true || !Array.isArray(data.items)) throw new LawRequestError("服务器返回的调取记录不完整，请重试。");
      validatePagination(data, data.items, page);
      emit({ phase: "ready", data, error: "" });
      return true;
    } catch (error) {
      if (token !== generation) return false;
      emit({ phase: "error", data: null, error: error?.message || "调取记录加载失败，请重试。" });
      if (error?.status === 401) onUnauthorized();
      return false;
    }
  }
  return { load, invalidate, reset: () => invalidate(""), state: () => ({ ...state }), page: (page) => load(filters, page) };
}
