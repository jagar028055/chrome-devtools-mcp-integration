const fs = require('fs/promises');
const path = require('path');

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeFilename(input) {
  if (!input) return 'output';
  const normalized = input
    .normalize('NFKD')
    .replace(/[^\w\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
  if (normalized) return normalized;
  return encodeURIComponent(input).replace(/%/g, '_').slice(0, 80) || 'output';
}

function toISODate(raw, referenceDate = new Date()) {
  if (!raw) return '';
  if (/\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.match(/\d{4}-\d{2}-\d{2}/)[0];
  }
  const jp = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jp) {
    const [, y, m, d] = jp;
    return [y, m.padStart(2, '0'), d.padStart(2, '0')].join('-');
  }
  const relHours = raw.match(/(\d+)\s*時間前/);
  if (relHours) {
    const hours = Number(relHours[1]);
    const date = new Date(referenceDate.getTime() - hours * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
  const relDays = raw.match(/(\d+)\s*日前/);
  if (relDays) {
    const days = Number(relDays[1]);
    const date = new Date(referenceDate.getTime() - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
  return '';
}

function normalizeEntry(entry, regionKey, label, referenceDate) {
  const analysts = ensureArray(entry.analysts).map((a) => a.trim()).filter(Boolean);
  const summary = (entry.summary || '').replace(/\s+/g, ' ').trim();
  const iso = toISODate(entry.date || entry.dateRaw, referenceDate);
  return {
    regionKey,
    region: label || regionKey,
    title: entry.title || '',
    url: entry.url || '',
    dateRaw: entry.date || entry.dateRaw || '',
    dateISO: iso,
    summary,
    category: entry.category || entry.categories || '',
    analysts: analysts.join('; ')
  };
}

function convertToCSV(rows, columns) {
  if (!rows || rows.length === 0) {
    const header = (columns || ['regionKey', 'region', 'title', 'url', 'dateISO', 'dateRaw', 'summary', 'category', 'analysts']).join(',');
    return `${header}\n`;
  }
  const cols = columns || Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value).replace(/"/g, '""');
    if (/[",\n]/.test(str)) {
      return `"${str}"`;
    }
    return str;
  };
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((col) => escape(row[col])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function writeRegionOutputs(results, options = {}) {
  const { outputDir = 'reports', runDate } = options;
  const reference = options.referenceDate || new Date();
  const dateStr = runDate || new Date(reference.getTime()).toISOString().slice(0, 10);

  const metaDir = path.join(outputDir, '.meta', dateStr);
  const visibleDir = path.join(outputDir, dateStr);

  await fs.mkdir(metaDir, { recursive: true });
  await fs.mkdir(visibleDir, { recursive: true });

  const metaJsonPath = path.join(metaDir, 'overseas_reports.json');
  const visibleJsonPath = path.join(visibleDir, 'overseas_reports.json');
  const serialized = JSON.stringify(results, null, 2);
  await fs.writeFile(metaJsonPath, serialized, 'utf8');
  await fs.writeFile(visibleJsonPath, serialized, 'utf8');

  const combined = [];
  for (const [regionKey, payload] of Object.entries(results)) {
    if (!payload || !payload.items) continue;
    const label = payload.label || regionKey;
    const normalized = payload.items.map((item) => normalizeEntry(item, regionKey, label, reference));
    combined.push(...normalized);
    const csv = convertToCSV(normalized);
    const filename = `${sanitizeFilename(regionKey)}.csv`;
    await fs.writeFile(path.join(metaDir, filename), csv, 'utf8');
    await fs.writeFile(path.join(visibleDir, filename), csv, 'utf8');
  }
  const combinedCsv = convertToCSV(combined);
  const metaCsvPath = path.join(metaDir, 'overseas_reports.csv');
  const visibleCsvPath = path.join(visibleDir, 'overseas_reports.csv');
  await fs.writeFile(metaCsvPath, combinedCsv, 'utf8');
  await fs.writeFile(visibleCsvPath, combinedCsv, 'utf8');
  return { directory: visibleDir, metaDirectory: metaDir, combinedCount: combined.length };
}

module.exports = {
  convertToCSV,
  writeRegionOutputs,
  normalizeEntry,
  toISODate,
  sanitizeFilename
};
