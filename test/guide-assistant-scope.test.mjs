import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideAssistantService } from '../server/guide-assistant-service.mjs';
import { createLearningCompassService, loadLearningCompassSnapshot } from '../server/learning-compass-service.mjs';

const NOW = Date.parse('2026-10-25T00:00:00+08:00');
const snapshot = loadLearningCompassSnapshot();
function setup(chunks, conflicts = []) {
  const calls = [];
  const learningCompass = {
    retrievalChunks: () => chunks,
    conflictTopics: () => conflicts,
    sourceFileById: (id) => ({ id, title: id }),
  };
  const svc = createGuideAssistantService({ learningCompass, now: () => NOW, qwen: async (messages) => { calls.push(messages[1].content); return '仅按对应文件说明。'; } });
  return { svc, calls };
}
function chunk(id, metadata = {}) {
  return { guide_id: id, guide_title: '转专业申请条件', chunk_id: id, source_file_id: id, location: '申请条件', text: `${id}：转专业申请条件与流程。`, applicable_scope: '南开大学本科生', time_status: 'long_term', ...metadata };
}

test('real snapshot projection exposes exact college ownership without changing public DTOs', () => {
  const compass = createLearningCompassService(snapshot);
  const chunks = compass.retrievalChunks();
  assert.equal(chunks.length, 205);
  const variants = chunks.filter((item) => item.variant_id);
  assert.equal(variants.length, 150);
  assert.equal(new Set(variants.map((item) => item.variant_id)).size, 29);
  assert.ok(variants.every((item) => item.variant_title && item.time_status && item.applicable_scope));
  assert.equal(compass.guide('transfer-major-2026').variants.length, 29);
  assert.ok(!JSON.stringify(compass.guide('transfer-major-2026')).includes('variant_ambiguous'));
});

test('unknown major and generic questions do not mix college variants', async () => {
  const { svc, calls } = setup([chunk('general'), chunk('law', { variant_id: 'law', variant_title: '法学院' }), chunk('physics', { variant_id: 'physics', variant_title: '物理科学学院' })]);
  const result = await svc.answer(1, { question: '转专业申请条件是什么？', profile: { major: '法学' } });
  assert.deepEqual(result.citations.map((c) => c.id), ['general']);
  assert.ok(!calls[0].includes('law：'));
  assert.ok(!calls[0].includes('physics：'));
});

test('one exact target college may use that variant; ambiguous colleges fall back to general', async () => {
  const { svc } = setup([chunk('general'), chunk('law', { variant_id: 'law', variant_title: '法学院' }), chunk('physics', { variant_id: 'physics', variant_title: '物理科学学院' })]);
  const one = await svc.answer(1, { question: '法学院转专业申请条件是什么？' });
  assert.ok(one.citations.some((c) => c.id === 'law'));
  assert.ok(one.citations.every((c) => c.id !== 'physics'));
  const two = await svc.answer(1, { question: '法学院和物理科学学院转专业申请条件是什么？' });
  assert.deepEqual(two.citations.map((c) => c.id), ['general']);
});

test('unknown target with only college evidence refuses without invoking provider', async () => {
  const { svc, calls } = setup([chunk('law', { variant_id: 'law', variant_title: '法学院' })]);
  assert.equal((await svc.answer(1, { question: '转专业申请条件是什么？' })).reason, 'INSUFFICIENT_EVIDENCE');
  assert.equal(calls.length, 0);
});

test('cohort metadata restricts evidence to matching explicit profile', async () => {
  const { svc } = setup([chunk('cohort', { applicable_scope: '2025级本科生，2026—2027学年第一学期', time_status: 'current' })]);
  for (const profile of [undefined, { admission_year: 2024 }]) {
    assert.equal((await svc.answer(1, { question: '转专业申请条件是什么？', ...(profile ? { profile } : {}) })).refused, true);
  }
  assert.equal((await svc.answer(1, { question: '转专业申请条件是什么？', profile: { admission_year: 2025 } })).refused, false);
  assert.equal((await svc.answer(1, { question: '2024级转专业申请条件是什么？', profile: { admission_year: 2025 } })).refused, true);
});

test('ended notices require explicit historical intent and matching event year', async () => {
  const { svc, calls } = setup([chunk('ended', { applicable_scope: '南开大学2026年本科生转专业申请', time_status: 'ended' })]);
  for (const question of ['现在转专业申请条件是什么？', '转专业申请条件是什么？', '2026年转专业现在还能申请吗？', '回顾2025年转专业申请条件']) {
    assert.equal((await svc.answer(1, { question })).refused, true);
  }
  assert.equal(calls.length, 0);
  const past = await svc.answer(1, { question: '回顾2026年转专业申请条件' });
  assert.equal(past.refused, false);
  assert.ok(calls[0].includes('时效标签：ended'));
});

test('current notices from another year cannot answer current questions or different named years', async () => {
  const { svc } = setup([chunk('old-current', { applicable_scope: '南开大学2025年转专业申请', time_status: 'current' })]);
  for (const question of ['转专业申请条件是什么？', '今年转专业申请条件是什么？', '2027年转专业申请条件是什么？']) {
    assert.equal((await svc.answer(1, { question })).refused, true);
  }
});

test('follow-up topic and conflict check share context across multiple elliptical turns', async () => {
  const { svc, calls } = setup([chunk('general')], [{ keywords: ['自修'] }]);
  const history = [{ role: 'user', content: '自修课程申请条件是什么？' }, { role: 'assistant', content: '来源冲突。' }, { role: 'user', content: '那GPA呢？' }, { role: 'assistant', content: '来源冲突。' }];
  assert.equal((await svc.answer(1, { question: '那门数呢？', history })).reason, 'SOURCE_CONFLICT');
  assert.equal(calls.length, 0);
  assert.equal((await svc.answer(1, { question: '转专业申请条件是什么？', history })).refused, false);
  assert.equal((await svc.answer(1, { question: '换个话题，NBA结果是什么？', history })).reason, 'INSUFFICIENT_EVIDENCE');
});

function realSetup() {
  const calls = [];
  const svc = createGuideAssistantService({ learningCompass: createLearningCompassService(snapshot), now: () => NOW,
    qwen: async (messages) => { calls.push(messages[1].content); return '请参考对应指南中的校级一般规定，不能据此确认个人申请资格。'; } });
  return { svc, calls };
}

test('implicit attributes retain conflict topic; complete new topic drops old model history', async () => {
  const { svc, calls } = realSetup();
  const history = [{ role: 'user', content: '自修申请有什么条件？' }, { role: 'assistant', content: '来源冲突无法回答。' }];
  for (const question of ['GPA要求是多少？', '最多可以申请几门课程？', '那门数呢？']) {
    assert.equal((await svc.answer(1, { question, history })).reason, 'SOURCE_CONFLICT');
  }
  assert.equal(calls.length, 0);
  assert.equal((await svc.answer(1, { question: '如果课程成绩有异议，如何申请复核？', history })).refused, false);
  assert.ok(!calls[0].includes('用户：自修'));
  assert.ok(!calls[0].includes('同主题历史'));
});

test('ordinary implicit follow-up still receives consistent grade-review context', async () => {
  const { svc, calls } = realSetup();
  const history = [{ role: 'user', content: '课程成绩有异议，如何申请复核？' }, { role: 'assistant', content: '应按规定申请。' }];
  assert.equal((await svc.answer(1, { question: '申请期限是多久？', history })).refused, false);
  assert.ok(calls[0].includes('用户：课程成绩有异议'));
});

test('current college and transfer origin are not mistaken for destination in real snapshot', async () => {
  const { svc, calls } = realSetup();
  for (const question of [
    '我是法学院学生，想转入计算机专业，有什么申请条件？',
    '我是法学院学生，想转出到其他学院，有什么申请条件？',
  ]) {
    const result = await svc.answer(1, { question });
    assert.ok(result.citations.every((item) => !item.id.startsWith('SRC-005-')));
  }
  assert.ok(calls.every((prompt) => !prompt.includes('适用范围：法学院；')));
  const target = await svc.answer(1, { question: '我目前就读法学院，想转入计算机学院，有什么申请条件？' });
  assert.ok(target.citations.some((item) => item.id === 'SRC-005-computer-science'));
  assert.ok(!target.citations.some((item) => item.id === 'SRC-005-law'));
});

test('semester and academic-year conflicts exclude incompatible real evidence', async () => {
  const { svc, calls } = realSetup();
  for (const question of ['2027年第二学期选课规则', '2026年春季学期选课规则', '2027年秋季学期选课规则', '2025—2026学年第一学期选课规则']) {
    await svc.answer(1, { question, profile: { admission_year: 2025 } });
  }
  assert.ok(calls.every((prompt) => !prompt.includes('第一学期；时效标签：current')));
  const { svc: one, calls: accepted } = realSetup();
  assert.equal((await one.answer(1, { question: '2026年秋季选课规则', profile: { admission_year: 2025 } })).refused, false);
  assert.ok(accepted[0].includes('2026—2027学年第一学期；时效标签：current'));
});
