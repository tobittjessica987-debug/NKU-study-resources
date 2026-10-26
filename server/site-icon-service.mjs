import fs from "node:fs";
import path from "node:path";

// 站点图标（侧栏 Logo / 浏览器标签 favicon）：后台可上传覆盖，未设置时回退
// 到静态发布树 public/site-icon/ 中的构建默认图。

export const SITE_ICON_FILES = Object.freeze(["favicon-32.png", "apple-touch-180.png", "icon-512.png"]);
const SITE_ICON_MAX_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff]);

export function detectImageSignature(bytes) {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_PREFIX)) return "jpeg";
  return null;
}

export function siteIconUploadLimits() {
  return { maxBytes: SITE_ICON_MAX_BYTES, accepted: ["image/png", "image/jpeg"] };
}

async function readBodyBytes(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("图标文件过大。");
      error.statusCode = 413;
      error.code = "SITE_ICON_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 生成三种尺寸并原子写入 dataDir/site-assets/（0700 目录 / 0600 文件）。
export async function writeSiteIconAssets({ bytes, dataDir, sharpImpl }) {
  const sharp = sharpImpl;
  if (!sharp) throw new Error("site icon upload requires sharp");
  const signature = detectImageSignature(bytes);
  if (!signature) {
    const error = new Error("仅支持 PNG 或 JPEG 图片。");
    error.statusCode = 400;
    error.code = "SITE_ICON_INVALID_TYPE";
    throw error;
  }
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height || Math.max(meta.width, meta.height) > 4096) {
    const error = new Error("图片尺寸无效（最长边需在 1–4096 像素）。");
    error.statusCode = 400;
    error.code = "SITE_ICON_INVALID_DIMENSIONS";
    throw error;
  }
  const directory = path.join(dataDir, "site-assets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outputs = [
    { name: "icon-512.png", size: 512 },
    { name: "apple-touch-180.png", size: 180 },
    { name: "favicon-32.png", size: 32 },
  ];
  const written = [];
  for (const output of outputs) {
    const target = path.join(directory, output.name);
    const tmp = `${target}.tmp`;
    const buffer = await sharp(bytes)
      .resize(output.size, output.size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    written.push(output.name);
  }
  return { directory, written };
}

export function removeSiteIconAssets(dataDir) {
  const directory = path.join(dataDir, "site-assets");
  const removed = [];
  for (const name of SITE_ICON_FILES) {
    const target = path.join(directory, name);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed.push(name);
    }
  }
  return removed;
}

// 优先 dataDir 覆盖图，其次发布树默认图；返回 {bytes, source} 或 null。
export function readSiteIconFile({ dataDir, publicDir, name }) {
  if (!SITE_ICON_FILES.includes(name)) return null;
  const override = path.join(dataDir, "site-assets", name);
  try {
    const bytes = fs.readFileSync(override);
    return { bytes, source: "custom" };
  } catch { /* fall through to published default */ }
  const fallback = path.join(publicDir, "site-icon", name);
  try {
    const bytes = fs.readFileSync(fallback);
    return { bytes, source: "default" };
  } catch { /* no default either */ }
  return null;
}

export { readBodyBytes };
