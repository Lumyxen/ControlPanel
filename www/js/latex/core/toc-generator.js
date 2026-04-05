// www/js/latex/core/toc-generator.js
// Table of contents generator from parsed LaTeX AST.

import { NodeType, flattenText } from './ast.js';
import { toRoman } from '../utils/number-utils.js';

const SECTION_LEVELS = {
  '\\part': -1,
  '\\chapter': 0,
  '\\section': 1,
  '\\subsection': 2,
  '\\subsubsection': 3,
  '\\paragraph': 4,
  '\\subparagraph': 5,
};

export class TOCGenerator {
  constructor(options = {}) {
    this.options = {
      maxDepth: options.maxDepth ?? 3, // Default: show down to subsubsection
      numbered: options.numbered !== false,
      linkable: options.linkable !== false,
      ...options,
    };
    this.sections = [];
    this._counter = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, subparagraph: 0 };
  }

  /**
   * Generate TOC from AST.
   */
  generateFromAST(ast) {
    this.sections = [];
    this._resetCounters();
    this._walkAST(ast);
    return this.sections;
  }

  /**
   * Generate TOC from raw source (extracts section commands).
   */
  generateFromSource(source) {
    this.sections = [];
    this._resetCounters();

    const sectionRx = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
    let match;
    let id = 0;

    while ((match = sectionRx.exec(source)) !== null) {
      const name = match[1];
      const starred = match[0].includes('*');
      const shortTitle = match[2] || match[3];
      const title = match[3];
      const level = SECTION_LEVELS['\\' + name] ?? 1;

      if (level <= this.options.maxDepth) {
        this._incrementCounter(name);
        const number = starred ? null : this._getCounterString(name);

        this.sections.push({
          id: `toc-${id++}`,
          level,
          name,
          title,
          shortTitle,
          number,
          starred,
          children: [],
        });
      }
    }

    this._buildHierarchy();
    return this.sections;
  }

  /**
   * Render the TOC as HTML.
   */
  renderHTML(sections = null) {
    const items = sections || this.sections;
    if (items.length === 0) return '';

    return `<nav class="latex-toc" aria-label="Table of Contents">
  <h3 class="latex-toc-title">Contents</h3>
  <ol class="latex-toc-list">${this._renderItems(items)}</ol>
</nav>`;
  }

  _renderItems(items, depth = 0) {
    let html = '';
    for (const item of items) {
      const indent = ` data-depth="${depth}"`;
      const numberHtml = item.number ? `<span class="latex-toc-number">${item.number}</span>` : '';
      const linkAttr = this.options.linkable ? ` href="#${item.id}"` : '';
      const starredClass = item.starred ? ' latex-toc-starred' : '';

      html += `<li class="latex-toc-item latex-toc-level-${item.level}${starredClass}"${indent}>`;
      html += `<a class="latex-toc-link"${linkAttr}>${numberHtml} <span class="latex-toc-title">${item.shortTitle || item.title}</span></a>`;

      if (item.children && item.children.length > 0) {
        html += `<ol class="latex-toc-list">${this._renderItems(item.children, depth + 1)}</ol>`;
      }

      html += `</li>`;
    }
    return html;
  }

  _walkAST(node, parentLevel = -1) {
    if (!node) return;

    if (node.type === NodeType.COMMAND && SECTION_LEVELS[node.name] !== undefined) {
      const name = node.name;
      const level = SECTION_LEVELS[name];
      const starred = (node.raw || '').includes('*');

      if (level <= this.options.maxDepth) {
        this._incrementCounter(name.replace('\\', ''));
        const number = starred ? null : this._getCounterString(name.replace('\\', ''));
        const title = node.content?.title ? flattenText({ children: node.content.title }) : '';

        const section = {
          id: `toc-${this.sections.length}`,
          level,
          name: name.replace('\\', ''),
          title,
          shortTitle: title,
          number,
          starred,
          children: [],
        };

        this.sections.push(section);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this._walkAST(child, parentLevel);
      }
    }
  }

  _buildHierarchy() {
    const root = [];
    const stack = [{ items: root, level: -1 }];

    for (const section of this.sections) {
      while (stack.length > 1 && stack[stack.length - 1].level >= section.level) {
        stack.pop();
      }
      stack[stack.length - 1].items.push(section);
      stack.push({ items: section.children, level: section.level });
    }

    this.sections = root;
  }

  _resetCounters() {
    for (const key of Object.keys(this._counter)) {
      this._counter[key] = 0;
    }
  }

  _incrementCounter(name) {
    const level = SECTION_LEVELS['\\' + name] ?? 1;
    // Reset all sub-counters
    for (const [key, val] of Object.entries(SECTION_LEVELS)) {
      if (val > level) {
        const k = key.replace('\\', '');
        this._counter[k] = 0;
      }
    }
    this._counter[name] = (this._counter[name] || 0) + 1;
  }

  _getCounterString(name) {
    switch (name) {
      case 'part': return toRoman(this._counter.part);
      case 'chapter': return String(this._counter.chapter);
      case 'section': return `${this._counter.chapter}.${this._counter.section}`;
      case 'subsection': return `${this._counter.chapter}.${this._counter.section}.${this._counter.subsection}`;
      case 'subsubsection': return `${this._counter.chapter}.${this._counter.section}.${this._counter.subsection}.${this._counter.subsubsection}`;
      case 'paragraph': return `${this._counter.chapter}.${this._counter.section}.${this._counter.subsection}.${this._counter.subsubsection}.${this._counter.paragraph}`;
      case 'subparagraph': return `${this._counter.chapter}.${this._counter.section}.${this._counter.subsection}.${this._counter.subsubsection}.${this._counter.paragraph}.${this._counter.subparagraph}`;
      default: return '';
    }
  }
}
