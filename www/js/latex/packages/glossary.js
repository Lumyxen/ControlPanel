// www/js/latex/packages/glossary.js
// Glossary and acronym support: \newglossaryentry, \gls, \glspl, \acrfull, etc.

import { getIcon } from '../utils/icons.js';

export class GlossaryEngine {
  constructor() {
    this.entries = new Map();
    this.acronyms = new Map();
    this.acronymFirstUse = new Map();
    this.usageCounts = new Map();
  }

  /**
   * Define a glossary entry.
   */
  defineEntry(key, options = {}) {
    this.entries.set(key, {
      key,
      name: options.name || key,
      description: options.description || '',
      symbol: options.symbol || '',
      sort: options.sort || options.name || key,
      type: options.type || 'main',
      user1: options.user1 || '',
      user2: options.user2 || '',
      first: options.first || null,
      plural: options.plural || null,
      firstplural: options.firstplural || null,
    });
    this.usageCounts.set(key, 0);
  }

  /**
   * Define an acronym.
   */
  defineAcronym(key, options = {}) {
    const entry = {
      key,
      short: options.short || key,
      long: options.long || key,
      shortplural: options.shortplural || (options.short ? options.short + 's' : key + 's'),
      longplural: options.longplural || (options.long ? options.long + 's' : key + 's'),
      first: options.first || null,
      description: options.description || '',
      sort: options.sort || key,
    };
    this.acronyms.set(key, entry);
    this.acronymFirstUse.set(key, true);
    this.usageCounts.set(key, 0);
  }

  /**
   * Reference a glossary entry.
   */
  reference(key, options = {}) {
    const entry = this.entries.get(key);
    if (!entry) return `??`;

    const count = (this.usageCounts.get(key) || 0) + 1;
    this.usageCounts.set(key, count);

    if (options.plural && entry.plural) return entry.plural;
    if (count === 1 && entry.first) return entry.first;
    return entry.name;
  }

  /**
   * Reference an acronym.
   */
  referenceAcronym(key, options = {}) {
    const acronym = this.acronyms.get(key);
    if (!acronym) return `??`;

    const count = (this.usageCounts.get(key) || 0) + 1;
    this.usageCounts.set(key, count);
    const isFirst = this.acronymFirstUse.get(key);

    if (options.full) {
      if (options.plural) return `${acronym.longplural} (${acronym.shortplural})`;
      return `${acronym.long} (${acronym.short})`;
    }

    if (isFirst && acronym.first) {
      this.acronymFirstUse.set(key, false);
      return acronym.first;
    }

    if (options.plural) return acronym.shortplural;
    return acronym.short;
  }

  /**
   * Render the glossary as HTML.
   */
  renderGlossary(options = {}) {
    const entries = Array.from(this.entries.values())
      .sort((a, b) => (a.sort || a.name).localeCompare(b.sort || b.name));

    if (entries.length === 0) return '';

    const rows = entries.map(e => {
      const usageCount = this.usageCounts.get(e.key) || 0;
      const usedClass = usageCount > 0 ? ' latex-glossary-used' : ' latex-glossary-unused';
      return `<tr class="latex-glossary-entry${usedClass}" data-key="${escapeAttr(e.key)}">
        <td class="latex-glossary-name">${escapeHtml(e.name)}</td>
        ${e.symbol ? `<td class="latex-glossary-symbol">${escapeHtml(e.symbol)}</td>` : ''}
        <td class="latex-glossary-description">${escapeHtml(e.description)}</td>
        <td class="latex-glossary-usage" title="Used ${usageCount} time${usageCount !== 1 ? 's' : ''}">${usageCount}</td>
      </tr>`;
    }).join('');

    return `<div class="latex-glossary">
  <h3 class="latex-glossary-title">
    <span class="latex-glossary-icon">${getIcon('library')}</span>
    Glossary
  </h3>
  <div class="latex-table-wrapper">
    <table class="latex-table latex-glossary-table">
      <thead><tr>
        <th class="latex-table-header">Term</th>
        ${entries.some(e => e.symbol) ? '<th class="latex-table-header">Symbol</th>' : ''}
        <th class="latex-table-header">Description</th>
        <th class="latex-table-header">Uses</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
  }

  /**
   * Render the acronym list as HTML.
   */
  renderAcronyms(options = {}) {
    const acronyms = Array.from(this.acronyms.values())
      .sort((a, b) => (a.sort || a.short).localeCompare(b.sort || b.short));

    if (acronyms.length === 0) return '';

    const rows = acronyms.map(a => {
      const usageCount = this.usageCounts.get(a.key) || 0;
      const usedClass = usageCount > 0 ? ' latex-glossary-used' : ' latex-glossary-unused';
      return `<tr class="latex-acronym-entry${usedClass}" data-key="${escapeAttr(a.key)}">
        <td class="latex-acronym-short">${escapeHtml(a.short)}</td>
        <td class="latex-acronym-long">${escapeHtml(a.long)}</td>
        ${a.description ? `<td class="latex-acronym-description">${escapeHtml(a.description)}</td>` : ''}
        <td class="latex-acronym-usage">${usageCount}</td>
      </tr>`;
    }).join('');

    return `<div class="latex-glossary latex-acronyms">
  <h3 class="latex-glossary-title">
    <span class="latex-glossary-icon">${getIcon('sigma')}</span>
    Acronyms
  </h3>
  <div class="latex-table-wrapper">
    <table class="latex-table latex-acronym-table">
      <thead><tr>
        <th class="latex-table-header">Short</th>
        <th class="latex-table-header">Long</th>
        ${acronyms.some(a => a.description) ? '<th class="latex-table-header">Description</th>' : ''}
        <th class="latex-table-header">Uses</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
  }

  /**
   * Process glossary commands in source.
   */
  processGlossaryCommands(source) {
    let result = source;

    // \newglossaryentry{key}{name=...,description=...}
    result = result.replace(/\\newglossaryentry\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (match, key, fields) => {
      const opts = parseGlossaryFields(fields);
      this.defineEntry(key, opts);
      return '';
    });

    // \newacronym{key}{short}{long}
    result = result.replace(/\\newacronym(?:\[([^\]]*)\])?\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g,
      (match, options, key, short, long) => {
        const opts = options ? parseGlossaryFields(options) : {};
        this.defineAcronym(key, { ...opts, short, long });
        return '';
      });

    // \gls{key}, \Gls{key}, \GLS{key}
    result = result.replace(/\\[Gg]?[Ll]?[Ss]\*?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (match, opts, key) => {
      const isCapitalized = match.startsWith('\\Gls');
      const isAllCaps = match.startsWith('\\GLS');
      const options = opts ? parseGlossaryFields(opts) : {};
      let ref = this.reference(key, options);
      if (isCapitalized) ref = ref.charAt(0).toUpperCase() + ref.slice(1);
      if (isAllCaps) ref = ref.toUpperCase();
      return `<span class="latex-gls" data-gls-key="${escapeAttr(key)}">${escapeHtml(ref)}</span>`;
    });

    // \acrshort{key}, \acrlong{key}, \acrfull{key}
    result = result.replace(/\\acr(?:short|long|full)\*?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g, (match, opts, key) => {
      const options = opts ? parseGlossaryFields(opts) : {};
      if (match.includes('short')) return this.referenceAcronym(key, { ...options, plural: false });
      if (match.includes('long')) return this.referenceAcronym(key, { ...options, full: true });
      return this.referenceAcronym(key, { ...options, full: true });
    });

    // \printglossary
    result = result.replace(/\\printglossary/g, '<!-- GLOSSARY_PLACEHOLDER -->');

    // \printacronyms
    result = result.replace(/\\printacronyms/g, '<!-- ACRONYMS_PLACEHOLDER -->');

    return result;
  }

  clear() {
    this.entries.clear();
    this.acronyms.clear();
    this.acronymFirstUse.clear();
    this.usageCounts.clear();
  }
}

function parseGlossaryFields(str) {
  const fields = {};
  const rx = /(\w+)\s*=\s*\{([^}]*)\}/g;
  let match;
  while ((match = rx.exec(str)) !== null) {
    fields[match[1]] = match[2];
  }
  return fields;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
