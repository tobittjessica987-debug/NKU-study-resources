import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  detectImageSignature,
  readSiteIconFile,
  removeSiteIconAssets,
  writeSiteIconAssets,
  SITE_ICON_FILES,
} from "../server/site-icon-service.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-site-icon-"));
const dataDir = path.join(tempRoot, "data");
const publicDir = path.join(tempRoot, "public");
fs.mkdirSync(path.join(publicDir, "site-icon"), { recursive: true });

test("detectImageSignature recognizes PNG and JPEG bytes", () => {
  assert.equal(detectImageSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(detectImageSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(detectImageSignature(Buffer.from([0x47, 0x49, 0x46, 0x38])), null);
  assert.equal(detectImageSignature(Buffer.alloc(0)), null);
});

test("readSiteIconFile rejects unknown names and falls back to published default", () => {
  assert.equal(readSiteIconFile({ dataDir, publicDir, name: "../secret" }), null);
  assert.equal(readSiteIconFile({ dataDir, publicDir, name: "icon.svg" }), null);
  const defaultBytes = Buffer.from("default-icon");
  fs.writeFileSync(path.join(publicDir, "site-icon", "icon-512.png"), defaultBytes);
  const hit = readSiteIconFile({ dataDir, publicDir, name: "icon-512.png" });
  assert.equal(hit?.source, "default");
  assert.ok(defaultBytes.equals(hit?.bytes ?? Buffer.alloc(0)));
});

test("writeSiteIconAssets generates sizes and overrides fallback; remove restores default", async () => {
  const sourcePng = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 79, g: 38, b: 131, alpha: 1 } },
  }).png().toBuffer();

  await assert.rejects(
    writeSiteIconAssets({ bytes: Buffer.from("not-an-image"), dataDir, sharpImpl: sharp }),
    (error) => error.code === "SITE_ICON_INVALID_TYPE",
  );

  const result = await writeSiteIconAssets({ bytes: sourcePng, dataDir, sharpImpl: sharp });
  assert.deepEqual([...result.written].sort(), [...SITE_ICON_FILES].sort());
  if (process.platform !== "win32") {
    const stat = fs.statSync(path.join(dataDir, "site-assets"));
    assert.equal(stat.mode & 0o077, 0);
  }

  const hit = readSiteIconFile({ dataDir, publicDir, name: "favicon-32.png" });
  assert.equal(hit?.source, "custom");
  const meta = await sharp(hit.bytes).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 32);

  const removed = removeSiteIconAssets(dataDir);
  assert.equal(removed.length, SITE_ICON_FILES.length);
  const fallback = readSiteIconFile({ dataDir, publicDir, name: "favicon-32.png" });
  assert.equal(fallback, null);
});
