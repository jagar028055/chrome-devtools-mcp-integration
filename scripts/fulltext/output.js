const fs = require('fs/promises');
const path = require('path');
const { ensureDir, parseCSV, readFileIfExists } = require('./helpers');
const { sanitizeFilename, convertToCSV } = require('../reportUtils');

const CSV_COLUMNS = ['regionKey', 'region', 'title', 'url', 'dateISO', 'dateRaw', 'summary', 'category', 'analysts'];

async function writeCategoryOutputs(reportDir, categoryResults, context = {}) {
  const index = {};
  const now = new Date().toISOString();
  const metaFulltextDir = path.join(reportDir, 'fulltext');
  await ensureDir(metaFulltextDir);

  const plainDir = context.writePlain
    ? path.resolve(context.plainDir || path.join(metaFulltextDir, 'plain'))
    : null;

  const usedPlainNames = new Set();
  if (context.writePlain) {
    await fs.rm(plainDir, { recursive: true, force: true }).catch(() => {});
    await ensureDir(plainDir);
  }
  for (const [category, items] of categoryResults.entries()) {
    const safeName = sanitizeFilename(category);
    const payload = {
      category,
      generatedAt: now,
      total: items.length,
      items
    };
    const targetPath = path.join(metaFulltextDir, `${safeName}.json`);
    await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), 'utf8');
    index[category] = { path: path.relative(reportDir, targetPath), count: items.length };
    if (context.writePlain) {
      const buildPlainFilename = (item) => {
        const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
        const fallbackId = item.id ? String(item.id) : 'report';
        const baseSource = rawTitle || fallbackId || 'report';
        let base = baseSource
          .replace(/[\\/:*?"<>|]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!base) base = fallbackId || 'report';
        const maxLength = 120;
        if (base.length > maxLength) base = base.slice(0, maxLength).trim();
        base = base.replace(/\.+$/, '') || fallbackId || 'report';
        let candidate = `${base}.txt`;
        let counter = 2;
        while (usedPlainNames.has(candidate)) {
          const suffix = ` (${counter})`;
          const trimmedBase = base.slice(0, Math.max(1, maxLength - suffix.length));
          candidate = `${trimmedBase}${suffix}.txt`;
          counter += 1;
        }
        usedPlainNames.add(candidate);
        return candidate;
      };
      for (const item of items) {
        const plainName = buildPlainFilename(item);
        const textValue = typeof item.text === 'string'
          ? item.text
          : (item.text == null ? '' : String(item.text));
        await fs.writeFile(path.join(plainDir, plainName), textValue, 'utf8');
      }
    }
  }
  await fs.writeFile(path.join(metaFulltextDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

async function updateOverseasCsv(reportDir, resultsMap) {
  const csvPath = path.join(reportDir, 'overseas_reports.csv');
  const csvContent = await readFileIfExists(csvPath);
  if (!csvContent) return;
  const rows = parseCSV(csvContent);
  const updated = rows.map((row) => {
    const info = resultsMap.get(row.url);
    const pathValue = info ? Array.from(info.paths).join('; ') : '';
    const pdfValue = info ? Array.from(info.pdfPaths || []).join('; ') : '';
    const driveLinkValue = info ? Array.from(info.driveLinks || []).join('; ') : '';
    return {
      ...row,
      fulltextPath: pathValue,
      fulltextSnippet: info ? info.snippet : '',
      pdfPath: pdfValue,
      driveLink: driveLinkValue
    };
  });
  const columns = [...CSV_COLUMNS, 'fulltextPath', 'fulltextSnippet', 'pdfPath', 'driveLink'];
  const content = convertToCSV(updated, columns);
  await fs.writeFile(csvPath, content, 'utf8');
}

module.exports = {
  writeCategoryOutputs,
  updateOverseasCsv
};
