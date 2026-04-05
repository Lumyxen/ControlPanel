// www/js/latex/environments/float-envs.js
// Float environment handlers: figure, table, wrapfigure, etc.
import { getIcon } from '../utils/icons.js';
import { escapeHtml } from '../utils/html-utils.js';

export const FLOAT_ENVIRONMENTS = new Set([
  'figure','figure*','table','table*',
  'wrapfigure','wraptable',
  'marginpar','marginfigure','margintable',
  'sidewaysfigure','sidewaystable',
]);

export function isFloatEnvironment(name) {
  return FLOAT_ENVIRONMENTS.has(name);
}

export function renderFloatEnvironment(name, content, caption = '', label = '', options = {}) {
  const isFigure = name.startsWith('figure');
  const iconSvg = getIcon(isFigure ? 'image' : 'table');
  const floatType = isFigure ? 'figure' : 'table';
  const captionHtml = caption ? `<div class="latex-float-caption">${caption}</div>` : '';
  const labelAttr = label ? ` data-label="${label}"` : '';

  return `<div class="latex-float latex-float-${floatType}"${labelAttr}>
  <div class="latex-float-header">
    <span class="latex-float-icon">${iconSvg}</span>
    <span class="latex-float-type">${floatType.charAt(0).toUpperCase() + floatType.slice(1)}</span>
  </div>
  <div class="latex-float-content">${content}</div>
  ${captionHtml}
  <details class="latex-float-source">
    <summary>Source</summary>
    <pre class="latex-float-source-code"><code>${escapeHtml(`\\begin{${name}}\n${content}\n\\end{${name}}`)}</code></pre>
  </details>
</div>`;
}
