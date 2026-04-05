// www/js/latex/environments/preamble-envs.js
// Preamble environment handlers: documentclass, usepackage, etc.
import { getIcon } from '../utils/icons.js';

export const PREAMBLE_COMMANDS = new Set([
  'documentclass','usepackage','newcommand','renewcommand','providecommand',
  'newenvironment','renewenvironment',
  'author','title','date','institute','affiliation',
  'DeclareMathOperator','newtheorem',
  'setlength','setcounter','setlist',
  'geometry','hypersetup','definecolor',
  'lstset','fancyhead','fancyfoot','pagestyle',
  'bibliography','bibliographystyle','addbibresource',
  'input','include','includeonly',
  'nofiles','makeindex','makeglossary',
  'AtBeginDocument','AtEndDocument',
]);

export function isPreambleCommand(name) {
  return PREAMBLE_COMMANDS.has(name);
}

export function renderPreambleSection(items) {
  if (!items || items.length === 0) return '';
  const iconSvg = getIcon('file-cog');

  const itemRows = items.map(item => {
    return `<div class="latex-preamble-item">
      <span class="latex-preamble-cmd">${escapeHtml(item.command)}</span>
      <span class="latex-preamble-args">${escapeHtml(item.args || '')}</span>
    </div>`;
  }).join('');

  return `<details class="latex-preamble-section">
    <summary><span class="latex-preamble-icon">${iconSvg}</span> Document Configuration</summary>
    <div class="latex-preamble-items">${itemRows}</div>
  </details>`;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
