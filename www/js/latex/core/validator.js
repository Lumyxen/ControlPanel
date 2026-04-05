// www/js/latex/core/validator.js
// LaTeX source validator/linter: checks for common issues, style violations, and potential errors.

import { tokenize, TokenType } from './tokenizer.js';
import { Parser } from './parser.js';
import { collectErrors } from './errors.js';

export const ValidationSeverity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
  HINT: 'hint',
};

export class LaTeXValidator {
  constructor(options = {}) {
    this.options = {
      maxLineLength: options.maxLineLength || 120,
      checkUnusedLabels: options.checkUnusedLabels !== false,
      checkMathSpacing: options.checkMathSpacing !== false,
      checkDeprecatedCommands: options.checkDeprecatedCommands !== false,
      checkStyle: options.checkStyle !== false,
      checkAccessibility: options.checkAccessibility !== false,
      ...options,
    };
    this.issues = [];
  }

  /**
   * Validate LaTeX source and return all issues.
   */
  validate(source) {
    this.issues = [];

    // Stage 1: Tokenize and parse
    const { tokens, errors: tokenErrors } = tokenize(source);
    for (const err of tokenErrors) {
      this.issues.push({
        severity: ValidationSeverity.ERROR,
        code: 'PARSE_ERROR',
        message: err.message || 'Parse error',
        location: err.location,
        suggestion: err.suggestion,
      });
    }

    const parser = new Parser(tokens, []);
    const ast = parser.parse();
    const parseErrors = collectErrors(ast);
    for (const err of parseErrors) {
      if (!this.issues.some(i => i.code === err.code && i.location?.line === err.location?.line)) {
        this.issues.push({
          severity: ValidationSeverity.ERROR,
          code: err.code,
          message: err.message,
          location: err.location,
          suggestion: err.suggestion,
        });
      }
    }

    // Stage 2: Line-level checks
    this._checkLines(source);

    // Stage 3: Token-level checks
    this._checkTokens(tokens, source);

    // Stage 4: Structural checks
    this._checkStructure(source, ast);

    // Stage 5: Style checks
    if (this.options.checkStyle) {
      this._checkStyle(source);
    }

    // Stage 6: Accessibility checks
    if (this.options.checkAccessibility) {
      this._checkAccessibility(source);
    }

    // Sort by severity then location
    this.issues.sort((a, b) => {
      const sevOrder = { error: 0, warning: 1, info: 2, hint: 3 };
      const aSev = sevOrder[a.severity] ?? 4;
      const bSev = sevOrder[b.severity] ?? 4;
      if (aSev !== bSev) return aSev - bSev;
      const aLine = a.location?.line || 0;
      const bLine = b.location?.line || 0;
      return aLine - bLine;
    });

    return this.issues;
  }

  _checkLines(source) {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check line length
      if (line.length > this.options.maxLineLength) {
        this.issues.push({
          severity: ValidationSeverity.HINT,
          code: 'LINE_TOO_LONG',
          message: `Line ${lineNum} is ${line.length} characters (max ${this.options.maxLineLength})`,
          location: { line: lineNum, column: this.options.maxLineLength },
          suggestion: 'Consider breaking this line for readability.',
        });
      }

      // Check trailing whitespace
      if (/\s+$/.test(line)) {
        this.issues.push({
          severity: ValidationSeverity.HINT,
          code: 'TRAILING_WHITESPACE',
          message: `Line ${lineNum} has trailing whitespace`,
          location: { line: lineNum, column: line.length - line.trimEnd().length },
          suggestion: 'Remove trailing whitespace.',
        });
      }

      // Check for tabs
      if (line.includes('\t')) {
        this.issues.push({
          severity: ValidationSeverity.HINT,
          code: 'TAB_CHARACTER',
          message: `Line ${lineNum} contains tab characters`,
          location: { line: lineNum, column: line.indexOf('\t') + 1 },
          suggestion: 'Use spaces instead of tabs.',
        });
      }
    }
  }

  _checkTokens(tokens, source) {
    const DEPRECATED_COMMANDS = new Set([
      '\\rm', '\\sf', '\\tt', '\\it', '\\bf', '\\sl', '\\sc', '\\cal',
      '\\em', '\\bf', '\\it', '\\sf', '\\tt',
    ]);

    let inMath = false;
    let mathContent = '';
    let mathStartLine = 0;

    for (const token of tokens) {
      if (token.type === TokenType.EOF) break;

      // Check deprecated commands
      if (this.options.checkDeprecatedCommands && token.type === TokenType.COMMAND) {
        if (DEPRECATED_COMMANDS.has(token.value)) {
          const replacements = {
            '\\rm': '\\mathrm{}', '\\sf': '\\mathsf{}', '\\tt': '\\mathtt{}',
            '\\it': '\\mathit{}', '\\bf': '\\mathbf{}', '\\sl': '\\textsl{}',
            '\\sc': '\\textsc{}', '\\cal': '\\mathcal{}',
          };
          this.issues.push({
            severity: ValidationSeverity.WARNING,
            code: 'DEPRECATED_COMMAND',
            message: `Deprecated command ${token.value} used`,
            location: token.location,
            suggestion: `Use ${replacements[token.value] || 'a modern alternative'} instead.`,
          });
        }
      }

      // Track math mode for spacing checks
      if (token.type === TokenType.MATH_SHIFT) {
        if (inMath) {
          // Check math spacing
          if (this.options.checkMathSpacing) {
            this._checkMathSpacing(mathContent, mathStartLine);
          }
          inMath = false;
          mathContent = '';
        } else {
          inMath = true;
          mathStartLine = token.location?.line || 0;
          mathContent = '';
        }
      } else if (inMath && token.value) {
        mathContent += token.value;
      }

      // Check for double $$ (should use \[ \])
      if (token.type === TokenType.MATH_SHIFT && token.value === '$$') {
        this.issues.push({
          severity: ValidationSeverity.INFO,
          code: 'DISPLAY_MATH_DOLLAR',
          message: 'Display math using $$...$$',
          location: token.location,
          suggestion: 'Consider using \\[...\\] for display math instead of $$...$$.',
        });
      }
    }
  }

  _checkMathSpacing(content, lineNum) {
    // Check for missing spaces around operators
    if (/\w=\w/.test(content) && !/\w\s*=\s*\w/.test(content)) {
      this.issues.push({
        severity: ValidationSeverity.HINT,
        code: 'MATH_SPACING',
        message: 'Missing spaces around = in math mode',
        location: { line: lineNum },
        suggestion: 'Use spaces around operators: x = y instead of x=y.',
      });
    }

    // Check for \left without matching \right
    const leftCount = (content.match(/\\left/g) || []).length;
    const rightCount = (content.match(/\\right/g) || []).length;
    if (leftCount !== rightCount) {
      this.issues.push({
        severity: ValidationSeverity.WARNING,
        code: 'UNMATCHED_LEFT_RIGHT',
        message: `Mismatched \\left (${leftCount}) and \\right (${rightCount})`,
        location: { line: lineNum },
        suggestion: 'Ensure every \\left has a matching \\right.',
      });
    }
  }

  _checkStructure(source, ast) {
    // Check for \begin{document} without \end{document}
    if (source.includes('\\begin{document}') && !source.includes('\\end{document}')) {
      this.issues.push({
        severity: ValidationSeverity.ERROR,
        code: 'MISSING_END_DOCUMENT',
        message: 'Missing \\end{document}',
        suggestion: 'Add \\end{document} to close the document environment.',
      });
    }

    // Check for \end{document} without \begin{document}
    if (source.includes('\\end{document}') && !source.includes('\\begin{document}')) {
      this.issues.push({
        severity: ValidationSeverity.ERROR,
        code: 'MISSING_BEGIN_DOCUMENT',
        message: 'Missing \\begin{document}',
        suggestion: 'Add \\begin{document} before the document content.',
      });
    }

    // Check for labels without references
    if (this.options.checkUnusedLabels) {
      const labels = [];
      const labelRx = /\\label\s*\{([^}]*)\}/g;
      let match;
      while ((match = labelRx.exec(source)) !== null) {
        labels.push(match[1]);
      }

      const refs = [];
      const refRx = /\\(?:ref|pageref|eqref|autoref|nameref)\s*\{([^}]*)\}/g;
      while ((match = refRx.exec(source)) !== null) {
        refs.push(match[1]);
      }

      for (const label of labels) {
        if (!refs.includes(label)) {
          this.issues.push({
            severity: ValidationSeverity.INFO,
            code: 'UNUSED_LABEL',
            message: `Label "${label}" is defined but never referenced`,
            suggestion: 'Remove unused labels or add a reference.',
          });
        }
      }
    }

    // Check for empty sections
    const sectionRx = /\\(section|subsection|subsubsection)\*?\s*\{([^}]*)\}/g;
    const sections = [];
    let match;
    while ((match = sectionRx.exec(source)) !== null) {
      sections.push({ name: match[1], title: match[2], pos: match.index });
    }

    for (let i = 0; i < sections.length - 1; i++) {
      const current = sections[i];
      const next = sections[i + 1];
      const between = source.slice(current.pos + match[0].length, next.pos).trim();
      if (!between) {
        this.issues.push({
          severity: ValidationSeverity.WARNING,
          code: 'EMPTY_SECTION',
          message: `Section "${current.title}" appears to be empty`,
          suggestion: 'Add content to the section or remove it.',
        });
      }
    }
  }

  _checkStyle(source) {
    // Check for \begin{center} (should use \centering)
    if (/\\begin\s*\{center\}/.test(source)) {
      this.issues.push({
        severity: ValidationSeverity.HINT,
        code: 'CENTER_ENV',
        message: '\\begin{center} adds extra vertical space',
        suggestion: 'Consider using {\\centering ...} instead for tighter spacing.',
      });
    }

    // Check for $$ in math mode (should use \[ \])
    if (/\$\$/.test(source)) {
      this.issues.push({
        severity: ValidationSeverity.INFO,
        code: 'DISPLAY_MATH_STYLE',
        message: 'Using $$ for display math',
        suggestion: 'Use \\[...\\] instead of $$...$$ for display math (LaTeX best practice).',
      });
    }

    // Check for \newline (should use \\)
    if (/\\newline/.test(source)) {
      this.issues.push({
        severity: ValidationSeverity.HINT,
        code: 'NEWLINE_COMMAND',
        message: '\\newline used',
        suggestion: 'Consider using \\\\ for line breaks in most contexts.',
      });
    }

    // Check for multiple consecutive blank lines
    if (/\n{3,}/.test(source)) {
      this.issues.push({
        severity: ValidationSeverity.HINT,
        code: 'MULTIPLE_BLANK_LINES',
        message: 'Multiple consecutive blank lines found',
        suggestion: 'Use at most one blank line between paragraphs.',
      });
    }
  }

  _checkAccessibility(source) {
    // Check for images without alt text
    const imgRx = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
    let match;
    while ((match = imgRx.exec(source)) !== null) {
      const options = match[1] || '';
      if (!options.includes('alt') && !options.includes('description')) {
        this.issues.push({
          severity: ValidationSeverity.WARNING,
          code: 'MISSING_ALT_TEXT',
          message: `Image ${match[2]} may be missing alt text`,
          suggestion: 'Add alt={...} to \\includegraphics options for accessibility.',
        });
      }
    }

    // Check for color-only emphasis
    if (/\\textcolor\s*\{red\}/.test(source) || /\\color\s*\{red\}/.test(source)) {
      this.issues.push({
        severity: ValidationSeverity.INFO,
        code: 'COLOR_ONLY_EMPHASIS',
        message: 'Red color used for emphasis',
        suggestion: 'Combine color with other emphasis methods (bold, italic) for color-blind accessibility.',
      });
    }
  }

  /**
   * Get a summary of validation results.
   */
  getSummary() {
    const summary = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const issue of this.issues) {
      summary[issue.severity] = (summary[issue.severity] || 0) + 1;
    }
    return summary;
  }

  /**
   * Check if the source passes validation (no errors).
   */
  isValid() {
    return this.issues.filter(i => i.severity === ValidationSeverity.ERROR).length === 0;
  }

  /**
   * Get issues filtered by severity.
   */
  getIssuesBySeverity(severity) {
    return this.issues.filter(i => i.severity === severity);
  }

  /**
   * Get issues for a specific line.
   */
  getIssuesForLine(lineNum) {
    return this.issues.filter(i => i.location?.line === lineNum);
  }
}

/**
 * Convenience: validate LaTeX source.
 */
export function validateLatex(source, options = {}) {
  const validator = new LaTeXValidator(options);
  return validator.validate(source);
}
