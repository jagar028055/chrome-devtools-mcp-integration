#!/usr/bin/env node
const assert = require('assert');
const { extractTextFromHtml, normalizeWhitespace } = require('./fulltext/htmlToText');

async function run() {
  console.log('🧪 htmlToText ユーティリティの挙動を検証');

  const sampleHtml = `
    <html lang="ja">
      <body>
        <div class="content-grid">
          <main class="center">
            <article class="front-page">
              <p>段落A</p>
              <div class="collapsible" style="display:none;">隠しテキスト</div>
              <p>段落B</p>
            </article>
          </main>
          <aside class="lhs"><p>サイド情報</p></aside>
        </div>
      </body>
    </html>
  `;

  const { text, sections, meta } = extractTextFromHtml(sampleHtml, { minLength: 0 });
  assert.ok(text.includes('段落A'), '本文に段落Aが含まれるべき');
  assert.ok(text.includes('段落B'), '本文に段落Bが含まれるべき');
  assert.ok(text.includes('隠しテキスト'), '折り畳み要素のテキストを含むべき');
  assert.ok(Array.isArray(sections) && sections.length > 0, 'セクション情報が取得できるべき');
  assert.ok(meta && typeof meta === 'object', 'meta 情報が返却されるべき');
  assert.strictEqual(meta.title, null, 'サンプルHTMLではタイトルが null のはず');

  const normalized = normalizeWhitespace(' 行1  \n\n  行2   \n   ');
  assert.strictEqual(normalized, '行1\n\n行2', '余分な空白を除去しつつ空行を保持するべき');

  console.log('✅ htmlToText utility test passed');
}

run().catch((error) => {
  console.error('❌ testHtmlToText.js failed:', error);
  process.exitCode = 1;
});
