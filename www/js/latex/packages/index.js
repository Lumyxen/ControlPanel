// www/js/latex/packages/index.js
// LaTeX index support: \index, \makeindex, \printindex.

import { getIcon } from '../utils/icons.js';
import { escapeHtml, escapeAttr } from '../utils/html-utils.js';

export class IndexEngine {
  constructor() {
    this.entries = new Map();
    this.enabled = false;
  }

  /**
   * Enable indexing (equivalent to \makeindex).
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Add an index entry.
   */
  addEntry(term, subentry = '', page = null) {
    const key = subentry ? `${term}!${subentry}` : term;
    if (!this.entries.has(term)) {
      this.entries.set(term, { term, subentries: new Map(), pages: [] });
    }
    const entry = this.entries.get(term);
    if (subentry) {
      if (!entry.subentries.has(subentry)) {
        entry.subentries.set(subentry, []);
      }
      if (page) entry.subentries.get(subentry).push(page);
    } else if (page) {
      entry.pages.push(page);
    }
  }

  /**
   * Process index commands in source.
   */
  processIndexCommands(source) {
    let result = source;

    // \makeindex
    result = result.replace(/\\makeindex/g, () => {
      this.enable();
      return '';
    });

    // \index{term}
    result = result.replace(/\\index\s*\{([^}]*)\}/g, (match, term) => {
      if (!this.enabled) return '';
      const parts = term.split('!');
      this.addEntry(parts[0], parts[1] || '');
      return `<span class="latex-index-mark" data-index="${escapeAttr(term)}"></span>`;
    });

    // \index{term|textbf} etc. with formatting
    result = result.replace(/\\index\s*\{([^|]*)\|(\w+)\}/g, (match, term, format) => {
      if (!this.enabled) return '';
      const parts = term.split('!');
      this.addEntry(parts[0], parts[1] || '');
      return `<span class="latex-index-mark" data-index="${escapeAttr(term)}" data-format="${format}"></span>`;
    });

    // \printindex
    result = result.replace(/\\printindex/g, '<!-- INDEX_PLACEHOLDER -->');

    return result;
  }

  /**
   * Render the index as HTML.
   */
  renderIndex() {
    if (!this.enabled || this.entries.size === 0) return '';

    const sorted = Array.from(this.entries.values())
      .sort((a, b) => a.term.localeCompare(b.term));

    // Group by first letter
    const groups = {};
    for (const entry of sorted) {
      const letter = entry.term.charAt(0).toUpperCase();
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(entry);
    }

    let html = `<div class="latex-index">
  <h3 class="latex-index-title">
    <span class="latex-index-icon">${getIcon('library')}</span>
    Index
  </h3>`;

    for (const [letter, entries] of Object.entries(groups).sort()) {
      html += `<div class="latex-index-group">
  <h4 class="latex-index-letter">${letter}</h4>
  <ul class="latex-index-list">`;

      for (const entry of entries) {
        const subentries = Array.from(entry.subentries.entries());
        if (subentries.length > 0) {
          html += `<li class="latex-index-entry">
            <span class="latex-index-term">${escapeHtml(entry.term)}</span>
            <ul class="latex-index-subentries">`;
          for (const [sub, pages] of subentries) {
            html += `<li class="latex-index-subentry">
              <span class="latex-index-subterm">${escapeHtml(sub)}</span>
              ${pages.length > 0 ? `<span class="latex-index-pages">${pages.join(', ')}</span>` : ''}
            </li>`;
          }
          html += `</ul></li>`;
        } else {
          html += `<li class="latex-index-entry">
            <span class="latex-index-term">${escapeHtml(entry.term)}</span>
            ${entry.pages.length > 0 ? `<span class="latex-index-pages">${entry.pages.join(', ')}</span>` : ''}
          </li>`;
        }
      }

      html += `</ul></div>`;
    }

    html += `</div>`;
    return html;
  }

  clear() {
    this.entries.clear();
    this.enabled = false;
  }
}
