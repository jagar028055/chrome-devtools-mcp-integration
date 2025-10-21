const fs = require('fs/promises');
const path = require('path');
const { sanitizeFilename } = require('../reportUtils');

function resolveReportDirs(baseDir, runDate) {
  if (!runDate) throw new Error('日付を YYYY-MM-DD 形式で指定してください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw new Error(`日付形式が不正です: ${runDate}`);
  }
  const root = path.resolve(baseDir || 'reports');
  return {
    metaDir: path.join(root, '.meta', runDate),
    visibleDir: path.join(root, runDate)
  };
}

function resolveReportDir(baseDir, runDate) {
  return resolveReportDirs(baseDir, runDate).metaDir;
}

async function readFileIfExists(absPath) {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadJSON(filePath) {
  const content = await readFileIfExists(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${filePath} のJSON解析に失敗しました: ${error.message}`);
  }
}

function parseCSV(content) {
  if (!content) return [];
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const [header, ...rest] = rows;
  return rest.filter((r) => r.length === header.length).map((fields) => {
    const entry = {};
    for (let i = 0; i < header.length; i += 1) {
      entry[header[i]] = fields[i] ?? '';
    }
    return entry;
  });
}

async function loadCategoryCSV(reportDir, category) {
  const safeName = sanitizeFilename(category);
  const csvPath = path.join(reportDir, `${safeName}.csv`);
  const content = await readFileIfExists(csvPath);
  if (content === null) return [];
  return parseCSV(content);
}

async function loadOverseasReports(reportDir) {
  const jsonPath = path.join(reportDir, 'overseas_reports.json');
  const payload = await loadJSON(jsonPath);
  if (!payload) return {};
  return payload;
}

function dedupeByUrl(entries) {
  const seen = new Map();
  for (const item of entries) {
    const key = item.url || item.id;
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      const existing = seen.get(key);
      const mergedSources = new Set([]);
      ensureArray(existing.sources).forEach((value) => mergedSources.add(value));
      ensureArray(item.sources).forEach((value) => mergedSources.add(value));
      seen.set(key, { ...existing, ...item, sources: Array.from(mergedSources) });
    }
  }
  return Array.from(seen.values());
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  resolveReportDir,
  loadOverseasReports,
  loadCategoryCSV,
  parseCSV,
  dedupeByUrl,
  ensureDir,
  sleep,
  ensureArray,
  readFileIfExists,
  loadJSON,
  resolveReportDirs
};
