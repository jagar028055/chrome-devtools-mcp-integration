const fs = require('fs');
const path = require('path');

const loadedEnvFiles = new Set();

function stripQuotes(value) {
  const match = value.match(/^(['"])(.*)\1$/);
  if (!match) return value;
  return match[2]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function normalizeLine(line) {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('export ')) {
    trimmed = trimmed.slice(7).trim();
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;
  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();
  if (!key) return null;
  const quoted = /^(['"]).*\1$/.test(value);
  if (!quoted) {
    const commentIndex = value.indexOf('#');
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trim();
    }
  }
  value = stripQuotes(value);
  return { key, value };
}

function loadEnv(options = {}) {
  const filename = options.filename || '.env';
  const envPath = options.path || path.resolve(process.cwd(), filename);
  if (loadedEnvFiles.has(envPath) && !options.force) return;
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      loadedEnvFiles.add(envPath);
      return;
    }
    throw error;
  }
  content.split(/\r?\n/).forEach((line) => {
    const pair = normalizeLine(line);
    if (!pair) return;
    if (!options.override && Object.prototype.hasOwnProperty.call(process.env, pair.key)) {
      return;
    }
    process.env[pair.key] = pair.value;
  });
  loadedEnvFiles.add(envPath);
}

module.exports = {
  loadEnv
};

