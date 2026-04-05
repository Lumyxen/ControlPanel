// www/js/latex/core/parser.js
// Recursive descent parser consuming token stream, building AST with proper environment nesting.

import { TokenType } from './tokenizer.js';
import {
  NodeType,
  createDocument, createCommand, createEnvironment, createGroup,
  createText, createMath, createParameter, createComment,
  createWhitespace, createSuperscript, createSubscript,
  createArgument, createRaw,
} from './ast.js';
import { createError } from './errors.js';

// ─── Known Section Commands ───────────────────────────────────────────────────

const SECTION_COMMANDS = {
  '\\part': 0,
  '\\chapter': 1,
  '\\section': 2,
  '\\subsection': 3,
  '\\subsubsection': 4,
  '\\paragraph': 5,
  '\\subparagraph': 6,
};

// ─── Known Math Commands (don't try to parse as text) ─────────────────────────

const MATH_COMMANDS = new Set([
  '\\frac', '\\dfrac', '\\tfrac', '\\cfrac',
  '\\binom', '\\dbinom', '\\tbinom',
  '\\sqrt', '\\left', '\\right',
  '\\begin', '\\end',
  '\\over', '\\above', '\\atop',
  '\\choose', '\\brack', '\\brace',
]);

// ─── Parser ───────────────────────────────────────────────────────────────────

export class Parser {
  constructor(tokens, errors = []) {
    this.tokens = tokens;
    this.pos = 0;
    this.errors = errors;
    this.envStack = [];
    this.mathDepth = 0;
  }

  peek() {
    if (this.pos >= this.tokens.length) return null;
    return this.tokens[this.pos];
  }

  peekAhead(n = 1) {
    const idx = this.pos + n;
    if (idx >= this.tokens.length) return null;
    return this.tokens[idx];
  }

  advance() {
    if (this.pos >= this.tokens.length) return null;
    return this.tokens[this.pos++];
  }

  expect(type) {
    const token = this.peek();
    if (!token || token.type !== type) {
      if (token) {
        this.errors.push(createError('UNEXPECTED_TOKEN', token.location, token.value));
      }
      return null;
    }
    return this.advance();
  }

  skipWhitespace() {
    while (this.peek() && this.peek().type === TokenType.WHITESPACE) {
      this.advance();
    }
  }

  skipWhitespaceAndNewlines() {
    while (this.peek() && (this.peek().type === TokenType.WHITESPACE || this.peek().type === TokenType.END_OF_LINE)) {
      this.advance();
    }
  }

  parse() {
    const children = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token.type === TokenType.EOF) break;
      const node = this.parseNode();
      if (node) children.push(node);
    }
    return createDocument(children);
  }

  parseNode() {
    const token = this.peek();
    if (!token || token.type === TokenType.EOF) return null;

    switch (token.type) {
      case TokenType.BEGIN_ENV:
        return this.parseEnvironment();
      case TokenType.COMMAND:
        return this.parseCommand();
      case TokenType.MATH_SHIFT_LPAREN:
        return this.parseMathParen(false);
      case TokenType.MATH_SHIFT_LBRACKET:
        return this.parseMathBracket();
      case TokenType.BEGIN_GROUP:
        return this.parseGroup();
      case TokenType.MATH_SHIFT:
        return this.parseMath();
      case TokenType.SUPERSCRIPT:
        return this.parseSuperscript();
      case TokenType.SUBSCRIPT:
        return this.parseSubscript();
      case TokenType.COMMENT:
        return this.parseComment();
      case TokenType.WHITESPACE:
      case TokenType.END_OF_LINE:
        return this.parseWhitespace();
      case TokenType.ALIGNMENT:
        return this.parseAlignment();
      case TokenType.LETTER:
      case TokenType.OTHER:
      case TokenType.ACTIVE:
        return this.parseText();
      case TokenType.PARAMETER:
        return this.parseParameter();
      case TokenType.END_GROUP:
        this.errors.push(createError('UNMATCHED_BRACE_CLOSE', token.location, '}'));
        this.advance();
        return createText('}', { location: token.location });
      default:
        this.advance();
        return createText(token.value, { location: token.location });
    }
  }

  parseEnvironment() {
    const beginToken = this.advance();
    const envName = beginToken.value;
    this.envStack.push(envName);

    const options = this.parseOptionalArgument();
    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token.type === TokenType.EOF) {
        this.errors.push(createError('MISMATCHED_ENVIRONMENT', beginToken.location, `\\begin{${envName}} without matching \\end`));
        break;
      }
      if (token.type === TokenType.END_ENV) {
        if (token.value === envName || token.value === envName + '*') {
          this.advance();
          this.envStack.pop();
          break;
        } else {
          this.errors.push(createError('MISMATCHED_ENVIRONMENT', token.location, `\\begin{${envName}} vs \\end{${token.value}}`));
          this.advance();
          this.envStack.pop();
          break;
        }
      }
      if (token.type === TokenType.END_GROUP) {
        this.errors.push(createError('UNMATCHED_BRACE_CLOSE', token.location, '}'));
        this.advance();
        continue;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createEnvironment(envName, options, children, {
      location: beginToken.location,
      raw: `\\begin{${envName}}`,
    });
  }

  parseCommand() {
    const token = this.advance();
    const name = token.value;

    // Check if it's a section command
    if (SECTION_COMMANDS[name] !== undefined) {
      return this.parseSection(name, SECTION_COMMANDS[name], token);
    }

    // Parse arguments
    const args = [];
    let optArg = this.parseOptionalArgument();
    if (optArg) args.push(optArg);

    while (this.peek() && this.peek().type === TokenType.BEGIN_GROUP) {
      const arg = this.parseMandatoryArgument();
      if (arg) args.push(arg);
    }

    // For commands that take children (like \text, \mbox, etc.)
    const textCommands = new Set([
      '\\text', '\\mbox', '\\makebox', '\\fbox', '\\framebox',
      '\\colorbox', '\\fcolorbox', '\\raisebox', '\\scalebox',
      '\\textrm', '\\textsf', '\\texttt', '\\textbf', '\\textit',
      '\\textsl', '\\textsc', '\\textmd', '\\textup', '\\textnormal',
      '\\emph', '\\underline', '\\overline', '\\widehat', '\\widetilde',
      '\\vec', '\\bar', '\\tilde', '\\hat', '\\dot', '\\ddot',
      '\\mathbf', '\\mathit', '\\mathrm', '\\mathsf', '\\mathtt',
      '\\mathcal', '\\mathbb', '\\mathfrak', '\\boldsymbol',
    ]);

    if (textCommands.has(name) && args.length > 0) {
      const lastArg = args[args.length - 1];
      return createCommand(name, args.slice(0, -1), lastArg ? lastArg.children : [], {
        location: token.location,
        raw: name,
      });
    }

    // For frac, binom, etc. - special handling
    if (name === '\\frac' || name === '\\dfrac' || name === '\\tfrac') {
      const num = args[0] ? args[0].children : [];
      const den = args[1] ? args[1].children : [];
      return createCommand(name, args, [], {
        location: token.location,
        raw: name,
        content: { numerator: num, denominator: den },
      });
    }

    if (name === '\\sqrt') {
      return createCommand(name, args, [], {
        location: token.location,
        raw: name,
        content: { index: args[0] || null, radicand: args[1] || null },
      });
    }

    return createCommand(name, args, [], {
      location: token.location,
      raw: name,
    });
  }

  parseSection(name, level, token) {
    const args = [];
    const optArg = this.parseOptionalArgument();
    if (optArg) args.push(optArg);

    let titleArg = null;
    if (this.peek() && this.peek().type === TokenType.BEGIN_GROUP) {
      titleArg = this.parseMandatoryArgument();
      if (titleArg) args.push(titleArg);
    }

    const title = titleArg ? titleArg.children : [];

    // Parse section body until next section or end
    const body = [];
    while (this.pos < this.tokens.length) {
      const next = this.peek();
      if (!next || next.type === TokenType.EOF) break;
      if (next.type === TokenType.COMMAND && SECTION_COMMANDS[next.value] !== undefined) {
        if (SECTION_COMMANDS[next.value] <= level) break;
      }
      if (next.type === TokenType.END_ENV || (next.type === TokenType.END_GROUP && this.envStack.length === 0)) break;
      const node = this.parseNode();
      if (node) body.push(node);
    }

    return createCommand(name, args, body, {
      location: token.location,
      raw: name,
      content: { level, title },
    });
  }

  parseGroup() {
    const startToken = this.advance();
    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) {
        this.errors.push(createError('UNMATCHED_BRACE', startToken.location, '{'));
        break;
      }
      if (token.type === TokenType.END_GROUP) {
        this.advance();
        break;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createGroup(children, {
      location: startToken.location,
      raw: '{',
    });
  }

  parseMath() {
    const startToken = this.advance();
    const isDisplay = startToken.value === '$$';
    this.mathDepth++;

    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) {
        this.errors.push(createError('UNMATCHED_DOLLAR', startToken.location, '$'));
        break;
      }
      if (token.type === TokenType.MATH_SHIFT) {
        const endToken = this.advance();
        const endIsDisplay = endToken.value === '$$';
        if (endIsDisplay === isDisplay) {
          this.mathDepth--;
          break;
        }
        // Mismatched: single $ vs $$, treat as content
        continue;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createMath(children, isDisplay, {
      location: startToken.location,
      raw: startToken.value,
    });
  }

  /**
   * Parse inline math from \( ... \)
   */
  parseMathParen(_isDisplay = false) {
    const startToken = this.advance();
    this.mathDepth++;

    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) {
        this.errors.push(createError('UNMATCHED_PAREN', startToken.location, '\\('));
        break;
      }
      if (token.type === TokenType.MATH_SHIFT_RPAREN) {
        this.advance();
        this.mathDepth--;
        break;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createMath(children, false, {
      location: startToken.location,
      raw: '\\(',
    });
  }

  /**
   * Parse display math from \[ ... \]
   */
  parseMathBracket() {
    const startToken = this.advance();
    this.mathDepth++;

    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) {
        this.errors.push(createError('UNMATCHED_BRACKET', startToken.location, '\\['));
        break;
      }
      if (token.type === TokenType.MATH_SHIFT_RBRACKET) {
        this.advance();
        this.mathDepth--;
        break;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createMath(children, true, {
      location: startToken.location,
      raw: '\\[',
    });
  }

  parseOptionalArgument() {
    if (this.peek() && this.peek().type === TokenType.WHITESPACE) {
      this.advance();
    }
    if (!this.peek() || this.peek().type !== TokenType.OTHER || this.peek().value !== '[') {
      return null;
    }
    this.advance(); // consume '['
    const children = [];
    let depth = 1;

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) break;
      if (token.type === TokenType.OTHER && token.value === '[') depth++;
      if (token.type === TokenType.OTHER && token.value === ']') {
        depth--;
        if (depth === 0) {
          this.advance();
          break;
        }
      }
      if (depth === 0) break;
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createArgument(children, true);
  }

  parseMandatoryArgument() {
    if (!this.peek() || this.peek().type !== TokenType.BEGIN_GROUP) return null;
    const startToken = this.advance();
    const children = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token || token.type === TokenType.EOF) {
        this.errors.push(createError('UNMATCHED_BRACE', startToken.location, '{'));
        break;
      }
      if (token.type === TokenType.END_GROUP) {
        this.advance();
        break;
      }
      const node = this.parseNode();
      if (node) children.push(node);
    }

    return createArgument(children, false, {
      location: startToken.location,
    });
  }

  parseSuperscript() {
    const token = this.advance();
    let content = [];

    if (this.peek() && this.peek().type === TokenType.BEGIN_GROUP) {
      const group = this.parseGroup();
      if (group) content = group.children;
    } else {
      const node = this.parseNode();
      if (node) content = [node];
    }

    return createSuperscript(content, {
      location: token.location,
      raw: '^',
    });
  }

  parseSubscript() {
    const token = this.advance();
    let content = [];

    if (this.peek() && this.peek().type === TokenType.BEGIN_GROUP) {
      const group = this.parseGroup();
      if (group) content = group.children;
    } else {
      const node = this.parseNode();
      if (node) content = [node];
    }

    return createSubscript(content, {
      location: token.location,
      raw: '_',
    });
  }

  parseComment() {
    const token = this.advance();
    return createComment(token.value, {
      location: token.location,
      raw: '%' + token.value,
    });
  }

  parseWhitespace() {
    const token = this.advance();
    return createWhitespace(token.value, {
      location: token.location,
      raw: token.value,
    });
  }

  parseAlignment() {
    const token = this.advance();
    return createRaw('&', {
      location: token.location,
      raw: '&',
    });
  }

  parseParameter() {
    const token = this.advance();
    const num = parseInt(token.value.slice(1), 10) || 0;
    return createParameter(num, {
      location: token.location,
      raw: token.value,
    });
  }

  parseText() {
    const token = this.advance();
    return createText(token.value, {
      location: token.location,
      raw: token.value,
    });
  }
}

// ─── Convenience Function ─────────────────────────────────────────────────────

export function parse(tokens, errors = []) {
  const parser = new Parser(tokens, errors);
  return parser.parse();
}

// ─── Full Pipeline: source -> AST ─────────────────────────────────────────────

export async function parseSource(source, options = {}) {
  const { tokenize } = await import('./tokenizer.js');
  const { tokens, errors } = tokenize(source, options);
  const ast = parse(tokens, errors);
  return { ast, tokens, errors };
}
