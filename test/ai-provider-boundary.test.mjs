import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AiProviderStore } from "../server/ai-provider-store.mjs";
import { normalizeAiBaseUrl, aiSettingsWriteRequest, assertAiRollbackDisabled } from "../server/ai-provider-config.mjs";
import { createQwenProviderFromSettings, validateQwenEndpoint } from "../server/qwen-provider.mjs";

const WX = "https://chatapi.weixin.qq.com/openai/v1";
const DASH = "https://dashscope.aliyuncs.com/compatible-mode/v1";
function memory(initial, seedEnv = {}) {
  let value = initial;
  let failure;
  const store = {
    readSync() { if (failure) throw failure; if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return structuredClone(value); },
    async update(_file, updater, options) { value = await updater(structuredClone(value ?? options.initialize)); return value; },
  };
  return { ai: new AiProviderStore({ store, filePath: "memory-only", seedEnv }), raw: () => structuredClone(value), fail(error) { failure = error; } };
}
const saved = (base = WX, key = "TEST_WECHAT") => ({ version: 1, settings: { base_url: base, model: "GLM-5.2", enabled: true }, api_key: key });

test("canonical equivalent endpoints preserve destination; disallowed components never fall back", () => {
  for (const alias of [WX, `${WX}/`, "https://CHATAPI.WEIXIN.QQ.COM:443/openai/v1", ` ${WX} `]) {
    assert.equal(normalizeAiBaseUrl(alias), WX);
    assert.equal(memory(saved(alias)).ai.runtime().base_url, WX);
  }
  for (const url of ["http://chatapi.weixin.qq.com/openai/v1", `${WX}?key=x`, `${WX}#x`, `${WX}/other`, "https://chatapi.weixin.qq.com:444/openai/v1", "https://user@chatapi.weixin.qq.com/openai/v1", `${DASH}?x=y`, `${DASH}#x`, "https://dashscope.aliyuncs.com:444/compatible-mode/v1", "https://aliyuncs.com.evil.example/v1"]) {
    assert.throws(() => validateQwenEndpoint(url));
    const runtime = memory(saved(url)).ai.runtime();
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.api_key, "");
  }
});

test("saved empty or missing keys cannot revive a seed from a different provider", async () => {
  const state = memory(saved(WX, ""), { DASHSCOPE_API_KEY: "TEST_DASH" });
  assert.equal(state.ai.runtime().api_key, "");
  const missing = saved(); delete missing.api_key;
  assert.equal(memory(missing, { DASHSCOPE_API_KEY: "TEST_DASH" }).ai.runtime().api_key, "");
  await state.ai.update({ apiKey: "TEST_WECHAT" });
  await state.ai.update({ clearApiKey: true });
  assert.equal(state.ai.runtime().api_key, "");
  assert.equal(state.ai.masked().has_api_key, false);
});

test("only an absent file permits seed initialization, not corrupted or unreadable data", () => {
  assert.equal(memory(undefined, { DASHSCOPE_API_KEY: "TEST_SEED" }).ai.runtime().api_key, "TEST_SEED");
  for (const value of [null, [], {}, { version: 1, api_key: "TEST_UNKNOWN" }, { ...saved(), version: 2 }]) {
    const runtime = memory(value, { DASHSCOPE_API_KEY: "TEST_SEED" }).ai.runtime();
    assert.equal(runtime.enabled, false); assert.equal(runtime.api_key, "");
  }
  const broken = memory(saved(), { DASHSCOPE_API_KEY: "TEST_SEED" });
  for (const error of [new SyntaxError("bad JSON"), Object.assign(new Error("denied"), { code: "EACCES" })]) {
    broken.fail(error); assert.equal(broken.ai.runtime().api_key, ""); assert.equal(broken.ai.runtime().enabled, false);
  }
});

test("save and preview both reject changing endpoint with a retained credential", async () => {
  const state = memory(saved());
  const update = aiSettingsWriteRequest({ settings: { base_url: DASH } });
  assert.throws(() => state.ai.preview(update), /explicit API Key/);
  await assert.rejects(state.ai.update(update), /explicit API Key/);
  assert.equal(state.raw().settings.base_url, WX);
  const explicit = aiSettingsWriteRequest({ settings: { base_url: DASH, model: "qwen-plus" }, api_key: "TEST_DASH" });
  const preview = state.ai.preview(explicit);
  assert.equal(preview.base_url, DASH); assert.equal(preview.api_key, "TEST_DASH");
  assert.equal(state.raw().api_key, "TEST_WECHAT", "preview must not persist");
  await state.ai.update(explicit);
  assert.equal(state.ai.runtime().api_key, "TEST_DASH");
  await state.ai.update({ settings: { base_url: WX, enabled: false }, clearApiKey: true });
  assert.equal(state.ai.runtime().api_key, "");
});

test("same-destination model or limits changes preserve an existing key", async () => {
  const state = memory(saved());
  await state.ai.update({ settings: { base_url: `${WX}/`, model: "GLM-5.2", daily_limit_per_user: 30 } });
  assert.equal(state.ai.runtime().api_key, "TEST_WECHAT");
  assert.equal(state.ai.runtime().daily_limit_per_user, 30);
});

test("first unsaved connection preview evaluates the supplied full configuration", () => {
  const state = memory(undefined);
  const runtime = state.ai.preview(aiSettingsWriteRequest({ settings: { enabled: true, base_url: WX, model: "GLM-5.2", max_tokens: 4096 }, api_key: "TEST_WECHAT" }));
  assert.equal(runtime.base_url, WX); assert.equal(runtime.api_key, "TEST_WECHAT"); assert.equal(runtime.max_tokens, 4096);
  assert.equal(state.raw(), undefined);
  assert.equal(state.ai.preview(aiSettingsWriteRequest({ base_url: WX, api_key: "TEST_WECHAT" })).base_url, WX, "legacy flat request remains supported");
});

test("UI collects the edited destination with the new key for save and test", () => {
  const source = readFileSync(new URL("../src/pages/admin.astro", import.meta.url), "utf8");
  const start = source.indexOf("function collectAiSettingsWrite()");
  const end = source.indexOf("async function saveAiAdmin()", start);
  assert.ok(start >= 0 && end > start);
  const values = { "#ai-enabled": "true", "#ai-api-key": "TEST_WECHAT", "#ai-base-url": WX, "#ai-model": "GLM-5.2", "#ai-max-tokens": "4096", "#ai-daily-user": "30", "#ai-minute-user": "3", "#ai-daily-global": "2000" };
  const js = ts.transpile(source.slice(start, end));
  const body = new Function("requireAdminElement", "HTMLInputElement", "HTMLSelectElement", "aiAdminState", `${js}; return collectAiSettingsWrite();`)((selector) => ({ value: values[selector] }), class {}, class {}, { clearKey: false });
  const state = memory(saved(DASH, "TEST_OLD_DASH"));
  const preview = state.ai.preview(aiSettingsWriteRequest(body));
  assert.equal(preview.base_url, WX); assert.equal(preview.api_key, "TEST_WECHAT");
  assert.equal(state.raw().api_key, "TEST_OLD_DASH");
});

test("provider rejects redirects and sends only the resolved credential to its destination", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "fixture answer" } }] }) };
  });
  const state = memory(saved());
  const provider = createQwenProviderFromSettings(() => state.ai.runtime());
  assert.equal(await provider([{ role: "user", content: "fixture" }]), "fixture answer");
  assert.equal(seen[0].url, `${WX}/chat/completions`);
  assert.equal(seen[0].init.headers.authorization, "Bearer TEST_WECHAT");
  assert.equal(seen[0].init.redirect, "error");
  const invalid = createQwenProviderFromSettings(() => memory(saved("https://evil.example/v1")).ai.runtime());
  assert.equal(await invalid([]), null); assert.equal(seen.length, 1);
});

test("old-release rollback preflight refuses active, missing and ambiguous configuration", () => {
  for (const raw of [undefined, null, {}, saved(), { version: 1, settings: { enabled: "false" } }]) assert.throws(() => assertAiRollbackDisabled(raw), /Rollback blocked/);
  const disabled = saved(); disabled.settings.enabled = false;
  assert.equal(assertAiRollbackDisabled(disabled).aiMustRemainDisabled, true);
});
