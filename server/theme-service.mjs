import fs from "node:fs";
import path from "node:path";

// 站点配色：双档配置——active（当前生效）与 customDefault（管理员设为默认的方案）。
// GET /theme.css 输出"出厂默认 + active"合并后的完整变量集；
// 本机预览由前台内联脚本基于 localStorage 覆盖，不经服务器。

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const RGBA_RE = /^rgba\(\s*(2[0-4]\d|25[0-5]|1\d\d|[1-9]?\d)\s*,\s*(2[0-4]\d|25[0-5]|1\d\d|[1-9]?\d)\s*,\s*(2[0-4]\d|25[0-5]|1\d\d|[1-9]?\d)\s*,\s*(0|1|0?\.\d+)\s*\)$/;

export const THEME_VARIABLES = Object.freeze({
  light: Object.freeze({
    "--bg": "#f4f6fb",
    "--primary": "#4f2683",
    "--primary-dark": "#3d1e68",
    "--accent": "#b8912f",
    "--primary-soft-bg": "#f5f0fb",
    "--primary-soft-border": "#d9cbee",
    "--primary-border": "#bfa7e0",
    "--button-bg": "var(--primary)",
    "--top-link-bg": "rgba(255, 255, 255, 0.12)",
    "--top-link-bg-hover": "rgba(255, 255, 255, 0.12)",
    "--top-link-border-hover": "rgba(255, 255, 255, 0.35)",
    "--topbar-bg": "var(--primary)",
    "--sidebar-bg": "var(--surface)",
  }),
  dark: Object.freeze({
    "--bg": "#191d20",
    "--primary": "#8a63c9",
    "--primary-dark": "#a98ada",
    "--accent": "#d4b45a",
    "--primary-bright": "#b9a0e8",
    "--primary-strong-border": "#5b3a94",
    "--primary-tint-bg": "rgba(138, 99, 201, 0.18)",
    "--primary-deep-tint": "rgba(79, 38, 131, 0.32)",
    "--button-bg": "#4a2d78",
    "--top-link-bg": "#38235c",
    "--top-link-bg-hover": "#47296f",
    "--top-link-border-hover": "#7a57ab",
    "--topbar-bg": "#2a1a47",
    "--sidebar-bg": "#1e1a26",
  }),
});

export function isValidColorValue(value) {
  return typeof value === "string" && (HEX_RE.test(value.trim()) || RGBA_RE.test(value.trim()));
}

// 只保留白名单变量 + 合法色值 + 与出厂默认不同的条目。
export function normalizeThemeOverrides(input) {
  const result = { light: {}, dark: {} };
  const source = input && typeof input === "object" ? input : {};
  for (const mode of ["light", "dark"]) {
    const allowed = THEME_VARIABLES[mode];
    const incoming = source[mode] && typeof source[mode] === "object" ? source[mode] : {};
    for (const [variable, value] of Object.entries(incoming)) {
      if (!Object.hasOwn(allowed, variable)) continue;
      if (!isValidColorValue(value)) continue;
      const normalized = value.trim();
      if (normalized.toLowerCase() === allowed[variable].toLowerCase()) continue;
      result[mode][variable] = normalized;
    }
  }
  return result;
}

const MAX_THEME_PRESETS = 12;

// 保存的多套配色方案：[{id, name, light, dark}]，id 用于前端操作，名称去重。
export function normalizeThemePresets(input) {
  if (!Array.isArray(input)) return [];
  const presets = [];
  const names = new Set();
  for (const raw of input.slice(0, MAX_THEME_PRESETS)) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
    if (!id || !name || names.has(name)) continue;
    names.add(name);
    presets.push({ id, name, ...normalizeThemeOverrides(raw) });
  }
  return presets;
}

export function normalizeThemeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const active = normalizeThemeOverrides(source.active ?? { light: source.light, dark: source.dark });
  const customDefault = normalizeThemeOverrides(source.customDefault);
  const presets = normalizeThemePresets(source.presets);
  return { version: 2, active, customDefault, presets };
}

export function isDefaultTheme(settings) {
  const data = normalizeThemeSettings(settings);
  const empty = (modes) => Object.keys(modes.light).length === 0 && Object.keys(modes.dark).length === 0;
  return empty(data.active) && empty(data.customDefault);
}

// 输出完整变量集（出厂默认 + active 合并），保证覆盖顺序稳定。
export function generateThemeCss(settings) {
  const { active } = normalizeThemeSettings(settings);
  const blocks = [];
  // :root:root 提高特异性：无论 theme.css 与打包主样式表的先后顺序都能覆盖出厂值。
  for (const [mode, selector] of [["light", ":root:root"], ["dark", ':root:root[data-theme="dark"]']]) {
    const merged = { ...THEME_VARIABLES[mode], ...active[mode] };
    const body = Object.entries(merged).map(([k, v]) => `${k}:${v};`).join("\n");
    blocks.push(`${selector}{\n${body}\n}`);
  }
  return blocks.join("\n") + "\n";
}

export function readThemeSettings(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const normalized = normalizeThemeSettings(raw);
    return { ...normalized, updated: typeof raw.updated === "string" ? raw.updated : "" };
  } catch {
    return { version: 2, updated: "", active: { light: {}, dark: {} }, customDefault: { light: {}, dark: {} }, presets: [] };
  }
}

export function themeSettingsPath(dataDir) {
  return path.join(dataDir, "theme-settings.json");
}
