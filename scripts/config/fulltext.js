const path = require('path');

const DEFAULT_DRIVE_RETRIES = 3;

function resolvePath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function asBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return defaultValue;
}

function asNumber(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return defaultValue;
}

function asList(value) {
  if (!value) return [];
  return String(value)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getFulltextEnv() {
  const defaultTokenPath = path.resolve(process.cwd(), 'secure/credentials/token.json');
  return {
    driveUpload: asBoolean(process.env.FULLTEXT_DRIVE_UPLOAD, false),
    driveFolderId: process.env.FULLTEXT_DRIVE_FOLDER_ID || null,
    driveAdditionalFolders: asList(process.env.FULLTEXT_DRIVE_SUBFOLDERS),
    driveUseDateFolder: asBoolean(process.env.FULLTEXT_DRIVE_USE_DATE_FOLDER, true),
    driveDateFolderName: process.env.FULLTEXT_DRIVE_DATE_FOLDER_NAME || null,
    driveRootName: process.env.FULLTEXT_DRIVE_ROOT_NAME || 'ResearchReports',
    driveProviderFallback: process.env.FULLTEXT_PROVIDER_FALLBACK || 'unknown',
    driveFlatStructure: asBoolean(process.env.FULLTEXT_DRIVE_FLAT, false),
    defaultCategories: asList(process.env.FULLTEXT_DEFAULT_CATEGORIES),
    googleCredentials: resolvePath(process.env.GOOGLE_APPLICATION_CREDENTIALS || null),
    tokenPath: process.env.GOOGLE_TOKEN_PATH ? resolvePath(process.env.GOOGLE_TOKEN_PATH) : defaultTokenPath,
    driveImpersonate: process.env.GOOGLE_DRIVE_IMPERSONATE || null,
    driveShareAnyone: asBoolean(process.env.GOOGLE_DRIVE_SHARE_ANYONE, false),
    driveShareDomain: process.env.GOOGLE_DRIVE_SHARE_DOMAIN || null,
    driveShareRole: process.env.GOOGLE_DRIVE_SHARE_ROLE || 'reader',
    driveIgnoreShareErrors: asBoolean(process.env.GOOGLE_DRIVE_IGNORE_SHARE_ERRORS, false),
    driveAllowRootUpload: asBoolean(process.env.FULLTEXT_DRIVE_ALLOW_ROOT_UPLOAD, false),
    driveRetries: Math.max(1, Math.floor(asNumber(process.env.FULLTEXT_DRIVE_RETRIES, DEFAULT_DRIVE_RETRIES)))
  };
}

module.exports = {
  getFulltextEnv
};
