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

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getIcon(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
}
