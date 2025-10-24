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
  const args = {
    output: 'reports',
    storageState: null,
    from: null,
    date: null,
    applyFilter: false,
    fromDate: null,
    toDate: null,
    debug: false,
    providers: [],
    smbcCategories: [],
    smbcMaxPages: null,
    smbcMaxItems: null,
    smbcTimeout: 30000,
    daiwaCategories: [],
    daiwaMaxPages: null,
    daiwaMaxItems: null,
    daiwaTimeout: 45000,
    daiwaWaitAfterSearch: null,
    daiwaKeywordDelay: null
  };
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
    } else if (arg === '--provider' && argv[i + 1]) {
      args.providers.push(argv[++i]);
    } else if (arg === '--providers' && argv[i + 1]) {
      args.providers.push(...argv[++i].split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg === '--smbc-category' && argv[i + 1]) {
      args.smbcCategories.push(argv[++i]);
    } else if (arg === '--smbc-categories' && argv[i + 1]) {
      args.smbcCategories.push(...argv[++i].split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg === '--smbc-max-pages' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.smbcMaxPages = Math.floor(value);
      }
    } else if (arg === '--smbc-max-items' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.smbcMaxItems = Math.floor(value);
      }
    } else if ((arg === '--smbc-timeout' || arg === '--provider-timeout') && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 5000) {
        args.smbcTimeout = Math.floor(value);
      }
    } else if (arg === '--daiwa-category' && argv[i + 1]) {
      args.daiwaCategories.push(argv[++i]);
    } else if (arg === '--daiwa-categories' && argv[i + 1]) {
      args.daiwaCategories.push(...argv[++i].split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg === '--daiwa-max-pages' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.daiwaMaxPages = Math.floor(value);
      }
    } else if (arg === '--daiwa-max-items' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        args.daiwaMaxItems = Math.floor(value);
      }
    } else if (arg === '--daiwa-timeout' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 5000) {
        args.daiwaTimeout = Math.floor(value);
      }
    } else if (arg === '--daiwa-wait-after-search' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        args.daiwaWaitAfterSearch = Math.floor(value);
      }
    } else if (arg === '--daiwa-keyword-delay' && argv[i + 1]) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        args.daiwaKeywordDelay = Math.floor(value);
      }
    }
  }
  args.providers = Array.from(new Set(args.providers.filter(Boolean)));
  args.smbcCategories = Array.from(new Set(args.smbcCategories.filter(Boolean)));
  args.daiwaCategories = Array.from(new Set(args.daiwaCategories.filter(Boolean)));
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

function normalizeProviderKey(input) {
  const key = String(input || '').toLowerCase();
  if (key === 'nomura' || key === 'nom') return 'nomura';
  if (key === 'smbc' || key === 'smbc-nikko' || key === 'smbcnikko') return 'smbc-nikko';
  if (key === 'daiwa' || key === 'daiwa-securities' || key === 'daiwasecurities' || key === 'daiwa_sec') return 'daiwa';
  return key;
}

function getTodayString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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
    const providerList = (args.providers.length > 0 ? args.providers : ['nomura']).map(normalizeProviderKey);
    const providerSet = new Set(providerList);

    let resolvedDate = args.date || null;

    if (providerSet.has('nomura')) {
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
      resolvedDate = path.basename(summary.directory);
      console.log(`✅ Nomura: 出力先 ${summary.directory}`);
      console.log(`   合計件数: ${summary.combinedCount}`);
      if (!args.from) {
        console.log('   Googleドライブへのアップロードは、生成されたCSVをGoogleスプレッドシートにインポートしてください。');
      }
    }

    const providerDate = resolvedDate || args.date || getTodayString();

    if (providerSet.has('smbc-nikko')) {
      const { parseArgs: parseSmbcArgs, runCollector: runSmbcCollector } = require('./providers/smbc');
      const smbcArgv = ['node', 'smbc', '--output', args.output, '--date', providerDate];
      if (args.storageState) {
        smbcArgv.push('--storage-state', args.storageState);
      }
      if (args.headless === false) {
        smbcArgv.push('--headless=false');
      }
      if (args.debug) {
        smbcArgv.push('--debug');
      }
      if (args.smbcCategories.length > 0) {
        smbcArgv.push('--categories', args.smbcCategories.join(','));
      }
      if (args.smbcMaxPages) {
        smbcArgv.push('--max-pages', String(args.smbcMaxPages));
      }
      if (args.smbcMaxItems) {
        smbcArgv.push('--max-items', String(args.smbcMaxItems));
      }
      if (args.smbcTimeout && args.smbcTimeout !== 30000) {
        smbcArgv.push('--timeout', String(args.smbcTimeout));
      }
      const smbcArgs = parseSmbcArgs(smbcArgv);
      await runSmbcCollector(smbcArgs);
    }

    if (providerSet.has('daiwa')) {
      const { parseArgs: parseDaiwaArgs, runCollector: runDaiwaCollector } = require('./providers/daiwa');
      const daiwaArgv = ['node', 'daiwa', '--output', args.output, '--date', providerDate];
      if (args.storageState) {
        daiwaArgv.push('--storage-state', args.storageState);
      }
      if (args.headless === false) {
        daiwaArgv.push('--headless=false');
      }
      if (args.debug) {
        daiwaArgv.push('--debug');
      }
      if (args.daiwaCategories.length > 0) {
        daiwaArgv.push('--categories', args.daiwaCategories.join(','));
      }
      if (args.daiwaMaxPages) {
        daiwaArgv.push('--max-pages', String(args.daiwaMaxPages));
      }
      if (args.daiwaMaxItems) {
        daiwaArgv.push('--max-items', String(args.daiwaMaxItems));
      }
      if (args.daiwaTimeout) {
        daiwaArgv.push('--timeout', String(args.daiwaTimeout));
      }
      if (args.daiwaWaitAfterSearch !== null && args.daiwaWaitAfterSearch !== undefined) {
        daiwaArgv.push('--wait-after-search', String(args.daiwaWaitAfterSearch));
      }
      if (args.daiwaKeywordDelay !== null && args.daiwaKeywordDelay !== undefined) {
        daiwaArgv.push('--keyword-delay', String(args.daiwaKeywordDelay));
      }
      const daiwaArgs = parseDaiwaArgs(daiwaArgv);
      await runDaiwaCollector(daiwaArgs);
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
