import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  CURRENT_PRIVACY_RULES_CONTENT,
  DEFAULT_PRIVACY_CONTENT,
  LEGACY_DEFAULT_PRIVACY_CONTENT,
  effectivePrivacyDocument,
} from "../server/default-privacy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const require = createRequire(import.meta.url);

test("the complete historical default is preserved for exact saved-policy identification", () => {
  assert.equal(
    createHash("sha256").update(LEGACY_DEFAULT_PRIVACY_CONTENT.content).digest("hex"),
    "ce3cfd2f23ff670b2f9601345542ec78b87b2c462a0575259c6c124ca7da23bb",
  );
  const saved = { title: "已保存的标题", content: `\n${LEGACY_DEFAULT_PRIVACY_CONTENT.content}\n` };
  const effective = effectivePrivacyDocument(saved);
  assert.deepEqual(effective, {
    document: { title: saved.title, content: DEFAULT_PRIVACY_CONTENT.content },
    upgradedLegacyDefault: true,
    customNeedsReview: false,
  });
  assert.equal(saved.content, `\n${LEGACY_DEFAULT_PRIVACY_CONTENT.content}\n`);
});

test("missing or current default uses the current document without flagging custom review", () => {
  for (const saved of [null, undefined, [], {}, { title: " ", content: "\n " }, DEFAULT_PRIVACY_CONTENT]) {
    assert.deepEqual(effectivePrivacyDocument(saved), {
      document: DEFAULT_PRIVACY_CONTENT,
      upgradedLegacyDefault: false,
      customNeedsReview: false,
    });
  }
});

test("unknown custom policy is preserved and requires operator review", () => {
  const custom = { title: "运营方补充", content: `  ${LEGACY_DEFAULT_PRIVACY_CONTENT.content}\n\n额外自定义条款  ` };
  const snapshot = structuredClone(custom);
  assert.deepEqual(effectivePrivacyDocument(custom), {
    document: custom,
    upgradedLegacyDefault: false,
    customNeedsReview: true,
  });
  assert.deepEqual(custom, snapshot);
  assert.equal(effectivePrivacyDocument({ content: "自定义条款" }).document.title, DEFAULT_PRIVACY_CONTENT.title);
});

async function buildPrivacyPage(saved) {
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-s5-privacy-")));
  try {
    const source = path.join(project, "src");
    const dataDir = path.join(project, "synthetic-data");
    await fs.mkdir(path.join(source, "pages"), { recursive: true });
    await fs.mkdir(dataDir);
    // Only the actual privacy route and its reviewed dependencies are copied;
    // all runtime inputs and build output belong to this isolated root.
    await fs.copyFile(path.join(root, "src/pages/privacy.astro"), path.join(source, "pages/privacy.astro"));
    for (const name of ["layouts", "styles", "lib"]) {
      await fs.cp(path.join(root, "src", name), path.join(source, name), { recursive: true });
    }
    await fs.mkdir(path.join(project, "server"));
    for (const name of ["default-privacy.mjs", "runtime-config.mjs"]) {
      await fs.copyFile(path.join(root, "server", name), path.join(project, "server", name));
    }
    await fs.symlink(path.join(root, "node_modules"), path.join(project, "node_modules"), "junction");
    await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", private: true }));
    await fs.writeFile(path.join(dataDir, "footer.json"), JSON.stringify({ enabled: false }));
    await fs.writeFile(path.join(dataDir, "privacy.json"), JSON.stringify(saved));
    await fs.writeFile(path.join(project, "astro.config.mjs"), [
      'import { defineConfig } from "astro/config";',
      'export default defineConfig({ site: "https://privacy.synthetic.invalid", cacheDir: "./.astro-cache", vite: { cacheDir: "./.vite-cache" } });',
    ].join("\n"));
    const packagePath = require.resolve("astro/package.json");
    const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin.astro;
    try {
      await execute(process.execPath, [path.resolve(path.dirname(packagePath), bin), "build", "--root", project], {
        cwd: project,
        env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test", ASTRO_TELEMETRY_DISABLED: "1" },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Isolated privacy build failed: ${error.stderr || error.stdout || error.message}`, { cause: error });
    }
    return await fs.readFile(path.join(project, "dist/privacy/index.html"), "utf8");
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
}

function assertCurrentRules(html) {
  assert.match(html, /data-current-privacy-rules/);
  assert.match(html, /私密投诉举报允许匿名提交，始终不公开/);
  assert.match(html, /允许自动公开的评价按规则公开/);
  assert.match(html, /评价、反馈和私密投诉保留原文、评分、处理回复及原有状态/);
  assert.match(html, /匿名提交和账号注销后均无法通过原账号查看回复/);
  assert.match(html, /正文、标题或回复中由用户主动写入的个人信息不会被自动识别并移除/);
  assert.match(html, /其中仍可能保留内部账号编号/);
  assert.match(html, /400天是现有配置，不是所有数据的统一法定期限/);
  assert.match(html, /历史加密备份不逐份改写/);
  assert.match(html, /不承诺缓存立即消失/);
  assert.ok(html.indexOf("data-current-privacy-rules") < html.indexOf("data-saved-privacy-content"));
  assert.ok(DEFAULT_PRIVACY_CONTENT.content.includes(CURRENT_PRIVACY_RULES_CONTENT));
}

test("final Astro HTML upgrades a saved legacy default and publishes only the current rules", { timeout: 90_000 }, async () => {
  const html = await buildPrivacyPage(LEGACY_DEFAULT_PRIVACY_CONTENT);
  assertCurrentRules(html);
  assert.doesNotMatch(html, /昵称会随你的评价公开展示/);
  assert.doesNotMatch(html, /所有公开内容先经审核后展示/);
  assert.doesNotMatch(html, /日志依法保留满 6 个月/);
  assert.doesNotMatch(html, /data-custom-privacy-review/);
  assert.equal((html.match(/现行账号与内容规则/g) || []).length, 1);
});

test("final Astro HTML keeps unknown custom text behind mandatory current rules and a review notice", { timeout: 90_000 }, async () => {
  const saved = {
    title: "合成自定义政策",
    content: "# 旧自定义补充\n\n合成旧说法：所有公开内容先经审核后展示。\n\n<script>throw new Error('must not execute')</script>",
  };
  const html = await buildPrivacyPage(saved);
  assertCurrentRules(html);
  assert.match(html, /合成自定义政策/);
  assert.match(html, /data-custom-privacy-review/);
  assert.match(html, /合成旧说法：所有公开内容先经审核后展示/);
  assert.match(html, /账号注销与内容处理以上方现行规则为准/);
  assert.ok(html.indexOf("以本节为准") < html.indexOf("旧自定义补充"));
  assert.ok(html.indexOf("data-custom-privacy-review") < html.indexOf("旧自定义补充"));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>throw new Error/);
});
