// www/js/latex/engines/latex-macros.js
// LaTeX 2e macro layer: document structure, sectioning, cross-referencing, fonts, lengths, lists.

import { TeXCore } from './tex-core.js';

export class LaTeXMacros extends TeXCore {
  constructor() {
    super();
    this.labels = new Map();
    this.references = new Map();
    this.lengths = new Map();
    this.counters = new Map();
    this._initLengths();
    this._initCounters();
    this._initMacros();
  }

  _initLengths() {
    this.lengths.set('\\paperwidth', '8.5in');
    this.lengths.set('\\paperheight', '11in');
    this.lengths.set('\\textwidth', '6.5in');
    this.lengths.set('\\textheight', '8.9in');
    this.lengths.set('\\parindent', '15pt');
    this.lengths.set('\\parskip', '0pt');
    this.lengths.set('\\baselineskip', '12pt');
    this.lengths.set('\\linespread', '1.0');
    this.lengths.set('\\tabcolsep', '6pt');
    this.lengths.set('\\arraycolsep', '5pt');
    this.lengths.set('\\fboxsep', '3pt');
    this.lengths.set('\\fboxrule', '0.4pt');
    this.lengths.set('\\arrayrulewidth', '0.4pt');
    this.lengths.set('\\doublerulesep', '2pt');
    this.lengths.set('\\columnsep', '10pt');
    this.lengths.set('\\columnseprule', '0pt');
    this.lengths.set('\\topmargin', '0in');
    this.lengths.set('\\headheight', '12pt');
    this.lengths.set('\\headsep', '25pt');
    this.lengths.set('\\footskip', '30pt');
    this.lengths.set('\\marginparwidth', '65pt');
    this.lengths.set('\\marginparsep', '11pt');
    this.lengths.set('\\marginparpush', '5pt');
    this.lengths.set('\\oddsidemargin', '0in');
    this.lengths.set('\\evensidemargin', '0in');
  }

  _initCounters() {
    this.counters.set('page', 1);
    this.counters.set('section', 0);
    this.counters.set('subsection', 0);
    this.counters.set('subsubsection', 0);
    this.counters.set('paragraph', 0);
    this.counters.set('subparagraph', 0);
    this.counters.set('equation', 0);
    this.counters.set('figure', 0);
    this.counters.set('table', 0);
    this.counters.set('footnote', 0);
    this.counters.set('mpfootnote', 0);
    this.counters.set('enumi', 0);
    this.counters.set('enumii', 0);
    this.counters.set('enumiii', 0);
    this.counters.set('enumiv', 0);
    this.counters.set('part', 0);
    this.counters.set('chapter', 0);
  }

  _initMacros() {
    this.macros.set('\\today', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    this.macros.set('\\contentsname', 'Contents');
    this.macros.set('\\listfigurename', 'List of Figures');
    this.macros.set('\\listtablename', 'List of Tables');
    this.macros.set('\\partname', 'Part');
    this.macros.set('\\chaptername', 'Chapter');
    this.macros.set('\\appendixname', 'Appendix');
    this.macros.set('\\abstractname', 'Abstract');
    this.macros.set('\\bibname', 'Bibliography');
    this.macros.set('\\refname', 'References');
    this.macros.set('\\indexname', 'Index');
    this.macros.set('\\figurename', 'Figure');
    this.macros.set('\\tablename', 'Table');
    this.macros.set('\\pagename', 'Page');
    this.macros.set('\\headtoname', 'To');
    this.macros.set('\\ccname', 'cc');
    this.macros.set('\\enclname', 'Encl');
    this.macros.set('\\proofname', 'Proof');
    this.macros.set('\\see', 'see');
    this.macros.set('\\alsoname', 'see also');

    this.macros.set('\\author', '__CMD_AUTHOR__');
    this.macros.set('\\title', '__CMD_TITLE__');
    this.macros.set('\\date', '__CMD_DATE__');
    this.macros.set('\\maketitle', '__CMD_MAKETITLE__');
    this.macros.set('\\tableofcontents', '__CMD_TOC__');
    this.macros.set('\\listoffigures', '__CMD_LOF__');
    this.macros.set('\\listoftables', '__CMD_LOT__');
    this.macros.set('\\pagenumbering', '__CMD_PAGENUM__');
    this.macros.set('\\pagestyle', '__CMD_PAGESTYLE__');
    this.macros.set('\\thispagestyle', '__CMD_THISPAGESTYLE__');

    this.macros.set('\\label', '__CMD_LABEL__');
    this.macros.set('\\ref', '__CMD_REF__');
    this.macros.set('\\pageref', '__CMD_PAGEREF__');
    this.macros.set('\\eqref', '__CMD_EQREF__');

    this.macros.set('\\setlength', '__CMD_SETLENGTH__');
    this.macros.set('\\addtolength', '__CMD_ADDTOLENGTH__');
    this.macros.set('\\setcounter', '__CMD_SETCOUNTER__');
    this.macros.set('\\addtocounter', '__CMD_ADDTOCOUNTER__');
    this.macros.set('\\stepcounter', '__CMD_STEPCOUNTER__');
    this.macros.set('\\refstepcounter', '__CMD_REFSTEPCOUNTER__');
    this.macros.set('\\newcounter', '__CMD_NEWCOUNTER__');
    this.macros.set('\\value', '__CMD_VALUE__');
    this.macros.set('\\arabic', '__CMD_ARABIC__');
    this.macros.set('\\roman', '__CMD_ROMAN__');
    this.macros.set('\\Roman', '__CMD_ROMAN_UPPER__');
    this.macros.set('\\alph', '__CMD_ALPH__');
    this.macros.set('\\Alph', '__CMD_ALPH_UPPER__');
    this.macros.set('\\fnsymbol', '__CMD_FNSYMBOL__');

    this.macros.set('\\hspace', '__CMD_HSPACE__');
    this.macros.set('\\vspace', '__CMD_VSPACE__');
    this.macros.set('\\hspace*', '__CMD_HSPACE_STAR__');
    this.macros.set('\\vspace*', '__CMD_VSPACE_STAR__');
    this.macros.set('\\hfill', '__CMD_HFILL__');
    this.macros.set('\\vfill', '__CMD_VFILL__');
    this.macros.set('\\hrulefill', '__CMD_HRULEFILL__');
    this.macros.set('\\dotfill', '__CMD_DOTFILL__');

    this.macros.set('\\textbf', '__CMD_TEXTBF__');
    this.macros.set('\\textit', '__CMD_TEXTIT__');
    this.macros.set('\\texttt', '__CMD_TEXTTT__');
    this.macros.set('\\textrm', '__CMD_TEXTRM__');
    this.macros.set('\\textsf', '__CMD_TEXTSF__');
    this.macros.set('\\textsl', '__CMD_TEXTSL__');
    this.macros.set('\\textsc', '__CMD_TEXTSC__');
    this.macros.set('\\textmd', '__CMD_TEXTMD__');
    this.macros.set('\\textup', '__CMD_TEXTUP__');
    this.macros.set('\\textnormal', '__CMD_TEXTNORMAL__');
    this.macros.set('\\emph', '__CMD_EMPH__');
    this.macros.set('\\underline', '__CMD_UNDERLINE__');
    this.macros.set('\\overline', '__CMD_OVERLINE__');
    this.macros.set('\\sout', '__CMD_SOUT__');
    this.macros.set('\\uwave', '__CMD_UWAVE__');
    this.macros.set('\\xout', '__CMD_XOUT__');
    this.macros.set('\\dashuline', '__CMD_DASHULINE__');
    this.macros.set('\\dotuline', '__CMD_DOTULINE__');

    this.macros.set('\\bfseries', '__CMD_BFSERIES__');
    this.macros.set('\\itshape', '__CMD_ITSHAPE__');
    this.macros.set('\\ttfamily', '__CMD_TTFAMILY__');
    this.macros.set('\\rmfamily', '__CMD_RMFAMILY__');
    this.macros.set('\\sffamily', '__CMD_SFFAMILY__');
    this.macros.set('\\slshape', '__CMD_SLSHAPE__');
    this.macros.set('\\scshape', '__CMD_SCSHAPE__');
    this.macros.set('\\mdseries', '__CMD_MDSERIES__');
    this.macros.set('\\upshape', '__CMD_UPSHAPE__');
    this.macros.set('\\normalfont', '__CMD_NORMALFONT__');
    this.macros.set('\\em', '__CMD_EM__');

    this.macros.set('\\tiny', '__CMD_TINY__');
    this.macros.set('\\scriptsize', '__CMD_SCRIPTSIZE__');
    this.macros.set('\\footnotesize', '__CMD_FOOTNOTESIZE__');
    this.macros.set('\\small', '__CMD_SMALL__');
    this.macros.set('\\normalsize', '__CMD_NORMALSIZE__');
    this.macros.set('\\large', '__CMD_LARGE__');
    this.macros.set('\\Large', '__CMD_Large__');
    this.macros.set('\\LARGE', '__CMD_LARGE_UPPER__');
    this.macros.set('\\huge', '__CMD_HUGE__');
    this.macros.set('\\Huge', '__CMD_Huge__');

    this.macros.set('\\centering', '__CMD_CENTERING__');
    this.macros.set('\\raggedright', '__CMD_RAGGEDRIGHT__');
    this.macros.set('\\raggedleft', '__CMD_RAGGEDLEFT__');
    this.macros.set('\\flushleft', '__CMD_FLUSHLEFT__');
    this.macros.set('\\flushright', '__CMD_FLUSHRIGHT__');

    this.macros.set('\\item', '__CMD_ITEM__');
    this.macros.set('\\paragraph', '__CMD_PARAGRAPH__');
    this.macros.set('\\subparagraph', '__CMD_SUBPARAGRAPH__');

    this.macros.set('\\caption', '__CMD_CAPTION__');
    this.macros.set('\\shortstack', '__CMD_SHORTSTACK__');
    this.macros.set('\\rule', '__CMD_RULE__');
    this.macros.set('\\raisebox', '__CMD_RAISEBOX__');
    this.macros.set('\\makebox', '__CMD_MAKEBOX__');
    this.macros.set('\\framebox', '__CMD_FRAMEBOX__');
    this.macros.set('\\fbox', '__CMD_FBOX__');
    this.macros.set('\\parbox', '__CMD_PARBOX__');
    this.macros.set('\\minipage', '__CMD_MINIPAGE__');
    this.macros.set('\\marginpar', '__CMD_MARGINPAR__');
    this.macros.set('\\footnote', '__CMD_FOOTNOTE__');
    this.macros.set('\\footnotetext', '__CMD_FOOTNOTETEXT__');
    this.macros.set('\\footnotemark', '__CMD_FOOTNOTEMARK__');
    this.macros.set('\\thanks', '__CMD_THANKS__');
    this.macros.set('\\cite', '__CMD_CITE__');
    this.macros.set('\\nocite', '__CMD_NOCITE__');
    this.macros.set('\\bibliography', '__CMD_BIBLIOGRAPHY__');
    this.macros.set('\\bibliographystyle', '__CMD_BIBLIOGRAPHYSTYLE__');
    this.macros.set('\\include', '__CMD_INCLUDE__');
    this.macros.set('\\input', '__CMD_INPUT__');
    this.macros.set('\\verb', '__CMD_VERB__');
    this.macros.set('\\url', '__CMD_URL__');
    this.macros.set('\\href', '__CMD_HREF__');
    this.macros.set('\\nolinkurl', '__CMD_NOLINKURL__');
  }

  setLength(name, value) {
    this.lengths.set(name, value);
  }

  getLength(name) {
    return this.lengths.get(name) || '0pt';
  }

  setCounter(name, value) {
    this.counters.set(name, value);
  }

  getCounter(name) {
    return this.counters.get(name) || 0;
  }

  stepCounter(name) {
    const current = this.getCounter(name);
    this.setCounter(name, current + 1);
    return current + 1;
  }

  addLabel(name, target) {
    this.labels.set(name, target);
  }

  getLabel(name) {
    return this.labels.get(name) || null;
  }

  formatCounter(name, format = 'arabic') {
    const value = this.getCounter(name);
    switch (format) {
      case 'arabic': return String(value);
      case 'roman': return toRoman(value).toLowerCase();
      case 'Roman': return toRoman(value);
      case 'alph': return String.fromCharCode(96 + Math.min(value, 26));
      case 'Alph': return String.fromCharCode(64 + Math.min(value, 26));
      default: return String(value);
    }
  }

  processCommand(source) {
    let result = source;
    result = this._processSetLength(result);
    result = this._processSetCounter(result);
    result = this._processLabel(result);
    return result;
  }

  _processSetLength(source) {
    return source.replace(/\\setlength\s*\{([^}]+)\}\s*\{([^}]+)\}/g, (_, name, value) => {
      this.setLength(name, value);
      return '';
    });
  }

  _processSetCounter(source) {
    return source.replace(/\\setcounter\s*\{([^}]+)\}\s*\{([^}]+)\}/g, (_, name, value) => {
      this.setCounter(name, parseInt(value, 10) || 0);
      return '';
    });
  }

  _processLabel(source) {
    return source.replace(/\\label\s*\{([^}]+)\}/g, (_, name) => {
      this.addLabel(name, { page: this.getCounter('page'), section: this.getCounter('section'), equation: this.getCounter('equation') });
      return '';
    });
  }

  clone() {
    const copy = new LaTeXMacros();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.labels = new Map(this.labels);
    copy.lengths = new Map(this.lengths);
    copy.counters = new Map(this.counters);
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}

function toRoman(num) {
  if (num <= 0 || num > 3999) return String(num);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
  }
  return result;
}
