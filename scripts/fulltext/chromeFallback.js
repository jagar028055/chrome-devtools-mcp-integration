const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const { loadEnv } = require('../config/env');

loadEnv();

function isPdfResponse(response) {
  if (!response || typeof response.headers !== 'function') return false;
  const headers = response.headers();
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  return typeof contentType === 'string' && contentType.toLowerCase().includes('application/pdf');
}

async function extractInlinePdf(page, timeout) {
  if (!page) return null;
  try {
    const pdfResponse = await page.waitForResponse((response) => isPdfResponse(response), { timeout });
    if (pdfResponse) {
      const buffer = await pdfResponse.body();
      if (buffer && buffer.length > 0) {
        return buffer;
      }
    }
  } catch (error) {
    // waiting timeout or other errors are expected in some flows
  }

  try {
    const base64 = await page.evaluate(async () => {
      try {
        const res = await fetch(window.location.href, { credentials: 'include' });
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
      } catch (fetchError) {
        return null;
      }
    });
    if (base64) {
      return Buffer.from(base64, 'base64');
    }
  } catch (error) {
    // ignore evaluation errors (CORS等)
  }

  return null;
}

async function capturePdfFromPage(page, timeout) {
  if (!page) return { download: null, buffer: null };
  const normalizedTimeout = Math.max(timeout || 10000, 1000);

  const downloadPromise = page.waitForEvent('download', { timeout: normalizedTimeout })
    .then((download) => ({ download, buffer: null }))
    .catch(() => ({ download: null, buffer: null }));

  const inlinePromise = (async () => {
    try {
      const buffer = await extractInlinePdf(page, normalizedTimeout);
      if (buffer && buffer.length > 0) {
        return { download: null, buffer };
      }
    } catch (error) {
      // ignore
    }
    return { download: null, buffer: null };
  })();

  const first = await Promise.race([downloadPromise, inlinePromise]);
  if (first.download || first.buffer) {
    return first;
  }

  const [downloadResult, inlineResult] = await Promise.all([downloadPromise, inlinePromise]);
  if (downloadResult.download || downloadResult.buffer) {
    return downloadResult;
  }
  return inlineResult;
}

/**
 * CDP接続が利用可能かチェック
 * @returns {Promise<boolean>}
 */
async function isCDPAvailable() {
  const port = process.env.CHROME_DEVTOOLS_PORT || '9222';
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(3000)
    });
    if (response.ok) {
      return true;
    }
  } catch (error) {
    // CDP not available
  }
  return false;
}

/**
 * CDP経由でブラウザコンテキストに接続
 * @returns {Promise<{browser: Browser, context: BrowserContext, disconnect: Function}>}
 */
async function connectViaCDP() {
  const port = process.env.CHROME_DEVTOOLS_PORT || '9222';
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const contexts = browser.contexts();
    const createdContext = contexts.length === 0;

    // 既存のコンテキストを使用（ログイン状態保持）
    let context;
    if (contexts.length > 0) {
      context = contexts[0];
    } else {
      // 新規コンテキスト作成
      context = await browser.newContext();
    }

    const disconnect = async () => {
      const tasks = [];
      if (createdContext && context && typeof context.isClosed === 'function' && !context.isClosed()) {
        tasks.push(context.close());
      }
      if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
        tasks.push(browser.close());
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
    };

    return { browser, context, disconnect, createdContext };
  } catch (error) {
    throw new Error(`CDP connection failed: ${error.message}`);
  }
}

/**
 * PDFダウンロード候補セレクタ設定を読み込む
 * @param {string} domain - 対象ドメイン
 * @returns {Object|null} セレクタ設定
 */
async function loadPdfSiteConfig(domain) {
  const configPath = path.join(__dirname, '../../config/pdfSites.json');

  try {
    const content = await fs.readFile(configPath, 'utf8');
    const configs = JSON.parse(content);

    for (const config of configs) {
      if (domain.includes(config.domain)) {
        return config;
      }
    }
  } catch (error) {
    // Config file not found or invalid
  }

  return null;
}

/**
 * Chrome DevTools経由でPDFをダウンロード
 * @param {string} url - 対象URL
 * @param {Object} options - オプション
 * @param {string} options.entryId - エントリID
 * @param {string} options.date - 日付
 * @param {boolean} options.debug - デバッグモード
 * @returns {Promise<{success: boolean, pdfPath?: string, error?: string, method: string}>}
 */
async function downloadPdfViaCDP(url, options = {}) {
  const {
    entryId,
    date,
    debug = false,
    connectionFactory,
    siteConfig
  } = options;
  const urlObj = new URL(url);
  const domain = urlObj.hostname;

  const config = siteConfig || await loadPdfSiteConfig(domain);

  if (!config) {
    return {
      success: false,
      error: `No PDF site configuration found for domain: ${domain}`,
      method: 'cdp'
    };
  }

  let connection = null;
  let page = null;
  const managedPages = new Set();
  const logData = {
    url,
    domain,
    entryId,
    date,
    timestamp: new Date().toISOString(),
    config: config.name,
    steps: [],
    networkRequests: [],
    consoleMessages: []
  };

  try {
    const connect = typeof connectionFactory === 'function' ? connectionFactory : connectViaCDP;
    connection = await connect();
    const { context } = connection;

    page = await context.newPage();
    const initialPage = page;
    managedPages.add(page);
    const managedContext = context;

    // コンソールメッセージをキャプチャ
    page.on('console', (msg) => {
      logData.consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString()
      });
    });

    // ネットワークリクエストをキャプチャ
    page.on('response', (response) => {
      const req = response.request();
      if (req.url().includes('.pdf') || response.headers()['content-type']?.includes('pdf')) {
        logData.networkRequests.push({
          url: req.url(),
          method: req.method(),
          status: response.status(),
          contentType: response.headers()['content-type'],
          timestamp: new Date().toISOString()
        });
      }
    });

    // ページを開く
    logData.steps.push({ action: 'navigate', url, timestamp: new Date().toISOString() });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    if (debug) {
      console.log(`[CDP] Opened page: ${url}`);
    }

    // PDFリンク/ボタンをクリック（順次リトライ with タブ遷移対応）
    let clickedSelector = null;
    let download = null;
    let pdfBuffer = null;
    const downloadTimeout = Math.max(parseInt(process.env.CHROME_MCP_TIMEOUT || '30000', 10) || 30000, 1000);

    const findNewlyOpenedPage = () => {
      const pages = managedContext.pages();
      for (const candidate of pages) {
        if (!managedPages.has(candidate)) {
          managedPages.add(candidate);
          return candidate;
        }
      }
      return null;
    };

    for (const selector of config.selectors) {
      try {
        const element = await page.waitForSelector(selector, { timeout: 5000 });
        if (element) {
          logData.steps.push({ action: 'click_attempt', selector, timestamp: new Date().toISOString() });

          // クリック実行
          await element.click();

          if (debug) {
            console.log(`[CDP] Clicked selector: ${selector}`);
          }

          const currentCapture = await capturePdfFromPage(page, downloadTimeout);
          if (currentCapture.download || currentCapture.buffer) {
            download = currentCapture.download;
            pdfBuffer = currentCapture.buffer;
            clickedSelector = selector;
            logData.steps.push({
              action: download ? 'click_success' : 'inline_pdf_captured',
              selector,
              timestamp: new Date().toISOString()
            });
            break;
          }

          const newPage = findNewlyOpenedPage();
          if (newPage) {
            logData.steps.push({
              action: 'new_tab_detected',
              selector,
              newUrl: newPage.url(),
              timestamp: new Date().toISOString()
            });

            try {
              const captureNewPage = await capturePdfFromPage(newPage, downloadTimeout);
              if (captureNewPage.download || captureNewPage.buffer) {
                download = captureNewPage.download;
                pdfBuffer = captureNewPage.buffer;
                clickedSelector = selector;
                logData.steps.push({
                  action: captureNewPage.download ? 'click_success_new_tab' : 'inline_pdf_captured',
                  selector,
                  timestamp: new Date().toISOString()
                });
                page = newPage;
                break;
              }
              logData.steps.push({
                action: 'download_not_detected_new_tab',
                selector,
                error: 'No download or inline PDF detected',
                timestamp: new Date().toISOString()
              });
            } catch (newTabError) {
              logData.steps.push({
                action: 'download_not_detected_new_tab',
                selector,
                error: newTabError.message,
                timestamp: new Date().toISOString()
              });
            } finally {
              if (!download && !pdfBuffer) {
                logData.steps.push({
                  action: 'new_tab_closed_without_download',
                  selector,
                  timestamp: new Date().toISOString()
                });
                if (typeof newPage.close === 'function') {
                  await newPage.close().catch(() => {});
                }
                page = initialPage;
              }
            }
          } else {
            logData.steps.push({
              action: 'download_not_detected',
              selector,
              error: 'No download or inline PDF detected',
              timestamp: new Date().toISOString()
            });
          }
          // 次のセレクタを試行
        }
      } catch (error) {
        logData.steps.push({
          action: 'click_failed',
          selector,
          error: error.message,
          timestamp: new Date().toISOString()
        });
        // Try next selector
        continue;
      }
    }

    // いずれのセレクタでもダウンロード検出できなかった場合
    if (!download && !pdfBuffer) {
      throw new Error('PDF download not triggered by any selector');
    }
    logData.steps.push({ action: 'download_started', timestamp: new Date().toISOString() });

    // 保存先ディレクトリ
    const saveDir = path.join(process.cwd(), 'tmp', 'fulltext-cdp', date || 'unknown');
    await fs.mkdir(saveDir, { recursive: true });

    const filename = `${entryId || 'download'}.pdf`;
    const savePath = path.join(saveDir, filename);

    // ダウンロードファイルを保存
    if (download) {
      await download.saveAs(savePath);
    } else if (pdfBuffer) {
      await fs.writeFile(savePath, pdfBuffer);
    }
    logData.steps.push({ action: 'download_completed', path: savePath, timestamp: new Date().toISOString() });

    if (debug) {
      console.log(`[CDP] PDF saved: ${savePath}`);
    }

    const savedBuffer = await fs.readFile(savePath);
    const rawHeader = savedBuffer.slice(0, 32).toString('utf8');
    const trimmedHeader = rawHeader.replace(/^[\u0000-\u001F\s]+/g, '').toLowerCase();
    const startsWithPdf = savedBuffer.slice(0, 8).toString().startsWith('%PDF');
    const startsWithHtml = trimmedHeader.startsWith('<!doctype html') || trimmedHeader.startsWith('<html');
    const probablyHtml = !startsWithPdf && (startsWithHtml || trimmedHeader.startsWith('<head') || trimmedHeader.startsWith('<body'));

    let finalPath = savePath;
    let format = 'pdf';
    let contentType = 'application/pdf';

    if (!startsWithPdf) {
      if (probablyHtml) {
        format = 'html';
        contentType = 'text/html';
      } else {
        format = 'binary';
        contentType = 'application/octet-stream';
      }
    }

    if (format === 'html') {
      const htmlPath = savePath.replace(/\.pdf$/i, '.html');
      if (htmlPath !== savePath) {
        await fs.writeFile(htmlPath, savedBuffer);
        await fs.unlink(savePath);
        finalPath = htmlPath;
      }
      logData.steps.push({
        action: 'format_converted',
        format,
        headerSample: rawHeader.trim(),
        path: finalPath,
        timestamp: new Date().toISOString()
      });
    }

    // ログを保存
    logData.success = true;
    logData.clickedSelector = clickedSelector;
    logData.detectedFormat = format;
    logData.contentType = contentType;
    await saveDevToolsLog(entryId, date, logData);

    const relativePath = path.relative(process.cwd(), finalPath);
    return {
      success: true,
      pdfPath: relativePath,
      filePath: relativePath,
      method: 'cdp',
      format,
      type: format,
      contentType,
      bytes: savedBuffer.length
    };

  } catch (error) {
    logData.success = false;
    logData.error = error.message;
    logData.steps.push({ action: 'error', error: error.message, timestamp: new Date().toISOString() });

    // エラーログも保存
    await saveDevToolsLog(entryId, date, logData).catch(() => {});

    return {
      success: false,
      error: error.message,
      method: 'cdp'
    };
  } finally {
    const closeTasks = [];
    for (const managedPage of managedPages) {
      if (managedPage && typeof managedPage.isClosed === 'function' && !managedPage.isClosed()) {
        closeTasks.push(managedPage.close().catch(() => {}));
      }
    }
    if (closeTasks.length > 0) {
      await Promise.allSettled(closeTasks);
    }
    if (connection && typeof connection.disconnect === 'function') {
      await connection.disconnect().catch(() => {});
    }
  }
}

/**
 * DevToolsログを保存
 * @param {string} entryId - エントリID
 * @param {string} date - 日付
 * @param {Object} logData - ログデータ
 */
async function saveDevToolsLog(entryId, date, logData) {
  const logDir = path.join(process.cwd(), 'logs', 'devtools', date);
  await fs.mkdir(logDir, { recursive: true });

  const logPath = path.join(logDir, `${entryId}.json`);
  await fs.writeFile(logPath, JSON.stringify(logData, null, 2), 'utf8');
}

module.exports = {
  isCDPAvailable,
  connectViaCDP,
  downloadPdfViaCDP,
  saveDevToolsLog
};
