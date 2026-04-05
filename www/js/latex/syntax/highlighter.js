// www/js/latex/syntax/highlighter.js
// Full LaTeX syntax highlighting for code blocks using the core tokenizer.

import { tokenize, TokenType } from '../core/tokenizer.js';

const COMMAND_HIGHLIGHT = 'latex-command';
const ENV_HIGHLIGHT = 'latex-env-name';
const COMMENT_HIGHLIGHT = 'latex-comment';
const MATH_HIGHLIGHT = 'latex-math';
const BRACE_HIGHLIGHT = 'latex-brace';
const SPECIAL_HIGHLIGHT = 'latex-special';
const TEXT_HIGHLIGHT = 'latex-text';
const ARG_HIGHLIGHT = 'latex-arg';

const KNOWN_ENVS = new Set([
  'document','equation','equation*','align','align*','gather','gather*',
  'itemize','enumerate','description','tabular','figure','table',
  'theorem','lemma','proof','definition','remark','example',
  'verbatim','lstlisting','minted','center','flushleft','flushright',
  'quote','quotation','verse','abstract','titlepage',
  'bmatrix','pmatrix','vmatrix','Vmatrix','matrix','cases',
]);

const KNOWN_CMDS = new Set([
  '\\documentclass','\\usepackage','\\begin','\\end','\\section','\\subsection',
  '\\subsubsection','\\chapter','\\title','\\author','\\date','\\maketitle',
  '\\tableofcontents','\\newcommand','\\renewcommand','\\include','\\input',
  '\\cite','\\ref','\\label','\\bibliography','\\bibliographystyle',
  '\\textbf','\\textit','\\texttt','\\emph','\\underline','\\overline',
  '\\frac','\\sqrt','\\sum','\\prod','\\int','\\oint','\\iint','\\iiint',
  '\\left','\\right','\\big','\\Big','\\bigg','\\Bigg',
  '\\alpha','\\beta','\\gamma','\\delta','\\epsilon','\\theta','\\lambda',
  '\\mu','\\pi','\\sigma','\\phi','\\omega','\\Gamma','\\Delta','\\Theta',
  '\\Lambda','\\Xi','\\Pi','\\Sigma','\\Phi','\\Psi','\\Omega',
  '\\infty','\\partial','\\nabla','\\forall','\\exists','\\neg','\\wedge',
  '\\vee','\\cap','\\cup','\\subset','\\supset','\\in','\\notin','\\emptyset',
  '\\rightarrow','\\leftarrow','\\leftrightarrow','\\Rightarrow','\\Leftrightarrow',
  '\\mapsto','\\hookrightarrow','\\longrightarrow','\\longleftarrow',
  '\\ldots','\\cdots','\\vdots','\\ddots','\\dots',
  '\\quad','\\qquad','\\hspace','\\vspace','\\newline','\\\\',
  '\\item','\\caption','\\includegraphics','\\href','\\url',
  '\\today','\\TeX','\\LaTeX',
]);

export function highlightLatex(source) {
  if (!source) return '';
  const { tokens } = tokenize(source);
  let result = '';
  let inMath = false;
  let inComment = false;

  for (const token of tokens) {
    if (token.type === TokenType.EOF) break;

    switch (token.type) {
      case TokenType.COMMAND: {
        const cmd = token.value;
        const isKnown = KNOWN_CMDS.has(cmd);
        result += `<span class="${isKnown ? COMMAND_HIGHLIGHT : SPECIAL_HIGHLIGHT}">${escapeHtml(cmd)}</span>`;
        break;
      }
      case TokenType.BEGIN_ENV:
      case TokenType.END_ENV: {
        const envName = token.value;
        const isKnown = KNOWN_ENVS.has(envName);
        const prefix = token.type === TokenType.BEGIN_ENV ? '\\begin{' : '\\end{';
        result += `<span class="${COMMAND_HIGHLIGHT}">${escapeHtml(prefix)}</span>`;
        result += `<span class="${isKnown ? ENV_HIGHLIGHT : SPECIAL_HIGHLIGHT}">${escapeHtml(envName)}</span>`;
        result += `<span class="${COMMAND_HIGHLIGHT}">}</span>`;
        break;
      }
      case TokenType.MATH_SHIFT:
        inMath = !inMath;
        result += `<span class="${MATH_HIGHLIGHT}">${escapeHtml(token.value)}</span>`;
        break;
      case TokenType.COMMENT:
        result += `<span class="${COMMENT_HIGHLIGHT}">%${escapeHtml(token.value)}</span>`;
        break;
      case TokenType.BEGIN_GROUP:
        result += `<span class="${BRACE_HIGHLIGHT}">{</span>`;
        break;
      case TokenType.END_GROUP:
        result += `<span class="${BRACE_HIGHLIGHT}">}</span>`;
        break;
      case TokenType.ALIGNMENT:
        result += `<span class="${SPECIAL_HIGHLIGHT}">&amp;</span>`;
        break;
      case TokenType.SUPERSCRIPT:
        result += `<span class="${SPECIAL_HIGHLIGHT}">^</span>`;
        break;
      case TokenType.SUBSCRIPT:
        result += `<span class="${SPECIAL_HIGHLIGHT}">_</span>`;
        break;
      case TokenType.PARAMETER:
        result += `<span class="${ARG_HIGHLIGHT}">${escapeHtml(token.value)}</span>`;
        break;
      case TokenType.WHITESPACE:
      case TokenType.END_OF_LINE:
        result += escapeHtml(token.value);
        break;
      case TokenType.LETTER:
      case TokenType.OTHER:
      case TokenType.ACTIVE:
        result += `<span class="${inMath ? MATH_HIGHLIGHT : TEXT_HIGHLIGHT}">${escapeHtml(token.value)}</span>`;
        break;
      default:
        result += escapeHtml(token.value);
    }
  }

  return result;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function wrapHighlighted(code) {
  return `<pre class="latex-highlighted"><code>${code}</code></pre>`;
}
