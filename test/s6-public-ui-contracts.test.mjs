import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { isReviewPublicEligible } from '../server/moderation-model.mjs';

const require = createRequire(import.meta.url);
function loadTypescript(relative, overrides = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Error,
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : require(name),
  }, { filename: relative });
  return module.exports;
}

test('markdown image width handling preserves escaping and ordinary image rendering', () => {
  const { markdownToHtml } = loadTypescript('../src/lib/markdown.ts');
  const sized = markdownToHtml('![sample](https://example.invalid/image.png#w240)');
  assert.match(sized, /src="https:\/\/example\.invalid\/image\.png"/);
  assert.match(sized, /width="240"/);
  assert.match(sized, /alt="sample"/);
  assert.doesNotMatch(sized, /#w240/);
  const regular = markdownToHtml('![regular](https://example.invalid/image.png#section)');
  assert.match(regular, /#section/);
  assert.doesNotMatch(regular, /width=/);
  assert.doesNotMatch(markdownToHtml('<img src=x onerror=alert(1)>'), /<img/);
});

test('review grouping normalizes supported punctuation without breaking Chinese parentheses', () => {
  const { reviewKey } = loadTypescript('../src/lib/reviews.ts', {
    './runtime-data': { readBuildData: () => ({ reviews: [] }) },
    '../../server/moderation-model.mjs': { isReviewPublicEligible },
  });
  const canonical = reviewKey({ courseTitle: '高等数学(A)', teacher: '张老师' });
  assert.equal(reviewKey({ courseTitle: ' 高等 / 数学（A） ', teacher: '张\\老、师' }), canonical);
  assert.notEqual(reviewKey({ courseTitle: '高等数学(B)', teacher: '张老师' }), canonical);
});

test('required browser controls reject absent or wrong elements and escape untrusted display text', () => {
  const { requireElement, escapeHtml, errorMessage } = loadTypescript('../src/lib/browser-dom.ts');
  class Input {}
  class Other {}
  const element = new Input();
  assert.equal(requireElement('#input', Input, { querySelector: () => element }), element);
  assert.throws(() => requireElement('#input', Input, { querySelector: () => null }), /页面控件不可用/);
  assert.throws(() => requireElement('#input', Input, { querySelector: () => new Other() }), /页面控件不可用/);
  assert.equal(escapeHtml(`<script>"a" & 'b'</script>`), '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;');
  assert.equal(errorMessage(null, 'unknown result'), 'unknown result');
  assert.equal(errorMessage(new Error(''), 'unknown result'), 'unknown result');
  assert.equal(errorMessage(new Error('specific failure'), 'unknown result'), 'specific failure');
});
