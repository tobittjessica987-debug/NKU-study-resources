import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Load the browser-independent DTO boundary with the repository's TS compiler.
const source = fs.readFileSync(new URL('../src/lib/review-page-types.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { readPublicReviewList, readReviewEditorSettings, reviewPageErrorMessage, requiredReviewElement } =
  await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('review list preserves legacy public rows and scores without a new field or range gate', () => {
  const rows = [
    { id: 17, courseTitle: '旧课程', teacher: '旧老师', rating: 0, content: '旧公开内容', createdAt: 1791370000000 },
    { id: 'fraction', courseTitle: '旧课程', teacher: '旧老师', rating: 4.5, content: '旧公开小数评分', createdAt: null },
    { id: 'string', courseTitle: '旧课程', teacher: '旧老师', rating: '3', content: '旧公开字符串评分' },
    { id: 'missing-score', courseTitle: '旧课程', teacher: '旧老师', content: '旧公开缺省评分' },
    { id: 'loose-text', courseTitle: 2026, teacher: null, rating: 6, content: 123 },
  ];
  const result = readPublicReviewList({ ok: true, reviews: rows });
  assert.equal(result.reviews, rows);
  assert.deepEqual(result.reviews.map(row => row.id), [17, 'fraction', 'string', 'missing-score', 'loose-text']);
  assert.deepEqual(result.reviews.map(row => Number(row.rating || 0)), [0, 4.5, 3, 0, 6]);
  assert.equal(String(result.reviews[0].createdAt ?? ''), '1791370000000');
  assert.equal(String(result.reviews[4].content ?? ''), '123');
});

test('review list preserves rule metadata and a valid empty public list', () => {
  const rules = { minLength: '12', moderationRequired: false, announcement: 2026, submission_hint: '旧提示' };
  const result = readPublicReviewList({ ok: true, reviews: [], rules });
  assert.deepEqual(result.reviews, []);
  assert.equal(result.rules, rules);
  assert.equal(result.rules.moderationRequired, false);
});

test('failed or malformed top-level responses are not treated as an empty successful list', () => {
  for (const bad of [null, {}, { ok: false, reviews: [] }, { ok: true, reviews: {} }, { ok: true, reviews: [null] }]) {
    assert.throws(() => readPublicReviewList(bad), /评价列表返回结果不完整/);
  }
});

test('editor settings retain server string toolbars and ignore malformed configuration', () => {
  assert.deepEqual(readReviewEditorSettings({ user: { toolbar: ['bold', 'link'] }, admin: { toolbar: ['preview'] } }),
    { user: { toolbar: ['bold', 'link'] }, admin: { toolbar: ['preview'] } });
  assert.deepEqual(readReviewEditorSettings({ user: { toolbar: [3] } }), {});
  assert.equal(readReviewEditorSettings(null), null);
});

test('unknown errors have a usable fallback without reading arbitrary properties', () => {
  assert.equal(reviewPageErrorMessage(new Error('请求失败'), '备用'), '请求失败');
  assert.equal(reviewPageErrorMessage(null, '备用'), '备用');
  assert.equal(reviewPageErrorMessage({ message: '任意对象' }, '备用'), '备用');
});

test('required template nodes are checked for existence and the expected DOM type', () => {
  class SyntheticElement {}
  class OtherElement {}
  const expected = new SyntheticElement();
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => selector === '#present' ? expected : selector === '#wrong' ? new OtherElement() : null };
  try {
    assert.equal(requiredReviewElement('#present', SyntheticElement), expected);
    assert.throws(() => requiredReviewElement('#missing', SyntheticElement));
    assert.throws(() => requiredReviewElement('#wrong', SyntheticElement));
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
