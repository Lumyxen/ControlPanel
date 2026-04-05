// www/js/latex/renderers/html-renderer.js
// Renders text-mode LaTeX AST to HTML with environment-specific rendering.

import { isStructuralEnvironment, renderStructuralEnvironment } from '../environments/structural-envs.js';
import { isTextEnvironment, renderTextEnvironment, renderListItem, renderDescriptionItem, renderTabular } from '../environments/text-envs.js';
import { isFloatEnvironment, renderFloatEnvironment } from '../environments/float-envs.js';
import { isMathEnvironment, renderMathEnvironment } from '../environments/math-envs.js';
import { isPreambleCommand, renderPreambleSection } from '../environments/preamble-envs.js';

export class HTMLRenderer {
  constructor(options = {}) {
    this.options = {
      mathPlaceholder: '__MATH_PLACEHOLDER__',
      ...options,
    };
    this.mathBlocks = [];
    this.preambleItems = [];
  }

  render(ast, mathBlocks = []) {
    this.mathBlocks = mathBlocks;
    this.preambleItems = [];

    if (!ast || !ast.children) return '';
    return this._renderNodes(ast.children);
  }

  _renderNodes(nodes) {
    if (!nodes || !Array.isArray(nodes)) return '';
    return nodes.map(node => this._renderNode(node)).join('');
  }

  _renderNode(node) {
    if (!node) return '';
    if (typeof node === 'string') return this._escapeHtml(node);

    switch (node.type) {
      case 'Document':
        return this._renderNodes(node.children);
      case 'Text':
        return this._escapeHtml(node.value || '');
      case 'Whitespace':
        return node.value || ' ';
      case 'Comment':
        return '';
      case 'Command':
        return this._renderCommand(node);
      case 'Environment':
        return this._renderEnvironment(node);
      case 'Group':
        return this._renderGroup(node);
      case 'MathInline':
      case 'MathDisplay':
        return this._renderMath(node);
      case 'Superscript':
        return this._renderSuperscript(node);
      case 'Subscript':
        return this._renderSubscript(node);
      case 'Section':
        return this._renderSection(node);
      case 'List':
        return this._renderList(node);
      case 'ListItem':
        return this._renderListItem(node);
      case 'Table':
        return this._renderTable(node);
      case 'TableRow':
        return this._renderTableRow(node);
      case 'TableCell':
        return this._renderTableCell(node);
      case 'Fraction':
        return this._renderFraction(node);
      case 'Matrix':
        return this._renderMatrix(node);
      case 'Parameter':
        return `#${node.content || ''}`;
      case 'Argument':
        return this._renderNodes(node.children);
      default:
        return this._renderNodes(node.children);
    }
  }

  _renderCommand(node) {
    const name = node.name || '';

    if (isPreambleCommand(name.replace(/^\\/, ''))) {
      const args = (node.args || []).map(a => {
        if (a && a.children) return this._renderNodes(a.children);
        return a.value || '';
      }).join(' ');
      this.preambleItems.push({ command: name, args });
      return '';
    }

    switch (name) {
      case '\\textbf':
      case '\\textbf{}':
        return `<strong>${this._renderNodes(node.children)}</strong>`;
      case '\\textit':
        return `<em>${this._renderNodes(node.children)}</em>`;
      case '\\texttt':
        return `<code class="latex-tt">${this._renderNodes(node.children)}</code>`;
      case '\\underline':
        return `<u>${this._renderNodes(node.children)}</u>`;
      case '\\overline':
        return `<span style="text-decoration: overline">${this._renderNodes(node.children)}</span>`;
      case '\\emph':
        return `<em>${this._renderNodes(node.children)}</em>`;
      case '\\href': {
        const args = node.args || [];
        const url = args[0] ? this._renderNodes(args[0].children) : '#';
        const text = args[1] ? this._renderNodes(args[1].children) : url;
        return `<a href="${this._escapeAttr(url)}" target="_blank" rel="noopener">${text}</a>`;
      }
      case '\\url': {
        const url = this._renderNodes(node.children);
        return `<a href="${this._escapeAttr(url)}" target="_blank" rel="noopener" class="latex-url">${url}</a>`;
      }
      case '\\cite': {
        const keys = this._renderNodes(node.children).split(',').map(k => k.trim());
        return `<span class="latex-citation" data-cite-keys="${keys.join(',')}">[${keys.join(', ')}]</span>`;
      }
      case '\\label':
        return '';
      case '\\ref':
      case '\\pageref':
      case '\\eqref':
        return `<span class="latex-ref" data-ref="${this._renderNodes(node.children)}">??</span>`;
      case '\\includegraphics': {
        const opts = node.args ? this._renderNodes(node.args[0]?.children || []) : '';
        const src = node.args && node.args[1] ? this._renderNodes(node.args[1].children) : '';
        return `<div class="latex-includegraphics" data-src="${this._escapeAttr(src)}" data-options="${this._escapeAttr(opts)}">
          <span class="latex-graphics-placeholder">[Image: ${this._escapeHtml(src)}]</span>
        </div>`;
      }
      case '\\newline':
      case '\\\\':
        return '<br>';
      case '\\par':
        return '</p><p>';
      case '\\hspace':
      case '\\vspace': {
        const len = this._renderNodes(node.children);
        return `<span class="latex-space" data-length="${this._escapeAttr(len)}"></span>`;
      }
      case '\\quad':
        return '<span class="latex-quad"></span>';
      case '\\qquad':
        return '<span class="latex-qquad"></span>';
      case '\\dots':
      case '\\ldots':
        return '\u2026';
      case '\\cdots':
        return '\u22ef';
      case '\\vdots':
        return '\u22ee';
      case '\\ddots':
        return '\u22f1';
      case '\\textbackslash':
        return '\\';
      case '\\textasciitilde':
        return '~';
      case '\\textasciicircum':
        return '^';
      case '\\textless':
        return '<';
      case '\\textgreater':
        return '>';
      case '\\textbar':
        return '|';
      case '\\textdollar':
        return '$';
      case '\\textpercent':
        return '%';
      case '\\textampersand':
        return '&';
      case '\\textunderscore':
        return '_';
      case '\\textbraceleft':
        return '{';
      case '\\textbraceright':
        return '}';
      case '\\#':
        return '#';
      case '\\$':
        return '$';
      case '\\%':
        return '%';
      case '\\&':
        return '&amp;';
      case '\\_':
        return '_';
      case '\\{':
        return '{';
      case '\\}':
        return '}';
      case '\\textregistered':
        return '&reg;';
      case '\\textcopyright':
        return '&copy;';
      case '\\texttrademark':
        return '&trade;';
      case '\\textendash':
        return '&ndash;';
      case '\\textemdash':
        return '&mdash;';
      case '\\textbullet':
        return '&bull;';
      case '\\textopenbullet':
        return '&#8226;';
      case '\\textvisiblespace':
        return '&#9251;';
      case '\\textellipsis':
        return '\u2026';
      case '\\today':
        return new Date().toLocaleDateString();
      case '\\LaTeX':
        return 'L<sup>A</sup>T<sub>E</sub>X';
      case '\\TeX':
        return 'T<sub>E</sub>X';
      default:
        if (node.children && node.children.length > 0) {
          return this._renderNodes(node.children);
        }
        return this._escapeHtml(name);
    }
  }

  _renderEnvironment(node) {
    const name = (node.name || '').replace(/^\\/, '');
    const content = this._renderNodes(node.children);

    if (isStructuralEnvironment(name)) {
      const title = this._extractTitle(node);
      return renderStructuralEnvironment(name, content, title);
    }
    if (isTextEnvironment(name)) {
      return renderTextEnvironment(name, content);
    }
    if (isFloatEnvironment(name)) {
      const caption = this._extractCaption(node);
      return renderFloatEnvironment(name, content, caption);
    }
    if (isMathEnvironment(name)) {
      return renderMathEnvironment(name, content);
    }

    return `<div class="latex-env latex-env-${name}">${content}</div>`;
  }

  _renderGroup(node) {
    return this._renderNodes(node.children);
  }

  _renderMath(node) {
    const idx = this.mathBlocks.length;
    this.mathBlocks.push(node);
    return `<span class="latex-math-block" data-math-idx="${idx}" data-display="${node.type === 'MathDisplay'}"></span>`;
  }

  _renderSuperscript(node) {
    return `<sup>${this._renderNodes(node.children)}</sup>`;
  }

  _renderSubscript(node) {
    return `<sub>${this._renderNodes(node.children)}</sub>`;
  }

  _renderSection(node) {
    const level = node.content?.level || 1;
    const title = node.content?.title ? this._renderNodes(node.content.title) : '';
    const body = this._renderNodes(node.children);
    const tag = `h${Math.min(level + 1, 6)}`;
    return `<${tag} class="latex-section latex-section-${level}">${title}</${tag}>${body}`;
  }

  _renderList(node) {
    const ordered = node.options?.ordered;
    const tag = ordered ? 'ol' : 'ul';
    const items = this._renderNodes(node.children);
    return `<${tag} class="latex-list">${items}</${tag}>`;
  }

  _renderListItem(node) {
    return `<li class="latex-list-item">${this._renderNodes(node.children)}</li>`;
  }

  _renderTable(node) {
    return this._renderNodes(node.children);
  }

  _renderTableRow(node) {
    return `<tr class="latex-table-row">${this._renderNodes(node.children)}</tr>`;
  }

  _renderTableCell(node) {
    return `<td class="latex-table-cell">${this._renderNodes(node.children)}</td>`;
  }

  _renderFraction(node) {
    const num = node.content?.numerator ? this._renderNodes(node.content.numerator) : '';
    const den = node.content?.denominator ? this._renderNodes(node.content.denominator) : '';
    return `<span class="latex-frac"><span class="latex-frac-num">${num}</span><span class="latex-frac-den">${den}</span></span>`;
  }

  _renderMatrix(node) {
    return `<span class="latex-matrix">${this._renderNodes(node.children)}</span>`;
  }

  _extractTitle(node) {
    if (!node.options) return '';
    if (typeof node.options === 'string') return node.options;
    return '';
  }

  _extractCaption(node) {
    for (const child of (node.children || [])) {
      if (child && child.name === '\\caption' && child.args && child.args[0]) {
        return this._renderNodes(child.args[0].children);
      }
    }
    return '';
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  getPreambleItems() {
    return this.preambleItems;
  }

  getMathBlocks() {
    return this.mathBlocks;
  }
}

export function renderToHTML(ast, mathBlocks = []) {
  const renderer = new HTMLRenderer();
  return renderer.render(ast, mathBlocks);
}
