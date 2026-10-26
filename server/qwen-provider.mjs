/**
 * OpenAI 兼容 provider：默认千问（DashScope 兼容模式），另支持微信 AI 开放接口
 * （chatapi.weixin.qq.com/openai/v1，OpenAI 兼容协议，模型如 GLM-5.2）。
 * 配置来源（按优先级）：管理页落盘的 ai-provider-store 运行时配置 →
 * 环境变量 DASHSCOPE_API_KEY / QWEN_API_KEY（初始种子）。
 * Base URL 必须命中允许清单（阿里云或微信 chatapi 的 HTTPS 地址），防止把密钥发往任意主机。
 */
import { DEFAULT_AI_BASE_URL, normalizeAiBaseUrl } from "./ai-provider-config.mjs";
const DEFAULT_BASE_URL = DEFAULT_AI_BASE_URL;
const DEFAULT_MODEL = "qwen-plus";
const DEFAULT_MAX_TOKENS = 1200;

export function validateQwenEndpoint(baseUrl) {
  return `${normalizeAiBaseUrl(baseUrl)}/chat/completions`;
}

function createQwenClient({ apiKey, baseUrl, model, maxTokens }) {
  const endpoint = validateQwenEndpoint(baseUrl);
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error("AI API Key is invalid.");
  const normalizedModel = String(model || DEFAULT_MODEL).trim();
  const normalizedMaxTokens = Number(maxTokens) || DEFAULT_MAX_TOKENS;
  // This gateway serves GLM-5.2 through a chat template; the native BigModel
  // `thinking` field is ignored. Disable template reasoning for bounded RAG
  // responses only on the verified endpoint/model pair, preserving all others.
  const disableTemplateThinking = endpoint === "https://chatapi.weixin.qq.com/openai/v1/chat/completions"
    && normalizedModel === "GLM-5.2";
  return async function qwenClient(messages, { timeoutMs = 20_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: normalizedModel,
          messages,
          max_tokens: normalizedMaxTokens,
          stream: false,
          ...(disableTemplateThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 读取并记录非敏感错误码（如 invalid_api_key / invalid_model），完整 body 不落日志
        let providerCode = "";
        try {
          const body = await response.text();
          providerCode = String(JSON.parse(body)?.error?.code || "").slice(0, 60);
        } catch {}
        const error = new Error(`qwen http ${response.status}`);
        error.status = response.status;
        error.providerCode = providerCode;
        throw error;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : "")).join("\n") : "";
      if (!text.trim()) throw new Error("qwen returned empty content");
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createQwenProviderFromEnv(env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || "").trim();
  if (!apiKey) return null;
  return createQwenClient({
    apiKey,
    baseUrl: String(env.QWEN_BASE_URL || DEFAULT_BASE_URL),
    model: String(env.QWEN_MODEL || DEFAULT_MODEL),
    maxTokens: Number(env.QWEN_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
  });
}

/**
 * 每次调用前动态读取运行时配置的 provider：未配置 Key 或停用时返回 null。
 * readRuntime 必须返回 { enabled, api_key, base_url, model, max_tokens }。
 */
export function createQwenProviderFromSettings(readRuntime) {
  return async function qwen(messages, options = {}) {
    const runtime = readRuntime();
    if (!runtime || !runtime.enabled || !String(runtime.api_key || "").trim()) return null;
    // 运行时配置是 snake_case（api_key/base_url/max_tokens），必须显式映射，
    // 不能整对象透传——曾因字段名不匹配把密钥发成 undefined 导致全线 401。
    return createQwenClient({
      apiKey: runtime.api_key,
      baseUrl: runtime.base_url,
      model: runtime.model,
      maxTokens: runtime.max_tokens,
    })(messages, options);
  };
}
