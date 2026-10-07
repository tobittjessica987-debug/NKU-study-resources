import assert from "node:assert/strict";
import test from "node:test";
import { buildLawQueryParams, createLawLogController, createLawQueryController, formatLawTime, lawExportFilename, lawTimeParameter, LawRequestError, normalizeLawQuery, requestLawJson } from "../src/lib/law-query-controller.js";
import { createLawQueryService } from "../server/law-query-service.mjs";

const keys = ["reviews", "feedback", "security_logs", "admin_audit"];
const paginationKeys = ["reviews_pagination", "feedback_pagination", "log_pagination", "audit_pagination"];
const paramsKeys = ["review_page", "feedback_page", "log_page", "audit_page"];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const queryInput = { type: "account", value: "1" };

function pagination(total, page = 1, pageSize = 2) {
  const returned = Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
  return { total, page, page_size: pageSize, returned, total_pages: Math.ceil(total / pageSize), has_more: page * pageSize < total, truncated: returned < total };
}

function queryData(url, { totals = [5, 4, 6, 3], complete = false } = {}) {
  const params = new URL(url, "https://example.test").searchParams;
  const type = params.get("type"), value = params.get("value") || params.get("id");
  const filters = { from: Number(params.get("from") || 0), to: Number(params.get("to") || 100), action: params.get("action") || "", audit_action: params.get("audit_action") || "" };
  const data = { account: { id: 1, nickname: "synthetic <script>" }, query: { type, target: type === "account" ? "user:1" : `${type}:${value}`, reference: params.get("reference") || null, filters }, generatedAt: new Date(100).toISOString(), range: { from_ms: filters.from, to_ms: filters.to, inclusive: true, scope: ["security_logs", "admin_audit"] }, counts: { account: 1 } };
  keys.forEach((key, index) => {
    const page = complete ? 1 : Number(params.get(paramsKeys[index]) || 1);
    const pageSize = complete ? Math.max(1, totals[index]) : Number(params.get(index < 2 ? "content_page_size" : index === 2 ? "log_page_size" : "audit_page_size") || 2);
    const pageInfo = pagination(totals[index], page, pageSize);
    data[key] = Array.from({ length: pageInfo.returned }, (_, row) => ({ id: `${key}:${(page - 1) * pageSize + row + 1}`, content: "synthetic <img src=x onerror=alert(1)>" }));
    data[paginationKeys[index]] = pageInfo;
    data.counts[key] = totals[index];
  });
  data.complete = keys.every((key) => data.counts[key] === data[key].length);
  return data;
}

const queryResult = (url, options) => ({ ok: true, data: queryData(url, options) });
const logResult = (number, total = 5) => ({ ok: true, ...pagination(total, number), items: Array.from({ length: pagination(total, number).returned }, (_, index) => ({ id: number * 10 + index, at: "invalid", queried_by: "synthetic" })) });
const attachment = (url, options) => { const data = queryData(url, { complete: true, ...options }); return { data, filename: "server-synthetic-export.json", body: JSON.stringify(data) }; };

test("query filters keep exact log actions, Beijing time, reference and independent pages; export omits all pagination", () => {
  const input = { type: "feedback", value: "id:12&x", from: "2026-10-07T12:30:00", to: "2026-10-07T13:00:00", action: " feedback.submit ", audit_action: " POST /admin-api/feedback/id:12 ", reference: "synthetic:S4-01" };
  const params = buildLawQueryParams(input, { reviews: 2, feedback: 3, security_logs: 4, admin_audit: 5 }, { pageSize: 50 });
  assert.equal(params.get("id"), "id:12&x");
  assert.equal(params.get("from"), String(Date.parse("2026-10-07T12:30:00+08:00")));
  assert.equal(params.get("action"), "feedback.submit");
  assert.equal(params.get("audit_action"), "POST /admin-api/feedback/id:12");
  assert.equal(params.get("reference"), "synthetic:S4-01");
  assert.deepEqual(paramsKeys.map((key) => params.get(key)), ["2", "3", "4", "5"]);
  const exported = buildLawQueryParams(input, {}, { exportJson: true });
  assert.ok(![...exported.keys()].some((key) => key.includes("page")));
  assert.equal(exported.get("audit_action"), params.get("audit_action"));
});

test("invalid ranges and references are rejected without a request; malformed stored time never throws", () => {
  for (const value of ["invalid", "2026-02-30T12:00", "2026-10-07T25:00", "-1", "9007199254740992"]) assert.throws(() => lawTimeParameter(value), LawRequestError);
  assert.equal(lawTimeParameter("0"), "0");
  assert.equal(lawTimeParameter("2026-10-07T04:00:00Z"), String(Date.parse("2026-10-07T12:00:00+08:00")));
  assert.throws(() => normalizeLawQuery({ ...queryInput, from: "2", to: "1" }), /开始时间/);
  for (const reference of ["synthetic / path", "中文编号", "A".repeat(81)]) assert.throws(() => normalizeLawQuery({ ...queryInput, reference }), /关联编号/);
  assert.equal(normalizeLawQuery(queryInput).reference, "");
  assert.equal(formatLawTime("invalid"), "无效时间");
  assert.equal(formatLawTime(null), "—");
  assert.match(formatLawTime(0), /08:00:00/);
});

test("GET requests retain the admin cookie, bypass cache and report HTTP/JSON errors", async () => {
  let options;
  const result = await requestLawJson("/admin-api/law-query?type=account&value=1", { fetch: async (_url, init) => { options = init; return new Response(JSON.stringify({ ok: true, data: {} })); } });
  assert.equal(result.ok, true);
  assert.equal(options.method, "GET");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
  assert.equal(options.headers["x-nkustudy-admin-request"], "1");
  await assert.rejects(requestLawJson("/law-query?value=1"), /接口地址/);
  await assert.rejects(requestLawJson("/admin-api/law-query?value=1", { fetch: async () => new Response("<html>failure</html>", { status: 500 }) }), /HTTP 500/);
  await assert.rejects(requestLawJson("/admin-api/law-query?value=1", { fetch: async () => new Response(JSON.stringify({ ok: false, error: "synthetic not found" }), { status: 404 }) }), /synthetic not found/);
  await assert.rejects(requestLawJson("/admin-api/law-query?value=1", { fetch: async () => new Response(JSON.stringify({ ok: false }), { status: 401 }) }), (error) => error.status === 401 && /重新登录/.test(error.message));
});

test("a stalled GET request exits loading with a timeout error", async () => {
  await assert.rejects(requestLawJson("/admin-api/law-query?value=1", { timeoutMs: 5, fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }), /请求超时/);
});

test("query results expose full totals and four independent pagination positions", async () => {
  const calls = [];
  const controller = createLawQueryController({ pageSize: 2, request: async (url) => { calls.push(url); return queryResult(url); } });
  assert.equal(await controller.load(queryInput), true);
  assert.equal(controller.state().data.log_pagination.total, 6);
  assert.equal(controller.state().data.security_logs.length, 2);
  assert.equal(controller.state().data.complete, false);
  await controller.page("reviews", 2);
  await controller.page("security_logs", 3);
  assert.deepEqual(controller.state().pages, { reviews: 2, feedback: 1, security_logs: 3, admin_audit: 1 });
  assert.equal(controller.state().data.reviews[0].id, "reviews:3");
  assert.equal(controller.state().data.security_logs[0].id, "security_logs:5");
  const params = new URL(calls.at(-1), "https://example.test").searchParams;
  assert.equal(params.get("feedback_page"), "1");
  assert.equal(params.get("audit_page"), "1");
});

test("loading and failed queries clear old records; an empty successful scope stays distinct from an error", async () => {
  let failure = false;
  const states = [];
  const controller = createLawQueryController({ pageSize: 2, onState: (state) => states.push(state), request: async (url) => { if (failure) throw new LawRequestError("synthetic not found", 404); return queryResult(url, { totals: [0, 0, 0, 0] }); } });
  await controller.load(queryInput);
  assert.equal(controller.state().phase, "ready");
  assert.deepEqual(controller.state().data.security_logs, []);
  failure = true;
  await controller.load({ ...queryInput, value: "2" });
  assert.equal(controller.state().phase, "error");
  assert.equal(controller.state().data, null);
  assert.match(controller.state().error, /not found/);
  assert.ok(states.filter((state) => state.phase === "loading").every((state) => state.data === null));
});

test("an older query response or failure cannot replace newer results or changed filters", async () => {
  const old = deferred();
  let oldUrl;
  const controller = createLawQueryController({ pageSize: 2, request: (url) => { if (!oldUrl) { oldUrl = url; return old.promise; } return Promise.resolve(queryResult(url)); } });
  const inFlight = controller.load(queryInput);
  controller.invalidate();
  assert.equal(controller.state().data, null);
  assert.match(controller.state().error, /条件已修改/);
  await controller.load({ type: "feedback", value: "new-id" });
  old.resolve(queryResult(oldUrl));
  assert.equal(await inFlight, false);
  assert.equal(controller.state().data.query.target, "feedback:new-id");
  const failed = deferred();
  const staleFailure = createLawQueryController({ request: () => failed.promise });
  const failingLoad = staleFailure.load(queryInput);
  staleFailure.reset();
  failed.reject(new LawRequestError("late failure"));
  await failingLoad;
  assert.equal(staleFailure.state().phase, "idle");
  assert.equal(staleFailure.state().error, "");
});

test("malformed pagination, inconsistent counts, target and filters are visible query errors", async () => {
  const alterations = [
    (data) => { data.log_pagination.returned = 99; },
    (data) => { data.log_pagination.has_more = false; },
    (data) => { data.counts.security_logs = 999; },
    (data) => { data.admin_audit = undefined; },
    (data) => { data.query.target = "feedback:another-id"; },
    (data) => { data.query.filters.audit_action = "unexpected"; },
    (data) => { data.complete = true; },
  ];
  for (const alter of alterations) {
    const controller = createLawQueryController({ pageSize: 2, request: async (url) => { const result = queryResult(url); alter(result.data); return result; } });
    assert.equal(await controller.load({ type: "feedback", value: "id" }), false);
    assert.equal(controller.state().phase, "error");
    assert.equal(controller.state().data, null);
  }
});

test("law history uses the dedicated GET endpoint, filters and independent pages", async () => {
  const calls = [];
  const controller = createLawLogController({ pageSize: 2, request: async (url) => { calls.push(url); return logResult(Number(new URL(url, "https://example.test").searchParams.get("page"))); } });
  await controller.load({ actor: " synthetic ", type: "feedback", exported: "false", from: "1", to: "99" });
  await controller.page(3);
  assert.equal(controller.state().data.total, 5);
  assert.equal(controller.state().data.items.length, 1);
  assert.ok(calls.every((url) => url.startsWith("/admin-api/law-logs?")));
  const params = new URL(calls[1], "https://example.test").searchParams;
  assert.equal(params.get("actor"), "synthetic");
  assert.equal(params.get("exported"), "false");
  assert.equal(params.get("page"), "3");
  assert.equal(params.get("from"), "1");
});

test("a failed history refresh is an error, and stale history does not appear under new filters", async () => {
  const old = deferred();
  const controller = createLawLogController({ pageSize: 2, request: () => old.promise });
  const load = controller.load({ actor: "old" });
  controller.invalidate();
  old.resolve(logResult(1));
  await load;
  assert.equal(controller.state().phase, "idle");
  assert.equal(controller.state().data, null);
  const failure = createLawLogController({ request: async () => { throw new LawRequestError("synthetic history failure", 503); } });
  await failure.load();
  assert.equal(failure.state().phase, "error");
  assert.match(failure.state().error, /history failure/);
});

test("complete export downloads the validated full JSON and server filename using current filters", async () => {
  const calls = [], downloads = [];
  const controller = createLawQueryController({ request: async (url, options) => { calls.push({ url, options }); return attachment(url); }, download: async (file) => { downloads.push(file); } });
  assert.equal(await controller.exportJson({ ...queryInput, action: "login", audit_action: "admin.change", from: "1", to: "90", reference: "synthetic:S4" }), true);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "server-synthetic-export.json");
  const body = JSON.parse(downloads[0].body);
  assert.equal(body.complete, true);
  assert.equal(body.security_logs.length, 6);
  assert.equal(body.admin_audit.length, 3);
  assert.equal(body.query.reference, "synthetic:S4");
  assert.ok(calls[0].url.startsWith("/admin-api/law-export?"));
  assert.equal(calls[0].options.attachment, true);
  assert.ok(![...new URL(calls[0].url, "https://example.test").searchParams.keys()].some((key) => key.includes("page")));
  assert.match(controller.state().exportMessage, /本机下载/);
  assert.match(controller.state().exportMessage, /对外交付需另行记录/);
});

test("partial, inconsistent, malformed and mismatched export packages never download", async () => {
  const alterations = [
    (file) => { file.data.complete = false; file.body = JSON.stringify(file.data); },
    (file) => { file.data.counts.admin_audit++; file.body = JSON.stringify(file.data); },
    (file) => { file.data.feedback.pop(); file.body = JSON.stringify(file.data); },
    (file) => { file.body = JSON.stringify({ ...file.data, complete: false }); },
    (file) => { file.body = undefined; },
    (file) => { file.filename = "../invalid.json"; },
  ];
  for (const alter of alterations) {
    let downloaded = false;
    const controller = createLawQueryController({ request: async (url) => { const file = attachment(url); alter(file); return file; }, download: () => { downloaded = true; } });
    assert.equal(await controller.exportJson(queryInput), false);
    assert.equal(downloaded, false);
    assert.equal(controller.state().exportPhase, "error");
  }
});

test("HTTP failures and HTML downloads remain visible errors without a fake export file", async () => {
  for (const response of [
    new Response(JSON.stringify({ ok: false, error: "synthetic over limit" }), { status: 413 }),
    new Response("<html>synthetic gateway error</html>", { status: 500 }),
    new Response("{broken", { status: 200, headers: { "content-type": "application/json", "content-disposition": "attachment; filename=synthetic.json" } }),
  ]) {
    let downloaded = false;
    const controller = createLawQueryController({ request: (url, options) => requestLawJson(url, { ...options, fetch: async () => response }), download: () => { downloaded = true; } });
    assert.equal(await controller.exportJson(queryInput), false);
    assert.equal(downloaded, false);
    assert.equal(controller.state().exportPhase, "error");
  }
});

test("a valid HTTP attachment preserves the server JSON bytes and UTF-8 filename", async () => {
  const url = `/admin-api/law-export?${buildLawQueryParams(queryInput, {}, { exportJson: true })}`;
  const file = attachment(url);
  const result = await requestLawJson(url, { attachment: true, fetch: async () => new Response(file.body, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": "attachment; filename=fallback.json; filename*=UTF-8''%E5%90%88%E6%88%90%E5%AF%BC%E5%87%BA.json" } }) });
  assert.equal(result.filename, "合成导出.json");
  assert.equal(result.body, file.body);
  for (const header of ["", "attachment; filename=../secret.json", "attachment; filename=error.html", "attachment; filename*=UTF-8''%ZZ.json"]) assert.throws(() => lawExportFilename(header), LawRequestError);
});

test("an export arriving after filters change or a newer export cannot download or replace state", async () => {
  const old = deferred();
  let firstUrl;
  const downloads = [];
  const controller = createLawQueryController({ request: (url) => { if (!firstUrl) { firstUrl = url; return old.promise; } return Promise.resolve(attachment(url)); }, download: (file) => { downloads.push(file); } });
  const oldLoad = controller.exportJson(queryInput);
  controller.invalidate();
  await controller.exportJson({ type: "feedback", value: "new-id" });
  old.resolve(attachment(firstUrl));
  assert.equal(await oldLoad, false);
  assert.equal(downloads.length, 1);
  assert.equal(JSON.parse(downloads[0].body).query.target, "feedback:new-id");
  assert.equal(controller.state().exportPhase, "ready");
});

test("401 query, export and history invoke the session expiry handler", async () => {
  let expired = 0;
  const request = async () => { throw new LawRequestError("synthetic expired", 401); };
  const options = { request, onUnauthorized: () => { expired++; } };
  const controller = createLawQueryController(options);
  await controller.load(queryInput);
  await controller.exportJson(queryInput);
  await createLawLogController(options).load();
  assert.equal(expired, 3);
});

test("the real query service contract renders empty collections, pages beyond 300 and full exports through the controller", async () => {
  const account = { id: 1, nickname: "synthetic", created_at: "invalid" };
  const service = createLawQueryService({
    db: { prepare: () => ({ get: () => account }) }, now: () => 1000,
    readReviews: () => ({ reviews: Array.from({ length: 105 }, (_, index) => ({ id: `review-${index}`, user_id: 1, content: "synthetic" })) }),
    readFeedback: () => ({ items: [] }),
    securityLogStore: { snapshot: () => Array.from({ length: 307 }, (_, index) => ({ id: index + 1, at: index + 1, action: "synthetic.login", user_id: 1 })) },
    accountsStore: { snapshotAudit: () => Array.from({ length: 305 }, (_, index) => ({ id: index + 1, at: index + 1, action: "synthetic.admin", target: "user:1" })) },
  });
  const downloads = [];
  const controller = createLawQueryController({ request: async (url, options) => {
    const params = new URL(url, "https://example.test").searchParams;
    if (options?.attachment) { const data = service.export(params); return { data, filename: "real-contract-synthetic.json", body: JSON.stringify(data) }; }
    return { ok: true, data: service.query(params) };
  }, download: (file) => { downloads.push(file); } });
  assert.equal(await controller.load(queryInput), true);
  assert.equal(controller.state().data.feedback_pagination.total_pages, 0);
  assert.equal(controller.state().data.feedback.length, 0);
  assert.equal(controller.state().data.query.reference, null);
  assert.equal(await controller.page("security_logs", 7), true);
  assert.equal(controller.state().data.security_logs.length, 7);
  assert.equal(controller.state().data.log_pagination.total, 307);
  assert.equal(await controller.page("admin_audit", 7), true);
  assert.equal(controller.state().data.admin_audit.length, 5);
  assert.equal(await controller.exportJson({ ...queryInput, from: "100", to: "200", action: "synthetic.login", audit_action: "synthetic.admin" }), true);
  const data = JSON.parse(downloads[0].body);
  assert.equal(data.security_logs.length, 101);
  assert.equal(data.admin_audit.length, 101);
  assert.equal(data.reviews.length, 105);
  assert.equal(data.complete, true);
});
