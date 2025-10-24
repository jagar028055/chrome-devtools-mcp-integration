#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { resolveReportDirs } = require('../fulltext/helpers');
const { toISODate } = require('../reportUtils');

const PROVIDER_KEY = 'daiwa';
const providersConfig = require('../../config/providers.json');
const providerConfig = providersConfig[PROVIDER_KEY];

if (!providerConfig) {
  throw new Error(`config/providers.json に ${PROVIDER_KEY} の設定が見つかりません`);
}

function todayString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseArgs(argv) {
  const args = {
    storageState: 'storage_state.json',
    outputDir: 'reports',
    date: null,
    headless: true,
    categories: [],
    maxPages: null,
    maxItems: null,
    timeout: 45000,
    waitAfterSearch: 800,
    debug: false,
    keywordDelay: 20
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '-s' || arg === '--storage-state') && argv[i + 1]) {
      args.storageState = argv[++i];
    } else if ((arg === '-o' || arg === '--output') && argv[i + 1]) {
      args.outputDir = argv[++i];
    } else if ((arg === '-d' || arg === '--date') && argv[i + 1]) {
      args.date = argv[++i];
    } else if ((arg === '--category' || arg === '--categories') && argv[i + 1]) {
      const list = argv[++i].split(',').map((v) => v.trim()).filter(Boolean);
      args.categories.push(...list);
    } else if (arg === '--headless=false') {
      args.headless = false;
    } else if (arg === '--headless=true') {
      args.headless = true;
    } else if (arg === '--max-pages' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.maxPages = Math.floor(value);
      }
    } else if ((arg === '--max-items' || arg === '--limit') && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.maxItems = Math.floor(value);
      }
    } else if (arg === '--timeout' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 5000) {
        args.timeout = value;
      }
    } else if (arg === '--debug') {
      args.debug = true;
    } else if (arg === '--keyword-delay' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        args.keywordDelay = value;
      }
    } else if (arg === '--wait-after-search' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        args.waitAfterSearch = value;
      }
    }
  }

  if (!args.date) {
    args.date = todayString();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date は YYYY-MM-DD 形式で指定してください: ${args.date}`);
  }

  const availableCategories = Object.keys(providerConfig.categories || {});
  if (args.categories.length === 0) {
    args.categories = availableCategories;
  } else {
    const normalized = new Set();
    args.categories.forEach((key) => {
      if (key) normalized.add(String(key).trim());
    });
    args.categories = Array.from(normalized);
    const unknown = args.categories.filter((key) => !availableCategories.includes(key));
    if (unknown.length > 0) {
      throw new Error(`不明なカテゴリが指定されました: ${unknown.join(', ')} (利用可能: ${availableCategories.join(', ')})`);
    }
  }

  return args;
}

function toSearchDate(date) {
  if (!date) return '';
  return date.replace(/-/g, '/');
}

async function fillInput(page, selectors, value, options = {}) {
  for (const selector of selectors) {
    const input = await page.$(selector);
    if (!input) continue;
    await input.fill('', { timeout: options.timeout }).catch(() => {});
    await input.fill(value, { timeout: options.timeout }).catch(async () => {
      await input.focus().catch(() => {});
      await input.type(value, { delay: options.delay ?? 0, timeout: options.timeout }).catch(() => {});
    });
    return true;
  }
  return false;
}

async function setDateRange(page, date, options) {
  if (!date) return;
  const formatted = toSearchDate(date);
  const selectors = [
    '#datepicker-from-pc',
    '#datepicker-to-pc',
    '#datepicker-from-sp',
    '#datepicker-to-sp',
    '#search-form-pc input[name="search_from_date"]',
    '#search-form-pc input[name="search_to_date"]',
    '#search-form-sp input[name="search_from_date"]',
    '#search-form-sp input[name="search_to_date"]'
  ];

  const fromSelectors = selectors.filter((selector) => selector.includes('from'));
  const toSelectors = selectors.filter((selector) => selector.includes('to'));

  const filledFrom = await fillInput(page, fromSelectors, formatted, options);
  const filledTo = await fillInput(page, toSelectors, formatted, options);

  if (!filledFrom || !filledTo) {
    await page.evaluate((value) => {
      const candidates = [
        document.querySelector('#datepicker-from-pc'),
        document.querySelector('#datepicker-from-sp'),
        document.querySelector('input[name="search_from_date"]')
      ].filter(Boolean);
      candidates.forEach((input) => {
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const candidatesTo = [
        document.querySelector('#datepicker-to-pc'),
        document.querySelector('#datepicker-to-sp'),
        document.querySelector('input[name="search_to_date"]')
      ].filter(Boolean);
      candidatesTo.forEach((input) => {
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, formatted).catch(() => {});
  }
}

async function submitSearch(page, options) {
  const buttonSelectors = [
    '#search-form-pc .search_btn',
    '#search-form-pc button[type="submit"]',
    '#search-form-pc input[type="submit"]',
    '#btn-head-search-pc',
    '#btn-head-search-sp'
  ];

  let triggered = false;
  for (const selector of buttonSelectors) {
    const button = await page.$(selector);
    if (!button) continue;
    triggered = true;
    const navigationPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: options.timeout })
      .catch(() => null);
    const ajaxPromise = page
      .waitForResponse(
        (response) => response.url().includes('/search/') && response.request().method() === 'POST',
        { timeout: options.timeout }
      )
      .catch(() => null);
    await button.click({ timeout: options.timeout }).catch(() => {});
    await page.waitForTimeout(options.waitAfterSearch).catch(() => {});
    const [navResult] = await Promise.allSettled([navigationPromise, ajaxPromise]);
    if (navResult.status === 'fulfilled') break;
    // 追加クリックは不要
    break;
  }

  if (!triggered) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(options.waitAfterSearch).catch(() => {});
  }

  await page.waitForTimeout(options.waitAfterSearch).catch(() => {});
}

function extractAnalysts(text) {
  if (!text) return [];
  return text
    .split(/[,、／\/;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizeWhitespace(text) {
  return text ? text.replace(/\s+/g, ' ').trim() : '';
}

async function extractReportsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    function absoluteUrl(href) {
      if (!href) return '';
      try {
        return new URL(href, window.location.href).href;
      } catch (_) {
        try {
          return new URL(href, window.location.origin).href;
        } catch (error) {
          return href;
        }
      }
    }

    function pushEntry(entry) {
      if (!entry || !entry.title || !entry.url) return;
      const key = entry.url || entry.reportId || entry.title;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(entry);
    }

    // Daiwa result table (desktop layout)
    const tableBoxes = Array.from(document.querySelectorAll('.wrp_result-table .box'));
    tableBoxes.forEach((box) => {
      const titleAnchor = box.querySelector('.title a[href*="reportFile.do"], .title a[href*=".pdf"], .title a[href*=".html"]');
      if (!titleAnchor) return;
      const title = titleAnchor.textContent ? titleAnchor.textContent.replace(/\s+/g, ' ').trim() : '';
      if (!title) return;
      const url = absoluteUrl(titleAnchor.getAttribute('href'));
      const pdfLink = box.querySelector('.item_format a[href*="reportFile.do"][href*="report_type=pdf"]') ||
        box.querySelector('a[href*=".pdf"]');
      const htmlLink = box.querySelector('.item_format a[href*="reportFile.do"][href*="report_type=html"]') ||
        box.querySelector('a[href*=".html"]');
      const summaryNode = box.querySelector('.text span[id^="subtitle-"], .text span');
      const summary = summaryNode ? summaryNode.textContent.replace(/\s+/g, ' ').trim() : '';
      const dateNode = box.querySelector('[id^="regist_date-"]') || box.querySelector('.item_day span') || box.querySelector('.day span');
      const dateRaw = dateNode ? dateNode.textContent.replace(/\s+/g, ' ').trim() : '';
      const analystNodes = box.querySelectorAll('.item_staff .name a, .item_staff .name span');
      const analystSet = new Set();
      analystNodes.forEach((node) => {
        if (!node || !node.textContent) return;
        let text = node.textContent.replace(/\s+/g, ' ').trim();
        text = text.replace(/[／/]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || text === '★') return;
        analystSet.add(text);
      });
      const analysts = Array.from(analystSet);

      let reportId = '';
      const linkAttr = titleAnchor.getAttribute('href') || '';
      try {
        const linkUrl = new URL(linkAttr, window.location.href);
        reportId = linkUrl.searchParams.get('research_id') || '';
      } catch (_) {
        // ignore URL parsing
      }
      if (!reportId) {
        const matchId = linkAttr.match(/(\d{6,})/);
        if (matchId) {
          reportId = matchId[1];
        }
      }

      pushEntry({
        title,
        url,
        pdfUrl: pdfLink ? absoluteUrl(pdfLink.getAttribute('href')) : '',
        htmlUrl: htmlLink ? absoluteUrl(htmlLink.getAttribute('href')) : '',
        reportId,
        summary,
        dateText: dateRaw,
        category: '',
        analysts
      });
    });

    function textContent(node, selectors) {
      if (!node) return '';
      if (!selectors || selectors.length === 0) return node.textContent || '';
      for (const selector of selectors) {
        const target = node.querySelector(selector);
        if (target && target.textContent) {
          return target.textContent;
        }
      }
      return '';
    }

    function extractDate(node) {
      if (!node) return '';
      const timeEl = node.querySelector('time');
      if (timeEl) {
        if (timeEl.dateTime) return timeEl.dateTime;
        if (timeEl.textContent) return timeEl.textContent;
      }
      const dateLabels = node.querySelectorAll('[class*="date"], .result-date, .report-date, span, td, div');
      for (const el of Array.from(dateLabels)) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        const match = text.match(/(\d{4})[\/\-年\.](\d{1,2})[\/\-月\.](\d{1,2})日?/);
        if (match) {
          const [, y, m, d] = match;
          return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
      }
      return '';
    }

    function extractSummary(node) {
      if (!node) return '';
      const selectors = ['.synopsis', '.summary', '.gaiyo', '.result-summary', '.lead', 'p'];
      for (const selector of selectors) {
        const candidate = node.querySelector(selector);
        if (candidate && candidate.textContent) {
          const text = candidate.textContent.replace(/\s+/g, ' ').trim();
          if (text.length > 0) return text;
        }
      }
      return '';
    }

    function extractCategory(node) {
      if (!node) return '';
      const selectors = [
        '[data-category]',
        '.category',
        '.badge',
        '.tag',
        '.result-tag',
        '.report-category',
        '.publication'
      ];
      for (const selector of selectors) {
        const target = node.matches(selector) ? node : node.querySelector(selector);
        if (target && target.textContent) {
          return target.textContent.replace(/\s+/g, ' ').trim();
        }
      }
      return '';
    }

    const candidateSelectors = [
      '.result-list .result-item',
      '.result-card',
      '.report-list .report-card',
      '.search-result .result-item',
      '.l-search__result .c-card',
      '.result-side .result-item',
      '.search-result .table tbody tr',
      '#result-area .result-item',
      '.result-area .result-item'
    ];

    candidateSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        const anchor =
          node.querySelector('a[href*="reportFile.do"]') ||
          node.querySelector('a[href*="reportDownload"]') ||
          node.querySelector('a[href*=".pdf"]') ||
          node.querySelector('a[href*=".html"]');
        if (!anchor) return;
        const title = anchor.textContent ? anchor.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!title) return;

        let url = anchor.href || '';
        if (url && url.startsWith('//')) {
          url = `${window.location.protocol}${url}`;
        }
        const dateText = extractDate(node);
        const summary = extractSummary(node);
        const category = extractCategory(node);
        const analystsText = textContent(node, ['.analyst', '.analysts', '.author', '.result-author']);
        const reportId =
          anchor.getAttribute('data-research-id') ||
          anchor.getAttribute('data-report-id') ||
          anchor.getAttribute('data-reportid') ||
          node.getAttribute('data-report-id') ||
          node.getAttribute('data-reportid') ||
          '';
        pushEntry({
          title,
          url,
          pdfUrl: url && url.endsWith('.pdf') ? url : '',
          reportId: reportId || '',
          summary,
          dateText,
          category,
          analysts: analystsText ? [analystsText] : []
        });
      });
    });

    // Fallback: table rows
    if (results.length === 0) {
      document.querySelectorAll('table tbody tr').forEach((row) => {
        const anchor =
          row.querySelector('a[href*="reportFile.do"]') ||
          row.querySelector('a[href*="reportDownload"]') ||
          row.querySelector('a[href*=".pdf"]') ||
          row.querySelector('a[href*=".html"]');
        if (!anchor) return;
        const title = anchor.textContent ? anchor.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!title) return;
        let url = anchor.href || '';
        if (url && url.startsWith('//')) {
          url = `${window.location.protocol}${url}`;
        }
        const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() || '');
        let dateText = '';
        for (const cellText of cells) {
          const match = cellText.match(/(\d{4})[\/\-年\.](\d{1,2})[\/\-月\.](\d{1,2})日?/);
          if (match) {
            const [, y, m, d] = match;
            dateText = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            break;
          }
        }
        const summary = extractSummary(row);
        let category = '';
        const badge = row.querySelector('.badge, .tag, .category');
        if (badge && badge.textContent) {
          category = badge.textContent.replace(/\s+/g, ' ').trim();
        }
        const analystCells = cells.filter((text) => /さん|氏|投資戦略部|アナリスト|Market\sTips/.test(text));
        pushEntry({
          title,
          url,
          pdfUrl: url && url.endsWith('.pdf') ? url : '',
          reportId: anchor.getAttribute('data-reportid') || '',
          summary,
          dateText,
          category,
          analysts: analystCells
        });
      });
    }

    return results;
  });
}

function matchesExpectedCategory(entry, categoryConfig) {
  const expected = categoryConfig.expectedCategories || [];
  if (expected.length === 0) return true;
  const normalize = (text) => (text || '').toString().replace(/\s+/g, '').toLowerCase();
  const targetTitle = normalize(entry.title);
  const targetCategory = normalize(entry.category);
  return expected.some((value) => {
    const normalized = normalize(value);
    return targetTitle.includes(normalized) || targetCategory.includes(normalized);
  });
}

function applyPostProcessing(items, categoryConfig, options) {
  const filtered = [];
  for (const item of items) {
    const rawDate = item.dateText || item.dateISO || '';
    const normalizedRaw = rawDate ? rawDate.replace(/\./g, '/').replace(/\//g, '-').replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '') : '';
    const dateISO = toISODate(normalizedRaw || rawDate, options.referenceDate);
    if (options.targetDate && dateISO && options.targetDate !== dateISO) {
      continue;
    }
    if (!matchesExpectedCategory(item, categoryConfig)) {
      continue;
    }
    const analystList = Array.isArray(item.analysts) ? item.analysts : extractAnalysts(item.analysts || '');
    const analysts = Array.from(
      new Set(
        analystList
          .map((value) => (value || '').replace(/\s+/g, ' ').trim())
          .filter((value) => value && value !== '／' && value !== '/')
      )
    );
    filtered.push({
      ...item,
      summary: normalizeWhitespace(item.summary || ''),
      category: item.category || categoryConfig.label,
      dateISO,
      analysts
    });
    if (options.maxItems && filtered.length >= options.maxItems) {
      break;
    }
  }
  return filtered;
}

async function collectCategory(context, categoryKey, categoryConfig, options) {
  const page = await context.newPage();
  const baseUrl = providerConfig.baseUrl || '';
  const targetUrl = `${baseUrl}${providerConfig.search?.indexPath || '/rp-daiwa/member/search/index.do'}`;
  const items = [];
  try {
    if (options.debug) {
      console.log(`[*] ${categoryConfig.label}: キーワード検索 "${categoryConfig.keyword}" を実行`);
    }
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout });

    const searchFilled = await fillInput(
      page,
      [
        '#search-form-pc input[name="search_text"]',
        '#search-form-pc input[name="search_word"]',
        '#search-form-pc input[id^="search_text_box"]',
        '#head-search-pc input[name="search_word"]',
        '#search-form-pc input[type="search"]',
        '#search-form-sp input[name="search_word"]'
      ],
      categoryConfig.keyword || categoryConfig.label,
      { timeout: options.timeout, delay: options.keywordDelay }
    );
    if (!searchFilled && options.debug) {
      console.log(`   [WARN] 検索入力欄を特定できませんでした。`);
    }

    await setDateRange(page, options.targetDate, { timeout: options.timeout });
    await submitSearch(page, options);

    await page.waitForSelector('.result-item, table tbody tr, .search-result', { timeout: options.timeout }).catch(() => {});
    await page.waitForTimeout(options.waitAfterSearch).catch(() => {});

    let currentPage = 1;
    const maxPages = options.maxPages || categoryConfig.maxPages || 1;

    while (true) {
      const rawItems = await extractReportsFromPage(page);
      const processed = applyPostProcessing(rawItems, categoryConfig, {
        targetDate: options.targetDate,
        referenceDate: options.referenceDate,
        maxItems: options.maxItems ? options.maxItems - items.length : null
      });
      items.push(...processed);
      if (options.debug) {
        console.log(`   [DEBUG] ${categoryConfig.label}: ページ${currentPage}で ${processed.length}/${rawItems.length} 件採用 (累計 ${items.length} 件)`);
      }

      if ((options.maxItems && items.length >= options.maxItems) || currentPage >= maxPages) {
        break;
      }

      const nextPageNum = currentPage + 1;
      const nextSelectors = [
        `div.click-paging-link a[data-page="${nextPageNum}"]`,
        `.pagination a[data-page="${nextPageNum}"]`,
        `.pagination a[href*="page=${nextPageNum}"]`,
        `a[href*="javascript:paging(${nextPageNum})"]`,
        'a.next, button.next'
      ];
      let navigated = false;
      for (const selector of nextSelectors) {
        const handle = await page.$(selector);
        if (!handle) continue;
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: options.timeout }).catch(() => null),
          handle.click({ timeout: options.timeout })
        ]);
        await page.waitForTimeout(options.waitAfterSearch).catch(() => {});
        navigated = true;
        break;
      }
      if (!navigated) break;
      currentPage += 1;
    }
  } catch (error) {
    console.log(`   [WARN] ${categoryConfig.label} の取得に失敗: ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }
  return items;
}

async function writeOutput(args, payload) {
  const { metaDir, visibleDir } = resolveReportDirs(args.outputDir, args.date);
  const targets = [
    path.join(metaDir, 'sources'),
    path.join(visibleDir, 'sources')
  ];
  let lastPath = null;
  for (const dir of targets) {
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${providerConfig.slug}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    lastPath = filePath;
  }
  return lastPath;
}

async function runCollector(args) {
  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext({ storageState: args.storageState });

  const categoriesResult = {};
  try {
    const referenceDate = new Date(`${args.date}T00:00:00+09:00`);
    for (const categoryKey of args.categories) {
      const categoryConfig = providerConfig.categories[categoryKey];
      if (args.debug) {
        console.log(`[*] ${categoryConfig.label} を処理中`);
      }
      const items = await collectCategory(context, categoryKey, categoryConfig, {
        timeout: args.timeout,
        maxPages: args.maxPages,
        maxItems: args.maxItems,
        targetDate: args.date,
        waitAfterSearch: args.waitAfterSearch,
        keywordDelay: args.keywordDelay,
        referenceDate,
        debug: args.debug
      });
      categoriesResult[categoryKey] = {
        label: categoryConfig.label,
        items
      };
      if (args.debug) {
        console.log(`   [DEBUG] ${categoryConfig.label}: 収集結果 ${items.length} 件`);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const payload = {
    provider: PROVIDER_KEY,
    slug: providerConfig.slug,
    displayName: providerConfig.displayName,
    fetchedAt: new Date().toISOString(),
    runDate: args.date,
    categories: categoriesResult,
    params: {
      categories: args.categories,
      maxPages: args.maxPages,
      maxItems: args.maxItems,
      timeout: args.timeout
    }
  };

  const outPath = await writeOutput(args, payload);
  console.log(`✅ ${providerConfig.displayName}: ${args.categories.length}カテゴリ, 出力 ${outPath}`);
  Object.entries(categoriesResult).forEach(([key, data]) => {
    const count = data?.items?.length || 0;
    console.log(`   - ${data.label} (${key}): ${count} 件`);
  });
}

if (require.main === module) {
  (async () => {
    try {
      const args = parseArgs(process.argv);
      await runCollector(args);
    } catch (error) {
      console.error(`❌ エラー: ${error.message}`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  parseArgs,
  runCollector,
  collectCategory,
  extractReportsFromPage,
  applyPostProcessing
};
