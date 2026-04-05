import { escapeHtml, escapeAttr } from '../utils/html-utils.js';
// www/js/latex/packages/hyperref.js
// \href, \url, \hypertarget support.

export function processHyperref(source) {
  let result = source;

  result = result.replace(/\\href\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, url, text) => {
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="latex-href">${escapeHtml(text)}</a>`;
  });

  result = result.replace(/\\url\s*\{([^}]*)\}/g, (_, url) => {
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="latex-url">${escapeHtml(url)}</a>`;
  });

  result = result.replace(/\\nolinkurl\s*\{([^}]*)\}/g, (_, url) => {
    return `<span class="latex-nolinkurl">${escapeHtml(url)}</span>`;
  });

  result = result.replace(/\\hypertarget\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, label, text) => {
    return `<span id="${escapeAttr(label)}" class="latex-hypertarget">${escapeHtml(text)}</span>`;
  });

  result = result.replace(/\\hyperlink\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, label, text) => {
    return `<a href="#${escapeAttr(label)}" class="latex-hyperlink">${escapeHtml(text)}</a>`;
  });

  result = result.replace(/\\hyperref\s*\[([^\]]*)\]\s*(?:\{([^}]*)\})?/g, (_, label, text) => {
    return `<a href="#${escapeAttr(label)}" class="latex-hyperref">${text || escapeHtml(label)}</a>`;
  });

  return result;
}
