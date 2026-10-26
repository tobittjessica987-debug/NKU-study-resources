import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  THEME_VARIABLES,
  normalizeThemePresets,
  generateThemeCss,
  isValidColorValue,
  isDefaultTheme,
  normalizeThemeOverrides,
  normalizeThemeSettings,
  readThemeSettings,
  themeSettingsPath,
} from "../server/theme-service.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-theme-"));

test("isValidColorValue accepts only strict hex/rgba forms", () => {
  assert.equal(isValidColorValue("#4f2683"), true);
  assert.equal(isValidColorValue("#FFFFFF"), true);
  assert.equal(isValidColorValue("rgba(138, 99, 201, 0.18)"), true);
  assert.equal(isValidColorValue("rgba(255,255,255,1)"), true);
  assert.equal(isValidColorValue("red"), false);
  assert.equal(isValidColorValue("#12345"), false);
  assert.equal(isValidColorValue("#1234567"), false);
  assert.equal(isValidColorValue("javascript:alert(1)"), false);
  assert.equal(isValidColorValue("rgba(300, 0, 0, 0.5)"), false);
  assert.equal(isValidColorValue("}; body{display:none"), false);
  assert.equal(isValidColorValue(null), false);
});

test("normalizeThemeOverrides drops unknown vars, invalid values and factory-equal entries", () => {
  const normalized = normalizeThemeOverrides({
    light: {
      "--primary": "#123456",
      "--primary-dark": THEME_VARIABLES.light["--primary-dark"],
      "--evil": "#000000",
      "--accent": "not-a-color",
    },
    dark: { "--topbar-bg": "#112233" },
  });
  assert.deepEqual(Object.keys(normalized.light), ["--primary"]);
  assert.equal(normalized.light["--primary"], "#123456");
  assert.deepEqual(normalized.dark, { "--topbar-bg": "#112233" });
});

test("normalizeThemeSettings supports active/customDefault and legacy top-level light/dark", () => {
  const modern = normalizeThemeSettings({
    active: { light: { "--primary": "#aabbcc" } },
    customDefault: { dark: { "--sidebar-bg": "#101010" } },
  });
  assert.equal(modern.active.light["--primary"], "#aabbcc");
  assert.equal(modern.customDefault.dark["--sidebar-bg"], "#101010");

  const legacy = normalizeThemeSettings({ light: { "--primary": "#aabbcc" }, dark: {} });
  assert.equal(legacy.active.light["--primary"], "#aabbcc");
  assert.deepEqual(legacy.customDefault, { light: {}, dark: {} });

  assert.equal(isDefaultTheme({ active: {}, customDefault: {} }), true);
  assert.equal(isDefaultTheme({ active: { light: { "--primary": THEME_VARIABLES.light["--primary"] } }, customDefault: {} }), true);
  assert.equal(isDefaultTheme({ active: {}, customDefault: { light: { "--primary": "#000000" } } }), false);
});

test("generateThemeCss emits full variable sets merged over factory defaults", () => {
  const css = generateThemeCss({
    active: { light: { "--primary": "#aabbcc" }, dark: { "--sidebar-bg": "rgba(1, 2, 3, 0.4)" } },
  });
  assert.ok(css.includes(":root:root{"));
  assert.ok(css.includes(':root:root[data-theme="dark"]{'));
  assert.ok(css.includes("--primary:#aabbcc;"));
  assert.ok(css.includes("--sidebar-bg:rgba(1, 2, 3, 0.4);"));
  // 完整集：未覆盖变量也输出出厂值
  assert.ok(css.includes(`--accent:${THEME_VARIABLES.light["--accent"]};`));
  assert.ok(css.includes(`--topbar-bg:${THEME_VARIABLES.dark["--topbar-bg"]};`));
  assert.ok(!css.includes("--evil"));
  // 非法值被丢弃后回退出厂
  const safe = generateThemeCss({ active: { light: { "--primary": "expression(alert(1))" } } });
  assert.ok(safe.includes(`--primary:${THEME_VARIABLES.light["--primary"]};`));
});

test("save-implies-default semantics are enforced by the caller, normalizeThemeSettings keeps slots independent", () => {
  // 后端在显式保存 active 且未显式传 customDefault 时用 active 作为 customDefault；
  // 这里验证 normalize 本身不会越权合并两档。
  const data = normalizeThemeSettings({
    active: { light: { "--primary": "#111111" } },
    customDefault: { light: { "--primary": "#222222" } },
  });
  assert.equal(data.active.light["--primary"], "#111111");
  assert.equal(data.customDefault.light["--primary"], "#222222");
});

test("normalizeThemePresets validates ids, names and dedupes", () => {
  const presets = normalizeThemePresets([
    { id: "p1", name: "方案一", light: { "--primary": "#123456" }, dark: {} },
    { id: "bad id!", name: "x", light: {}, dark: {} },
    { id: "p3", name: "", light: {}, dark: {} },
    { id: "p4", name: "方案一", light: {}, dark: {} },
    "garbage",
    { id: "p5", name: "ok", light: { "--evil": "#000000" }, dark: {} },
  ]);
  assert.deepEqual(presets.map(item => item.id), ["p1", "p5"]);
  assert.deepEqual(presets[1].light, {});
});

test("readThemeSettings returns defaults for missing/corrupt file and reads both slots", () => {
  const missing = path.join(tempDir, "missing.json");
  assert.deepEqual(readThemeSettings(missing), { version: 2, updated: "", active: { light: {}, dark: {} }, customDefault: { light: {}, dark: {} }, presets: [] });
  const corrupt = path.join(tempDir, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json", "utf8");
  assert.deepEqual(readThemeSettings(corrupt).active, { light: {}, dark: {} });
  const saved = path.join(tempDir, "saved.json");
  fs.writeFileSync(saved, JSON.stringify({ updated: "2026-10-12", active: { light: { "--primary": "#010203" } }, customDefault: { dark: { "--button-bg": "#040506" } }, presets: [{ id: "p1", name: "S1", light: {}, dark: {} }] }), "utf8");
  const loaded = readThemeSettings(saved);
  assert.equal(loaded.updated, "2026-10-12");
  assert.equal(loaded.active.light["--primary"], "#010203");
  assert.equal(loaded.customDefault.dark["--button-bg"], "#040506");
  assert.equal(loaded.presets.length, 1);
  assert.equal(loaded.presets[0].name, "S1");
});

test("themeSettingsPath lives inside dataDir", () => {
  assert.equal(themeSettingsPath("/srv/data"), path.join("/srv/data", "theme-settings.json"));
});
