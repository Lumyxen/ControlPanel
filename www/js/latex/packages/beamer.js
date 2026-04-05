// www/js/latex/packages/beamer.js
// Beamer presentation support: frames, blocks, overlays, themes.

import { getIcon } from '../utils/icons.js';

export const BEAMER_THEMES = {
  // Outer themes
  outer: ['default', 'infolines', 'miniframes', 'smoothbars', 'sidebar', 'shadow', 'split', 'tree'],
  // Inner themes
  inner: ['default', 'circles', 'rectangles', 'rounded', 'inmargin'],
  // Color themes
  color: ['default', 'albatross', 'beaver', 'beetle', 'crane', 'dolphin', 'dove', 'fly', 'lily', 'orchid', 'rose', 'seagull', 'seahorse', 'whale', 'wolverine'],
  // Font themes
  font: ['default', 'professionalfonts', 'serif', 'structurebold', 'structurebolditalic'],
};

export const BEAMER_BLOCK_TYPES = {
  block: { icon: 'file-text', label: 'Block', color: '--color-accent' },
  alertblock: { icon: 'triangle-alert', label: 'Alert', color: '--color-danger' },
  exampleblock: { icon: 'flask-conical', label: 'Example', color: '--color-success' },
  definition: { icon: 'book-open', label: 'Definition', color: '--color-accent' },
  theorem: { icon: 'landmark', label: 'Theorem', color: '--color-accent' },
  proof: { icon: 'file-check', label: 'Proof', color: '--color-muted' },
  remark: { icon: 'message-square', label: 'Remark', color: '--color-info' },
};

/**
 * Process Beamer source: frames, blocks, overlays, etc.
 */
export function processBeamer(source) {
  let result = source;

  // \begin{frame}...\end{frame}
  result = result.replace(/\\begin\s*\{frame\}(?:\[([^\]]*)\])?\s*(?:\{([^}]*)\})?([\s\S]*?)\\end\s*\{frame\}/g,
    (match, options, title, content) => {
      const opts = options ? parseFrameOptions(options) : {};
      const titleHtml = title ? `<h3 class="latex-beamer-frame-title">${title}</h3>` : '';
      const fragId = opts.fragile ? ' data-fragile="true"' : '';
      const allowBreak = opts.allowframebreaks ? ' data-allow-breaks="true"' : '';

      return `<div class="latex-beamer-frame"${fragId}${allowBreak}>
  ${titleHtml}
  <div class="latex-beamer-frame-content">${content}</div>
</div>`;
    });

  // \begin{block}...\end{block}
  result = result.replace(/\\begin\s*\{(block|alertblock|exampleblock|definition|theorem|proof|remark)\}\s*(?:\{([^}]*)\})?([\s\S]*?)\\end\s*\{\1\}/g,
    (match, type, title, content) => {
      return renderBeamerBlock(type, title, content);
    });

  // \frametitle
  result = result.replace(/\\frametitle\s*\{([^}]*)\}/g,
    '<h3 class="latex-beamer-frame-title">$1</h3>');

  // \framesubtitle
  result = result.replace(/\\framesubtitle\s*\{([^}]*)\}/g,
    '<h4 class="latex-beamer-frame-subtitle">$1</h4>');

  // \pause
  result = result.replace(/\\pause/g,
    '<span class="latex-beamer-pause" data-pause="true"></span>');

  // \only<n>{...}
  result = result.replace(/\\only<([^>]*)>\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-only" data-overlay="$1">$2</span>');

  // \uncover<n>{...}
  result = result.replace(/\\uncover<([^>]*)>\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-uncover" data-overlay="$1">$2</span>');

  // \visible<n>{...}
  result = result.replace(/\\visible<([^>]*)>\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-visible" data-overlay="$1">$2</span>');

  // \invisible<n>{...}
  result = result.replace(/\\invisible<([^>]*)>\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-invisible" data-overlay="$1" style="opacity:0.3">$2</span>');

  // \alert{...}
  result = result.replace(/\\alert\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-alert">$1</span>');

  // \structure{...}
  result = result.replace(/\\structure\s*\{([^}]*)\}/g,
    '<span class="latex-beamer-structure">$1</span>');

  // \usetheme
  result = result.replace(/\\usetheme(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g,
    '<!-- Beamer theme: $2 -->');

  // \usecolortheme
  result = result.replace(/\\usecolortheme\s*\{([^}]*)\}/g,
    '<!-- Beamer color theme: $1 -->');

  return result;
}

function renderBeamerBlock(type, title, content) {
  const config = BEAMER_BLOCK_TYPES[type] || BEAMER_BLOCK_TYPES.block;
  const iconSvg = getIcon(config.icon);
  const titleHtml = title ? `<span class="latex-beamer-block-title">${title}</span>` : '';

  return `<div class="latex-beamer-block latex-beamer-block-${type}">
  <div class="latex-beamer-block-header">
    <span class="latex-beamer-block-icon">${iconSvg}</span>
    ${titleHtml}
  </div>
  <div class="latex-beamer-block-content">${content}</div>
</div>`;
}

function parseFrameOptions(str) {
  if (!str) return {};
  const opts = {};
  const parts = str.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === 'fragile') opts.fragile = true;
    else if (trimmed === 'allowframebreaks') opts.allowframebreaks = true;
    else if (trimmed === 'plain') opts.plain = true;
    else if (trimmed === 'shrink') opts.shrink = true;
    else if (trimmed === 't') opts.vertical = 'top';
    else if (trimmed === 'c') opts.vertical = 'center';
    else if (trimmed === 'b') opts.vertical = 'bottom';
  }
  return opts;
}
