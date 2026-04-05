// www/js/latex/engines/pdftex-extensions.js
// pdfTeX primitives mapped to web equivalents.

import { TeXCore } from './tex-core.js';

export class PdfTeXExtensions extends TeXCore {
  constructor() {
    super();
    this.pdfConfig = {
      output: 0,
      pageWidth: '597.50793pt',
      pageHeight: '845.04694pt',
      hSize: '469.75502pt',
      vSize: '643.84216pt',
      minorVersion: 5,
    };
    this._initPdfTeXMacros();
  }

  _initPdfTeXMacros() {
    this.macros.set('\\pdfoutput', String(this.pdfConfig.output));
    this.macros.set('\\pdfpagewidth', this.pdfConfig.pageWidth);
    this.macros.set('\\pdfpageheight', this.pdfConfig.pageHeight);
    this.macros.set('\\pdfhorigin', '1in');
    this.macros.set('\\pdfvorigin', '1in');
    this.macros.set('\\pdfximage', '__PDFXIMAGE__');
    this.macros.set('\\pdfrefximage', '__PDFREFXIMAGE__');
    this.macros.set('\\pdfobj', '__PDFOBJ__');
    this.macros.set('\\pdfannot', '__PDFANNOT__');
    this.macros.set('\\pdfdest', '__PDFDEST__');
    this.macros.set('\\pdfoutline', '__PDFOUTLINE__');
    this.macros.set('\\pdfinfo', '__PDFINFO__');
    this.macros.set('\\pdfcatalog', '__PDFCATALOG__');
    this.macros.set('\\pdfcompresslevel', '9');
    this.macros.set('\\pdfdecimaldigits', '3');
    this.macros.set('\\pdfimageresolution', '72');
    this.macros.set('\\pdfpkresolution', '600');
    this.macros.set('\\pdfpageattr', '__PDFPAGEATTR__');
    this.macros.set('\\pdfpagesattr', '__PDFPAGESATTR__');
    this.macros.set('\\pdfpageresources', '__PDFPAGERESOURCES__');
    this.macros.set('\\pdftrailerid', '__PDFTRAILERID__');
    this.macros.set('\\pdfgentounicode', '1');
    this.macros.set('\\pdfmapfile', '__PDFMAPFILE__');
    this.macros.set('\\pdffontattr', '__PDFFONTATTR__');
    this.macros.set('\\pdfsavepos', '__PDFSAVEPOS__');
    this.macros.set('\\pdfxform', '__PDFXFORM__');
    this.macros.set('\\pdfrefxform', '__PDFREFXFORM__');
  }

  setPdfConfig(key, value) {
    if (key in this.pdfConfig) {
      this.pdfConfig[key] = value;
    }
  }

  getPdfConfig() {
    return { ...this.pdfConfig };
  }

  getPageDimensions() {
    return {
      width: this.pdfConfig.pageWidth,
      height: this.pdfConfig.pageHeight,
    };
  }

  processPdfCommands(source) {
    let result = source;
    result = result.replace(/\\pdfoutput\s*=?\s*([0-9]+)/g, (_, val) => {
      this.pdfConfig.output = parseInt(val, 10);
      return '';
    });
    result = result.replace(/\\pdfpagewidth\s*=?\s*([^\s\\]+)/g, (_, val) => {
      this.pdfConfig.pageWidth = val;
      return '';
    });
    result = result.replace(/\\pdfpageheight\s*=?\s*([^\s\\]+)/g, (_, val) => {
      this.pdfConfig.pageHeight = val;
      return '';
    });
    result = result.replace(/__PDF(?:XIMAGE|REFXIMAGE|OBJ|ANNOT|DEST|OUTLINE|INFO|CATALOG|PAGEATTR|PAGESATTR|PAGERESOURCES|TRAILERID|MAPFILE|FONTATTR|SAVEPOS|XFORM|REFXFORM)__/g, '');
    return result;
  }

  clone() {
    const copy = new PdfTeXExtensions();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.pdfConfig = { ...this.pdfConfig };
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
