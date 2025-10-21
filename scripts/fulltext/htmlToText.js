const { JSDOM } = require('jsdom');

const DEFAULT_SELECTORS = [
  'div.content-grid > main.center > article.front-page',
  'main.center',
  'div.content-grid',
  'article.front-page',
  'article.theme-container',
  'article.disclosure',
  '.theme-container',
  '[data-testid="publication-body"]',
  'main',
  'article',
  'body'
];

function normalizeWhitespace(value) {
  if (!value) return '';
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ');
  const lines = normalized.split('\n').map((line) => line.trim().replace(/\s+/g, ' '));
  const compacted = [];
  for (const line of lines) {
    if (!line) {
      if (compacted.length === 0 || compacted[compacted.length - 1] === '') continue;
      compacted.push('');
      continue;
    }
    compacted.push(line);
  }
  while (compacted.length && compacted[0] === '') compacted.shift();
  while (compacted.length && compacted[compacted.length - 1] === '') compacted.pop();
  return compacted.join('\n');
}

function expandInteractiveSections(document) {
  const toggleSelectors = [
    '.collapsible',
    '.expand-button',
    '.md-expandable',
    '.non-expand-button',
    '[data-collapsed="true"]',
    '[aria-expanded="false"]'
  ];
  toggleSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => {
      element.classList.add('expanded');
      if (element.hasAttribute && element.hasAttribute('hidden')) {
        element.removeAttribute('hidden');
      }
      if (element.style) {
        element.style.display = 'block';
        element.style.maxHeight = 'none';
        element.style.visibility = 'visible';
        element.style.opacity = '1';
      }
      if (element.setAttribute) {
        element.setAttribute('aria-expanded', 'true');
      }
    });
  });
  // 親要素が display:none の場合も展開
  document.querySelectorAll('[style*="display:none"]').forEach((element) => {
    element.style.display = 'block';
  });
}

function stripUnwantedNodes(document) {
  document.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((node) => {
    node.remove();
  });
}

function extractMeta(document) {
  const getMeta = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        if ('content' in node && node.content) return node.content.trim();
        if (node.textContent) return node.textContent.trim();
      }
    }
    return null;
  };

  const title = getMeta([
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
    'meta[itemprop="headline"]',
    'title'
  ]);

  const headline = title || getMeta([
    'h1',
    '.headline',
    '.title',
    'article header h1',
    'article h1'
  ]);

  const publishedAt = getMeta([
    'meta[property="article:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publication_date"]',
    'meta[name="date"]',
    'time[datetime]'
  ]);

  const author = getMeta([
    'meta[name="author"]',
    'meta[property="article:author"]',
    '.author',
    '.analyst',
    '.byline'
  ]);

  return {
    title: title || null,
    headline: headline || null,
    publishedAt: publishedAt || null,
    author: author || null
  };
}

function extractTextFromHtml(html, options = {}) {
  if (!html || typeof html !== 'string') {
    return { text: '', sections: [], meta: {} };
  }

  const { selectors = DEFAULT_SELECTORS, minLength = 400 } = options;
  const dom = new JSDOM(html);
  const { document } = dom.window;

  expandInteractiveSections(document);
  stripUnwantedNodes(document);

  const sections = [];
  for (const selector of selectors) {
    const node = selector === 'body' ? document.body : document.querySelector(selector);
    if (!node) continue;
    const text = normalizeWhitespace(node.textContent || '');
    if (!text) continue;
    sections.push({ selector, text });
    if (selector !== 'body' && text.length >= minLength) {
      break;
    }
  }

  let composed = '';
  if (sections.length > 0) {
    composed = sections[0].text;
  } else if (document.body) {
    composed = normalizeWhitespace(document.body.textContent || '');
  }

  const meta = extractMeta(document);

  return { text: composed, sections, meta };
}

module.exports = {
  DEFAULT_SELECTORS,
  extractTextFromHtml,
  normalizeWhitespace
};
