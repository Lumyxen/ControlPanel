// www/js/latex/engines/tex-core.js
// Core TeX primitive interpreter - token expansion, macros, conditionals, registers.

import { extractBraceContent, extractBracketContent } from '../utils/delimiter-matcher.js';

export class TeXCore {
  constructor() {
    this.macros = new Map();
    this.registers = {
      count: new Map(),
      dimen: new Map(),
      skip: new Map(),
      muskip: new Map(),
      toks: new Map(),
    };
    this.conditionals = [];
    this.definedCommands = new Set();
    this._initBuiltins();
  }

  _initBuiltins() {
    this.macros.set('\\TeX', 'T\\kern -.1667em\\lower .5ex\\hbox{E}\\kern -.1250emX');
    this.macros.set('\\LaTeX', 'L\\kern -.36em\\raise .3ex\\hbox{\\scriptsize A}\\kern -.15em\\TeX');
    this.macros.set('\\dots', '\\ldots');
    this.macros.set('\\textellipsis', '\\ldots');
    this.macros.set('\\quad', '\\hspace{1em}');
    this.macros.set('\\qquad', '\\hspace{2em}');
    this.macros.set('\\nobreakspace', '~');
    this.macros.set('\\enspace', '\\hspace{.5em}');
    this.macros.set('\\thinspace', '\\hspace{.1667em}');
    this.macros.set('\\negthinspace', '\\hspace{-.1667em}');
    this.macros.set('\\smallskip', '\\vspace{\\smallskipamount}');
    this.macros.set('\\medskip', '\\vspace{\\medskipamount}');
    this.macros.set('\\bigskip', '\\vspace{\\bigskipamount}');
    this.macros.set('\\newline', '\\\\\\@');
    this.macros.set('\\clearpage', '');
    this.macros.set('\\cleardoublepage', '');
    this.macros.set('\\newpage', '');
    this.macros.set('\\pagebreak', '');
    this.macros.set('\\nopagebreak', '');
    this.macros.set('\\hfil', '');
    this.macros.set('\\hfill', '');
    this.macros.set('\\vfil', '');
    this.macros.set('\\vfill', '');
    this.macros.set('\\hrule', '');
    this.macros.set('\\vrule', '');
    this.macros.set('\\smallskipamount', '3pt plus 1pt minus 1pt');
    this.macros.set('\\medskipamount', '6pt plus 2pt minus 2pt');
    this.macros.set('\\bigskipamount', '12pt plus 4pt minus 4pt');
  }

  defineMacro(name, replacement, global = false) {
    this.macros.set(name, replacement);
    this.definedCommands.add(name);
  }

  undefineMacro(name) {
    this.macros.delete(name);
    this.definedCommands.delete(name);
  }

  hasMacro(name) {
    return this.macros.has(name);
  }

  getMacro(name) {
    return this.macros.get(name) || null;
  }

  setRegister(type, index, value) {
    if (!this.registers[type]) return;
    this.registers[type].set(index, value);
  }

  getRegister(type, index) {
    if (!this.registers[type]) return 0;
    return this.registers[type].get(index) || 0;
  }

  newCount(name, initialValue = 0) {
    this.registers.count.set(name, initialValue);
  }

  newDimen(name, initialValue = '0pt') {
    this.registers.dimen.set(name, initialValue);
  }

  newSkip(name, initialValue = '0pt') {
    this.registers.skip.set(name, initialValue);
  }

  processConditionals(source) {
    let result = '';
    let i = 0;
    let depth = 0;
    const skipBranch = () => {
      let d = 0;
      while (i < source.length) {
        if (source.startsWith('\\if', i) || source.startsWith('\\unless', i)) {
          const cmdMatch = source.slice(i).match(/^\\(if[a-zA-Z]*|unless\\if[a-zA-Z]*)/);
          if (cmdMatch) { d++; i += cmdMatch[0].length; continue; }
        }
        if (source.startsWith('\\fi', i)) {
          if (d === 0) { i += 3; return; }
          d--; i += 3; continue;
        }
        if (source.startsWith('\\else', i) && d === 0) { i += 5; return; }
        if (source.startsWith('\\or', i) && d === 0) { i += 3; return; }
        i++;
      }
    };

    while (i < source.length) {
      if (source.startsWith('\\iftrue', i)) {
        i += 7;
        continue;
      }
      if (source.startsWith('\\iffalse', i)) {
        i += 8;
        skipBranch();
        continue;
      }
      if (source.startsWith('\\ifnum', i)) {
        i += 6;
        const cond = this._parseIfNum(source, i);
        if (cond.result) {
          i = cond.endPos;
        } else {
          skipBranch();
        }
        continue;
      }
      if (source.startsWith('\\ifx', i)) {
        i += 4;
        const cond = this._parseIfX(source, i);
        if (cond.result) {
          i = cond.endPos;
        } else {
          skipBranch();
        }
        continue;
      }
      if (source.startsWith('\\ifdim', i)) {
        i += 6;
        const cond = this._parseIfDim(source, i);
        if (cond.result) {
          i = cond.endPos;
        } else {
          skipBranch();
        }
        continue;
      }
      if (source.startsWith('\\ifcase', i)) {
        i += 7;
        const caseResult = this._parseIfCase(source, i);
        result += caseResult.body;
        i = caseResult.endPos;
        continue;
      }
      if (source.startsWith('\\fi', i)) {
        i += 3;
        continue;
      }
      if (source.startsWith('\\else', i)) {
        i += 5;
        continue;
      }
      if (source.startsWith('\\or', i)) {
        i += 3;
        continue;
      }
      result += source[i];
      i++;
    }
    return result;
  }

  _parseIfNum(source, pos) {
    const expr = this._readNumExpression(source, pos);
    return { result: expr.value !== 0, endPos: expr.endPos };
  }

  _parseIfX(source, pos) {
    return { result: false, endPos: pos };
  }

  _parseIfDim(source, pos) {
    const expr = this._readDimExpression(source, pos);
    return { result: true, endPos: expr.endPos };
  }

  _parseIfCase(source, pos) {
    return { body: '', endPos: pos };
  }

  _readNumExpression(source, pos) {
    let numStr = '';
    let i = pos;
    while (i < source.length && /[0-9\s\-+]/.test(source[i])) {
      numStr += source[i];
      if (source[i] === ' ' && numStr.trim().length > 0) break;
      i++;
    }
    return { value: parseInt(numStr.trim(), 10) || 0, endPos: i };
  }

  _readDimExpression(source, pos) {
    let i = pos;
    while (i < source.length && /[0-9\s\-.a-z]/.test(source[i])) {
      if (source[i] === ' ' && i > pos && /[a-z]/.test(source[i-1])) break;
      i++;
    }
    return { value: source.slice(pos, i).trim(), endPos: i };
  }

  expandMacros(source, maxDepth = 50) {
    let result = source;
    for (let depth = 0; depth < maxDepth; depth++) {
      let changed = false;
      for (const [name, replacement] of this.macros) {
        if (result.includes(name)) {
          result = result.split(name).join(replacement);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return result;
  }

  processDef(source) {
    const defRx = /\\(?:x?g?def|edef)\s*(\\[a-zA-Z]+|[^a-zA-Z\s\\])\s*/;
    const match = source.match(defRx);
    if (!match) return { remaining: source, defined: null };

    const cmdName = match[1];
    const afterPos = match.index + match[0].length;
    const rest = source.slice(afterPos);

    const braceContent = extractBraceContent(rest, 0);
    if (!braceContent) return { remaining: source, defined: null };

    this.defineMacro(cmdName, braceContent.content);
    return { remaining: rest.slice(braceContent.end + 1), defined: cmdName };
  }

  processNewCommand(source) {
    const ncRx = /\\(re)?newcommand\s*\*?\s*(\[[0-9]+\])?\s*\[([0-9]+)\](?:\[([^\]]*)\])?\s*/;
    const match = source.match(ncRx);
    if (!match) return { remaining: source, defined: null };

    const isRenew = !!match[1];
    const cmdNameMatch = source.match(/\\(re)?newcommand\s*\*?\s*\{([^}]+)\}/);
    if (!cmdNameMatch) return { remaining: source, defined: null };

    const cmdName = cmdNameMatch[2];
    const numArgs = parseInt(match[3], 10);
    const defaultVal = match[4];

    const afterPos = cmdNameMatch.index + cmdNameMatch[0].length;
    const rest = source.slice(afterPos);
    const braceContent = extractBraceContent(rest, 0);
    if (!braceContent) return { remaining: source, defined: null };

    if (isRenew || !this.hasMacro(cmdName)) {
      this.defineMacro(cmdName, braceContent.content);
    }
    return { remaining: rest.slice(braceContent.end + 1), defined: cmdName };
  }

  processLet(source) {
    const letRx = /\\let\s*(\\[a-zA-Z]+)\s*=\s*(\\[a-zA-Z]+)/;
    const match = source.match(letRx);
    if (!match) {
      const shortRx = /\\let\s*(\\[a-zA-Z]+)\s*(\\[a-zA-Z]+)/;
      const shortMatch = source.match(shortRx);
      if (shortMatch) {
        const target = this.macros.get(shortMatch[2]);
        if (target) this.defineMacro(shortMatch[1], target);
        return { remaining: source.slice(shortMatch.index + shortMatch[0].length), defined: shortMatch[1] };
      }
      return { remaining: source, defined: null };
    }

    const target = this.macros.get(match[2]);
    if (target) this.defineMacro(match[1], target);
    return { remaining: source.slice(match.index + match[0].length), defined: match[1] };
  }

  processPreamble(source) {
    let remaining = source;
    let changed = true;
    while (changed) {
      changed = false;
      const trimmed = remaining.trimStart();

      if (trimmed.startsWith('\\def') || trimmed.startsWith('\\edef') || trimmed.startsWith('\\gdef') || trimmed.startsWith('\\xdef')) {
        const result = this.processDef(trimmed);
        if (result.defined) { remaining = result.remaining; changed = true; }
      } else if (trimmed.startsWith('\\newcommand') || trimmed.startsWith('\\renewcommand')) {
        const result = this.processNewCommand(trimmed);
        if (result.defined) { remaining = result.remaining; changed = true; }
      } else if (trimmed.startsWith('\\let')) {
        const result = this.processLet(trimmed);
        if (result.defined) { remaining = result.remaining; changed = true; }
      }
    }
    return remaining;
  }

  clone() {
    const copy = new TeXCore();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
