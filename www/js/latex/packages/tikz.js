// www/js/latex/packages/tikz.js
// TikZ/PGF placeholder support - renders structured placeholders for diagrams.

import { getIcon } from '../utils/icons.js';

/**
 * Extract TikZ picture environments and render placeholders.
 */
export function processTikZ(source) {
  let result = source;
  let idx = 0;

  result = result.replace(/\\begin\s*\{tikzpicture\}(?:\[([^\]]*)\])?([\s\S]*?)\\end\s*\{tikzpicture\}/g, (match, options, content) => {
    const id = `tikz-${idx++}`;
    const opts = parseTikZOptions(options || '');
    const elements = extractTikZElements(content);

    return renderTikZPlaceholder(id, opts, elements);
  });

  // Also handle \tikz inline command
  result = result.replace(/\\tikz\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (match, options, content) => {
    const id = `tikz-${idx++}`;
    const opts = parseTikZOptions(options || '');
    const elements = extractTikZElements(content);

    return renderTikZPlaceholder(id, opts, elements, true);
  });

  return result;
}

function parseTikZOptions(str) {
  if (!str) return {};
  const opts = {};
  const parts = str.split(',');
  for (const part of parts) {
    const [key, ...valParts] = part.split('=');
    const k = key.trim();
    const v = valParts.join('=').trim();
    if (k) opts[k] = v || true;
  }
  return opts;
}

function extractTikZElements(content) {
  const elements = [];

  // \draw
  const drawRx = /\\draw\s*(?:\[([^\]]*)\])?\s*([^;]*);/g;
  let match;
  while ((match = drawRx.exec(content)) !== null) {
    elements.push({ type: 'draw', options: match[1] || '', path: match[2].trim() });
  }

  // \node
  const nodeRx = /\\node\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?\s*(?:at\s*\(([^)]*)\))?\s*\{([^}]*)\}\s*;/g;
  while ((match = nodeRx.exec(content)) !== null) {
    elements.push({
      type: 'node',
      options: match[1] || '',
      name: match[2] || '',
      position: match[3] || '',
      content: match[4],
    });
  }

  // \fill
  const fillRx = /\\fill\s*(?:\[([^\]]*)\])?\s*([^;]*);/g;
  while ((match = fillRx.exec(content)) !== null) {
    elements.push({ type: 'fill', options: match[1] || '', path: match[2].trim() });
  }

  // \path
  const pathRx = /\\path\s*(?:\[([^\]]*)\])?\s*([^;]*);/g;
  while ((match = pathRx.exec(content)) !== null) {
    elements.push({ type: 'path', options: match[1] || '', path: match[2].trim() });
  }

  return elements;
}

function renderTikZPlaceholder(id, options, elements, inline = false) {
  const iconSvg = getIcon('function');
  const elementCount = elements.length;
  const elementTypes = [...new Set(elements.map(e => e.type))].join(', ');
  const optsStr = Object.keys(options).length > 0
    ? Object.entries(options).map(([k, v]) => `${k}${v !== true ? `=${v}` : ''}`).join(', ')
    : '';

  const tag = inline ? 'span' : 'div';
  const classes = `latex-tikz-placeholder${inline ? ' latex-tikz-inline' : ''}`;

  return `<${tag} class="${classes}" data-tikz-id="${id}" data-elements="${elementCount}" data-types="${escapeAttr(elementTypes)}">
  <div class="latex-tikz-header">
    <span class="latex-tikz-icon">${iconSvg}</span>
    <span class="latex-tikz-label">TikZ Diagram</span>
    <span class="latex-tikz-info">${elementCount} element${elementCount !== 1 ? 's' : ''} (${elementTypes})</span>
  </div>
  ${optsStr ? `<div class="latex-tikz-options">${escapeHtml(optsStr)}</div>` : ''}
  <details class="latex-tikz-source">
    <summary>View Source</summary>
    <pre class="latex-tikz-source-code"><code>${elements.map(e => formatTikZElement(e)).join('\n')}</code></pre>
  </details>
</${tag}>`;
}

function formatTikZElement(el) {
  switch (el.type) {
    case 'draw': return `\\draw [${el.options}] ${el.path};`;
    case 'fill': return `\\fill [${el.options}] ${el.path};`;
    case 'path': return `\\path [${el.options}] ${el.path};`;
    case 'node': return `\\node [${el.options}] (${el.name}) at (${el.position}) {${el.content}};`;
    default: return `${el.type}: ${JSON.stringify(el)}`;
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
