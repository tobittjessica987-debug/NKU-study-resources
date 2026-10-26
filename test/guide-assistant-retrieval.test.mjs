import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideAssistantService } from '../server/guide-assistant-service.mjs';
import { createDefaultLearningCompassService } from '../server/learning-compass-service.mjs';

const NOW = Date.parse('2026-10-26T10:00:00+08:00');
const compass = createDefaultLearningCompassService();
const chunks = compass.retrievalChunks();

async function capture(body) {
  let messages;
  let prompt;
  const service = createGuideAssistantService({
    learningCompass: compass,
    now: () => NOW,
    log: (entry) => { if (entry.event === 'prompt_built') prompt = entry; },
    qwen: async (input) => { messages = input; return '请按照所引原文的适用条件办理。'; },
  });
  const result = await service.answer('local-retrieval-test', body);
  const evidence = messages?.[1].content.split(/(?=【依据\d+｜)/).slice(1) || [];
  const selected = evidence.map((block) => {
    const heading = block.replace(/^【依据\d+｜/, '').split('】', 1)[0];
    const chunk = chunks.find((item) => heading === `${item.guide_title}｜${item.location}` && block.includes(item.text));
    assert.ok(chunk, 'each evidence block must retain one complete original chunk');
    return chunk;
  });
  return { result, messages, prompt, selected };
}

for (const question of ['课程成绩有异议，如何申请复核？', '成绩复核什么时候申请？']) {
  test(`grade review avoids unrelated full policies: ${question}`, async () => {
    const { result, selected, prompt } = await capture({ question });
    assert.equal(result.refused, false);
    assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('下一学期开学3周内')));
    assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('任课教师不得擅自更改')));
    assert.ok(selected.every((item) => !['bachelor-degree-application', 'credit-recognition-and-exchange', 'resume-study', 'student-rights-discipline-appeals'].includes(item.guide_id)), 'generic application/review terms must not pull unrelated policies into grade review');
    assert.ok(prompt.prompt_chars < 2200, `unexpected noisy context: ${prompt.prompt_chars} characters`);
    assert.ok(result.citations.some((item) => item.id === 'SRC-003'));
  });
}

test('a short follow-up retains the full grade review deadline and approval text', async () => {
  const { selected, messages } = await capture({ question: '超过三周还可以吗？', history: [
    { role: 'user', content: '课程成绩有异议，如何申请复核？' },
    { role: 'assistant', content: '应在下一学期开学三周内提出书面申请。' },
  ] });
  assert.ok(messages[1].content.includes('同主题历史'));
  assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('超过时限，开课单位可不予受理')));
  assert.ok(selected.every((item) => item.guide_id === 'grade-review'));
});

test('an explicit comparison preserves evidence from both policy topics', async () => {
  const { selected } = await capture({ question: '成绩复核和学位授予异议分别怎么申请？' });
  assert.ok(selected.some((item) => item.guide_id === 'grade-review'));
  assert.ok(selected.some((item) => item.guide_id === 'bachelor-degree-application'));
});

test('a detailed first topic cannot crowd out a shorter explicit second topic', async () => {
  for (const question of [
    '课程总评成绩和GPA如何计算，成绩复核什么时候申请？',
    '成绩复核什么时候申请；课程总评成绩和GPA如何计算？',
  ]) {
    const { selected } = await capture({ question });
    assert.equal(selected.filter((item) => item.guide_id === 'course-grade-and-gpa').length, 4);
    assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('下一学期开学3周内')));
    assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('任课教师不得擅自更改')));
  }
});

test('explicit additive connectors retain both GPA and grade review evidence', async () => {
  for (const connector of ['以及', '并且', '同时', '另外', '还有']) {
    for (const question of [
      `课程总评成绩和GPA如何计算${connector}成绩复核什么时候申请？`,
      `成绩复核什么时候申请${connector}课程总评成绩和GPA如何计算？`,
    ]) {
      const { selected } = await capture({ question });
      assert.equal(selected.filter((item) => item.guide_id === 'course-grade-and-gpa').length, 4, question);
      assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('下一学期开学3周内')), question);
      assert.ok(selected.some((item) => item.guide_id === 'grade-review' && item.text.includes('任课教师不得擅自更改')), question);
    }
  }
});

test('a GPA question retains all four relevant chunks rather than imposing a two-chunk cap', async () => {
  const { selected } = await capture({ question: '课程总评成绩和GPA如何计算？' });
  assert.equal(selected.length, 4);
  assert.ok(selected.every((item) => item.guide_id === 'course-grade-and-gpa'));
});

test('a target-college question retains general rules and exact college sections', async () => {
  const { selected } = await capture({ question: '法学院转专业申请条件是什么？' });
  assert.ok(selected.some((item) => item.guide_id === 'transfer-major-2026' && !item.variant_id));
  assert.ok(selected.some((item) => item.variant_title === '法学院' && item.location.includes('接收转入条件')));
  assert.ok(selected.every((item) => item.guide_id === 'transfer-major-2026' && (!item.variant_id || item.variant_title === '法学院')));
});

test('another exact guide topic avoids application boilerplate from unrelated documents', async () => {
  const { selected, prompt } = await capture({ question: '休学期满后如何申请复学？' });
  assert.ok(selected.length > 0);
  assert.ok(selected.every((item) => item.guide_id === 'resume-study'));
  assert.ok(prompt.prompt_chars < 1500);
});

test('title weighting cannot promote a single weak match past the evidence threshold', async () => {
  let calls = 0;
  const service = createGuideAssistantService({
    learningCompass: {
      retrievalChunks: () => [{ chunk_id: 'weak', guide_id: 'weak', guide_title: '成绩说明', location: '第一条', text: '完整原文。', source_file_id: 'source' }],
      conflictTopics: () => [],
      sourceFileById: () => ({ id: 'source', title: 'source' }),
    },
    qwen: async () => { calls += 1; return '不应调用'; },
  });
  const result = await service.answer('local-retrieval-test', { question: '成绩' });
  assert.equal(result.reason, 'INSUFFICIENT_EVIDENCE');
  assert.equal(calls, 0);
});
