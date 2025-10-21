#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { writeRegionOutputs, normalizeEntry, toISODate } = require('./reportUtils');

const TITLE_KEYWORDS = [
  '欧州市場コメント',
  'グローバル金利デイリー',
  '為替モーニングコメント'
];

const ANALYST_KEYWORDS = [
  '雨宮 愛知'
];

const KEYWORD_SEARCHES = [
  '為替モーニングコメント',
  '欧州市場コメント',
  '米国市場コメント',
  'マクロ・スナップショット'
];

const MAX_ITEMS_PER_KEYWORD = 40;
const KEYWORD_TIMEOUT_MS = 10000;

function parseDateString(input) {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`日付形式は YYYY-MM-DD を使用してください: ${input}`);
  }
  return input;
}

function parseArgs(argv) {
  const args = { output: 'reports', storageState: null, from: null, date: null, applyFilter: false, fromDate: null, toDate: null, debug: false }; // defaults
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '-o' || arg === '--output') && argv[i + 1]) {
      args.output = argv[++i];
    } else if ((arg === '-s' || arg === '--storage-state') && argv[i + 1]) {
      args.storageState = argv[++i];
    } else if (arg === '--from' && argv[i + 1]) {
      args.from = argv[++i];
    } else if (arg === '--date' && argv[i + 1]) {
      args.date = argv[++i];
    } else if (arg === '--headless=false') {
      args.headless = false;
    } else if (arg === '--no-filter') {
      args.applyFilter = false;
    } else if (arg === '--from-date' && argv[i + 1]) {
      args.fromDate = parseDateString(argv[++i]);
    } else if (arg === '--to-date' && argv[i + 1]) {
      args.toDate = parseDateString(argv[++i]);
    } else if (arg === '--debug') {
      args.debug = true;
    }
  }
  return args;
}

async function extractCards(page) {
  const referenceDate = new Date();
  return page.evaluate((ref) => {
    const cards = Array.from(document.querySelectorAll('div.mx-n2.row div.card'));
    return cards.map((card) => {
      const title = card.querySelector('.card-title a');
      const summary = card.querySelector('.synopsis');
      const dateEl = card.querySelector('.card-footer b');
      const analysts = Array.from(card.querySelectorAll('.card-header b')).map((el) => el.textContent.trim());
      const category = card.querySelector('[data-testid="publication-tag"], .badge, .text-uppercase');
      return {
        title: title ? title.textContent.trim() : '',
        url: title ? title.href : '',
        date: dateEl ? dateEl.textContent.trim() : '',
        summary: summary ? summary.textContent.trim() : '',
        analysts,
        category: category ? category.textContent.trim() : ''
      };
    }).filter((item) => item.title && item.url);
  }, referenceDate.getTime());
}

function normalizeAnalysts(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return raw.split(/[;,、]/).map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function normalizeText(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, '');
}

function matchesFilters(item) {
  if (!item) return { match: false, reason: null };
  const activeTitleKeywords = TITLE_KEYWORDS.filter(Boolean);
  const activeAnalystKeywords = ANALYST_KEYWORDS.filter(Boolean);
  if (activeTitleKeywords.length === 0 && activeAnalystKeywords.length === 0) {
    return { match: true, reason: 'no-filter' };
  }
  const titleNormalized = normalizeText(item.title || '');
  const analysts = normalizeAnalysts(item.analysts).map((name) => normalizeText(name));
  const titleMatch = activeTitleKeywords.some((keyword) => titleNormalized.includes(normalizeText(keyword)));
  const analystMatch = activeAnalystKeywords.some((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    return analysts.some((name) => name.includes(normalizedKeyword));
  });
  const reason = titleMatch ? 'title' : analystMatch ? 'analyst' : null;
  return { match: !!reason, reason };
}

function applyFilters(results, shouldApply = true) {
  if (!shouldApply) return results;
  const filtered = {};
  const stats = {};
  for (const [regionKey, payload] of Object.entries(results)) {
    if (!payload || !Array.isArray(payload.items)) {
      filtered[regionKey] = payload;
      continue;
    }
    const items = [];
    let titleHits = 0;
    let analystHits = 0;
    for (const item of payload.items) {
      const { match, reason } = matchesFilters(item);
      if (match) {
        if (reason === 'title') titleHits += 1;
        if (reason === 'analyst') analystHits += 1;
        items.push(item);
      }
    }
    stats[regionKey] = { total: payload.items.length, kept: items.length, titleHits, analystHits };
    filtered[regionKey] = { ...payload, items };
  }
  filtered.__filterStats = stats;
  return filtered;
}

function filterByDateRange(results, options = {}) {
  const { fromDate, toDate, referenceDate = new Date() } = options;
  if (!fromDate && !toDate) return results;
  const filtered = {};
  for (const [regionKey, payload] of Object.entries(results)) {
    if (regionKey === '__filterStats') continue;
    if (!payload || !Array.isArray(payload.items)) {
      filtered[regionKey] = payload;
      continue;
    }
    const items = payload.items.filter((item) => {
      const iso = toISODate(item.date || item.dateRaw || '', referenceDate);
      if (!iso) return false;
      if (fromDate && iso < fromDate) return false;
      if (toDate && iso > toDate) return false;
      return true;
    });
    filtered[regionKey] = { ...payload, items };
  }
  return filtered;
}

function logPreview(results, options = {}) {
  const limit = options.limit ?? 5;
  let total = 0;
  console.log('--- 取得結果プレビュー (フィルター前) ---');
  for (const [regionKey, payload] of Object.entries(results)) {
    if (regionKey === '__filterStats') continue;
    const items = payload?.items || [];
    total += items.length;
    console.log(` ${regionKey}: ${items.length}件`);
    items.slice(0, limit).forEach((item, index) => {
      const analysts = normalizeAnalysts(item.analysts).join(', ');
      console.log(`   [${index + 1}] ${item.date || item.dateRaw || ''} | ${item.title || ''}`);
      if (analysts) {
        console.log(`        著者: ${analysts}`);
      }
      console.log(`        URL: ${item.url}`);
    });
  }
  console.log(` 合計件数(フィルター前): ${total}`);
}

async function collectWithBrowser(args) {
  if (!args.storageState) {
    throw new Error('Playwright storage stateファイル（--storage-state）が必要です。ログイン済みセッションを指定してください。');
  }
  const browser = await chromium.launch({ headless: args.headless !== false });
  const context = await browser.newContext({ storageState: args.storageState });
  const page = await context.newPage();
  const baseUrl = 'https://www.nomuranow.com/research/m/Home';

  const aggregate = new Map();
  const results = {};

  const addToAggregate = (items, keyword) => {
    for (const item of items) {
      const key = item.url || `${item.title}-${item.date}`;
      if (!key) continue;
      if (!aggregate.has(key)) {
        aggregate.set(key, { ...item, sources: [keyword] });
      } else {
        const existing = aggregate.get(key);
        const set = new Set(existing.sources || []);
        set.add(keyword);
        existing.sources = Array.from(set);
      }
    }
  };

  const collectForKeyword = async (keyword) => {
    try {
      if (args.debug) console.log(`   [DEBUG] ${keyword} を検索`);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: KEYWORD_TIMEOUT_MS * 2 });
      const input = page.locator('input[placeholder="定期刊行物すべて"], input[aria-label="定期刊行物すべて"]').first();
      await input.waitFor({ timeout: KEYWORD_TIMEOUT_MS });
      await input.fill('', { timeout: 2000 });
      await page.waitForTimeout(100);
      await input.type(keyword, { delay: 20, timeout: KEYWORD_TIMEOUT_MS });
      await input.press('Enter').catch(() => {});
      await page.waitForResponse((res) => res.url().includes('/pub/search/query'), { timeout: KEYWORD_TIMEOUT_MS }).catch(() => {});
      await page.waitForSelector(`text=${keyword}`, { timeout: KEYWORD_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(300);
      const items = await extractCards(page);
      const limited = items.slice(0, MAX_ITEMS_PER_KEYWORD);
      results[keyword] = { label: keyword, items: limited };
      addToAggregate(limited, keyword);
      if (args.debug) {
        console.log(`   [DEBUG] ${keyword} 取得件数: ${items.length}${items.length > MAX_ITEMS_PER_KEYWORD ? ` (うち${MAX_ITEMS_PER_KEYWORD}件のみ保持)` : ''}`);
      }
    } catch (error) {
      console.log(`   [WARN] ${keyword} の取得に失敗: ${error.message}`);
      results[keyword] = { label: keyword, items: [] };
    }
  };

  for (const keyword of KEYWORD_SEARCHES) {
    await collectForKeyword(keyword);
  }

  results.All = { label: 'All', items: Array.from(aggregate.values()).slice(0, MAX_ITEMS_PER_KEYWORD * KEYWORD_SEARCHES.length) };
  await context.close();
  await browser.close();
  return results;
}

async function loadFromFile(filePath) {
  const full = path.resolve(filePath);
  const content = await fs.readFile(full, 'utf8');
  return JSON.parse(content);
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    let results;
    if (args.from) {
      results = await loadFromFile(args.from);
    } else {
      results = await collectWithBrowser(args);
    }
    if (args.debug) {
      logPreview(results, { limit: 5 });
    }
    const referenceDate = args.date
      ? new Date(`${args.date}T00:00:00+09:00`)
      : new Date();
    const filteredResults = applyFilters(results, args.applyFilter);
    if (args.applyFilter) {
      const stats = filteredResults.__filterStats || {};
      delete filteredResults.__filterStats;
      for (const [region, payload] of Object.entries(filteredResults)) {
        const originalCount = (results[region]?.items || []).length;
        const filteredCount = (payload?.items || []).length;
        const regionStats = stats[region] || { titleHits: 0, analystHits: 0 };
        console.log(`   ${region}: ${filteredCount}/${originalCount} 件 (タイトル一致 ${regionStats.titleHits}, 著者一致 ${regionStats.analystHits})`);
      }
    }
    const dateFilteredResults = filterByDateRange(filteredResults, {
      fromDate: args.fromDate,
      toDate: args.toDate,
      referenceDate
    });
    if (args.fromDate || args.toDate) {
      for (const [region, payload] of Object.entries(dateFilteredResults)) {
        const beforeCount = (filteredResults[region]?.items || []).length;
        const afterCount = (payload?.items || []).length;
        console.log(`   ${region}: 日付フィルター後 ${afterCount}/${beforeCount} 件`);
      }
    }
    const summary = await writeRegionOutputs(dateFilteredResults, {
      outputDir: args.output,
      runDate: args.date || null,
      referenceDate
    });
    console.log(`✅ 出力先: ${summary.directory}`);
    console.log(`   合計件数: ${summary.combinedCount}`);
    if (!args.from) {
      console.log('   Googleドライブへのアップロードは、生成されたCSVをGoogleスプレッドシートにインポートしてください。');
    }
  } catch (error) {
    console.error('❌ エラー:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectWithBrowser,
  extractCards,
  parseArgs,
  loadFromFile
};
