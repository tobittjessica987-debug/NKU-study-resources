// One endpoint boundary for stored settings, previews and outbound requests.
export const DEFAULT_AI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export function normalizeAiBaseUrl(value = DEFAULT_AI_BASE_URL) {
  if (typeof value !== "string" || !value.trim()) throw new Error("AI Base URL is required.");
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("AI Base URL is not a valid URL."); }
  const pathname = url.pathname.replace(/\/+$/, "");
  const aliyun = url.hostname === "aliyuncs.com" || url.hostname.endsWith(".aliyuncs.com");
  const wechat = url.hostname === "chatapi.weixin.qq.com" && pathname === "/openai/v1";
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !(aliyun || wechat)) {
    throw new Error("AI Base URL must be an HTTPS aliyuncs.com or chatapi.weixin.qq.com/openai/v1 endpoint without credentials, query, fragment or a non-default port.");
  }
  return `${url.origin}${pathname}`;
}

// A retained credential is bound to its canonical destination. Save and test
// both use this rule; changing a destination requires explicit key input.
export function resolveAiCredential(current, nextBaseUrl, { apiKey, clearApiKey = false } = {}) {
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") throw new Error("AI API Key must be text.");
  const supplied = typeof apiKey === "string" ? apiKey.trim() : "";
  if (/[\r\n]/.test(supplied)) throw new Error("AI API Key contains invalid characters.");
  if (clearApiKey) return "";
  if (supplied) return supplied;
  const previous = String(current.api_key || "");
  if (previous && normalizeAiBaseUrl(current.base_url) !== nextBaseUrl) {
    throw new Error("Changing the AI endpoint requires an explicit API Key or clearing the existing Key.");
  }
  return previous;
}

export function aiSettingsWriteRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("AI settings must be an object.");
  const keys = ["enabled", "base_url", "model", "max_tokens", "daily_limit_per_user", "minute_limit_per_user", "daily_limit_global"];
  const settings = Object.hasOwn(body, "settings") ? body.settings : Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("AI settings must be an object.");
  return { settings, apiKey: body.api_key, clearApiKey: body.clear_api_key === true };
}

// An old binary cannot enforce the new endpoint boundary. The supported
// rollback starts with AI explicitly disabled in the existing settings file.
// Do not accept an absent file (old versions would revive environment seeds).
export function assertAiRollbackDisabled(raw) {
  if (!raw || raw.version !== 1 || !raw.settings || raw.settings.enabled !== false) {
    throw new Error("Rollback blocked: persist enabled:false in the AI settings before switching to an older release.");
  }
  return { safeToStartOldReleaseWithAiDisabled: true, aiMustRemainDisabled: true };
}
