// www/js/latex/engines/bibtex-engine.js
// BibTeX engine: parsing, citation rendering, bibliography generation.
// Per-chat database isolation - no global state.

const ENTRY_TYPES = new Set([
  'article','book','inproceedings','conference','incollection',
  'phdthesis','mastersthesis','techreport','misc','online',
  'electronic','www','proceedings','inbook','unpublished',
  'manual','booklet','patent','dataset','software','report',
]);

const FIELDS = {
  article: ['author','title','journal','year','volume','number','pages','month','note','doi','url'],
  book: ['author','title','publisher','year','volume','series','address','edition','month','note','isbn','doi','url'],
  inproceedings: ['author','title','booktitle','year','editor','pages','publisher','address','month','note','doi','url'],
  conference: ['author','title','booktitle','year','editor','pages','publisher','address','month','note','doi','url'],
  incollection: ['author','title','booktitle','year','editor','pages','publisher','address','month','note','doi','url'],
  phdthesis: ['author','title','school','year','address','month','note','doi','url'],
  mastersthesis: ['author','title','school','year','address','month','note','doi','url'],
  techreport: ['author','title','institution','year','type','number','address','month','note','doi','url'],
  misc: ['author','title','howpublished','month','year','note','doi','url'],
  online: ['author','title','url','urldate','year','month','note'],
  electronic: ['author','title','url','urldate','year','month','note'],
  www: ['author','title','url','urldate','year','month','note'],
  proceedings: ['title','year','editor','publisher','address','month','note','doi','url'],
  inbook: ['author','title','chapter','pages','publisher','year','address','edition','month','note','doi','url'],
  unpublished: ['author','title','note','month','year'],
  manual: ['title','author','organization','address','edition','month','year','note','doi','url'],
  booklet: ['title','author','howpublished','address','month','year','note'],
  patent: ['author','title','nationality','number','year','month','day','note','url'],
  dataset: ['author','title','year','publisher','address','edition','month','note','doi','url'],
  software: ['author','title','year','url','note'],
  report: ['author','title','institution','year','type','number','address','month','note','doi','url'],
};

export class BibTeXEngine {
  constructor(chatId = null) {
    this.chatId = chatId;
    this.entries = new Map();
    this.citations = new Map();
    this.style = 'plain';
    this.parseErrors = [];
  }

  parse(source) {
    this.parseErrors = [];
    const cleaned = this._stripComments(source);
    const entries = this._extractEntries(cleaned);
    for (const entry of entries) {
      this.addEntry(entry);
    }
    return entries;
  }

  _stripComments(source) {
    return source.replace(/(^|[^\\])%[^\n]*/g, '$1');
  }

  _extractEntries(source) {
    const entries = [];
    const entryRx = /@(\w+)\s*\{([^,]+),([\s\S]*?)\n\}/g;
    let match;
    while ((match = entryRx.exec(source)) !== null) {
      const type = match[1].toLowerCase();
      const key = match[2].trim();
      if (!ENTRY_TYPES.has(type) && type !== 'preamble' && type !== 'string' && type !== 'comment') {
        this.parseErrors.push({ key, message: `Unknown entry type: ${type}`, severity: 'warning' });
      }
      if (type === 'comment') continue;
      if (type === 'string') {
        this._parseStringDef(match[3]);
        continue;
      }
      if (type === 'preamble') continue;
      const fields = this._parseFields(match[3]);
      entries.push({ type, key, fields });
    }
    return entries;
  }

  _parseStringDef(fieldStr) {
    const m = fieldStr.match(/(\w+)\s*=\s*["{]([^"}]+)["}]/);
    if (m) {
      this._stringDefs = this._stringDefs || new Map();
      this._stringDefs.set(m[1].toLowerCase(), m[2]);
    }
  }

  _parseFields(fieldStr) {
    const fields = {};
    const fieldRx = /(\w+)\s*=\s*(?:"([^"]*)"|{([^}]*)}|(\d+))/g;
    let m;
    while ((m = fieldRx.exec(fieldStr)) !== null) {
      const name = m[1].toLowerCase();
      fields[name] = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]).trim();
    }
    return fields;
  }

  addEntry(entry) {
    this.entries.set(entry.key, entry);
  }

  getEntry(key) {
    return this.entries.get(key) || null;
  }

  getAllEntries() {
    return Array.from(this.entries.values());
  }

  getCitationKeys() {
    return Array.from(this.citations.keys());
  }

  cite(keys, options = {}) {
    for (const key of keys) {
      if (!this.citations.has(key)) {
        this.citations.set(key, { count: 1, entry: this.getEntry(key) });
      } else {
        this.citations.get(key).count++;
      }
    }
    return this._renderCitation(keys, options);
  }

  _renderCitation(keys, options = {}) {
    const parts = keys.map(key => {
      const entry = this.getEntry(key);
      if (!entry) return `??`;
      const authors = this._formatAuthors(entry.fields.author || '');
      const year = entry.fields.year || 'n.d.';
      switch (this.style) {
        case 'ieee':
        case 'vancouver':
          return `[${key}]`;
        case 'alpha':
          return `[${this._alphaLabel(entry)}]`;
        case 'authoryear':
        case 'apa':
        case 'chicago':
        case 'harvard':
        case 'mla':
          return `(${authors}, ${year})`;
        default:
          return `[${key}]`;
      }
    });
    return parts.join(', ');
  }

  _formatAuthors(authorStr) {
    if (!authorStr) return '';
    const authors = authorStr.split(/\s+and\s+/i);
    if (authors.length === 1) return this._cleanAuthor(authors[0]);
    if (authors.length === 2) return `${this._cleanAuthor(authors[0])} and ${this._cleanAuthor(authors[1])}`;
    return `${this._cleanAuthor(authors[0])} et al.`;
  }

  _cleanAuthor(author) {
    if (author.includes(',')) return author.split(',')[0].trim();
    const parts = author.trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : author;
  }

  _alphaLabel(entry) {
    const author = this._cleanAuthor(entry.fields.author || '');
    const year = (entry.fields.year || '').slice(-2);
    return `${author.slice(0, 3).toLowerCase()}${year}`;
  }

  renderBibliography(options = {}) {
    const entries = options.keys
      ? options.keys.map(k => this.getEntry(k)).filter(Boolean)
      : this.getAllEntries();

    if (entries.length === 0) return '';

    const styleRenderers = {
      plain: (e) => this._renderPlain(e),
      ieee: (e) => this._renderIEEE(e),
      vancouver: (e) => this._renderVancouver(e),
      alpha: (e) => this._renderAlpha(e),
      authoryear: (e) => this._renderAuthoryear(e),
      apa: (e) => this._renderAPA(e),
    };

    const renderer = styleRenderers[this.style] || styleRenderers.plain;
    const items = entries.map(renderer).join('');

    return `<div class="bibliography"><h3>References</h3>${items}</div>`;
  }

  _renderPlain(entry) {
    const authors = this._formatAuthors(entry.fields.author || '');
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    const year = entry.fields.year || '';
    const volume = entry.fields.volume ? ` vol. ${entry.fields.volume}` : '';
    const pages = entry.fields.pages ? `, pp. ${entry.fields.pages}` : '';
    return `<div class="bib-entry" data-key="${entry.key}">[${entry.key}] ${authors}, "${title}," ${journal}${volume}${year ? `, ${year}` : ''}${pages}.</div>`;
  }

  _renderIEEE(entry) {
    const authors = this._formatAuthors(entry.fields.author || '');
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    const year = entry.fields.year || '';
    return `<div class="bib-entry" data-key="${entry.key}">${authors}, "${title}," ${journal}${year ? `, ${year}` : ''}.</div>`;
  }

  _renderVancouver(entry) {
    const authors = this._formatAuthors(entry.fields.author || '');
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    const year = entry.fields.year || '';
    return `<div class="bib-entry" data-key="${entry.key}">${authors}. ${title}. ${journal}${year ? `; ${year}` : ''}.</div>`;
  }

  _renderAlpha(entry) {
    const label = this._alphaLabel(entry);
    const authors = this._formatAuthors(entry.fields.author || '');
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    const year = entry.fields.year || '';
    return `<div class="bib-entry" data-key="${entry.key}">[${label}] ${authors}, "${title}," ${journal}${year ? `, ${year}` : ''}.</div>`;
  }

  _renderAuthoryear(entry) {
    const authors = this._formatAuthors(entry.fields.author || '');
    const year = entry.fields.year || 'n.d.';
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    return `<div class="bib-entry" data-key="${entry.key}">${authors} (${year}). ${title}. ${journal}.</div>`;
  }

  _renderAPA(entry) {
    const authors = this._formatAuthors(entry.fields.author || '');
    const year = entry.fields.year || 'n.d.';
    const title = entry.fields.title || '';
    const journal = entry.fields.journal || entry.fields.booktitle || '';
    return `<div class="bib-entry" data-key="${entry.key}">${authors} (${year}). ${title}. <em>${journal}</em>.</div>`;
  }

  clear() {
    this.entries.clear();
    this.citations.clear();
    this.parseErrors = [];
  }

  clone() {
    const copy = new BibTeXEngine(this.chatId);
    copy.entries = new Map(this.entries);
    copy.citations = new Map(this.citations);
    copy.style = this.style;
    copy.parseErrors = [...this.parseErrors];
    return copy;
  }
}
