const path = require('path');
const {
  loadOverseasReports,
  loadCategoryCSV,
  dedupeByUrl,
  ensureArray,
  loadJSON
} = require('./helpers');
const { toISODate } = require('../reportUtils');

function normalizeFromJson(item, categoryKey, options = {}) {
  if (!item) return null;
  const referenceDate = options.referenceDate || new Date();
  const dateISO = item.dateISO || toISODate(item.date || item.dateRaw, referenceDate);
  const analysts = ensureArray(item.analysts).map((name) => name.trim()).filter(Boolean);
  const sources = new Set(ensureArray(item.sources));
  if (categoryKey) sources.add(categoryKey);
  return {
    id: item.url || `${categoryKey}:${item.title || ''}:${item.date || item.dateRaw || ''}`,
    url: item.url || '',
    title: item.title || '',
    category: categoryKey,
    dateISO: dateISO || '',
    dateRaw: item.date || item.dateRaw || '',
    summary: item.summary || '',
    analysts,
    sources: Array.from(sources),
    publicationId: item.publicationId || item.id || '',
    metadata: item.metadata || {}
  };
}

function normalizeFromCsv(row, categoryKey) {
  if (!row) return null;
  const analysts = row.analysts ? row.analysts.split(/;\s*/).filter(Boolean) : [];
  const sources = new Set();
  if (categoryKey) sources.add(categoryKey);
  if (row.regionKey) sources.add(row.regionKey);
  if (row.category) sources.add(row.category);
  return {
    id: row.url || `${row.regionKey}:${row.title}:${row.dateRaw}`,
    url: row.url || '',
    title: row.title || '',
    category: categoryKey || row.region || row.regionKey || '',
    dateISO: row.dateISO || '',
    dateRaw: row.dateRaw || '',
    summary: row.summary || '',
    analysts,
    sources: Array.from(sources)
  };
}

async function loadSources(options = {}) {
  const {
    reportDir,
    categories,
    includeJson = true,
    includeCsv = true,
    referenceDate = new Date()
  } = options;
  if (!reportDir) throw new Error('reportDir を指定してください');

  const normalizedCategories = ensureArray(categories).filter(Boolean);
  const targetCategories = normalizedCategories.length > 0 ? normalizedCategories : null;

  const overseas = includeJson ? await loadOverseasReports(reportDir) : {};
  const sources = [];

  if (includeJson && overseas) {
    const keys = Object.keys(overseas).filter((key) => key !== '__filterStats');
    for (const key of keys) {
      if (targetCategories && !targetCategories.includes(key)) continue;
      const payload = overseas[key];
      const items = ensureArray(payload?.items);
      for (const item of items) {
        const normalized = normalizeFromJson(item, key, { referenceDate });
        if (normalized && normalized.url) {
          sources.push(normalized);
        }
      }
    }
  }

  if (includeCsv) {
    const csvCategories = targetCategories || (await inferCategoriesFromDirectory(reportDir));
    for (const categoryKey of csvCategories) {
      const rows = await loadCategoryCSV(reportDir, categoryKey);
      for (const row of rows) {
        const normalized = normalizeFromCsv(row, categoryKey);
        if (normalized && normalized.url) {
          sources.push(normalized);
        }
      }
    }
  }

  return dedupeByUrl(sources).map((entry) => ({
    ...entry,
    dateISO: entry.dateISO || toISODate(entry.dateRaw, referenceDate)
  }));
}

async function inferCategoriesFromDirectory(reportDir) {
  const jsonPath = path.join(reportDir, 'overseas_reports.json');
  const payload = await loadJSON(jsonPath);
  if (payload) {
    return Object.keys(payload).filter((key) => key !== '__filterStats');
  }
  return [];
}

module.exports = {
  loadSources,
  inferCategoriesFromDirectory
};
