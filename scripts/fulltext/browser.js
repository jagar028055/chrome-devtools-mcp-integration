const { chromium, request: requestAPI } = require('playwright');

const { resolvePlaywrightProxy } = require('../config/network');

async function createBrowserContext(options = {}) {
  const {
    storageState,
    headless = true,
    slowMo = 0,
    proxy,
    viewport,
    extraHTTPHeaders
  } = options;
  if (!storageState) {
    throw new Error('storageState パスを指定してください (--storage-state)。');
  }
  const proxyOptions = options.proxy ?? resolvePlaywrightProxy() ?? undefined;
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    storageState,
    proxy: proxy ?? proxyOptions,
    viewport,
    extraHTTPHeaders,
    ignoreHTTPSErrors: true
  });
  const requestContext = await requestAPI.newContext({
    storageState,
    extraHTTPHeaders,
    proxy: proxy ?? proxyOptions,
    ignoreHTTPSErrors: true
  });

  const dispose = async () => {
    await Promise.allSettled([
      (async () => {
        try {
          if (context && !context.isClosed()) {
            await context.close();
          }
        } catch (error) {
          if (options.debug) {
            console.warn('[cleanup] context close failed:', error.message);
          }
        }
      })(),
      (async () => {
        try {
          if (requestContext) {
            await requestContext.dispose();
          }
        } catch (error) {
          if (options.debug) {
            console.warn('[cleanup] requestContext dispose failed:', error.message);
          }
        }
      })(),
      (async () => {
        try {
          if (browser && browser.isConnected()) {
            await browser.close();
          }
        } catch (error) {
          if (options.debug) {
            console.warn('[cleanup] browser close failed:', error.message);
          }
        }
      })()
    ]);
  };

  return {
    browser,
    context,
    request: requestContext,
    dispose,
    debug: !!options.debug
  };
}

async function withPage(options, handler) {
  const session = await createBrowserContext(options);
  const { context } = session;
  const page = await context.newPage();
  try {
    return await handler(page, session);
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    await session.dispose();
  }
}

module.exports = {
  createBrowserContext,
  withPage
};
