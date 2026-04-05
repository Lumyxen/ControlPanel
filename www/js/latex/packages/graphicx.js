import { getIcon } from '../utils/icons.js';
import { escapeHtml, escapeAttr } from '../utils/html-utils.js';
// www/js/latex/packages/graphicx.js
// \includegraphics support with options.

export function parseIncludeGraphics(source) {
  const results = [];
  const rx = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  let match;
  while ((match = rx.exec(source)) !== null) {
    const optionsStr = match[1] || '';
    const filename = match[2];
    const options = parseGraphicsOptions(optionsStr);
    results.push({ filename, options, raw: match[0] });
  }
  return results;
}

function parseGraphicsOptions(str) {
  if (!str) return {};
  const opts = {};
  const parts = str.split(',');
  for (const part of parts) {
    const [key, ...valParts] = part.split('=');
    const k = key.trim();
    const v = valParts.join('=').trim();
    if (k && v) {
      if (['width','height','scale','angle','trim','clip'].includes(k)) {
        opts[k] = v;
      }
    }
  }
  return opts;
}

export function renderIncludeGraphics(filename, options = {}) {
  const width = options.width ? `max-width:${options.width};` : '';
  const height = options.height ? `max-height:${options.height};` : '';
  const angle = options.angle ? `transform:rotate(${options.angle}deg);` : '';
  const style = `${width}${height}${angle}`;

  return `<div class="latex-graphics" data-filename="${escapeAttr(filename)}" style="${style}">
    <span class="latex-graphics-icon">${getIcon('image')}</span>
    <span class="latex-graphics-name">${escapeHtml(filename)}</span>
    ${options.width ? `<span class="latex-graphics-dim">w: ${options.width}</span>` : ''}
    ${options.height ? `<span class="latex-graphics-dim">h: ${options.height}</span>` : ''}
    ${options.angle ? `<span class="latex-graphics-dim">angle: ${options.angle}</span>` : ''}
  </div>`;
}
