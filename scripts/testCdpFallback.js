#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');

const {
  detectResourceType
} = require('./fulltext/extractors');
const {
  downloadPdfViaCDP
} = require('./fulltext/chromeFallback');

/**
 * モックレスポンス生成
 */
function createMockResponse({ status, headers }) {
  return {
    status: () => status,
    headers: () => ({ ...headers })
  };
}

/**
 * detectResourceType の GET フォールバックを検証
 */
async function testDetectResourceTypeFallback() {
  console.log('🧪 detectResourceType による HEAD→GET フォールバックの検証');

  const calls = [];
  const session = {
    request: {
      async head() {
        calls.push('HEAD');
        return createMockResponse({ status: 403, headers: { 'content-type': 'text/html' } });
      },
      async get() {
        calls.push('GET');
        return createMockResponse({ status: 200, headers: { 'content-type': 'application/pdf' } });
      }
    }
  };

  const result = await detectResourceType(session, 'https://example.com/report.pdf');
  assert.strictEqual(result.type, 'pdf', 'GET 経由で PDF と判定されるべき');
  assert.strictEqual(result.via, 'GET', 'via が GET になっているべき');
  assert.deepStrictEqual(calls, ['HEAD', 'GET'], 'HEAD 後に GET が実行されるべき');

  console.log('✅ detectResourceType fallback test passed');
}

class MockDownload {
  constructor(buffer) {
    this.buffer = buffer;
  }

  async saveAs(targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, this.buffer);
  }
}

class MockPage {
  constructor(context, name, actions = {}) {
    this._context = context;
    this._name = name;
    this._url = 'about:blank';
    this._closed = false;
    this._handlers = { console: [], response: [] };
    this._actions = new Map();
    Object.entries(actions).forEach(([selector, steps]) => {
      this._actions.set(selector, steps.map((step) => ({ ...step })));
    });
    this._downloadPromise = null;
  }

  on(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event].push(handler);
    }
  }

  context() {
    return this._context;
  }

  url() {
    return this._url;
  }

  async goto(url) {
    this._url = url;
  }

  async waitForSelector(selector) {
    if (!this._actions.has(selector)) {
      throw new Error(`Selector not available: ${selector}`);
    }
    return {
      click: async () => {
        const queue = this._actions.get(selector);
        const action = queue.shift();
        if (!action) {
          throw new Error(`No action left for selector: ${selector}`);
        }
        if (action.type === 'download') {
          this._downloadPromise = Promise.resolve(new MockDownload(action.buffer));
        } else if (action.type === 'new-tab') {
          const newPage = this._context.createPage(action.newPageActions || {});
          if (action.newPageDownloadBuffer) {
            newPage.setDownload(action.newPageDownloadBuffer);
          }
        } else if (action.type === 'none') {
          // do nothing
        } else {
          throw new Error(`Unknown action type: ${action.type}`);
        }
      }
    };
  }

  async waitForEvent(event, { timeout }) {
    if (event !== 'download') {
      throw new Error(`Unsupported event: ${event}`);
    }
    if (this._downloadPromise) {
      return this._downloadPromise;
    }
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Download timeout'));
      }, Math.min(timeout, 50));
    });
  }

  setDownload(buffer) {
    this._downloadPromise = Promise.resolve(new MockDownload(buffer));
  }

  async close() {
    this._closed = true;
  }

  isClosed() {
    return this._closed;
  }
}

class MockContext {
  constructor(initialActions, additionalPages = []) {
    this._pages = [];
    this._initialActions = initialActions;
    this._additionalPages = additionalPages.slice();
  }

  async newPage() {
    const actions = this._pages.length === 0 ? this._initialActions : (this._additionalPages.shift() || {});
    const page = new MockPage(this, `page-${this._pages.length}`, actions);
    this._pages.push(page);
    return page;
  }

  createPage(actions) {
    const page = new MockPage(this, `page-${this._pages.length}`, actions);
    this._pages.push(page);
    return page;
  }

  pages() {
    return this._pages.filter((page) => !page.isClosed());
  }
}

class MockBrowser {
  constructor() {
    this._closed = false;
  }

  isConnected() {
    return !this._closed;
  }

  async close() {
    this._closed = true;
  }
}

function createConnectionFactory({ initialActions, additionalPages }) {
  const context = new MockContext(initialActions, additionalPages);
  const browser = new MockBrowser();
  const state = { disconnectCalled: false };
  return {
    factory: async () => ({
      browser,
      context,
      disconnect: async () => {
        state.disconnectCalled = true;
      },
      createdContext: true
    }),
    state,
    context
  };
}

async function testDownloadWithSingleSelector() {
  console.log('🧪 downloadPdfViaCDP 単一セレクタの成功シナリオを検証');

  process.env.CHROME_MCP_TIMEOUT = '200';
  const pdfBuffer = Buffer.from('%PDF-1.4\n');
  const connection = createConnectionFactory({
    initialActions: {
      '.primary': [{ type: 'download', buffer: pdfBuffer }]
    }
  });

  const result = await downloadPdfViaCDP('https://example.com/report', {
    entryId: 'sample-entry',
    date: '2099-01-01',
    connectionFactory: connection.factory,
    siteConfig: {
      domain: 'example.com',
      selectors: ['.primary']
    }
  });

  assert.strictEqual(result.success, true, 'ダウンロード成功のはず');
  assert.ok(result.pdfPath, 'pdfPath が設定されるべき');
  assert.strictEqual(result.format, 'pdf', 'フォーマットはpdfのはず');
  assert.strictEqual(result.type, 'pdf', 'type も pdf のはず');
  assert.ok(result.filePath, 'filePath が設定されるべき');
  assert.strictEqual(result.filePath, result.pdfPath, 'filePath と pdfPath は一致するべき');
  assert.strictEqual(result.contentType, 'application/pdf', 'contentType が application/pdf のはず');
  const saved = await fs.readFile(path.resolve(process.cwd(), result.pdfPath));
  assert.strictEqual(saved.toString(), pdfBuffer.toString(), '保存されたPDF内容が一致するべき');
  assert.ok(connection.state.disconnectCalled, 'disconnect が呼ばれるべき');
  const remainingPages = connection.context.pages();
  assert.strictEqual(remainingPages.length, 0, '全ページがクローズされるべき');

  console.log('✅ downloadPdfViaCDP single selector test passed');
}

async function testDownloadWithNewTabFallback() {
  console.log('🧪 downloadPdfViaCDP 新規タブフォールバックの検証');

  process.env.CHROME_MCP_TIMEOUT = '200';
  const pdfBuffer = Buffer.from('%PDF-new-tab');
  const connection = createConnectionFactory({
    initialActions: {
      '.primary': [
        {
          type: 'new-tab',
          newPageDownloadBuffer: pdfBuffer
        },
        { type: 'download', buffer: pdfBuffer }
      ]
    },
    additionalPages: [
      {
        '.primary': [{ type: 'download', buffer: pdfBuffer }]
      }
    ]
  });

  const result = await downloadPdfViaCDP('https://example.com/report', {
    entryId: 'new-tab-entry',
    date: '2099-01-02',
    connectionFactory: connection.factory,
    siteConfig: {
      domain: 'example.com',
      selectors: ['.primary']
    }
  });

  assert.strictEqual(result.success, true, '新規タブ経由でも成功するはず');
  assert.strictEqual(result.format, 'pdf', 'フォーマットはpdfのはず');
  assert.strictEqual(result.type, 'pdf', 'type も pdf のはず');
  const saved = await fs.readFile(path.resolve(process.cwd(), result.pdfPath));
  assert.strictEqual(saved.toString(), pdfBuffer.toString(), '新規タブのPDF内容が一致するべき');
  assert.ok(connection.state.disconnectCalled, 'disconnect が呼び出されるべき');
  assert.strictEqual(connection.context.pages().length, 0, '全ページがクローズ済みであるべき');

  console.log('✅ downloadPdfViaCDP new tab test passed');
}

async function cleanupTmpArtifacts() {
  const tmpDir = path.join(process.cwd(), 'tmp', 'fulltext-cdp');
  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function testDownloadCapturesHtmlViewer() {
  console.log('🧪 downloadPdfViaCDP HTML ビューア取得時の挙動を検証');

  const htmlBuffer = Buffer.from('<html><body><main class="center"><article class="front-page"><p>Viewer Body</p></article></main></body></html>');
  const connection = createConnectionFactory({
    initialActions: {
      '.primary': [{ type: 'download', buffer: htmlBuffer }]
    }
  });

  const result = await downloadPdfViaCDP('https://example.com/report-viewer', {
    entryId: 'html-entry',
    date: '2099-01-03',
    connectionFactory: connection.factory,
    siteConfig: {
      domain: 'example.com',
      selectors: ['.primary']
    }
  });

  assert.strictEqual(result.success, true, 'HTML 取得でも成功扱いのはず');
  assert.strictEqual(result.format, 'html', 'フォーマットはhtmlのはず');
  assert.strictEqual(result.type, 'html', 'type も html のはず');
  assert.strictEqual(result.contentType, 'text/html', 'contentType は text/html のはず');
  assert.ok(result.pdfPath.endsWith('.html'), 'HTML 保存時は拡張子が .html のはず');
  assert.strictEqual(result.filePath, result.pdfPath, 'filePath も .html パスを指すべき');
  const saved = await fs.readFile(path.resolve(process.cwd(), result.pdfPath), 'utf8');
  assert.strictEqual(saved, htmlBuffer.toString(), '保存されたHTML内容が一致するべき');

  console.log('✅ downloadPdfViaCDP HTML viewer test passed');
}

async function run() {
  await cleanupTmpArtifacts();
  try {
    await testDetectResourceTypeFallback();
    await testDownloadWithSingleSelector();
    await testDownloadWithNewTabFallback();
    await testDownloadCapturesHtmlViewer();
    console.log('\n✅ testCdpFallback.js completed successfully');
  } catch (error) {
    console.error('\n❌ testCdpFallback.js failed:', error);
    process.exitCode = 1;
  } finally {
    await cleanupTmpArtifacts();
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  testDetectResourceTypeFallback,
  testDownloadWithSingleSelector,
  testDownloadWithNewTabFallback
};
