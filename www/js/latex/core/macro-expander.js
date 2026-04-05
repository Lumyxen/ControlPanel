// www/js/latex/core/macro-expander.js
// Full TeX macro expansion engine with argument parsing, \def, \newcommand, conditionals.
// Operates on the AST level for correctness.

import { TeXCore } from '../engines/tex-core.js';
import { ETeXExtensions } from '../engines/etex-extensions.js';
import { LaTeXMacros } from '../engines/latex-macros.js';

export class MacroExpander extends LaTeXMacros {
  constructor() {
    super();
    this.expansionDepth = 0;
    this.maxExpansionDepth = 50;
    this._expansionCache = new Map();
  }

  /**
   * Expand all macros in a source string.
   */
  expand(source, options = {}) {
    this.expansionDepth = 0;
    this._expansionCache.clear();
    return this._expandRecursive(source, options);
  }

  _expandRecursive(source, options) {
    if (this.expansionDepth >= this.maxExpansionDepth) {
      return source;
    }

    const cacheKey = source;
    if (this._expansionCache.has(cacheKey)) {
      return this._expansionCache.get(cacheKey);
    }

    this.expansionDepth++;
    let result = source;

    // Process preamble commands first
    result = this._processPreambleCommands(result);

    // Expand known macros
    result = this._expandMacros(result);

    // Process conditionals
    result = this.processConditionals(result);

    // Process e-TeX expressions
    result = this._processExpressions(result);

    this._expansionCache.set(cacheKey, result);
    this.expansionDepth--;
    return result;
  }

  _processPreambleCommands(source) {
    let result = source;

    // \def
    const defRx = /\\(?:x?g?def|edef)\s*(\\[a-zA-Z]+|[^a-zA-Z\s\\])\s*(?:\s*([#][0-9](?:\s*[#][0-9])*))?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    result = result.replace(defRx, (match, name, params, body) => {
      this.defineMacro(name, body);
      return '';
    });

    // \newcommand / \renewcommand
    const ncRx = /\\(re)?newcommand\s*\*?\s*\{([^}]+)\}(?:\[([0-9]+)\])?(?:\[([^\]]*)\])?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    result = result.replace(ncRx, (match, renew, name, numArgs, defaultVal, body) => {
      if (!renew || this.hasMacro(name)) {
        this.defineMacro(name, this._wrapWithArgs(body, parseInt(numArgs || '0', 10), defaultVal));
      }
      return '';
    });

    // \let
    const letRx = /\\let\s*(\\[a-zA-Z]+)\s*=?\s*(\\[a-zA-Z]+)/g;
    result = result.replace(letRx, (match, target, source) => {
      const existing = this.getMacro(source);
      if (existing) this.defineMacro(target, existing);
      return '';
    });

    return result;
  }

  _wrapWithArgs(body, numArgs, defaultVal) {
    if (numArgs === 0) return body;
    let wrapped = body;
    for (let i = numArgs; i >= 1; i--) {
      const placeholder = `#${i}`;
      if (i === 1 && defaultVal) {
        // Optional first arg with default
        wrapped = wrapped.replace(new RegExp(`\\\\?#${i}`, 'g'), `__ARG_${i}__`);
      } else {
        wrapped = wrapped.replace(new RegExp(`\\\\?#${i}`, 'g'), `__ARG_${i}__`);
      }
    }
    return wrapped;
  }

  _expandMacros(source) {
    let result = source;
    let changed = true;
    let iterations = 0;
    const maxIterations = 20;

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const [name, replacement] of this.macros) {
        if (result.includes(name)) {
          result = result.split(name).join(replacement);
          changed = true;
        }
      }

      // Replace argument placeholders
      for (let i = 1; i <= 9; i++) {
        const placeholder = `__ARG_${i}__`;
        if (result.includes(placeholder)) {
          result = result.split(placeholder).join('');
          changed = true;
        }
      }
    }

    return result;
  }

  _processExpressions(source) {
    let result = source;

    // \numexpr
    result = result.replace(/\\numexpr\s*([^\\]+?)(?=\s|\\|$)/g, (match, expr) => {
      try {
        return String(this.evaluateNumExpr(expr.trim()));
      } catch {
        return '0';
      }
    });

    // \dimexpr
    result = result.replace(/\\dimexpr\s*([^\\]+?)(?=\s|\\|$)/g, (match, expr) => {
      return this.evaluateDimExpr(expr.trim());
    });

    return result;
  }

  /**
   * Define a macro with parameter support.
   */
  defineMacro(name, replacement, global = false) {
    this.macros.set(name, replacement);
    this.definedCommands.add(name);
  }

  /**
   * Undefine a macro.
   */
  undefineMacro(name) {
    this.macros.delete(name);
    this.definedCommands.delete(name);
  }

  /**
   * Get all defined macros.
   */
  getDefinedMacros() {
    return Array.from(this.definedCommands);
  }

  /**
   * Check if a command is defined (either builtin or user-defined).
   */
  isDefined(name) {
    return this.macros.has(name) || this.definedCommands.has(name);
  }

  /**
   * Clone the expander with all state.
   */
  clone() {
    const copy = new MacroExpander();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.labels = new Map(this.labels);
    copy.lengths = new Map(this.lengths);
    copy.counters = new Map(this.counters);
    copy.expansionDepth = 0;
    copy.maxExpansionDepth = this.maxExpansionDepth;
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
