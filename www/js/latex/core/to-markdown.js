// www/js/latex/core/to-markdown.js
// Converts LaTeX AST or source to Markdown.

import { tokenize } from './tokenizer.js';
import { Parser } from './parser.js';
import { NodeType, flattenText } from './ast.js';

export class LatexToMarkdown {
  constructor(options = {}) {
    this.options = {
      mathStyle: options.mathStyle || 'dollar', // 'dollar' | 'katex' | 'mathjax'
      preserveEnvironments: options.preserveEnvironments !== false,
      headingStyle: options.headingStyle || 'atx', // 'atx' | 'setext'
      ...options,
    };
  }

  /**
   * Convert LaTeX source to Markdown.
   */
  convert(source) {
    const { tokens } = tokenize(source);
    const parser = new Parser(tokens, []);
    const ast = parser.parse();
    return this.convertAST(ast);
  }

  /**
   * Convert LaTeX AST to Markdown.
   */
  convertAST(ast) {
    if (!ast || !ast.children) return '';
    return this._convertNodes(ast.children).trim();
  }

  _convertNodes(nodes) {
    if (!nodes || !Array.isArray(nodes)) return '';
    return nodes.map(node => this._convertNode(node)).join('');
  }

  _convertNode(node) {
    if (!node) return '';
    if (typeof node === 'string') return this._escapeMarkdown(node);

    switch (node.type) {
      case 'Document':
        return this._convertNodes(node.children);
      case 'Text':
        return this._escapeMarkdown(node.value || '');
      case 'Whitespace':
        return node.value || ' ';
      case 'Comment':
        return '';
      case 'Command':
        return this._convertCommand(node);
      case 'Environment':
        return this._convertEnvironment(node);
      case 'Group':
        return this._convertNodes(node.children);
      case 'MathInline':
      case 'MathDisplay':
        return this._convertMath(node);
      case 'Superscript':
        return `^${this._convertNodes(node.children)}`;
      case 'Subscript':
        return `_${this._convertNodes(node.children)}`;
      case 'Section':
        return this._convertSection(node);
      case 'List':
        return this._convertList(node);
      case 'ListItem':
        return this._convertListItem(node);
      case 'Table':
        return this._convertTable(node);
      case 'TableRow':
        return this._convertTableRow(node);
      case 'TableCell':
        return this._convertTableCell(node);
      case 'Fraction':
        return this._convertFraction(node);
      case 'Matrix':
        return this._convertMatrix(node);
      case 'Parameter':
        return `#${node.content || ''}`;
      case 'Argument':
        return this._convertNodes(node.children);
      default:
        return this._convertNodes(node.children);
    }
  }

  _convertCommand(node) {
    const name = node.name || '';

    switch (name) {
      case '\\textbf':
      case '\\textbf{}':
        return `**${this._convertNodes(node.children)}**`;
      case '\\textit':
        return `*${this._convertNodes(node.children)}*`;
      case '\\texttt':
        return `\`${this._convertNodes(node.children)}\``;
      case '\\underline':
        return `<u>${this._convertNodes(node.children)}</u>`;
      case '\\emph':
        return `*${this._convertNodes(node.children)}*`;
      case '\\href': {
        const args = node.args || [];
        const url = args[0] ? this._convertNodes(args[0].children) : '#';
        const text = args[1] ? this._convertNodes(args[1].children) : url;
        return `[${text}](${url})`;
      }
      case '\\url': {
        const url = this._convertNodes(node.children);
        return `<${url}>`;
      }
      case '\\cite': {
        const keys = this._convertNodes(node.children).split(',').map(k => k.trim());
        return `[@${keys.join(', @')}]`;
      }
      case '\\label':
        return '';
      case '\\ref':
      case '\\pageref':
      case '\\eqref':
        return `[${this._convertNodes(node.children)}]`;
      case '\\newline':
      case '\\\\':
        return '  \n';
      case '\\par':
        return '\n\n';
      case '\\hspace':
      case '\\vspace':
        return '';
      case '\\quad':
        return '    ';
      case '\\qquad':
        return '        ';
      case '\\dots':
      case '\\ldots':
        return '...';
      case '\\cdots':
        return '...';
      case '\\vdots':
        return '⋮';
      case '\\ddots':
        return '⋱';
      case '\\#': return '#';
      case '\\$': return '$';
      case '\\%': return '%';
      case '\\&': return '&';
      case '\\_': return '_';
      case '\\{': return '{';
      case '\\}': return '}';
      case '\\textregistered': return '®';
      case '\\textcopyright': return '©';
      case '\\texttrademark': return '™';
      case '\\textendash': return '–';
      case '\\textemdash': return '—';
      case '\\textbullet': return '•';
      case '\\textellipsis': return '...';
      case '\\today':
        return new Date().toLocaleDateString();
      case '\\LaTeX':
        return 'LaTeX';
      case '\\TeX':
        return 'TeX';
      default:
        if (node.children && node.children.length > 0) {
          return this._convertNodes(node.children);
        }
        return this._escapeMarkdown(name);
    }
  }

  _convertEnvironment(node) {
    const name = (node.name || '').replace(/^\\/, '');

    switch (name) {
      case 'itemize':
        return this._convertNodes(node.children);
      case 'enumerate':
        return this._convertNodes(node.children);
      case 'description':
        return this._convertNodes(node.children);
      case 'quote':
      case 'quotation':
        return `> ${this._convertNodes(node.children).replace(/\n/g, '\n> ')}\n`;
      case 'verse':
        return `> ${this._convertNodes(node.children)}\n`;
      case 'verbatim':
      case 'Verbatim':
      case 'lstlisting':
      case 'minted':
        return `\`\`\`\n${this._convertNodes(node.children)}\n\`\`\`\n`;
      case 'center':
      case 'flushleft':
      case 'flushright':
        return this._convertNodes(node.children);
      case 'figure':
      case 'table':
        return this._convertNodes(node.children);
      case 'equation':
      case 'equation*':
      case 'align':
      case 'align*':
      case 'gather':
      case 'gather*':
        return this._convertMathContent(node);
      default:
        return this._convertNodes(node.children);
    }
  }

  _convertSection(node) {
    const level = node.content?.level || 1;
    const title = node.content?.title ? this._convertNodes(node.content.title) : '';
    const body = this._convertNodes(node.children);

    if (this.options.headingStyle === 'atx') {
      const hashes = '#'.repeat(Math.min(level + 1, 6));
      return `${hashes} ${title}\n\n${body}`;
    }

    // Setext style (only for h1 and h2)
    if (level === 0) {
      return `${title}\n${'='.repeat(title.length)}\n\n${body}`;
    }
    if (level === 1) {
      return `${title}\n${'-'.repeat(title.length)}\n\n${body}`;
    }
    const hashes = '#'.repeat(Math.min(level + 1, 6));
    return `${hashes} ${title}\n\n${body}`;
  }

  _convertList(node) {
    const ordered = node.options?.ordered;
    let idx = 1;
    const items = node.children.map(child => {
      const content = this._convertNode(child);
      if (ordered) {
        const result = `${idx}. ${content.trimStart()}`;
        idx++;
        return result;
      }
      return `- ${content.trimStart()}`;
    }).join('\n');
    return items + '\n';
  }

  _convertListItem(node) {
    return this._convertNodes(node.children);
  }

  _convertTable(node) {
    return this._convertNodes(node.children);
  }

  _convertTableRow(node) {
    return this._convertNodes(node.children) + '\n';
  }

  _convertTableCell(node) {
    return `| ${this._convertNodes(node.children)} `;
  }

  _convertMath(node) {
    const content = this._extractMathContent(node);
    const displayMode = node.type === 'MathDisplay';

    switch (this.options.mathStyle) {
      case 'dollar':
        return displayMode ? `\n$$${content}$$\n` : `$${content}$`;
      case 'katex':
        return displayMode ? `\n$$${content}$$\n` : `$${content}$`;
      case 'mathjax':
        return displayMode ? `\n$$${content}$$\n` : `$${content}$`;
      default:
        return displayMode ? `\n$$${content}$$\n` : `$${content}$`;
    }
  }

  _convertMathContent(node) {
    const content = this._convertNodes(node.children);
    return `\n$$${content}$$\n`;
  }

  _convertFraction(node) {
    const num = node.content?.numerator ? this._convertNodes(node.content.numerator) : '';
    const den = node.content?.denominator ? this._convertNodes(node.content.denominator) : '';
    return `$\\frac{${num}}{${den}}$`;
  }

  _convertMatrix(node) {
    return `$${this._convertNodes(node.children)}$`;
  }

  _extractMathContent(node) {
    if (!node || !node.children) return '';
    return node.children.map(child => {
      if (typeof child === 'string') return child;
      if (child.value) return child.value;
      if (child.raw) return child.raw;
      if (child.children) return this._extractMathContent(child);
      return '';
    }).join('');
  }

  _escapeMarkdown(text) {
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/`/g, '\\`')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }
}

/**
 * Convenience: convert LaTeX to Markdown.
 */
export function latexToMarkdown(source, options = {}) {
  const converter = new LatexToMarkdown(options);
  return converter.convert(source);
}
