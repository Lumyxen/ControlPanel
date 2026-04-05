// www/js/latex/environments/text-envs.js
// Text environment handlers: lists, tables, verbatim, quotes, etc.

export const TEXT_ENVIRONMENTS = new Set([
  'itemize','enumerate','description','compactitem','compactenum',
  'tasks','checklist',
  'quote','quotation','verse',
  'tabular','tabularx','longtable','array',
  'verbatim','Verbatim','lstlisting','minted',
  'minipage','parbox',
  'center','flushleft','flushright',
  'abstract','titlepage',
  'letter','figure','table',
]);

export function isTextEnvironment(name) {
  return TEXT_ENVIRONMENTS.has(name);
}

export function renderTextEnvironment(name, content, options = {}) {
  switch (name) {
    case 'itemize':
      return `<ul class="latex-list latex-itemize">${content}</ul>`;
    case 'enumerate':
      return `<ol class="latex-list latex-enumerate">${content}</ol>`;
    case 'description':
      return `<dl class="latex-list latex-description">${content}</dl>`;
    case 'quote':
      return `<blockquote class="latex-quote">${content}</blockquote>`;
    case 'quotation':
      return `<blockquote class="latex-quotation">${content}</blockquote>`;
    case 'verse':
      return `<div class="latex-verse">${content}</div>`;
    case 'verbatim':
    case 'Verbatim':
      return `<pre class="latex-verbatim"><code>${escapeHtml(content)}</code></pre>`;
    case 'lstlisting':
      return `<pre class="latex-lstlisting"><code>${escapeHtml(content)}</code></pre>`;
    case 'minted':
      return `<pre class="latex-minted"><code>${escapeHtml(content)}</code></pre>`;
    case 'center':
      return `<div class="latex-center">${content}</div>`;
    case 'flushleft':
      return `<div class="latex-flushleft">${content}</div>`;
    case 'flushright':
      return `<div class="latex-flushright">${content}</div>`;
    case 'tabular':
    case 'tabularx':
    case 'longtable':
      return renderTabularFromContent(content, name, options);
    case 'array':
      return renderArrayFromContent(content, options);
    default:
      return `<div class="latex-env latex-env-${name}">${content}</div>`;
  }
}

/**
 * Parse tabular content (cells separated by & and rows by \\) into HTML table.
 */
function renderTabularFromContent(content, envName, options = {}) {
  const rows = content.split(/\\\\/).filter(r => r.trim());
  if (rows.length === 0) return '';

  const alignment = options.alignment || '';
  const cols = alignment ? alignment.split('') : [];

  let html = '<div class="latex-table-wrapper"><table class="latex-table">';

  rows.forEach((row, idx) => {
    const cells = row.split('&').map(c => c.trim());
    const tag = idx === 0 ? 'thead' : 'tbody';
    if (idx === 0 || (idx === 1 && rows.length > 1 && !options.noHeader)) {
      html += `<tr class="latex-table-row">`;
      cells.forEach((cell, ci) => {
        const align = cols[ci] ? getAlignment(cols[ci]) : '';
        const style = align ? ` style="text-align:${align}"` : '';
        html += `<th class="latex-table-header"${style}>${cell}</th>`;
      });
      html += `</tr>`;
    } else {
      html += `<tr class="latex-table-row">`;
      cells.forEach((cell, ci) => {
        const align = cols[ci] ? getAlignment(cols[ci]) : '';
        const style = align ? ` style="text-align:${align}"` : '';
        html += `<td class="latex-table-cell"${style}>${cell}</td>`;
      });
      html += `</tr>`;
    }
  });

  html += '</table></div>';
  return html;
}

/**
 * Parse array content into a math array.
 */
function renderArrayFromContent(content, options = {}) {
  const rows = content.split(/\\\\/).filter(r => r.trim());
  if (rows.length === 0) return '';

  let html = '<span class="latex-array">';
  rows.forEach(row => {
    const cells = row.split('&').map(c => c.trim());
    html += '<span class="latex-array-row">';
    cells.forEach(cell => {
      html += `<span class="latex-array-cell">${cell}</span>`;
    });
    html += '</span>';
  });
  html += '</span>';
  return html;
}

function getAlignment(char) {
  switch (char.toLowerCase()) {
    case 'l': return 'left';
    case 'c': return 'center';
    case 'r': return 'right';
    case 'p': return 'left';
    case 'm': return 'center';
    case 'b': return 'left';
    default: return 'left';
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderListItem(content, label = '') {
  if (label) {
    return `<li class="latex-list-item"><span class="latex-list-label">${label}</span> ${content}</li>`;
  }
  return `<li class="latex-list-item">${content}</li>`;
}

export function renderDescriptionItem(term, content) {
  return `<dt class="latex-description-term">${term}</dt><dd class="latex-description-def">${content}</dd>`;
}

export function renderTabular(headers, rows, options = {}) {
  const headerRow = headers.map(h => `<th class="latex-table-header">${h}</th>`).join('');
  const bodyRows = rows.map(row => {
    const cells = row.map(cell => `<td class="latex-table-cell">${cell}</td>`).join('');
    return `<tr class="latex-table-row">${cells}</tr>`;
  }).join('');

  return `<div class="latex-table-wrapper"><table class="latex-table"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}
