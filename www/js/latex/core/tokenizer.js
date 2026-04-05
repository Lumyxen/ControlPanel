// www/js/latex/core/tokenizer.js
// Character-by-character LaTeX tokenizer producing a token stream.
// Handles catcodes (category codes) like real TeX.

import { createError } from './errors.js';

// ─── Token Types ──────────────────────────────────────────────────────────────

export const TokenType = {
  COMMAND: 'COMMAND',
  BEGIN_GROUP: 'BEGIN_GROUP',
  END_GROUP: 'END_GROUP',
  MATH_SHIFT: 'MATH_SHIFT',
  MATH_SHIFT_LPAREN: 'MATH_SHIFT_LPAREN',  // \(
  MATH_SHIFT_RPAREN: 'MATH_SHIFT_RPAREN',  // \)
  MATH_SHIFT_LBRACKET: 'MATH_SHIFT_LBRACKET', // \[
  MATH_SHIFT_RBRACKET: 'MATH_SHIFT_RBRACKET', // \]
  ALIGNMENT: 'ALIGNMENT',
  END_OF_LINE: 'END_OF_LINE',
  PARAMETER: 'PARAMETER',
  SUPERSCRIPT: 'SUPERSCRIPT',
  SUBSCRIPT: 'SUBSCRIPT',
  COMMENT: 'COMMENT',
  ESCAPE: 'ESCAPE',
  ACTIVE: 'ACTIVE',
  LETTER: 'LETTER',
  OTHER: 'OTHER',
  WHITESPACE: 'WHITESPACE',
  BEGIN_ENV: 'BEGIN_ENV',
  END_ENV: 'END_ENV',
  EOF: 'EOF',
};

// ─── Catcodes (TeX category codes) ────────────────────────────────────────────

const Catcode = {
  ESCAPE: 0,      // \
  BEGIN_GROUP: 1, // {
  END_GROUP: 2,   // }
  MATH_SHIFT: 3,  // $
  ALIGNMENT: 4,   // &
  END_OF_LINE: 5, // \n
  PARAMETER: 6,   // #
  SUPERSCRIPT: 7, // ^
  SUBSCRIPT: 8,   // _
  LETTER: 11,     // a-z, A-Z
  OTHER: 12,      // everything else
  COMMENT: 14,    // %
  ACTIVE: 13,     // ~ (in standard LaTeX)
  SPACE: 10,      // space, tab
};

// Default catcode table
function defaultCatcodes() {
  const cc = new Array(256).fill(Catcode.OTHER);
  cc[92] = Catcode.ESCAPE;       // \
  cc[123] = Catcode.BEGIN_GROUP; // {
  cc[125] = Catcode.END_GROUP;   // }
  cc[36] = Catcode.MATH_SHIFT;   // $
  cc[38] = Catcode.ALIGNMENT;    // &
  cc[10] = Catcode.END_OF_LINE;  // \n
  cc[13] = Catcode.END_OF_LINE;  // \r (treat as newline)
  cc[35] = Catcode.PARAMETER;    // #
  cc[94] = Catcode.SUPERSCRIPT;  // ^
  cc[95] = Catcode.SUBSCRIPT;    // _
  cc[37] = Catcode.COMMENT;      // %
  cc[126] = Catcode.ACTIVE;      // ~
  cc[32] = Catcode.SPACE;        // space
  cc[9] = Catcode.SPACE;         // tab
  for (let i = 65; i <= 90; i++) cc[i] = Catcode.LETTER;   // A-Z
  for (let i = 97; i <= 122; i++) cc[i] = Catcode.LETTER;  // a-z
  return cc;
}

// ─── Token Class ──────────────────────────────────────────────────────────────

export class Token {
  constructor(type, value, location) {
    this.type = type;
    this.value = value;
    this.location = location;
  }

  toString() {
    return `Token(${this.type}, "${this.value.replace(/\n/g, '\\n')}")`;
  }
}

// ─── Location Tracker ─────────────────────────────────────────────────────────

class LocationTracker {
  constructor() {
    this.line = 1;
    this.column = 1;
    this.offset = 0;
  }

  snapshot() {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  advance(char) {
    this.offset++;
    if (char === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
  }
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

export class Tokenizer {
  constructor(source, options = {}) {
    this.source = source || '';
    this.pos = 0;
    this.catcodes = options.catcodes || defaultCatcodes();
    this.loc = new LocationTracker();
    this.errors = [];
    this.inMathMode = options.inMathMode || false;
    this.inComment = false;
    this.maxErrors = options.maxErrors || 100;
  }

  peek() {
    if (this.pos >= this.source.length) return null;
    return this.source[this.pos];
  }

  advance() {
    if (this.pos >= this.source.length) return null;
    const ch = this.source[this.pos];
    this.pos++;
    this.loc.advance(ch);
    return ch;
  }

  startsWith(str) {
    return this.source.startsWith(str, this.pos);
  }

  catcode(charCode) {
    if (charCode < 0 || charCode >= this.catcodes.length) return Catcode.OTHER;
    return this.catcodes[charCode];
  }

  tokenize() {
    const tokens = [];
    while (this.pos < this.source.length) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
      if (this.errors.length >= this.maxErrors) break;
    }
    tokens.push(new Token(TokenType.EOF, '', this.loc.snapshot()));
    return { tokens, errors: this.errors };
  }

  nextToken() {
    if (this.pos >= this.source.length) return null;

    const startLoc = this.loc.snapshot();
    const ch = this.peek();
    const code = ch.charCodeAt(0);
    const cc = this.catcode(code);

    switch (cc) {
      case Catcode.ESCAPE:
        return this.readCommand();

      case Catcode.BEGIN_GROUP:
        this.advance();
        return new Token(TokenType.BEGIN_GROUP, '{', startLoc);

      case Catcode.END_GROUP:
        this.advance();
        return new Token(TokenType.END_GROUP, '}', startLoc);

      case Catcode.MATH_SHIFT:
        this.advance();
        // Check for display math $$
        if (this.peek() === '$') {
          this.advance();
          return new Token(TokenType.MATH_SHIFT, '$$', startLoc);
        }
        return new Token(TokenType.MATH_SHIFT, '$', startLoc);

      case Catcode.ALIGNMENT:
        this.advance();
        return new Token(TokenType.ALIGNMENT, '&', startLoc);

      case Catcode.END_OF_LINE: {
        const nl = this.advance();
        return new Token(TokenType.END_OF_LINE, nl, startLoc);
      }

      case Catcode.PARAMETER:
        this.advance();
        // Read parameter number
        const paramCh = this.peek();
        if (paramCh && /[0-9]/.test(paramCh)) {
          this.advance();
          return new Token(TokenType.PARAMETER, '#' + paramCh, startLoc);
        }
        return new Token(TokenType.PARAMETER, '#', startLoc);

      case Catcode.SUPERSCRIPT:
        this.advance();
        return new Token(TokenType.SUPERSCRIPT, '^', startLoc);

      case Catcode.SUBSCRIPT:
        this.advance();
        return new Token(TokenType.SUBSCRIPT, '_', startLoc);

      case Catcode.COMMENT:
        return this.readComment();

      case Catcode.SPACE:
        return this.readWhitespace();

      case Catcode.LETTER:
        return this.readLetterOrWord();

      case Catcode.ACTIVE:
        this.advance();
        return new Token(TokenType.ACTIVE, '~', startLoc);

      default:
        this.advance();
        return new Token(TokenType.OTHER, ch, startLoc);
    }
  }

  readCommand() {
    const startLoc = this.loc.snapshot();
    this.advance(); // consume '\'

    if (this.pos >= this.source.length) {
      return new Token(TokenType.COMMAND, '', startLoc);
    }

    const nextCh = this.peek();
    const nextCode = nextCh.charCodeAt(0);
    const nextCc = this.catcode(nextCode);

    // Control sequence: either a single non-letter or a sequence of letters
    if (nextCc !== Catcode.LETTER) {
      this.advance();
      // Check for \( and \[ math delimiters
      if (nextCh === '(') {
        return new Token(TokenType.MATH_SHIFT_LPAREN, '\\(', startLoc);
      }
      if (nextCh === '[') {
        return new Token(TokenType.MATH_SHIFT_LBRACKET, '\\[', startLoc);
      }
      return new Token(TokenType.COMMAND, '\\' + nextCh, startLoc);
    }

    // Read all consecutive letters
    let name = '\\';
    while (this.pos < this.source.length) {
      const ch = this.peek();
      const code = ch.charCodeAt(0);
      if (this.catcode(code) === Catcode.LETTER) {
        name += this.advance();
      } else {
        break;
      }
    }

    // Check for \begin{...} and \end{...}
    if (name === '\\begin') {
      return this.readEnvironmentName('begin', startLoc);
    }
    if (name === '\\end') {
      return this.readEnvironmentName('end', startLoc);
    }

    // Check for \) and \] math delimiters
    if (name === '\\)') {
      return new Token(TokenType.MATH_SHIFT_RPAREN, '\\)', startLoc);
    }
    if (name === '\\]') {
      return new Token(TokenType.MATH_SHIFT_RBRACKET, '\\]', startLoc);
    }

    return new Token(TokenType.COMMAND, name, startLoc);
  }

  readEnvironmentName(type, startLoc) {
    // Consume optional whitespace after \begin or \end
    while (this.pos < this.source.length && /[ \t\n\r]/.test(this.peek())) {
      this.advance();
    }

    if (this.peek() !== '{') {
      this.errors.push(createError('MISMATCHED_ENVIRONMENT', startLoc, type));
      return new Token(TokenType.COMMAND, type === 'begin' ? '\\begin' : '\\end', startLoc);
    }

    this.advance(); // consume '{'

    let envName = '';
    while (this.pos < this.source.length && this.peek() !== '}') {
      envName += this.advance();
    }

    if (this.peek() === '}') {
      this.advance(); // consume '}'
    } else {
      this.errors.push(createError('UNMATCHED_BRACE', startLoc, '{' + envName));
    }

    return new Token(
      type === 'begin' ? TokenType.BEGIN_ENV : TokenType.END_ENV,
      envName,
      startLoc
    );
  }

  readComment() {
    const startLoc = this.loc.snapshot();
    this.advance(); // consume '%'
    let text = '';
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === '\n' || ch === '\r') break;
      text += this.advance();
    }
    return new Token(TokenType.COMMENT, text, startLoc);
  }

  readWhitespace() {
    const startLoc = this.loc.snapshot();
    let ws = '';
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t') {
        ws += this.advance();
      } else {
        break;
      }
    }
    if (ws.length > 0) {
      return new Token(TokenType.WHITESPACE, ws, startLoc);
    }
    return null;
  }

  readLetterOrWord() {
    const startLoc = this.loc.snapshot();
    let word = '';
    while (this.pos < this.source.length) {
      const ch = this.peek();
      const code = ch.charCodeAt(0);
      if (this.catcode(code) === Catcode.LETTER) {
        word += this.advance();
      } else {
        break;
      }
    }
    return new Token(TokenType.LETTER, word, startLoc);
  }
}

// ─── Convenience Function ─────────────────────────────────────────────────────

export function tokenize(source, options) {
  const tokenizer = new Tokenizer(source, options);
  return tokenizer.tokenize();
}
