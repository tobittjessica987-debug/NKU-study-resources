import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideAssistantService } from '../server/guide-assistant-service.mjs';
import { createDefaultLearningCompassService } from '../server/learning-compass-service.mjs';

const question = '课程成绩有异议，如何申请复核？';
const turn = [{ role: 'user', content: question }, { role: 'assistant', content: '请查阅原文。' }];
function service(qwen = async () => '请在规定期限内向开课单位提出复核。') {
  return createGuideAssistantService({ learningCompass: createDefaultLearningCompassService(), qwen });
}

test('rejects non-text inputs before provider; accepts complete 9-turn history', async () => {
  let calls = 0;
  const svc = service(async () => { calls++; return '回答'; });
  for (const value of [12, true, null, [], ['成绩复核'], {}]) {
    for (const body of [
      { question: value },
      { question, history: [{ role: 'user', content: value }, turn[1]] },
      { question, profile: { major: value } },
    ]) await assert.rejects(svc.answer(1, body), { code: 'INVALID_AI_QUESTION' });
  }
  for (const year of [[2025], { toString: () => '2025' }]) {
    await assert.rejects(svc.answer(1, { question, profile: { admission_year: year } }), { code: 'INVALID_AI_QUESTION' });
  }
  for (const count of [1, 3, 17, 19]) {
    await assert.rejects(svc.answer(1, { question, history: Array.from({ length: count }, (_, i) => turn[i % 2]) }), { code: 'INVALID_AI_QUESTION' });
  }
  assert.equal(calls, 0);
  assert.equal((await svc.answer(1, { question, history: Array.from({ length: 18 }, (_, i) => turn[i % 2]), profile: { admission_year: '2025', major: '' } })).refused, false);
  assert.equal(calls, 1);
});

test('non-string provider responses are unavailable instead of stringified', async () => {
  for (const answer of [42, true, {}, ['回答']]) {
    await assert.rejects(service(async () => answer).answer(1, { question }), { code: 'AI_UNAVAILABLE' });
  }
});
