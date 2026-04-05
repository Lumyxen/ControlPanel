// www/js/latex/engines/context-macros.js
// ConTeXt macro concepts: setup commands, module loading, XML-like syntax mapping.

import { TeXCore } from './tex-core.js';

export class ConTeXtMacros extends TeXCore {
  constructor() {
    super();
    this.setup = {
      bodyfont: '10pt',
      papersize: 'letter',
      orientation: 'portrait',
      layout: 'default',
      colors: 'default',
      language: 'en',
    };
    this.modules = new Set();
    this._initContextMacros();
  }

  _initContextMacros() {
    this.macros.set('\\setupbodyfont', '__CTX_SETUP_BODYFONT__');
    this.macros.set('\\setupcolors', '__CTX_SETUP_COLORS__');
    this.macros.set('\\setuplayout', '__CTX_SETUP_LAYOUT__');
    this.macros.set('\\setuppapersize', '__CTX_SETUP_PAPERSIZE__');
    this.macros.set('\\setupinteraction', '__CTX_SETUP_INTERACTION__');
    this.macros.set('\\setuphead', '__CTX_SETUP_HEAD__');
    this.macros.set('\\setupheadertexts', '__CTX_SETUP_HEADERTEXTS__');
    this.macros.set('\\setupfootertexts', '__CTX_SETUP_FOOTERTEXTS__');
    this.macros.set('\\setupmarginblocks', '__CTX_SETUP_MARGINBLOCKS__');
    this.macros.set('\\setupnotation', '__CTX_SETUP_NOTATION__');
    this.macros.set('\\setuplist', '__CTX_SETUP_LIST__');
    this.macros.set('\\setupcombinedlist', '__CTX_SETUP_COMBINEDLIST__');
    this.macros.set('\\setuplabeltext', '__CTX_SETUP_LABELTEXT__');
    this.macros.set('\\setupcaptions', '__CTX_SETUP_CAPTIONS__');
    this.macros.set('\\setupfloats', '__CTX_SETUP_FLOATS__');
    this.macros.set('\\setupTABLE', '__CTX_SETUP_TABLE__');
    this.macros.set('\\setupTABLErow', '__CTX_SETUP_TABLEROW__');
    this.macros.set('\\setupTABLEcolumn', '__CTX_SETUP_TABLECOLUMN__');
    this.macros.set('\\setupTABLEcell', '__CTX_SETUP_TABLECELL__');
    this.macros.set('\\starttext', '__CTX_STARTTEXT__');
    this.macros.set('\\stoptext', '__CTX_STOPTEXT__');
    this.macros.set('\\starttitle', '__CTX_STARTTITLE__');
    this.macros.set('\\stoptitle', '__CTX_STOPTITLE__');
    this.macros.set('\\startchapter', '__CTX_STARTCHAPTER__');
    this.macros.set('\\stopchapter', '__CTX_STOPCHAPTER__');
    this.macros.set('\\startsection', '__CTX_STARTSECTION__');
    this.macros.set('\\stopsection', '__CTX_STOPSECTION__');
    this.macros.set('\\startsubsection', '__CTX_STARTSUBSECTION__');
    this.macros.set('\\stopsubsection', '__CTX_STOPSUBSECTION__');
    this.macros.set('\\startitemize', '__CTX_STARTITEMIZE__');
    this.macros.set('\\stopitemize', '__CTX_STOPITEMIZE__');
    this.macros.set('\\startitem', '__CTX_STARTITEM__');
    this.macros.set('\\stopitem', '__CTX_STOPITEM__');
    this.macros.set('\\startformula', '__CTX_STARTFORMULA__');
    this.macros.set('\\stopformula', '__CTX_STOPFORMULA__');
    this.macros.set('\\startalignment', '__CTX_STARTALIGNMENT__');
    this.macros.set('\\stopalignment', '__CTX_STOPALIGNMENT__');
    this.macros.set('\\startnarrower', '__CTX_STARTNARROWER__');
    this.macros.set('\\stopnarrower', '__CTX_STOPNARROWER__');
    this.macros.set('\\startframedtext', '__CTX_STARTFRAMEDTEXT__');
    this.macros.set('\\stopframedtext', '__CTX_STOPFRAMEDTEXT__');
    this.macros.set('\\startbackground', '__CTX_STARTBACKGROUND__');
    this.macros.set('\\stopbackground', '__CTX_STOPBACKGROUND__');
    this.macros.set('\\startcolumns', '__CTX_STARTCOLUMNS__');
    this.macros.set('\\stopcolumns', '__CTX_STOPCOLUMNS__');
    this.macros.set('\\starttabulate', '__CTX_STARTTABULATE__');
    this.macros.set('\\stoptabulate', '__CTX_STOPTABULATE__');
    this.macros.set('\\starttable', '__CTX_STARTTABLE__');
    this.macros.set('\\stoptable', '__CTX_STOPTABLE__');
    this.macros.set('\\startfigure', '__CTX_STARTFIGURE__');
    this.macros.set('\\stopfigure', '__CTX_STOPFIGURE__');
    this.macros.set('\\usemodule', '__CTX_USEMODULE__');
    this.macros.set('\\loadmodule', '__CTX_LOADMODULE__');
    this.macros.set('\\enableregime', '__CTX_ENABLEREGIME__');
    this.macros.set('\\mainlanguage', '__CTX_MAINLANGUAGE__');
    this.macros.set('\\language', '__CTX_LANGUAGE__');
    this.macros.set('\\definefont', '__CTX_DEFINEFONT__');
    this.macros.set('\\definecolor', '__CTX_DEFINECOLOR__');
    this.macros.set('\\setupinterlinespace', '__CTX_SETUP_INTERLINESPACE__');
  }

  loadModule(name) {
    this.modules.add(name);
  }

  hasModule(name) {
    return this.modules.has(name);
  }

  getSetup() {
    return { ...this.setup };
  }

  processContextCommands(source) {
    let result = source;
    result = result.replace(/\\setupbodyfont\s*\[?([^\]\s]+)\]?/g, (_, size) => {
      this.setup.bodyfont = size;
      return '';
    });
    result = result.replace(/\\setupcolors\s*\[([^\]]*)\]/g, (_, state) => {
      this.setup.colors = state || 'default';
      return '';
    });
    result = result.replace(/\\setuppapersize\s*\[([^\]]*)\]/g, (_, size) => {
      this.setup.papersize = size;
      return '';
    });
    result = result.replace(/\\usemodule\s*\[([^\]]*)\]/g, (_, mods) => {
      mods.split(',').forEach(m => this.loadModule(m.trim()));
      return '';
    });
    result = result.replace(/\\mainlanguage\s*\[([^\]]*)\]/g, (_, lang) => {
      this.setup.language = lang;
      return '';
    });
    result = result.replace(/__CTX_[A-Z_]+__/g, '');
    return result;
  }

  clone() {
    const copy = new ConTeXtMacros();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.setup = { ...this.setup };
    copy.modules = new Set(this.modules);
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
