import test from "node:test";
import assert from "node:assert/strict";

import { createGuideAssistantService } from "../server/guide-assistant-service.mjs";
import { PublicApiError } from "../server/public-api-errors.mjs";

const FIXED_NOW = 1_761_283_200_000; // 2025-10-24T00:00:00+08:00，使 admission_year 校验范围正常

function compassFixture({ sourceResolvable = true } = {}) {
  const chunk = {
    chunk_id: "c1",
    guide_id: "grade-review",
    guide_title: "对课程成绩有异议，如何申请复核？",
    source_file_id: "SRC-1",
    location: "第十四条",
    text: "学生对课程成绩有异议的，可在下一学期开学3周内以书面形式向开课单位提出成绩复核申请，开课单位应当组织复议。超过时限提出申请的，开课单位可以不予受理。",
  };
  return {
    retrievalChunks: () => [chunk],
    conflictTopics: () => [],
    searchItems: () => [{ id: "grade-review", title: "对课程成绩有异议，如何申请复核？", summary: "", category: "exam-grade" }],
    sourceFileById: (id) =>
      sourceResolvable && id === "SRC-1"
        ? {
            id: "SRC-1",
            title: "南开大学本科课程考试与成绩管理规定",
            document_no: "教字〔2024〕2号",
            publisher: "教务部",
            published_at: "2024-01-01",
            file_type: "pdf",
            file_url: "https://resources.nkustudy.top/guide-sources/a.pdf",
            official_page_url: "",
          }
        : null,
  };
}

function buildService({ qwen = null, limiter = null, now = () => FIXED_NOW, compass = compassFixture(), log = null } = {}) {
  return createGuideAssistantService({ learningCompass: compass, qwen, limiter, now, log });
}

const QUESTION = "成绩复核怎么办？";

test("history must be strictly paired user/assistant turns", async () => {
  const service = buildService({ qwen: async () => "回答" });
  await assert.rejects(
    service.answer(1, { question: QUESTION, history: [
      { role: "user", content: QUESTION },
      { role: "user", content: "再问一遍" },
    ] }),
    (error) => error instanceof PublicApiError && error.code === "INVALID_AI_QUESTION",
  );
  await assert.rejects(
    service.answer(1, { question: QUESTION, history: [{ role: "assistant", content: "回答" }] }),
    (error) => error.code === "INVALID_AI_QUESTION",
  );
  // 成对交替的合法历史仍可用。
  const result = await service.answer(1, { question: QUESTION, history: [
    { role: "user", content: QUESTION }, { role: "assistant", content: "书面申请。" },
  ] });
  assert.equal(result.refused, false);
});

test("short follow-ups reuse the previous question for retrieval", async () => {
  const service = buildService({ qwen: async () => "超过时限可不予受理，但可向开课单位说明。" });
  const result = await service.answer(1, {
    question: "那要是我晚交了呢？",
    history: [
      { role: "user", content: "课程成绩有异议，如何申请复核？" },
      { role: "assistant", content: "可在下一学期开学3周内提出书面申请。" },
    ],
  });
  assert.equal(result.refused, false);
  assert.ok(result.citations.length >= 1);
});

test("provider retry stays within the server budget and never exceeds it", async () => {
  let clock = 0;
  const attempts = [];
  const qwen = async (_messages, { timeoutMs }) => {
    attempts.push({ at: clock, timeoutMs });
    clock += 24_000;
    const error = new Error("boom");
    error.providerCode = "X";
    throw error;
  };
  const service = buildService({ now: () => clock, qwen });
  await assert.rejects(service.answer(1, { question: QUESTION }), (error) => error.code === "AI_UNAVAILABLE");
  assert.ok(attempts.length >= 1, "first attempt happens");
  for (const attempt of attempts) {
    assert.ok(attempt.at + attempt.timeoutMs <= 25_000, `attempt ${JSON.stringify(attempt)} exceeds 25s budget`);
  }
  assert.ok(attempts.at(-1).at < 25_000, "no attempt starts beyond the budget");
});

test("answers without resolvable citations are refused instead of returned", async () => {
  let providerCalls = 0;
  const service = buildService({ compass: compassFixture({ sourceResolvable: false }), qwen: async () => { providerCalls += 1; return "回答"; } });
  const result = await service.answer(1, { question: QUESTION });
  assert.equal(result.refused, true);
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
  assert.equal(providerCalls, 0, "citation guard must refuse before calling the model");
});

test("model refusal marker is normalized into a structured refusal", async () => {
  const service = buildService({ qwen: async () => "REFUSE_INSUFFICIENT" });
  const result = await service.answer(1, { question: QUESTION });
  assert.equal(result.refused, true);
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.citations.length, 0);
});

test("short natural-language refusals are normalized but answers with pivots are not", async () => {
  const refusal = buildService({ qwen: async () => "抱歉，当前收录的官方文件没有足够依据回答这个问题。" });
  const refused = await refusal.answer(1, { question: QUESTION });
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, "INSUFFICIENT_EVIDENCE");

  const normal = buildService({ qwen: async () => "无法回答保研问题，但成绩复核可以按以下流程办理：开学3周内书面申请。" });
  const answered = await normal.answer(1, { question: QUESTION });
  assert.equal(answered.refused, false);
});

test("admission_year only accepts strict four-digit literals", async () => {
  const service = buildService({ qwen: async () => "回答" });
  for (const bad of ["2.025e3", 2025.5, true, "20250", "abcd", ""]) {
    await assert.rejects(
      service.answer(1, { question: QUESTION, profile: { admission_year: bad } }),
      (error) => error.code === "INVALID_AI_QUESTION",
      `admission_year=${JSON.stringify(bad)} should be rejected`,
    );
  }
  for (const good of [2025, "2025"]) {
    const result = await service.answer(1, { question: QUESTION, profile: { admission_year: good } });
    assert.equal(result.refused, false);
  }
});

test("answers are hard-capped at 12000 characters", async () => {
  const service = buildService({ qwen: async () => "答".repeat(20_000) });
  const result = await service.answer(1, { question: QUESTION });
  assert.equal(Array.from(result.answer).length, 12_000);
});

test("successful answers expose guide_id and category for client alignment", async () => {
  const service = buildService({ qwen: async () => "回答" });
  const result = await service.answer(1, { question: QUESTION });
  assert.equal(result.guide_id, "grade-review");
  assert.equal(result.category, "exam-grade");
});

test("a user with an in-flight question is rejected immediately", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = buildService({ qwen: async () => { await gate; return "回答"; } });
  const first = service.answer(1, { question: QUESTION });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.answer(1, { question: "成绩复核流程是什么？" }), (error) => error.code === "RATE_LIMITED");
  release();
  assert.equal((await first).refused, false);
  // 首问完成后同用户可继续提问。
  const again = await service.answer(1, { question: QUESTION });
  assert.equal(again.refused, false);
});
