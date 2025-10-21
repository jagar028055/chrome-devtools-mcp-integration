const path = require('path');
const fs = require('fs/promises');
const pdfParse = require('pdf-parse');
const { sleep } = require('./helpers');
const { isCDPAvailable, downloadPdfViaCDP } = require('./chromeFallback');
const { extractTextFromHtml } = require('./htmlToText');

const SELECTOR_CANDIDATES = [
  '[data-testid="publication-body"]',
  '.publication-body',
  '.report-body',
  '.reportBody',
  '.article-body',
  'div.content-grid',
  'main.center',
  'article.front-page',
  'article.theme-container',
  'article.disclosure',
  'article',
  '#content',
  '#contents',
  '.content',
  '.main-content'
];

const DEFAULT_WAIT_BETWEEN_REQUESTS_MS = 2000;
const NETWORK_TIMEOUT_MS = 20000;

const DISCLOSURE_PATTERNS = [
  /Appendix\s*A-?1/i,
  /ディスクロージャー/, // disclosure notice
  /重要なディスクロージャー/,
  /analyst certification/i
];

const PDF_UNWANTED_PATTERNS = [
  /プライバシーポリシー/,
  /ご登録いただいたお客様/,
  /本企画の目的でのみ/,
  /セミナー/,
  /ウェビナー/,
  /nomuraholdings/i,
  /privacy/i
];

function inferTypeFromUrl(url) {
  if (!url) return 'html';
  if (/\.pdf($|[?#])/i.test(url)) return 'pdf';
  if (/format=pdf/i.test(url)) return 'pdf';
  return 'html';
}

async function detectResourceType(session, url) {
  const request = session?.request;
  if (!request) {
    return { type: inferTypeFromUrl(url), via: 'url' };
  }
  const attempt = async (method) => {
    try {
      const response = method === 'HEAD'
        ? await request.head(url, { timeout: NETWORK_TIMEOUT_MS })
        : await request.get(url, { timeout: NETWORK_TIMEOUT_MS, maxRedirects: 2 });
      if (!response) return null;
      const status = response.status();
      if (status >= 400) return { status };
      const headers = response.headers();
      const contentType = headers['content-type'] || headers['Content-Type'];
      if (contentType) {
        if (contentType.includes('pdf')) {
          return { type: 'pdf', via: method, contentType, status };
        }
        if (contentType.includes('html') || contentType.includes('text/plain')) {
          return { type: 'html', via: method, contentType, status };
        }
      }
      return { type: inferTypeFromUrl(url), via: method, contentType, status };
    } catch (error) {
      return { error: error.message, method };
    }
  };

  const headResult = await attempt('HEAD');
  if (headResult && headResult.type) return headResult;
  // HEAD が 4xx エラーを返した場合でも GET を試行してより正確な判定を行う
  if (headResult && headResult.status && headResult.status >= 400 && headResult.status < 500) {
    const getResult = await attempt('GET');
    if (getResult && getResult.type) return getResult;
    // GET も失敗した場合は URL から推測
    return { type: inferTypeFromUrl(url), via: 'fallback', status: getResult?.status || headResult.status };
  }
  const getResult = await attempt('GET');
  if (getResult && getResult.type) return getResult;
  return { type: inferTypeFromUrl(url), via: 'url' };
}

async function extractPdf(session, url, page) {
  const request = session?.request;
  if (request) {
    const response = await request.get(url, { timeout: NETWORK_TIMEOUT_MS, maxRedirects: 2 });
    if (!response) throw new Error('PDFのダウンロードに失敗しました (レスポンスなし)');
    if (!response.ok()) {
      throw new Error(`PDFのダウンロードに失敗しました: status ${response.status()}`);
    }
    const buffer = await response.body();
    if (!buffer || buffer.length === 0) {
      throw new Error('PDFのダウンロードに失敗しました (ボディ空)');
    }
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').replace(/\u0000/g, '').trim();
    return {
      text,
      buffer,
      meta: {
        contentType: response.headers()['content-type'] || '',
        info: parsed.info || {},
        numpages: parsed.numpages || 0,
        bytes: buffer.length,
        downloadUrl: url
      }
    };
  }
  const context = session?.context;
  const workingPage = page || (context ? await context.newPage() : null);
  if (!workingPage) {
    throw new Error('PDFダウンロード用のコンテキストを作成できませんでした');
  }
  try {
    const response = await workingPage.goto(url, { waitUntil: 'networkidle', timeout: NETWORK_TIMEOUT_MS });
    if (!response) {
      throw new Error('PDFのダウンロードに失敗しました (ページレスポンスなし)');
    }
    if (!response.ok()) {
      throw new Error(`PDFのダウンロードに失敗しました: status ${response.status()}`);
    }
    const buffer = await response.body();
    if (!buffer || buffer.length === 0) {
      throw new Error('PDFのダウンロードに失敗しました (ボディ空)');
    }
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').replace(/\u0000/g, '').trim();
    return {
      text,
      buffer,
      meta: {
        contentType: response.headers()['content-type'] || '',
        info: parsed.info || {},
        numpages: parsed.numpages || 0,
        bytes: buffer.length,
        downloadUrl: url
      }
    };
  } finally {
    if (!page && workingPage && !workingPage.isClosed()) {
      await workingPage.close().catch(() => {});
    }
  }
}

async function extractHtml(page, url, options = {}) {
  const waitUntil = options.waitUntil || 'domcontentloaded';
  const timeout = options.timeout || NETWORK_TIMEOUT_MS;
  const selectors = options.selectors || SELECTOR_CANDIDATES;

  const response = await page.goto(url, { waitUntil, timeout });
  if (!response) {
    await page.waitForLoadState('networkidle', { timeout: timeout / 2 }).catch(() => {});
  }

  await page.evaluate(() => {
    const targets = document.querySelectorAll('.collapsible, .expand-button, .md-expandable, .non-expand-button');
    targets.forEach((element) => {
      element.classList.add('expanded');
      if (element.style) {
        element.style.display = 'block';
        element.style.maxHeight = 'none';
        element.style.visibility = 'visible';
      }
    });
  }).catch(() => {});

  const contentType = response?.headers()['content-type'] || '';
  if (contentType.includes('pdf')) {
    throw new Error('Content-Type が PDF のため HTML 抽出をスキップします');
  }

  const selector = await waitForAnySelector(page, selectors, options.selectorWait || 5000);
  const data = await page.evaluate((targets) => {
    const pickContent = (selectors, extractor) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!node) continue;
        if (extractor === 'text') {
          const value = node.textContent && node.textContent.trim();
          if (value) return value;
        } else if (extractor === 'content') {
          const attr = node.getAttribute('content');
          if (attr && attr.trim()) return attr.trim();
        } else if (extractor === 'datetime') {
          const attr = node.getAttribute('datetime');
          if (attr && attr.trim()) return attr.trim();
        }
      }
      return null;
    };

    const toPayload = (sel) => {
      const node = sel === 'body' ? document.body : document.querySelector(sel);
      if (!node) return null;
      const innerText = node.innerText ? node.innerText.trim() : '';
      const textContent = node.textContent ? node.textContent.trim() : '';
      return {
        selector: sel,
        innerText,
        textContent,
        html: node.innerHTML || ''
      };
    };

    const results = [];
    for (const target of targets) {
      const payload = toPayload(target);
      if (payload && (payload.innerText || payload.textContent)) {
        results.push(payload);
      }
    }

    const bodyPayload = toPayload('body');
    const meta = {
      title: pickContent(
        [
          'meta[property="og:title"]',
          'meta[name="twitter:title"]',
          'meta[name="title"]',
          'meta[itemprop="headline"]'
        ],
        'content'
      ) || (document.querySelector('title')?.textContent?.trim() || null),
      headline: pickContent(
        ['article h1', 'main h1', '.headline', '.title', 'h1'],
        'text'
      ),
      publishedAt: pickContent(
        [
          'meta[property="article:published_time"]',
          'meta[name="pubdate"]',
          'meta[name="publication_date"]',
          'meta[name="date"]'
        ],
        'content'
      ) || pickContent(['time[datetime]'], 'datetime'),
      author: pickContent(
        ['meta[name="author"]', 'meta[property="article:author"]'],
        'content'
      ) || pickContent(['.author', '.analyst', '.byline'], 'text')
    };

    return { results, body: bodyPayload, meta };
  }, selectors);

  const pickCandidate = () => {
    if (!data) return null;
    const { results, body } = data;
    const prioritized = (results || []).slice();
    if (selector && !prioritized.find((item) => item.selector === selector)) {
      const selectedPayload = (results || []).find((item) => item.selector === selector);
      if (selectedPayload) {
        prioritized.unshift(selectedPayload);
      }
    }

    for (const candidate of prioritized) {
      if (!candidate) continue;
      const richText = candidate.innerText && candidate.innerText.length >= 300 ? candidate.innerText : '';
      const fallbackText = candidate.textContent || '';
      const textValue = richText || fallbackText;
      if (textValue && textValue.trim().length > 0) {
        return {
          selector: candidate.selector,
          text: textValue.trim(),
          html: candidate.html
        };
      }
    }

    if (body && (body.innerText || body.textContent)) {
      const textValue = body.innerText || body.textContent || '';
      if (textValue.trim().length > 0) {
        return {
          selector: null,
          text: textValue.trim(),
          html: body.html
        };
      }
    }
    return null;
  };

  const candidate = pickCandidate();
  if (!candidate) {
    throw new Error('本文抽出に失敗しました (空テキスト)');
  }
  let result = {
    text: candidate.text,
    meta: {
      selector: candidate.selector,
      contentType: contentType || 'text/html',
      via: candidate.selector ? 'selector' : 'body',
      htmlMeta: data?.meta || null
    },
    html: candidate.html
  };

  const MIN_TEXT_LENGTH = options.minTextLength || 400;
  if (!result.text || result.text.length < MIN_TEXT_LENGTH) {
    try {
      const pageHtml = await page.content();
      const jsdomExtract = extractTextFromHtml(pageHtml, {
        selectors,
        minLength: MIN_TEXT_LENGTH / 2
      });
      if (jsdomExtract && jsdomExtract.text && jsdomExtract.text.trim().length > result.text.length) {
        result = {
          text: jsdomExtract.text.trim(),
          meta: {
            selector: candidate.selector || jsdomExtract.sections?.[0]?.selector || null,
            contentType: contentType || 'text/html',
            via: 'jsdom',
            htmlMeta: jsdomExtract.meta || data?.meta || null
          },
          html: candidate.html || pageHtml
        };
      } else if (!result.html) {
        result.html = pageHtml;
        if (result.meta && !result.meta.htmlMeta && jsdomExtract?.meta) {
          result.meta.htmlMeta = jsdomExtract.meta;
        }
      }
    } catch (jsdomError) {
      // jsdom変換失敗時は Playwright 結果をそのまま返す
    }
  } else if (result.meta && !result.meta.htmlMeta && data?.meta) {
    result.meta.htmlMeta = data.meta;
  }

  return result;
}

async function waitForAnySelector(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  for (const selector of selectors) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const found = await page.locator(selector).first().waitFor({ timeout: remaining }).then(() => true).catch(() => false);
    if (found) return selector;
  }
  return null;
}

function isDisclosureOnly(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 400) return true;
  if (DISCLOSURE_PATTERNS.some((pattern) => pattern.test(trimmed)) && trimmed.length < 1500) {
    return true;
  }
  return false;
}

function normalizeForMatch(input) {
  if (!input) return '';
  return String(input).replace(/\s+/g, '').toLowerCase();
}

function extractKeyPhrases(entry) {
  const phrases = new Set();
  if (entry?.title) {
    const title = normalizeForMatch(entry.title);
    if (title.length >= 4) {
      phrases.add(title.slice(0, Math.min(title.length, 20)));
      phrases.add(title.slice(0, 8));
    }
  }
  if (entry?.summary) {
    const summary = normalizeForMatch(entry.summary);
    if (summary.length >= 6) {
      phrases.add(summary.slice(0, Math.min(summary.length, 16)));
    }
  }
  const categorySources = [];
  if (entry?.category) categorySources.push(entry.category);
  if (Array.isArray(entry?.categoryList)) categorySources.push(...entry.categoryList);
  if (Array.isArray(entry?.sources)) categorySources.push(...entry.sources);
  categorySources
    .map((value) => normalizeForMatch(value))
    .filter((value) => value.length >= 4)
    .forEach((value) => {
      phrases.add(value.slice(0, Math.min(value.length, 12)));
    });
  return Array.from(phrases).filter(Boolean);
}

function isLikelyReportText(text, entry, candidateUrl) {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  if (normalized.length < 800) return false;
  if (PDF_UNWANTED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  const phrases = extractKeyPhrases(entry);
  if (phrases.length === 0) {
    return true;
  }
  return phrases.some((phrase) => phrase.length >= 4 && normalized.includes(phrase));
}

async function collectPdfCandidates(page, entry, htmlFragment) {
  const base = page.url() || entry.url;
  const candidates = new Set();
  const pushCandidate = (href) => {
    if (!href) return;
    try {
      const absolute = new URL(href, base).toString();
      if (/\.pdf($|[?#])/i.test(absolute)) {
        candidates.add(absolute);
      }
    } catch (error) {
      // ignore invalid URL
    }
  };

  const scraped = await page.evaluate(() => {
    const collectAttr = (selector, attr) => Array.from(document.querySelectorAll(selector), (el) => el.getAttribute(attr)).filter(Boolean);
    return {
      hrefs: collectAttr('a[href]', 'href'),
      dataHref: collectAttr('[data-href]', 'data-href'),
      dataUrl: collectAttr('[data-url]', 'data-url'),
      dataDownload: collectAttr('[data-download]', 'data-download'),
      iframeSrc: collectAttr('iframe[src]', 'src')
    };
  });
  [...scraped.hrefs, ...scraped.dataHref, ...scraped.dataUrl, ...scraped.dataDownload, ...scraped.iframeSrc].forEach(pushCandidate);

  if (htmlFragment) {
    const matches = htmlFragment.match(/href\s*=\s*"([^"]+\.pdf[^"]*)"/gi) || [];
    matches.forEach((match) => {
      const href = match.replace(/^[^"']+"/, '').replace(/"$/, '');
      pushCandidate(href);
    });
  }

  if (entry?.url) {
    try {
      const original = new URL(entry.url);
      const originalParams = original.searchParams.toString();
      const buildUrl = (base, params = '') => {
        const search = [params, originalParams].filter(Boolean).join('&');
        return search ? `${base}?${search}` : base;
      };

      if (!original.searchParams.has('format')) {
        const withFormat = new URL(entry.url);
        withFormat.searchParams.set('format', 'pdf');
        candidates.add(withFormat.toString());
      }
      // 直接 .file にアクセスすると PDF が返却されるケース (NomuraNow)
      const fileUrl = new URL(entry.url);
      const pathnameParts = fileUrl.pathname.split('/');
      if (pathnameParts[pathnameParts.length - 1]) {
        pathnameParts[pathnameParts.length - 1] = `${pathnameParts[pathnameParts.length - 1].replace(/\.html?$/i, '')}.file`;
        fileUrl.pathname = pathnameParts.join('/');
        fileUrl.search = original.searchParams.toString();
        candidates.add(fileUrl.toString());
      }
      const idCandidate = original.pathname.split('/').filter(Boolean).pop();
      const basePath = original.pathname.split('/').slice(0, -1).join('/') || '/';
      const origin = `${original.protocol}//${original.host}`;
      const altPath = original.pathname.replace(/\/publication\//, '/document/');
      candidates.add(buildUrl(new URL(altPath, origin).toString()));
      candidates.add(buildUrl(`${entry.url}.pdf`));
      if (idCandidate) {
        candidates.add(buildUrl(`${origin}${basePath}/${idCandidate}/download`, 'format=pdf'));
        candidates.add(buildUrl(`${origin}${basePath}/${idCandidate}/download`, 'locale=ja&format=pdf'));
        candidates.add(buildUrl(`${origin}${basePath}/${idCandidate}/download`, 'component=body&format=pdf'));
        candidates.add(buildUrl(`${origin}${basePath}/${idCandidate}`, 'download=1&format=pdf'));
        candidates.add(buildUrl(`${origin}${basePath}/${idCandidate}`, 'format=pdf&download=1'));
        candidates.add(buildUrl(`${origin}/research/japi/publication/${idCandidate}/download`, 'format=pdf'));
        candidates.add(buildUrl(`${origin}/research/japi/publication/${idCandidate}/download`, 'locale=ja&format=pdf'));
        candidates.add(buildUrl(`${origin}/research/japi/publication/${idCandidate}/download`, 'component=body&format=pdf'));
      }
    } catch (error) {
      // ignore url parsing errors
    }
  }

  return Array.from(candidates);
}

async function tryPdfFallback(session, entry, page, htmlResult, options = {}) {
  const candidates = await collectPdfCandidates(page, entry, htmlResult?.html);
  if (session?.debug) {
    console.log(`[debug] PDF候補: ${entry.title || entry.url}`, candidates);
  }

  const preferCdpFallback = !!options.enableCdpFallback;

  // 通常のPDFダウンロードを試行（CDP指定時も先に試行する）
  for (const candidate of candidates) {
    try {
      const pdfResult = await extractPdf(session, candidate);
      if (pdfResult?.text && pdfResult.text.trim().length > 400) {
        if (isDisclosureOnly(pdfResult.text) || !isLikelyReportText(pdfResult.text, entry, candidate)) {
          if (session?.debug) {
            console.log(`[debug] PDF候補をスキップ (本文が不足/不一致): ${candidate}`);
          }
          continue;
        }
        return {
          ...pdfResult,
          meta: {
            ...pdfResult.meta,
            downloadUrl: candidate,
            via: 'pdf-fallback'
          },
          type: 'pdf'
        };
      }
    } catch (error) {
      if (session?.debug) {
        console.log(`[debug] PDF候補取得失敗: ${candidate} -> ${error.message}`);
      }
      // 他候補を継続検索
    }
  }

  // CDP経由のフォールバックを試行
  if (options.enableCdpFallback) {
    const cdpAvailable = await isCDPAvailable();
    if (cdpAvailable) {
      if (session?.debug) {
        console.log(`[debug] CDP経由でPDFダウンロードを試行: ${entry.url}`);
      }
      try {
        const cdpResult = await downloadPdfViaCDP(entry.url, {
          entryId: options.entryId,
          date: options.date,
          debug: session?.debug
        });

        if (cdpResult.success && cdpResult.pdfPath) {
          const absolutePath = path.resolve(process.cwd(), cdpResult.pdfPath);
          const buffer = await fs.readFile(absolutePath);
          const header = buffer.slice(0, 32).toString('utf8');
          const startsWithPdf = buffer.slice(0, 8).toString().startsWith('%PDF');
          const headerTrimmed = header.replace(/^[\u0000-\u001F\s]+/g, '').toLowerCase();
          const startsWithHtml = headerTrimmed.startsWith('<!doctype html') || headerTrimmed.startsWith('<html') || headerTrimmed.startsWith('<head');
          const typeHint = cdpResult.type || cdpResult.format;
          let detectedType = typeHint;
          if (!detectedType || detectedType === 'binary') {
            if (startsWithPdf) {
              detectedType = 'pdf';
            } else if (startsWithHtml) {
              detectedType = 'html';
            } else {
              detectedType = 'binary';
            }
          }

          if (detectedType === 'pdf') {
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || '').replace(/\u0000/g, '').trim();

            if (text.length > 400 && !isDisclosureOnly(text) && isLikelyReportText(text, entry, entry.url)) {
              return {
                text,
                buffer,
                meta: {
                  contentType: 'application/pdf',
                  info: parsed.info || {},
                  numpages: parsed.numpages || 0,
                  bytes: buffer.length,
                  downloadUrl: entry.url,
                  via: 'cdp-fallback',
                  cdpPath: cdpResult.pdfPath
                },
                type: 'pdf'
              };
            }
          } else if (detectedType === 'html') {
            const html = buffer.toString('utf8');
            const extracted = extractTextFromHtml(html, { minLength: 200 });
            const text = (extracted.text || '').trim();
            if (text.length > 400 && !isDisclosureOnly(text) && isLikelyReportText(text, entry, entry.url)) {
              return {
                text,
                html,
                buffer: null,
                meta: {
                  contentType: 'text/html',
                  bytes: buffer.length,
                  downloadUrl: entry.url,
                  via: 'cdp-fallback-html',
                  cdpPath: cdpResult.pdfPath,
                  htmlMeta: extracted.meta || null
                },
                type: 'html'
              };
            }
          } else if (session?.debug) {
            console.log(`[debug] CDPフォールバックで未知フォーマットを取得: type=${detectedType}, header=${headerTrimmed.slice(0, 40)}`);
          }
        }
      } catch (error) {
        if (session?.debug) {
          console.log(`[debug] CDP経由のPDFダウンロード失敗: ${error.message}`);
        }
      }
    }
  }

  return null;
}

async function fetchFullText(entry, session, options = {}) {
  const rateWait = options.rateWait ?? DEFAULT_WAIT_BETWEEN_REQUESTS_MS;
  const context = session?.context;
  if (!context) {
    throw new Error('BrowserContext が初期化されていません');
  }
  const typeInfo = await detectResourceType(session, entry.url);
  const page = await context.newPage();
  try {
    if (typeInfo.type === 'pdf') {
      const pdfResult = await extractPdf(session, entry.url, page);
      await sleep(rateWait);
      return { ...pdfResult, type: 'pdf', detector: typeInfo };
    }

    // HTML 抽出を試みる（失敗しても PDF フォールバックを実行するため）
    let htmlResult = null;
    let htmlError = null;
    try {
      htmlResult = await extractHtml(page, entry.url, options.htmlOptions);

      // HTML 抽出成功時の処理
      if (!isDisclosureOnly(htmlResult.text)) {
        if (options.fetchPdfOnHtml !== false) {
          try {
            const pdfAttachment = await tryPdfFallback(session, entry, page, htmlResult, {
              enableCdpFallback: options.enableCdpFallback,
              entryId: options.entryId,
              date: options.date
            });
            if (session?.debug) {
              if (pdfAttachment) {
                console.log('[debug] HTML抽出後のPDF探索結果:', {
                  type: pdfAttachment.type || null,
                  keys: Object.keys(pdfAttachment),
                  hasBuffer: !!pdfAttachment.buffer,
                  bufferBytes: pdfAttachment.buffer ? pdfAttachment.buffer.length : 0,
                  metaKeys: pdfAttachment.meta ? Object.keys(pdfAttachment.meta) : null
                });
              } else {
                console.log('[debug] HTML抽出後のPDF探索結果: null');
              }
            }
            if (pdfAttachment && pdfAttachment.type === 'pdf' && pdfAttachment.buffer && pdfAttachment.buffer.length > 0) {
              if (session?.debug) {
                console.log(`[debug] HTML抽出成功後にPDFバッファを添付: ${(pdfAttachment.meta?.downloadUrl || '').slice(0, 120)}`);
              }
              htmlResult = {
                ...htmlResult,
                buffer: pdfAttachment.buffer,
                meta: {
                  ...(htmlResult.meta || {}),
                  pdf: pdfAttachment.meta || {}
                }
              };
            }
          } catch (attachmentError) {
            if (session?.debug) {
              console.log(`[debug] HTML成功後のPDF添付取得に失敗: ${attachmentError.message}`);
            }
          }
        }
        await sleep(rateWait);
        return { ...htmlResult, type: 'html', detector: typeInfo };
      }
      // ディスクロージャーのみの場合は PDF フォールバックへ
    } catch (error) {
      // HTML 抽出失敗時もエラーを記録して PDF フォールバックへ
      htmlError = error;
      if (session?.debug) {
        console.log(`[debug] HTML抽出失敗、PDFフォールバックを試行: ${error.message}`);
      }
    }

    // HTML が失敗またはディスクロージャーのみの場合、PDF フォールバックを試行
    const pdfFallback = await tryPdfFallback(session, entry, page, htmlResult, {
      enableCdpFallback: options.enableCdpFallback,
      entryId: options.entryId,
      date: options.date
    });

    if (pdfFallback) {
      await sleep(rateWait);
      const fallbackType = pdfFallback.type || 'pdf';
      return {
        ...pdfFallback,
        type: fallbackType,
        detector: { ...typeInfo, via: 'html->pdf' }
      };
    }

    // PDF フォールバックも失敗した場合
    await sleep(rateWait);
    if (htmlError) {
      throw new Error(`HTML抽出失敗: ${htmlError.message}`);
    }
    throw new Error('本文抽出がディスクロージャーのみのため失敗しました');
  } catch (error) {
    await sleep(rateWait);
    throw error;
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }
}

module.exports = {
  detectResourceType,
  extractPdf,
  extractHtml,
  fetchFullText,
  SELECTOR_CANDIDATES
};
