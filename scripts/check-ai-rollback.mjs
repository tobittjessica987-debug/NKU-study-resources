// Read-only preflight. Run against the effective persisted configuration only
// after AI is disabled and in-flight calls/configuration writes are quiesced.
import { lstatSync, readFileSync } from "node:fs";
import { assertAiRollbackDisabled } from "../server/ai-provider-config.mjs";

try {
  if (process.argv.length !== 4 || process.argv[2] !== "--settings") throw new Error("arguments");
  const file = process.argv[3];
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("permissions");
  const result = assertAiRollbackDisabled(JSON.parse(readFileSync(file, "utf8")));
  console.log(JSON.stringify({ status: "PASS", ...result, scope: "AI configuration only; not release/data restore verification" }));
} catch {
  // Never echo configuration, parser excerpts, credentials or supplied paths.
  console.error("BLOCKED: supply a readable private settings file with version:1 and settings.enabled:false; keep AI disabled throughout rollback.");
  process.exitCode = 1;
}
