#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { resolveReportDirs } = require('../fulltext/helpers');

const PROVIDER_KEY = 'smbc-nikko';
const providersConfig = require('../../config/providers.json');
const providerConfig = providersConfig[PROVIDER_KEY];

if (!providerConfig) {
  throw new Error(`providers.json に ${PROVIDER_KEY} の設定が見つかりません`);
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
    debug: false,
    timeout: 30000
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '-s' || arg === '--storage-state') && argv[i + 1]) {
      args.storageState = argv[++i];
    } else if ((arg === '-o' || arg === '--output') && argv[i + 1]) {
      args.outputDir = argv[++i];
    } else if ((arg === '-d' || arg === '--date') && argv[i + 1]) {
      args.date = argv[++i];
    } else if (arg === '--category' && argv[i + 1]) {
      args.categories.push(argv[++i]);
    } else if (arg === '--categories' && argv[i + 1]) {
      args.categories.push(...argv[++i].split(',').map((v) => v.trim()).filter(Boolean));
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
    } else if (arg === '--debug') {
      args.debug = true;
    } else if ((arg === '--timeout' || arg === '--nav-timeout') && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 1000) {
        args.timeout = Math.floor(value);
      }
    }
  }

  if (!args.date) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    args.date = `${yyyy}-${mm}-${dd}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date は YYYY-MM-DD 形式で指定してください: ${args.date}`);
  }

  const available = Object.keys(providerConfig.mysearchCategories);
  if (args.categories.length === 0) {
    args.categories = available;
  } else {
    args.categories = Array.from(new Set(args.categories));
    const unknown = args.categories.filter((key) => !available.includes(key));
    if (unknown.length > 0) {
      throw new Error(`不明なカテゴリが指定されました: ${unknown.join(', ')} (利用可能: ${available.join(', ')})`);
    }
  }

  return args;
}

function safeText(node) {
  return (node || '').replace(/\s+/g, ' ').trim();
}

function normalizeDate(dateText) {
  if (!dateText) return '';
  const trimmed = dateText.trim();
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(trimmed)) {
    return trimmed.replace(/\//g, '-');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

async function extractPageRows(page) {
  return page.evaluate(() => {
    const rows = [];
    const tableRows = document.querySelectorAll('table.table.table-striped tbody tr');
    tableRows.forEach((row) => {
      const titleAnchor = row.querySelector('.report-title a');
      const pdfLink = row.querySelector('a[href*="front_pdf_download.php"]');
      const summaryEl = row.querySelector('.gaiyo, .synopsis, .padL5');
      const categoryLabel = row.querySelector('.badge');
      const dateCell = row.querySelector('td:last-child');
      const mailLink = row.querySelector('a[href^="mailto:"]');
      const analystLinks = dateCell
        ? Array.from(dateCell.querySelectorAll('a[href*="analyst_individual"]'))
        : [];
      const analysts = analystLinks.map((a) => ({
        name: a.textContent.trim(),
        url: a.href
      }));

      const reportIdFromAttr = titleAnchor ? (titleAnchor.getAttribute('data-reportid') || titleAnchor.dataset?.reportid || '') : '';
      let reportId = reportIdFromAttr;
      if (!reportId && pdfLink) {
        try {
          const url = new URL(pdfLink.href);
          reportId = url.searchParams.get('reportid') || reportId;
        } catch (_) {
          // ignore URL parse errors
        }
      }

      let detailUrl = '';
      if (mailLink) {
        const href = mailLink.getAttribute('href') || '';
        const idx = href.indexOf('body=');
        if (idx >= 0) {
          try {
            const decoded = decodeURIComponent(href.slice(idx + 5));
            const match = decoded.match(/https?:\/\/[^\s]+/);
            if (match && match[0]) {
              detailUrl = match[0];
            }
          } catch (_) {
            // ignore decode issues
          }
        }
      }

      const title = titleAnchor ? titleAnchor.textContent.trim() : '';
      const pdfUrl = pdfLink ? pdfLink.href : '';
      const summary = summaryEl ? summaryEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const category = categoryLabel ? categoryLabel.textContent.trim() : '';
      const dateMatch = dateCell ? dateCell.textContent.match(/(\d{4}\/\d{2}\/\d{2})/) : null;
      const dateText = dateMatch ? dateMatch[1] : '';

      if (!title || !pdfUrl) return;

      rows.push({
        title,
        pdfUrl,
        detailUrl,
        reportId,
        summary,
        category,
        dateText,
        analysts
      });
    });
    return rows;
  });
}

async function determinePageCount(page) {
  const pageNumbers = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href^="javascript:paging"]'));
    const nums = links
      .map((link) => {
        const match = link.getAttribute('href')?.match(/paging\((\d+)\)/);
        if (match) return Number(match[1]);
        return null;
      })
      .filter((num) => Number.isFinite(num));
    if (nums.length === 0) return 1;
    return Math.max(...nums);
  });
  return Number.isFinite(pageNumbers) && pageNumbers > 0 ? pageNumbers : 1;
}

async function gotoMysearchPage(context, categoryConfig, options = {}) {
  const page = await context.newPage();
  const baseUrl = providerConfig.baseUrl;
  const url = `${baseUrl}/powerSearch/front_powersearch_result.php?mode=mysearch&mysearchId=${categoryConfig.id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeout });
  return page;
}

async function paginateTo(page, targetPage, timeout) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
    page.evaluate((pageNumber) => {
      if (!document.form1) throw new Error('form1 が見つかりません');
      const sortSelect = document.getElementById('sortselected');
      const sortHidden = document.getElementById('sort');
      if (sortSelect && sortHidden) {
        sortHidden.value = sortSelect.value;
      }
      document.form1.mode.value = 'pager';
      document.form1.page.value = String(pageNumber);
      document.form1.submit();
    }, targetPage)
  ]);
}

async function collectCategory(context, categoryKey, categoryConfig, options) {
  const page = await gotoMysearchPage(context, categoryConfig, options);
  await page.waitForLoadState('domcontentloaded', { timeout: options.timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: options.timeout }).catch(() => {});
  const pageUrl = page.url();
  if (options.debug) {
    console.log(`   [DEBUG] ${categoryConfig.label}: ${pageUrl}`);
  }
  const isLoginPage = await page.evaluate(() => {
    const title = document.title || '';
    return /Login/i.test(title);
  });
  if (isLoginPage) {
    throw new Error('ログインページへリダイレクトされました。Playwright storage_state の有効期限を確認してください。');
  }
  await page.waitForSelector('table.table.table-striped tbody tr', { timeout: options.timeout });
  const totalPages = await determinePageCount(page);
  const maxPages = options.maxPages ? Math.min(totalPages, options.maxPages) : totalPages;
  const items = [];

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    if (options.debug) {
      console.log(`   [DEBUG] ${categoryConfig.label}: ページ ${currentPage}/${maxPages}`);
    }

    if (currentPage > 1) {
      await paginateTo(page, currentPage, options.timeout);
      await page.waitForLoadState('networkidle', { timeout: options.timeout }).catch(() => {});
      await page.waitForSelector('table.table.table-striped tbody tr', { timeout: options.timeout });
    }

    const rows = await extractPageRows(page);
    if (options.debug) {
      console.log(`   [DEBUG] ${categoryConfig.label}: ページ${currentPage} raw ${rows.length}件`);
    }
    for (const row of rows) {
      const dateISO = normalizeDate(row.dateText);
      if (options.debug) {
        console.log(`      -> keys=${Object.keys(row || {}).join(',')} rawDate=${row.dateText || '(no-date)'} => ${dateISO || '(parsed-nil)'}`);
      }
      if (options.targetDate && dateISO !== options.targetDate) {
        continue;
      }
      const normalizedAnalysts = (row.analysts || []).map((entry) => entry.name).filter(Boolean);
      const primaryUrl = row.pdfUrl || row.detailUrl || row.url || '';
      items.push({
        ...row,
        url: primaryUrl,
        pdfUrl: row.pdfUrl || null,
        dateISO,
        category: row.category || categoryConfig.label || categoryKey,
        provider: PROVIDER_KEY,
        providerSlug: providerConfig.slug,
        displayName: providerConfig.displayName,
        analysts: normalizedAnalysts,
        analystLinks: (row.analysts || []).filter((entry) => entry.url)
      });
      if (options.maxItems && items.length >= options.maxItems) {
        if (options.debug) {
          console.log(`   [DEBUG] ${categoryConfig.label}: max-items (${options.maxItems}) に到達`);
        }
        await page.close();
        return items;
      }
    }
  }

  await page.close();
  return items;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeOutput(args, payload) {
  const { metaDir, visibleDir } = resolveReportDirs(args.outputDir, args.date);
  const targetDirs = [
    path.join(visibleDir, 'sources'),
    path.join(metaDir, 'sources')
  ];
  let lastPath = null;
  for (const dir of targetDirs) {
    await ensureDir(dir);
    const filePath = path.join(dir, `${providerConfig.slug}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    lastPath = filePath;
  }
  return lastPath;
}

async function runCollector(args) {
  const browser = await chromium.launch({ headless: args.headless, timeout: args.timeout });
  const context = await browser.newContext({ storageState: args.storageState });

  const categoriesResult = {};
  try {
    for (const categoryKey of args.categories) {
      const categoryConfig = providerConfig.mysearchCategories[categoryKey];
      if (args.debug) {
        console.log(`[*] ${categoryConfig.label} を取得中 (mysearchId=${categoryConfig.id})`);
      }
      const items = await collectCategory(context, categoryKey, categoryConfig, {
        timeout: args.timeout,
        maxPages: args.maxPages,
        maxItems: args.maxItems,
        debug: args.debug,
        targetDate: args.date
      });
      categoriesResult[categoryKey] = {
        label: categoryConfig.label,
        items
      };
      if (args.debug) {
        console.log(`   [DEBUG] ${categoryConfig.label}: ${items.length} 件`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const outputPayload = {
    provider: PROVIDER_KEY,
    slug: providerConfig.slug,
    displayName: providerConfig.displayName,
    fetchedAt: new Date().toISOString(),
    runDate: args.date,
    categories: categoriesResult,
    params: {
      categories: args.categories,
      maxPages: args.maxPages,
      maxItems: args.maxItems
    }
  };

  const outPath = await writeOutput(args, outputPayload);
  console.log(`✅ ${providerConfig.displayName}: ${args.categories.length}カテゴリ, 出力 ${outPath}`);
  for (const [key, data] of Object.entries(categoriesResult)) {
    const count = data?.items?.length || 0;
    console.log(`   - ${data.label} (${key}): ${count} 件`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await runCollector(args);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ エラー:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  collectCategory,
  gotoMysearchPage,
  extractPageRows,
  determinePageCount,
  normalizeDate,
  parseArgs,
  runCollector
};
