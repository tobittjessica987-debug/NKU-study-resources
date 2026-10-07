import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/pages/admin.astro", import.meta.url), "utf8");
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "the management script is present");
const ast = ts.createSourceFile("admin.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const helperSource = fs.readFileSync(new URL("../src/lib/admin-types.ts", import.meta.url), "utf8");

// Execute the page's real functions/bindings with a small DOM that implements only
// the browser behavior used here, including select options being erased by textContent.
class SyntheticElement {
  id = "";
  className = "";
  dataset = {};
  disabled = false;
  children = [];
  parent = null;
  listeners = new Map();
  text = "";

  get textContent() { return this.text; }
  set textContent(value) { this.text = String(value ?? ""); this.children = []; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const nodes = this.children.flatMap((child) => [child, ...child.descendants()]);
    return nodes.filter((node) => {
      if (selector.startsWith("#")) return node.id === selector.slice(1);
      const match = selector.match(/^\.([\w-]+)(?::not\(\.([\w-]+)\))?$/);
      const classes = node.className.split(/\s+/);
      return match && classes.includes(match[1]) && (!match[2] || !classes.includes(match[2]));
    });
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.className.split(/\s+/).includes(selector.slice(1))) return node;
    return null;
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async trigger(type) { for (const listener of this.listeners.get(type) ?? []) await listener({ target: this }); }
  click() { void this.trigger("click"); }
}
class SyntheticInput extends SyntheticElement { value = ""; checked = false; }
class SyntheticSelect extends SyntheticElement { value = "all"; }
class SyntheticButton extends SyntheticElement {}

function makeNode(tag, attributes, content = "") {
  const Constructor = tag === "input" ? SyntheticInput : tag === "select" ? SyntheticSelect : tag === "button" ? SyntheticButton : SyntheticElement;
  const node = new Constructor();
  node.id = attributes.match(/\bid="([^"]+)"/)?.[1] ?? "";
  node.className = attributes.match(/\bclass="([^"]+)"/)?.[1] ?? "";
  node.textContent = content.replace(/<[^>]+>/g, "").trim();
  for (const match of attributes.matchAll(/\bdata-([\w-]+)="([^"]+)"/g)) node.dataset[match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = match[2];
  if (tag === "select") for (const option of content.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const child = new SyntheticElement(); child.value = option[1]; child.textContent = option[2]; node.append(child);
  }
  return node;
}

function donationDom() {
  const root = new SyntheticElement();
  const markup = source.slice(0, source.indexOf("<script>"));
  // Keep DOM order: duplicate IDs therefore reproduce the browser's first-match behavior.
  for (const match of markup.matchAll(/<(input|select|span)\b([^>]*\bid="donate-stats-[^"]+"[^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/g)) root.append(makeNode(match[1], match[2], match[3]));
  return root;
}

function executableStatements(names = [], includeCleanup = false) {
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    || includeCleanup && ts.isExpressionStatement(node) && node.getText(ast).startsWith('adminElements(".clean-images",'));
  assert.equal(selected.length, names.length + Number(includeCleanup));
  return ts.transpileModule(selected.map((node) => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function harness(document, statements, globals = {}) {
  const context = vm.createContext({
    document, HTMLElement: SyntheticElement, HTMLInputElement: SyntheticInput,
    HTMLSelectElement: SyntheticSelect, HTMLButtonElement: SyntheticButton,
    exports: {}, Error, ...globals,
  });
  const helperJs = ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(helperJs, context);
  Object.assign(context, context.exports);
  vm.runInContext(statements, context);
  return context;
}

const donationRows = () => [
  { created_at: Date.now(), amount_total: 100, source: "jsapi", status: "paid", out_trade_no: "first" },
  { created_at: Date.now(), amount_total: 200, source: "native", status: "paid", out_trade_no: "second" },
  { created_at: Date.now(), amount_total: 300, source: "jsapi", status: "pending", out_trade_no: "third" },
];

test("donation statistics loading preserves filter options and applies selected status/source", async () => {
  const document = donationDom();
  const statusFilter = document.querySelector("#donate-stats-status");
  const sourceFilter = document.querySelector("#donate-stats-source");
  assert.ok(statusFilter instanceof SyntheticSelect);
  assert.ok(sourceFilter instanceof SyntheticSelect);
  const options = statusFilter.children.map((option) => option.value);
  statusFilter.value = "paid";
  sourceFilter.value = "jsapi";
  const renders = [];
  const summary = { paid_count: 2, paid_total_fen: 300, pending_count: 1, by_source: {} };
  const context = harness(document, executableStatements(["loadDonateStats", "donateStatsFiltered"]), {
    donateStatsRows: [], donateStatsPage: 9, donateOrderSummaryCache: null,
    api: async (endpoint) => { assert.equal(endpoint, "/donate-stats"); return { data: { summary, recent: donationRows() } }; },
    renderDonateStats: (data) => renders.push(data),
  });
  await context.loadDonateStats();
  assert.deepEqual(statusFilter.children.map((option) => option.value), options);
  assert.ok(options.length >= 3, "the original filters remain selectable after loading");
  assert.equal(statusFilter.value, "paid");
  assert.equal(document.querySelector("#donate-stats-message").textContent, "");
  assert.equal(context.donateStatsPage, 1);
  assert.deepEqual(renders, [summary]);
  assert.deepEqual(Array.from(context.donateStatsFiltered(), (row) => row.out_trade_no), ["first"]);
});

test("a donation statistics load failure remains visible without erasing filter options", async () => {
  const document = donationDom();
  const statusFilter = document.querySelector("#donate-stats-status");
  const options = statusFilter.children.map((option) => option.value);
  const context = harness(document, executableStatements(["loadDonateStats"]), {
    donateStatsRows: [], donateStatsPage: 1, donateOrderSummaryCache: null,
    api: async () => { throw new Error("statistics unavailable"); },
    renderDonateStats: () => assert.fail("a failed response cannot render successful statistics"),
  });
  await context.loadDonateStats();
  assert.equal(document.querySelector("#donate-stats-message").textContent, "statistics unavailable");
  assert.deepEqual(statusFilter.children.map((option) => option.value), options);
});

function cleanupDom() {
  const document = new SyntheticElement();
  const markup = source.slice(0, source.indexOf("<script>"));
  const match = Array.from(markup.matchAll(/<button\b([^>]*\bclass="[^"]*clean-images[^"]*"[^>]*)>([^<]*)<\/button>/g)).find((match) => match[1].includes('data-owner="reviews"'));
  assert.ok(match, "the review image cleanup control exists");
  const row = new SyntheticElement(); row.className = "filter-row";
  const button = makeNode("button", match[1], match[2]);
  const status = new SyntheticElement(); status.className = "muted";
  row.append(button, status); document.append(row);
  return { document, button, status };
}

test("image cleanup shows nested server counts and restores the action after success", async () => {
  const { document, button, status } = cleanupDom();
  const requests = [];
  const original = button.textContent;
  harness(document, executableStatements([], true), {
    confirm: () => true,
    alert: () => assert.fail("a successful cleanup must not alert an error"),
    api: async (endpoint, options) => {
      requests.push({ endpoint, body: JSON.parse(options.body) });
      assert.equal(button.disabled, true);
      return { ok: true, data: { scanned: 9, removed: 4, kept: 5 } };
    },
  });
  await button.trigger("click");
  assert.deepEqual(requests, [{ endpoint: "/content-images/cleanup", body: { owner: "reviews" } }]);
  assert.equal(status.textContent, "清理完成：扫描 9 张，删除 4 张，保留引用中 5 张");
  assert.equal(button.textContent, original);
  assert.equal(button.disabled, false);
});

test("image cleanup failure preserves the action and displays the failure", async () => {
  const { document, button, status } = cleanupDom();
  const alerts = [];
  const original = button.textContent;
  harness(document, executableStatements([], true), {
    confirm: () => true, alert: (message) => alerts.push(message),
    api: async () => { throw new Error("cleanup unavailable"); },
  });
  await button.trigger("click");
  assert.deepEqual(alerts, ["cleanup unavailable"]);
  assert.equal(status.textContent, "");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, original);
});

test("declining image cleanup does not send a request or disable the control", async () => {
  const { document, button } = cleanupDom();
  harness(document, executableStatements([], true), { confirm: () => false, api: () => assert.fail("a declined action must not write") });
  await button.trigger("click");
  assert.equal(button.disabled, false);
});

test("DOM helpers distinguish required nodes, optional nodes, and the expected element type", () => {
  const document = donationDom();
  const context = harness(document, "");
  const input = document.querySelector("#donate-stats-search");
  assert.equal(context.requireAdminElement("#donate-stats-search", SyntheticInput), input);
  assert.equal(context.findAdminElement("#missing", SyntheticInput), null);
  assert.equal(context.findAdminElement("#donate-stats-status", SyntheticInput), null);
  assert.throws(() => context.requireAdminElement("#missing", SyntheticInput), /管理页面缺少预期元素/);
  assert.throws(() => context.requireAdminElement("#donate-stats-status", SyntheticInput), /管理页面缺少预期元素/);
  assert.deepEqual(Array.from(context.adminElements("#donate-stats-status", SyntheticSelect)), [document.querySelector("#donate-stats-status")]);
});

test("initial navigation prefers allowed tabs and retains the all-locked and empty-list fallbacks", () => {
  for (const scenario of ["allowed", "all-locked", "empty"]) {
    const document = new SyntheticElement();
    const clicked = [];
    if (scenario !== "empty") {
      const locked = new SyntheticButton(); locked.className = "admin-nav-item admin-nav-item--locked";
      locked.addEventListener("click", () => clicked.push("locked")); document.append(locked);
      if (scenario === "allowed") {
        const allowed = new SyntheticButton(); allowed.className = "admin-nav-item";
        allowed.addEventListener("click", () => clicked.push("allowed")); document.append(allowed);
      }
    }
    const loginPanel = { hidden: false };
    const adminApp = { hidden: true };
    const context = harness(document, executableStatements(["showFirstAllowedTab"]), { loginPanel, adminApp });
    context.showFirstAllowedTab();
    assert.deepEqual(clicked, scenario === "empty" ? [] : [scenario === "allowed" ? "allowed" : "locked"]);
    if (scenario === "empty") { assert.equal(loginPanel.hidden, true); assert.equal(adminApp.hidden, false); }
  }
});
