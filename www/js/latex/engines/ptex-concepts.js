// www/js/latex/engines/ptex-concepts.js
// pTeX/upTeX Japanese typesetting: character categories, kinsoku rules, ruby support.

import { TeXCore } from './tex-core.js';

export class PTexConcepts extends TeXCore {
  constructor() {
    super();
    this.kansujiMode = false;
    this.kinsokuRules = {
      noStart: new Set(['。','、','）','〕','］','｝','』','】','」','』','>', '>', ']', ')', '}', '!', '?', ',', '.', ':', ';']),
      noEnd: new Set(['（','〔','［','｛','『','【','「','『','<', '<', '[', '(', '{', '$', '\u00a3', '\u00a5']),
      noBreakBefore: new Set(['。','、','）','〕','］','｝','』','】','」','』','！','？','…','‥']),
      noBreakAfter: new Set(['（','〔','［','｛','『','【','「','『','『']),
    };
    this._initPTexMacros();
  }

  _initPTexMacros() {
    this.macros.set('\\ruby', '__PRUBY__');
    this.macros.set('\\RenewCommandCopy\\ruby\\pxrubymacro', '');
    this.macros.set('\\kenten', '__PKENTEN__');
    this.macros.set('\\warichu', '__PWARICHU__');
    this.macros.set('\\rensuji', '__PRENSUJI__');
    this.macros.set('\\kanjiskip', '__PKANJISKIP__');
    this.macros.set('\\xkanjiskip', '__PXKANJISKIP__');
    this.macros.set('\\prebreakpenalty', '__PPREBREAK__');
    this.macros.set('\\postbreakpenalty', '__PPOSTBREAK__');
    this.macros.set('\\inhibitglue', '__PINHIBITGLUE__');
    this.macros.set('\\inhibitxspcode', '__PINHIBITXSP__');
    this.macros.set('\\kansujichar', '__PKANSUJICHAR__');
    this.macros.set('\\kansuji', '__PKANSUJI__');
    this.macros.set('\\kchardef', '__PKCHARDEF__');
    this.macros.set('\\kcatcode', '__PKCATCODE__');
    this.macros.set('\\ptexversion', '3.141592653');
    this.macros.set('\\upTeXversion', '1.0');
  }

  isJapaneseChar(ch) {
    const code = ch.charCodeAt(0);
    return (code >= 0x3040 && code <= 0x30FF) ||
           (code >= 0x4E00 && code <= 0x9FFF) ||
           (code >= 0x3400 && code <= 0x4DBF) ||
           (code >= 0xF900 && code <= 0xFAFF) ||
           (code >= 0x3000 && code <= 0x303F);
  }

  applyKinsoku(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (i > 0 && this.kinsokuRules.noBreakBefore.has(ch)) {
        result += '\u2060';
      }
      if (i < text.length - 1 && this.kinsokuRules.noBreakAfter.has(ch)) {
        result += '\u2060';
      }
      result += ch;
    }
    return result;
  }

  renderRuby(base, ruby) {
    return `<ruby>${base}<rt>${ruby}</rt></ruby>`;
  }

  processPTexCommands(source) {
    let result = source;
    result = result.replace(/\\ruby\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, base, ruby) => {
      return this.renderRuby(base, ruby);
    });
    result = result.replace(/__(?:PRUBY|PKENTEN|PWARICHU|PRENSUJI|PKANJISKIP|PXKANJISKIP|PPREBREAK|PPOSTBREAK|PINHIBITGLUE|PINHIBITXSP|PKANSUJICHAR|PKANSUJI|PKCHARDEF|PKCATCODE)__/g, '');
    return result;
  }

  clone() {
    const copy = new PTexConcepts();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.kansujiMode = this.kansujiMode;
    copy.kinsokuRules = {
      noStart: new Set(this.kinsokuRules.noStart),
      noEnd: new Set(this.kinsokuRules.noEnd),
      noBreakBefore: new Set(this.kinsokuRules.noBreakBefore),
      noBreakAfter: new Set(this.kinsokuRules.noBreakAfter),
    };
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
