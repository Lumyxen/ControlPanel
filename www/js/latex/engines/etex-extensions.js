// www/js/latex/engines/etex-extensions.js
// e-TeX extensions: expression evaluators, \protected, \scantokens.

import { TeXCore } from './tex-core.js';

export class ETeXExtensions extends TeXCore {
  constructor() {
    super();
    this._initETexPrimitives();
  }

  _initETexPrimitives() {
    this.macros.set('\\numexpr', '__NUMEXPR__');
    this.macros.set('\\dimexpr', '__DIMEXPR__');
    this.macros.set('\\glueexpr', '__GLUEEXPR__');
    this.macros.set('\\muexpr', '__MUEXPR__');
    this.macros.set('\\unless', '__UNLESS__');
    this.macros.set('\\protected', '__PROTECTED__');
    this.macros.set('\\scantokens', '__SCANTOKENS__');
    this.macros.set('\\showthe', '__SHOWTHE__');
    this.macros.set('\\eTeXversion', '2.7');
    this.macros.set('\\eTeXrevision', '.7');
  }

  evaluateNumExpr(expr) {
    const cleaned = expr.trim().replace(/\s+/g, '');
    const result = this._evalMathExpression(cleaned);
    return Math.trunc(result);
  }

  evaluateDimExpr(expr) {
    const cleaned = expr.trim();
    const match = cleaned.match(/^([+-]?[\d.]+)\s*([a-z]+)?$/);
    if (!match) return '0pt';
    const value = parseFloat(match[1]) || 0;
    const unit = match[2] || 'pt';
    return `${value}${unit}`;
  }

  evaluateGlueExpr(expr) {
    return this.evaluateDimExpr(expr);
  }

  evaluateMuExpr(expr) {
    const cleaned = expr.trim();
    const match = cleaned.match(/^([+-]?[\d.]+)\s*mu$/);
    if (!match) return '0mu';
    const value = parseFloat(match[1]) || 0;
    return `${value}mu`;
  }

  _evalMathExpression(expr) {
    try {
      const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, '');
      if (!sanitized) return 0;
      return Function('"use strict"; return (' + sanitized + ')')();
    } catch {
      return 0;
    }
  }

  processExpression(source) {
    let result = source;

    const numExprRx = /__NUMEXPR__\s*([^\s\\{]+|{[^}]+})/g;
    result = result.replace(numExprRx, (match, expr) => {
      const cleaned = expr.replace(/[{}]/g, '');
      return String(this.evaluateNumExpr(cleaned));
    });

    const dimExprRx = /__DIMEXPR__\s*([^\s\\{]+|{[^}]+})/g;
    result = result.replace(dimExprRx, (match, expr) => {
      const cleaned = expr.replace(/[{}]/g, '');
      return this.evaluateDimExpr(cleaned);
    });

    const glueExprRx = /__GLUEEXPR__\s*([^\s\\{]+|{[^}]+})/g;
    result = result.replace(glueExprRx, (match, expr) => {
      const cleaned = expr.replace(/[{}]/g, '');
      return this.evaluateGlueExpr(cleaned);
    });

    const muExprRx = /__MUEXPR__\s*([^\s\\{]+|{[^}]+})/g;
    result = result.replace(muExprRx, (match, expr) => {
      const cleaned = expr.replace(/[{}]/g, '');
      return this.evaluateMuExpr(cleaned);
    });

    result = result.replace(/__(?:NUMEXPR|DIMEXPR|GLUEEXPR|MUEXPR|UNLESS|PROTECTED|SCANTOKENS|SHOWTHE)__/g, '');
    return result;
  }

  scantokens(tokens) {
    return this.expandMacros(tokens);
  }

  clone() {
    const copy = new ETeXExtensions();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
