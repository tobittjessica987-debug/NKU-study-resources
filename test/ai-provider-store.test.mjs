import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, unlinkSync, rmdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AtomicJsonStore } from "../server/atomic-json-store.mjs";
import { AiProviderStore } from "../server/ai-provider-store.mjs";

function fixture(t, seedEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-provider-"));
  const filePath = path.join(dir, "ai-settings.json");
  t.after(() => {
    // Only the one file created by this fixture, then its empty directory.
    if (existsSync(filePath)) unlinkSync(filePath);
    rmdirSync(dir);
  });
  const store = new AtomicJsonStore({ allowedRoot: dir });
  const ai = new AiProviderStore({ store, filePath, seedEnv });
  return { dir, store, ai };
}

test("defaults come from env seed and never leak into masked reads", (t) => {
  const { ai } = fixture(t, { DASHSCOPE_API_KEY: "sk-test-1234", QWEN_MODEL: "qwen-max" });
  const masked = ai.masked();
  assert.equal(masked.has_api_key, true);
  assert.equal(masked.api_key_masked, "••••1234");
  assert.equal(masked.model, "qwen-max");
  assert.equal("api_key" in masked, false, "明文 Key 不得出现在掩码读取");
  assert.equal(ai.runtime().api_key, "sk-test-1234");
});

test("update persists settings and key, keeping previous key when omitted", async (t) => {
  const { ai, dir } = fixture(t);
  await ai.update({ settings: { model: "qwen-turbo", daily_limit_per_user: 5 }, apiKey: "sk-abc9999xyz" });
  let masked = ai.masked();
  assert.equal(masked.model, "qwen-turbo");
  assert.equal(masked.daily_limit_per_user, 5);
  assert.equal(masked.api_key_masked, "••••9xyz");
  await ai.update({ settings: { model: "qwen-plus" } });
  masked = ai.masked();
  assert.equal(masked.model, "qwen-plus");
  assert.equal(masked.has_api_key, true, "未提供新 Key 时保留旧 Key");
  const raw = JSON.parse(readFileSync(path.join(dir, "ai-settings.json"), "utf8"));
  assert.equal(raw.api_key, "sk-abc9999xyz");
  if (process.platform !== "win32") {
    const mode = statSync(path.join(dir, "ai-settings.json")).mode & 0o777;
    assert.equal(mode, 0o600, "配置文件必须 0600");
  }
});

test("invalid endpoints are rejected; explicit clearing persists even with an env seed", async (t) => {
  const { ai } = fixture(t, { DASHSCOPE_API_KEY: "fake-seed" });
  await assert.rejects(ai.update({ apiKey: "sk-x", settings: { base_url: "http://evil.example.com/v1" } }), /HTTPS/);
  await ai.update({ apiKey: "sk-x", settings: { max_tokens: 999999, daily_limit_per_user: -3 } });
  const runtime = ai.runtime();
  assert.equal(runtime.max_tokens, 8192);
  assert.equal(runtime.daily_limit_per_user, 1);
  assert.equal(runtime.base_url, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const masked = await ai.update({ clearApiKey: true });
  assert.equal(masked.has_api_key, false);
  assert.equal(ai.runtime().api_key, "");
});

test("disabled flag is honored by runtime projection", async (t) => {
  const { ai } = fixture(t, { DASHSCOPE_API_KEY: "sk-live" });
  await ai.update({ settings: { enabled: false } });
  const runtime = ai.runtime();
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.api_key, "sk-live");
});

test("wechat is accepted and invalid paths cannot rewrite its destination", async (t) => {
  const { ai } = fixture(t);
  await ai.update({ apiKey: "wx-key", settings: { base_url: "https://chatapi.weixin.qq.com/openai/v1", model: "GLM-5.2" } });
  assert.equal(ai.runtime().base_url, "https://chatapi.weixin.qq.com/openai/v1");
  assert.equal(ai.runtime().model, "GLM-5.2");
  await assert.rejects(ai.update({ settings: { base_url: "https://chatapi.weixin.qq.com/openai/v2" } }), /HTTPS/);
  assert.equal(ai.runtime().base_url, "https://chatapi.weixin.qq.com/openai/v1");
  assert.equal(ai.runtime().api_key, "wx-key");
});

test("changing provider cannot silently reuse the current credential", async (t) => {
  const { ai } = fixture(t);
  await ai.update({ apiKey: "fake-wechat", settings: { base_url: "https://chatapi.weixin.qq.com/openai/v1" } });
  await assert.rejects(ai.update({ settings: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" } }), /explicit API Key/);
  assert.equal(ai.runtime().base_url, "https://chatapi.weixin.qq.com/openai/v1");
  await ai.update({ apiKey: "fake-dashscope", settings: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" } });
  assert.equal(ai.runtime().api_key, "fake-dashscope");
});
