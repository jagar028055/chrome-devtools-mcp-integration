#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const { createBrowserContext } = require('./fulltext/browser');
const { loadSources } = require('./fulltext/sources');
const {
  resolveReportDirs,
  ensureDir,
  ensureArray
} = require('./fulltext/helpers');
const { fetchFullText } = require('./fulltext/extractors');
const { sanitizeFilename } = require('./reportUtils');
const { resolvePdfDir, savePdfBuffer } = require('./fulltext/pdfStorage');
const { createDriveUploader } = require('./fulltext/drive');
const { writeCategoryOutputs, updateOverseasCsv } = require('./fulltext/output');
const { loadEnv } = require('./config/env');
const { getFulltextEnv } = require('./config/fulltext');

const DEFAULT_RATE_WAIT_MS = 2000;
const DEFAULT_RETRY = 2;

const DISCLOSURE_CUTOFF_PATTERNS = [
  /アナリスト\s*証明/gi,
  /重要なディスクロージャー/gi,
  /Appendix\s*A-?1/gi,
  /Analyst\s+Certification/gi
];

loadEnv();

function trimDisclosureTail(text) {
  if (!text) return text;
  let cutoff = text.length;
  for (const pattern of DISCLOSURE_CUTOFF_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && match.index < cutoff) {
      cutoff = match.index;
    }
  }
  const sliced = cutoff < text.length ? text.slice(0, cutoff) : text;
  return sliced.replace(/[\s\u3000]+$/gu, '').trimEnd();
}

function parseArgs(argv) {
  const envConfig = getFulltextEnv();
  const defaultCategories = Array.from(new Set(envConfig.defaultCategories || []));
  const userCategories = [];
  let categorySpecified = false;
  const args = {
    date: null,
    storageState: 'storage_state.json',
    output: 'reports',
    categories: [...defaultCategories],
    all: false,
    headless: true,
    rateWait: DEFAULT_RATE_WAIT_MS,
    retries: DEFAULT_RETRY,
    driveFlatStructure: envConfig.driveFlatStructure,
    selectorWait: 5000,
    writePlain: false,
    debug: false,
    maxEntries: null,
    enableCdpFallback: false,
    driveUpload: envConfig.driveUpload,
    driveFolderId: envConfig.driveFolderId,
    driveAdditionalFolders: [...envConfig.driveAdditionalFolders],
    driveUseDateFolder: envConfig.driveUseDateFolder,
    driveDateFolderName: envConfig.driveDateFolderName,
    driveRootName: envConfig.driveRootName,
    driveProviderFallback: envConfig.driveProviderFallback,
    googleCredentials: envConfig.googleCredentials,
    googleTokenPath: envConfig.tokenPath,
    driveImpersonate: envConfig.driveImpersonate,
    driveShareAnyone: envConfig.driveShareAnyone,
    driveShareDomain: envConfig.driveShareDomain,
    driveShareRole: envConfig.driveShareRole,
    driveIgnoreShareErrors: envConfig.driveIgnoreShareErrors,
    driveAllowRootUpload: envConfig.driveAllowRootUpload,
    driveRetries: envConfig.driveRetries
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '-d' || arg === '--date') && argv[i + 1]) {
      args.date = argv[++i];
    } else if (arg === '--storage-state' && argv[i + 1]) {
      args.storageState = argv[++i];
    } else if ((arg === '-o' || arg === '--output') && argv[i + 1]) {
      args.output = argv[++i];
    } else if ((arg === '-c' || arg === '--category') && argv[i + 1]) {
      categorySpecified = true;
      userCategories.push(argv[++i]);
    } else if (arg === '--categories' && argv[i + 1]) {
      categorySpecified = true;
      userCategories.push(...argv[++i].split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--headless=false') {
      args.headless = false;
    } else if (arg === '--headless=true') {
      args.headless = true;
    } else if ((arg === '--rate-wait' || arg === '--wait') && argv[i + 1]) {
      args.rateWait = Number(argv[++i]) || DEFAULT_RATE_WAIT_MS;
    } else if ((arg === '--retries' || arg === '--retry') && argv[i + 1]) {
      args.retries = Math.max(0, Number(argv[++i]) || DEFAULT_RETRY);
    } else if (arg === '--write-plain') {
      args.writePlain = true;
    } else if (arg === '--debug') {
      args.debug = true;
    } else if ((arg === '--selector-wait') && argv[i + 1]) {
      args.selectorWait = Number(argv[++i]) || 5000;
    } else if ((arg === '--limit') && argv[i + 1]) {
      const limitValue = Number(argv[++i]);
      args.limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 1;
    } else if ((arg === '--max-entries' || arg === '--sample') && argv[i + 1]) {
      const maxEntriesValue = Number(argv[++i]);
      if (!Number.isFinite(maxEntriesValue) || maxEntriesValue <= 0) {
        throw new Error('--max-entries には 1 以上の数値を指定してください');
      }
      args.maxEntries = Math.floor(maxEntriesValue);
    } else if (arg === '--drive-upload') {
      args.driveUpload = true;
    } else if (arg === '--no-drive-upload') {
      args.driveUpload = false;
    } else if ((arg === '--drive-folder-id' || arg === '--drive-base-folder') && argv[i + 1]) {
      args.driveFolderId = argv[++i];
    } else if (arg === '--drive-subfolder' && argv[i + 1]) {
      args.driveAdditionalFolders.push(argv[++i]);
    } else if (arg === '--drive-no-date-folder') {
      args.driveUseDateFolder = false;
    } else if (arg === '--drive-date-folder' && argv[i + 1]) {
      args.driveUseDateFolder = true;
      args.driveDateFolderName = argv[++i];
    } else if (arg === '--google-credentials' && argv[i + 1]) {
      args.googleCredentials = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--google-token' && argv[i + 1]) {
      args.googleTokenPath = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--drive-impersonate' && argv[i + 1]) {
      args.driveImpersonate = argv[++i];
    } else if (arg === '--drive-share-anyone') {
      args.driveShareAnyone = true;
    } else if (arg === '--drive-share-domain' && argv[i + 1]) {
      args.driveShareDomain = argv[++i];
    } else if (arg === '--drive-share-role' && argv[i + 1]) {
      args.driveShareRole = argv[++i];
    } else if (arg === '--drive-ignore-share-errors') {
      args.driveIgnoreShareErrors = true;
    } else if ((arg === '--drive-root') && argv[i + 1]) {
      args.driveRootName = argv[++i];
    } else if ((arg === '--drive-provider-fallback') && argv[i + 1]) {
      args.driveProviderFallback = argv[++i];
    } else if (arg === '--drive-flat') {
      args.driveFlatStructure = true;
    } else if ((arg === '--drive-retries' || arg === '--drive-max-retries') && argv[i + 1]) {
      const driveRetriesValue = Number(argv[++i]);
      if (!Number.isFinite(driveRetriesValue) || driveRetriesValue <= 0) {
        throw new Error('--drive-retries には 1 以上の数値を指定してください');
      }
      args.driveRetries = Math.floor(driveRetriesValue);
    } else if (arg === '--drive-allow-root-upload') {
      args.driveAllowRootUpload = true;
    } else if (arg === '--enable-cdp-fallback' || arg === '--cdp') {
      args.enableCdpFallback = true;
    }
  }
  if (categorySpecified) {
    args.categories = Array.from(new Set(userCategories.filter(Boolean)));
  } else {
    args.categories = Array.from(new Set(args.categories.filter(Boolean)));
  }
  if (!args.date) {
    throw new Error('--date YYYY-MM-DD を指定してください');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date の形式が不正です: ${args.date}`);
  }
  if (!args.all && args.categories.length === 0) {
    throw new Error('--category もしくは --all を指定するか、FULLTEXT_DEFAULT_CATEGORIES を設定してください');
  }
  return args;
}

function normalizeCategories(entries) {
  const set = new Set();
  for (const entry of entries) {
    ensureArray(entry.sources).forEach((src) => src && set.add(src));
    if (entry.category) set.add(entry.category);
  }
  return Array.from(set);
}

function deriveEntryId(entry) {
  if (entry.publicationId) return String(entry.publicationId);
  if (entry.metadata?.id) return String(entry.metadata.id);
  if (entry.url) {
    try {
      const url = new URL(entry.url);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        return segments[segments.length - 1];
      }
    } catch (error) {
      // ignore
    }
  }
  const base = `${entry.dateISO || entry.dateRaw || ''}-${entry.title || ''}`;
  return sanitizeFilename(base).slice(0, 60) || `entry-${Date.now()}`;
}

function buildSnippet(text, length = 200) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
}

function sanitizeDriveText(value) {
  if (!value) return '';
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDescriptor(entry) {
  if (!entry) return '';
  const primary = sanitizeDriveText(entry.summary || '');
  if (primary) {
    const truncated = primary.slice(0, 50).trim();
    return truncated.replace(/[、,;]+$/g, '').trim();
  }
  if (entry.text) {
    const lines = String(entry.text)
      .split('\n')
      .map((line) => sanitizeDriveText(line))
      .filter((line) => line.length > 0);
    const discardPatterns = [
      /^20\d{2}\s*年/,
      /^本レポート/,
      /^ＳＭＢＣ日興証券/,
      /^SMBC\s*NIKKO/i,
      /^For the exclusive use/i
    ];
    const descriptorLine = lines.find((line) => !discardPatterns.some((pattern) => pattern.test(line)));
    if (descriptorLine) return descriptorLine;
  }
  if (entry.snippet) {
    return sanitizeDriveText(entry.snippet);
  }
  return '';
}

function buildDriveFileName(entry, fallbackId, dateStr) {
  const rawTitle = sanitizeDriveText(entry && entry.title ? entry.title : '');
  const descriptor = extractDescriptor(entry);
  const sanitizedDescriptor = descriptor ? sanitizeDriveText(descriptor) : '';

  const segments = [];
  if (dateStr) segments.push(sanitizeDriveText(dateStr));
  if (rawTitle) segments.push(rawTitle);
  if (sanitizedDescriptor && sanitizedDescriptor !== rawTitle) {
    const maxDescriptorLength = 80;
    const clipped = sanitizedDescriptor.length > maxDescriptorLength
      ? `${sanitizedDescriptor.slice(0, maxDescriptorLength).trim()}`
      : sanitizedDescriptor;
    segments.push(clipped);
  }
  let combined = segments.filter(Boolean).join('_');
  const maxCombinedLength = 180;
  if (!combined) {
    combined = fallbackId || 'report';
  } else if (combined.length > maxCombinedLength) {
    combined = combined.slice(0, maxCombinedLength).trim();
  }
  return `${combined}.pdf`;
}

function sanitizeDriveSegment(value, fallback = 'unknown') {
  const raw = (value || '').trim();
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

const PROVIDER_RULES = [
  { pattern: /nomuranow\.com|nomura/i, slug: 'nomura' },
  { pattern: /mizuho/i, slug: 'mizuho' },
  { pattern: /daiwa/i, slug: 'daiwa' },
  { pattern: /smbc|nikko/i, slug: 'smbc-nikko' },
  { pattern: /jp\.ubs|ubs\.com/i, slug: 'ubs' },
  { pattern: /goldmansachs/i, slug: 'goldman-sachs' }
];

function deriveProviderSlug(entry, fallback = 'unknown') {
  const candidateUrls = [
    entry?.url,
    entry?.meta?.downloadUrl,
    entry?.detector?.downloadUrl
  ].filter(Boolean);
  for (const url of candidateUrls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const rule of PROVIDER_RULES) {
        if (rule.pattern.test(host)) {
          return sanitizeDriveSegment(rule.slug, fallback);
        }
      }
      const parts = host.split('.').filter(Boolean);
      if (parts.length >= 2) {
        const base = sanitizeDriveSegment(parts.slice(-2, -1)[0]);
        if (base && base !== 'unknown') {
          return base;
        }
      }
    } catch (error) {
      // ignore parse errors
    }
  }
  return sanitizeDriveSegment(fallback);
}

function categoriesForEntry(entry, activeCategories) {
  if (!activeCategories || activeCategories.size === 0) {
    return ensureArray(entry.sources).filter(Boolean);
  }
  const matched = new Set();
  ensureArray(entry.sources).forEach((source) => {
    if (activeCategories.has(source)) matched.add(source);
  });
  if (entry.category && activeCategories.has(entry.category)) {
    matched.add(entry.category);
  }
  return Array.from(matched);
}


async function writeFailures(reportDir, failures) {
  if (failures.length === 0) return;
  const header = 'category,title,url,error,attempts\n';
  const lines = failures.map((item) => {
    const category = ensureArray(item.categories).join('; ');
    const title = item.title || '';
    const url = item.url || '';
    const error = (item.error || '').replace(/[\r\n]+/g, ' ');
    const attempts = item.attempts || 0;
    return [category, title, url, error, attempts]
      .map((value) => {
        const str = String(value ?? '').replace(/"/g, '""');
        if (/[",\n]/.test(str)) return `"${str}"`;
        return str;
      })
      .join(',');
  });
  const dir = path.join(reportDir, 'fulltext');
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'failed.csv'), `${header}${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    const { metaDir: reportDir, visibleDir } = resolveReportDirs(args.output, args.date);
    await ensureDir(path.join(reportDir, 'fulltext'));
    await ensureDir(visibleDir);
    const pdfDir = resolvePdfDir(args.date);
    await ensureDir(pdfDir);
    let driveUploader = null;
    if (args.driveUpload) {
      if (!args.driveFolderId && !args.driveAllowRootUpload) {
        throw new Error('Driveアップロードを有効にする場合は --drive-folder-id もしくは FULLTEXT_DRIVE_FOLDER_ID を指定してください');
      }
      const additionalFolders = [];
      if (!args.driveFlatStructure && args.driveRootName) {
        additionalFolders.push(args.driveRootName);
      }
      const extraFolders = Array.from(new Set(args.driveAdditionalFolders || []))
        .filter(Boolean);
      if (!args.driveFlatStructure) {
        additionalFolders.push(...extraFolders);
      }
      const dateFolderName = (!args.driveFlatStructure && args.driveUseDateFolder)
        ? (args.driveDateFolderName || args.date)
        : null;
      driveUploader = await createDriveUploader({
        credentialsPath: args.googleCredentials || undefined,
        tokenPath: args.googleTokenPath || undefined,
        impersonate: args.driveImpersonate || undefined,
        baseFolderId: args.driveFolderId || undefined,
        additionalFolders,
        dateFolderName,
        shareAnyone: !!args.driveShareAnyone,
        shareDomain: args.driveShareDomain || undefined,
        shareRole: args.driveShareRole || 'reader',
        ignoreShareErrors: !!args.driveIgnoreShareErrors,
        retry: { attempts: args.driveRetries },
        debug: args.debug,
        allowRootUpload: !!args.driveAllowRootUpload
      });
      if (args.debug) {
        console.log(`[drive] アップロード先フォルダID: ${driveUploader.folderId}`);
      }
    }
    const referenceDate = new Date(`${args.date}T00:00:00+09:00`);
    const rawSources = await loadSources({
      reportDir,
      categories: args.all ? null : args.categories,
      referenceDate
    });
    if (rawSources.length === 0) {
      console.log('対象レポートが見つかりませんでした');
      return;
    }
    const filteredSources = rawSources.filter((entry) => {
      if (!entry || !entry.dateISO) return false;
      return entry.dateISO === args.date;
    });
    if (args.debug) {
      console.log(`[debug] ソース件数: ${rawSources.length}件 -> 日付フィルター(${args.date})後 ${filteredSources.length}件`);
    }
    if (filteredSources.length === 0) {
      console.log(`対象レポートが見つかりませんでした (date=${args.date})`);
      return;
    }
    const allCategories = normalizeCategories(filteredSources);
    const activeList = args.all ? allCategories : args.categories;
    const activeSet = new Set(activeList);
    if (activeList.length === 0) {
      console.log('対象カテゴリが空です');
      return;
    }
    const categoryResults = new Map();
    activeList.forEach((category) => {
      categoryResults.set(category, []);
    });
    const resultsMap = new Map();
    const failures = [];
    const driveFailures = [];
    let driveAttempted = 0;
    let driveUploaded = 0;
    const categoryAttemptCounts = new Map();
    const drivePdfFolderCache = new Map();

    const modeLabel = args.all ? '全カテゴリ' : activeList.join(', ');
    const headlessLabel = args.headless === false ? '表示' : 'ヘッドレス';
    console.log(`=== 本文取得開始: date=${args.date} / 対象=${modeLabel} / ブラウザ=${headlessLabel} / wait=${args.rateWait}ms ===`);

    const session = await createBrowserContext({
      storageState: args.storageState,
      headless: args.headless,
      debug: args.debug
    });

    try {
      let processed = 0;
      let success = 0;
      const startedAt = Date.now();
      for (const entry of filteredSources) {
        const matchedCategories = categoriesForEntry(entry, activeSet);
        if (matchedCategories.length === 0) continue;

        const eligibleCategories = args.limit
          ? matchedCategories.filter((category) => (categoryAttemptCounts.get(category) || 0) < args.limit)
          : matchedCategories;

        if (eligibleCategories.length === 0) continue;
        let attempts = 0;
        let lastError = null;
        let result = null;
        const entryId = deriveEntryId(entry);
        while (attempts <= args.retries) {
          attempts += 1;
          try {
            result = await fetchFullText(entry, session, {
              rateWait: args.rateWait,
              htmlOptions: { selectorWait: args.selectorWait },
              enableCdpFallback: args.enableCdpFallback,
              entryId,
              date: args.date
            });
            break;
          } catch (error) {
            lastError = error;
            if (args.debug) {
              console.log(`   [DEBUG] ${entry.title || entry.url} 失敗 (${attempts}/${args.retries + 1}): ${error.message}`);
            }
            if (attempts > args.retries) break;
          }
        }
        processed += 1;
        if (result) {
          success += 1;
          const textValue = trimDisclosureTail(result.text || '');
          const id = entryId;
          const snippet = buildSnippet(textValue, 200);
          const pdfBuffer = result.buffer;
          const pdfMeta = result.meta || {};
          const providerSlug = deriveProviderSlug(entry, args.driveProviderFallback);
          let pdfSaved = null;
          if (pdfBuffer && pdfBuffer.length > 0) {
            try {
              pdfSaved = await savePdfBuffer({
                baseDir: pdfDir,
                entryId: id,
                buffer: pdfBuffer
              });
            } catch (error) {
              console.warn(`PDF保存に失敗しました (${entry.title || entry.url}): ${error.message}`);
            }
          }
          const payload = {
            id,
            url: entry.url,
            title: entry.title,
            categoryList: matchedCategories,
            dateISO: entry.dateISO || '',
            dateRaw: entry.dateRaw || '',
            summary: entry.summary || '',
            analysts: ensureArray(entry.analysts),
            sources: ensureArray(entry.sources),
            type: result.type,
            text: textValue,
            snippet,
            detector: result.detector,
            meta: pdfMeta,
            fetchedAt: new Date().toISOString(),
            pdfPath: pdfSaved ? pdfSaved.relativePath : null,
            pdfHash: pdfSaved ? pdfSaved.hash : null,
            pdfSize: pdfSaved ? pdfSaved.size : null,
            pdfDownloadUrl: pdfMeta.downloadUrl || null,
            provider: providerSlug,
            driveFileId: null,
            driveFileName: null,
            driveLink: null,
            driveFolderId: null,
            driveMimeType: null,
            driveUploadedAt: null,
            driveError: null
          };

          if (driveUploader && pdfSaved && pdfBuffer && pdfBuffer.length > 0) {
            driveAttempted += 1;
            const driveFileName = buildDriveFileName(entry, id, args.date);
            const driveProperties = {
              entryId: String(id || ''),
              entryUrl: entry.url || '',
              dateISO: entry.dateISO || '',
              categories: matchedCategories.join(';'),
              pdfHash: pdfSaved.hash || '',
              pdfPath: pdfSaved.relativePath || '',
              source: 'fetchFulltext',
              provider: providerSlug
            };
            try {
              let uploadFolderId = null;
              if (!args.driveFlatStructure) {
                uploadFolderId = drivePdfFolderCache.get(providerSlug) || null;
                if (!uploadFolderId) {
                  uploadFolderId = await driveUploader.ensureSubfolder([providerSlug, 'pdf']);
                  drivePdfFolderCache.set(providerSlug, uploadFolderId);
                }
              }
              const driveResult = await driveUploader.uploadPdf({
                buffer: pdfBuffer,
                fileName: driveFileName,
                description: entry.summary ? entry.summary.slice(0, 900) : undefined,
                properties: driveProperties,
                folderId: uploadFolderId || undefined
              });
              payload.driveFileId = driveResult.id || null;
              payload.driveFileName = driveResult.name || driveFileName;
              payload.driveLink = driveResult.webViewLink || driveResult.webContentLink || null;
              payload.driveFolderId = (uploadFolderId || driveUploader.folderId) || null;
              payload.driveMimeType = driveResult.mimeType || 'application/pdf';
              payload.driveUploadedAt = driveResult.modifiedTime || driveResult.createdTime || new Date().toISOString();
              driveUploaded += 1;
            } catch (error) {
              const message = error && error.message ? error.message : 'Driveアップロードに失敗しました';
              payload.driveError = message;
              driveFailures.push({
                categories: eligibleCategories.length ? eligibleCategories : matchedCategories,
                title: entry.title,
                url: entry.url,
                error: `Driveアップロード失敗: ${message}`,
                attempts: args.driveRetries
              });
              if (args.debug) {
                console.warn(`[drive] アップロード失敗: ${entry.title || entry.url}: ${message}`);
              }
            }
          }
          for (const category of eligibleCategories) {
            const list = categoryResults.get(category) || [];
            const referencePath = `${path.posix.join('fulltext', `${sanitizeFilename(category)}.json`)}::${id}`;
            list.push({ ...payload, category });
            categoryResults.set(category, list);
            const existing = resultsMap.get(entry.url);
            if (existing) {
              existing.paths.add(referencePath);
              existing.snippet = snippet;
              if (!existing.pdfPaths) existing.pdfPaths = new Set();
              if (!existing.driveLinks) existing.driveLinks = new Set();
              if (!existing.driveFileIds) existing.driveFileIds = new Set();
              if (payload.pdfPath) existing.pdfPaths.add(payload.pdfPath);
              if (payload.driveLink) existing.driveLinks.add(payload.driveLink);
              if (payload.driveFileId) existing.driveFileIds.add(payload.driveFileId);
              existing.provider = providerSlug;
            } else {
              resultsMap.set(entry.url, {
                paths: new Set([referencePath]),
                snippet,
                pdfPaths: payload.pdfPath ? new Set([payload.pdfPath]) : new Set(),
                driveLinks: payload.driveLink ? new Set([payload.driveLink]) : new Set(),
                driveFileIds: payload.driveFileId ? new Set([payload.driveFileId]) : new Set(),
                provider: providerSlug
              });
            }
          }
        } else {
          failures.push({
            categories: eligibleCategories.length ? eligibleCategories : matchedCategories,
            title: entry.title,
            url: entry.url,
            error: lastError ? lastError.message : '不明なエラー',
            attempts
          });
        }
        eligibleCategories.forEach((category) => {
          const current = categoryAttemptCounts.get(category) || 0;
          categoryAttemptCounts.set(category, current + 1);
        });

        if (args.maxEntries && processed >= args.maxEntries) {
          console.log(`--max-entries=${args.maxEntries} に到達したため処理を終了します`);
          break;
        }
      }
      const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const baseSummary = `処理件数: ${processed} / 成功: ${success} / 失敗: ${failures.length} / 所要時間: ${durationSec}秒`;
      if (driveUploader) {
        console.log(`${baseSummary} / Driveアップロード: ${driveUploaded}/${driveAttempted} / Drive失敗: ${driveFailures.length}`);
      } else {
        console.log(baseSummary);
      }
    } finally {
      await session.dispose();
    }

    await writeCategoryOutputs(reportDir, categoryResults, {
      writePlain: args.writePlain,
      plainDir: path.join(visibleDir, 'plain')
    });
    await updateOverseasCsv(reportDir, resultsMap);
    await writeFailures(reportDir, [...failures, ...driveFailures]);
    console.log('本文取得を完了しました');
  } catch (error) {
    console.error('❌ エラー:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  deriveEntryId,
  buildSnippet
};
