function getProxyConfig() {
  const server = process.env.FULLTEXT_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  if (!server) {
    return null;
  }
  const base = { server };
  if (process.env.FULLTEXT_PROXY_USERNAME) {
    base.username = process.env.FULLTEXT_PROXY_USERNAME;
    if (process.env.FULLTEXT_PROXY_PASSWORD) {
      base.password = process.env.FULLTEXT_PROXY_PASSWORD;
    }
  }
  return base;
}

function ensureProxyProtocol(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function resolvePlaywrightProxy() {
  const config = getProxyConfig();
  if (!config) return null;
  return {
    server: ensureProxyProtocol(config.server),
    username: config.username,
    password: config.password
  };
}

module.exports = {
  getProxyConfig,
  resolvePlaywrightProxy
};

