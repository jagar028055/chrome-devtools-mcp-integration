const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ensureDir } = require('./helpers');
const { sanitizeFilename } = require('../reportUtils');

function resolvePdfDir(runDate, options = {}) {
  if (!runDate) {
    throw new Error('PDF保存先を解決するには runDate が必要です');
  }
  const rootDir = options.rootDir || path.resolve(process.cwd(), 'tmp', 'fulltext-pdf');
  return path.resolve(rootDir, runDate);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function savePdfBuffer({ baseDir, entryId, buffer, hash }) {
  if (!baseDir) {
    throw new Error('savePdfBuffer には baseDir が必要です');
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('保存対象のPDFバッファが空です');
  }
  const digest = hash || crypto.createHash('sha256').update(buffer).digest('hex');
  const safeId = sanitizeFilename(entryId || `entry-${digest.slice(0, 8)}`);
  const trimmedId = safeId ? safeId.slice(0, 80) : `entry-${digest.slice(0, 8)}`;
  const fileName = `${trimmedId || `entry-${digest.slice(0, 8)}`}-${digest.slice(0, 16)}.pdf`;
  const absolutePath = path.join(baseDir, fileName);
  await ensureDir(baseDir);
  const alreadyExists = await fileExists(absolutePath);
  if (!alreadyExists) {
    await fs.writeFile(absolutePath, buffer);
  }
  return {
    absolutePath,
    relativePath: path.relative(process.cwd(), absolutePath),
    fileName,
    hash: digest,
    size: buffer.length,
    isNew: !alreadyExists
  };
}

module.exports = {
  resolvePdfDir,
  savePdfBuffer
};
