// www/js/latex/core/errors.js
// LaTeX error types, diagnostics, and suggestion engine.

export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

export class LatexError {
  constructor({ code, message, location, suggestion, severity = Severity.ERROR, raw }) {
    this.code = code;
    this.message = message;
    this.location = location || null;
    this.suggestion = suggestion || null;
    this.severity = severity;
    this.raw = raw || '';
  }

  toString() {
    const loc = this.location ? ` at line ${this.location.startLine}:${this.location.startColumn}` : '';
    return `[${this.severity.toUpperCase()}] ${this.code}${loc}: ${this.message}` +
      (this.suggestion ? `\n  Suggestion: ${this.suggestion}` : '');
  }
}

const SUGGESTIONS = {
  'UNMATCHED_BRACE': {
    message: 'Unmatched opening brace "{". Did you forget a closing "}"?',
    suggestion: 'Add a closing brace "}" to complete the group.',
  },
  'UNMATCHED_BRACE_CLOSE': {
    message: 'Unexpected closing brace "}" with no matching opening brace.',
    suggestion: 'Remove the extra "}" or check for mismatched braces earlier in the document.',
  },
  'UNDEFINED_COMMAND': {
    message: 'Undefined control sequence.',
    suggestion: 'Check the spelling of the command. You may need to load a package that defines it.',
  },
  'UNDEFINED_ENVIRONMENT': {
    message: 'Undefined environment.',
    suggestion: 'Check the environment name spelling. You may need \\usepackage{} to load it.',
  },
  'MISMATCHED_ENVIRONMENT': {
    message: 'Mismatched \\begin{...} and \\end{...}.',
    suggestion: 'Ensure each \\begin{name} has a matching \\end{name}.',
  },
  'UNMATCHED_DOLLAR': {
    message: 'Unmatched math shift character "$".',
    suggestion: 'Math mode requires a closing "$". Use $$...$$ for display math or $...$ for inline.',
  },
  'UNMATCHED_BRACKET': {
    message: 'Unmatched opening bracket "[".',
    suggestion: 'Add a closing "]" or escape it with "\\[".',
  },
  'UNMATCHED_PAREN': {
    message: 'Unmatched opening parenthesis "(".',
    suggestion: 'Add a closing ")" or escape it with "\\(".',
  },
  'ORPHANED_ALIGNMENT': {
    message: 'Alignment character "&" outside of a tabular or math environment.',
    suggestion: '& is only valid inside environments like tabular, align, or array.',
  },
  'ORPHANED_ROW_END': {
    message: 'Row ending "\\\\" outside of a compatible environment.',
    suggestion: '\\\\ is only valid inside environments like tabular, align, array, or equation.',
  },
  'INVALID_PARAMETER': {
    message: 'Invalid parameter reference.',
    suggestion: 'Parameters (#1, #2, etc.) are only valid in macro definitions.',
  },
  'ORPHANED_SUBSCRIPT': {
    message: 'Subscript "_" without a preceding atom.',
    suggestion: 'Add a base element before the subscript, e.g., "x_{...}" instead of "_{...}".',
  },
  'ORPHANED_SUPERSCRIPT': {
    message: 'Superscript "^" without a preceding atom.',
    suggestion: 'Add a base element before the superscript, e.g., "x^{...}" instead of "^{...}".',
  },
  'UNCLOSED_COMMENT': {
    message: 'Comment extends to end of line (this is normal in LaTeX).',
    suggestion: null,
    severity: Severity.INFO,
  },
  'UNKNOWN_ESCAPE': {
    message: 'Unrecognized escape sequence.',
    suggestion: 'Check the command spelling or verify the required package is loaded.',
  },
};

export function createError(code, location, raw) {
  const template = SUGGESTIONS[code] || {
    message: `LaTeX processing issue: ${code}`,
    suggestion: 'Review the source text around this location.',
  };
  return new LatexError({
    code,
    message: template.message,
    suggestion: template.suggestion,
    severity: template.severity || Severity.ERROR,
    location,
    raw,
  });
}

export function collectErrors(ast) {
  const errors = [];
  function walk(node) {
    if (node.errors) errors.push(...node.errors);
    if (node.children) node.children.forEach(walk);
    if (node.content && typeof node.content === 'object') walk(node.content);
  }
  walk(ast);
  return errors;
}
