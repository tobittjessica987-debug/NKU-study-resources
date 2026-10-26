import assert from "node:assert/strict";
import test from "node:test";
import { createQwenProviderFromSettings, createQwenProviderFromEnv, validateQwenEndpoint } from "../server/qwen-provider.mjs";

function withFetchStub(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

test("settings provider maps snake_case runtime config to client fields (regression: Bearer undefined 401)", async () => {
  const runtime = {
    enabled: true,
    api_key: "sk-runtime-key",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-plus",
    max_tokens: 3000,
  };
  const seen = [];
  await withFetchStub(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  }, async () => {
    const provider = createQwenProviderFromSettings(() => runtime);
    const output = await provider([{ role: "user", content: "hi" }], { timeoutMs: 1000 });
    assert.equal(output, "ok");
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer sk-runtime-key", "运行时 api_key 必须正确映射为 Bearer");
  assert.equal(seen[0].body.model, "qwen3.7-plus");
  assert.equal(seen[0].body.max_tokens, 3000);
  assert.equal(seen[0].body.stream, false);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["max_tokens", "messages", "model", "stream"], "不使用 response_format/JSON mode/额外参数");
});

test("settings provider returns null when disabled or key missing", async () => {
  const disabled = createQwenProviderFromSettings(() => ({ enabled: false, api_key: "sk", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", max_tokens: 100 }));
  assert.equal(await disabled([{ role: "user", content: "x" }]), null);
  const noKey = createQwenProviderFromSettings(() => ({ enabled: true, api_key: "", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "m", max_tokens: 100 }));
  assert.equal(await noKey([{ role: "user", content: "x" }]), null);
});

test("provider errors carry http status and non-sensitive provider code", async () => {
  await withFetchStub(async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { code: "invalid_api_key", message: "sensitive detail" } }),
  }), async () => {
    const provider = createQwenProviderFromEnv({ DASHSCOPE_API_KEY: "sk-bad" });
    await assert.rejects(
      () => provider([{ role: "user", content: "hi" }]),
      (error) => error.status === 401 && error.providerCode === "invalid_api_key" && /qwen http 401/.test(error.message),
    );
  });
});

test("wechat chatapi openai-compatible endpoint is allowed; other hosts stay rejected", async () => {
  assert.equal(
    validateQwenEndpoint("https://chatapi.weixin.qq.com/openai/v1/"),
    "https://chatapi.weixin.qq.com/openai/v1/chat/completions",
  );
  // 微信入口只开放精确路径；任意路径/子域/协议仍拒绝，防止密钥发往其他主机。
  for (const bad of [
    "https://chatapi.weixin.qq.com/openai/v2",
    "https://chatapi.weixin.qq.com/other",
    "https://evil.weixin.qq.com/openai/v1",
    "http://chatapi.weixin.qq.com/openai/v1",
    "https://chatapi.example.com/openai/v1",
  ]) {
    assert.throws(() => validateQwenEndpoint(bad), /must be an HTTPS/, bad);
  }
  const seen = [];
  await withFetchStub(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok", reasoning_content: "思考过程" } }] }) };
  }, async () => {
    const provider = createQwenProviderFromSettings(() => ({
      enabled: true,
      api_key: "wechat-key",
      base_url: "https://chatapi.weixin.qq.com/openai/v1",
      model: "GLM-5.2",
      max_tokens: 4096,
    }));
    assert.equal(await provider([{ role: "user", content: "hi" }], { timeoutMs: 1000 }), "ok");
  });
  assert.equal(seen[0].url, "https://chatapi.weixin.qq.com/openai/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer wechat-key");
});

test("WeChat GLM-5.2 disables template thinking through settings and environment entrypoints", async () => {
  const messages = [{ role: "user", content: "成绩复核什么时候申请？" }];
  const seen = [];
  await withFetchStub(async (url, init) => {
    seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "答复" } }] }) };
  }, async () => {
    // Canonical URL aliases and trimmed model values use the same wire request.
    const baseUrl = " https://CHATAPI.WEIXIN.QQ.COM:443/openai/v1/ ";
    const runtimeProvider = createQwenProviderFromSettings(() => ({
      enabled: true, api_key: "fake-wechat-key", base_url: baseUrl,
      model: " GLM-5.2 ", max_tokens: 4096,
    }));
    const envProvider = createQwenProviderFromEnv({
      QWEN_API_KEY: "fake-wechat-key", QWEN_BASE_URL: baseUrl,
      QWEN_MODEL: " GLM-5.2 ", QWEN_MAX_TOKENS: "4096",
    });
    for (const provider of [runtimeProvider, envProvider]) {
      assert.equal(await provider(messages, { timeoutMs: 1000 }), "答复");
    }
  });
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.url, "https://chatapi.weixin.qq.com/openai/v1/chat/completions");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers.authorization, "Bearer fake-wechat-key");
    assert.deepEqual(call.body, {
      model: "GLM-5.2", messages, max_tokens: 4096, stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  }
});

test("the template override never leaks into other models, endpoints or defaults", async () => {
  const messages = [{ role: "user", content: "hi" }];
  const runtime = { enabled: true, api_key: "fake-key", max_tokens: 1200 };
  const cases = [
    { base_url: "https://chatapi.weixin.qq.com/openai/v1", model: "GLM-5.2", override: true },
    { base_url: "https://chatapi.weixin.qq.com/openai/v1", model: "GLM-5.1" },
    { base_url: "https://chatapi.weixin.qq.com/openai/v1", model: "DeepSeek-V4-Flash" },
    { base_url: "https://chatapi.weixin.qq.com/openai/v1", model: "GLM-5.2-preview" },
    { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "GLM-5.2" },
    { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  ];
  const seen = [];
  await withFetchStub(async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  }, async () => {
    const provider = createQwenProviderFromSettings(() => runtime);
    for (const item of cases) {
      runtime.base_url = item.base_url;
      runtime.model = item.model;
      await provider(messages);
    }
    await createQwenProviderFromEnv({ DASHSCOPE_API_KEY: "fake-key" })(messages);
  });
  for (let index = 0; index < cases.length; index += 1) {
    assert.deepEqual(seen[index], {
      model: cases[index].model, messages, max_tokens: 1200, stream: false,
      ...(cases[index].override ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    });
  }
  assert.deepEqual(seen.at(-1), { model: "qwen-plus", messages, max_tokens: 1200, stream: false });
});
