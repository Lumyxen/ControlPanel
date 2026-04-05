// www/js/latex/engines/omega-extensions.js
// Omega/Aleph Unicode extensions: 16-bit character codes, RTL support.

import { TeXCore } from './tex-core.js';

export class OmegaExtensions extends TeXCore {
  constructor() {
    super();
    this.otpProcesses = new Map();
    this.direction = 'ltr';
    this._initOmegaMacros();
  }

  _initOmegaMacros() {
    this.macros.set('\\OmegaVersion', '1.15');
    this.macros.set('\\lefttoright', '__OMEGA_LTR__');
    this.macros.set('\\righttoleft', '__OMEGA_RTL__');
    this.macros.set('\\char', '__OMEGA_CHAR__');
    this.macros.set('\\Uchar', '__OMEGA_UCHAR__');
    this.macros.set('\\Umathchar', '__OMEGA_UMATHCHAR__');
    this.macros.set('\\delimiter', '__OMEGA_DELIMITER__');
    this.macros.set('\\radical', '__OMEGA_RADICAL__');
    this.macros.set('\\accent', '__OMEGA_ACCENT__');
    this.macros.set('\\Uaccent', '__OMEGA_UACCENT__');
    this.macros.set('\\OTPreprocess', '__OMEGA_OTP_PREPROCESS__');
    this.macros.set('\\OTPpostprocess', '__OMEGA_OTP_POSTPROCESS__');
    this.macros.set('\\setOTP', '__OMEGA_SET_OTP__');
    this.macros.set('\\addOTP', '__OMEGA_ADD_OTP__');
    this.macros.set('\\removeOTP', '__OMEGA_REMOVE_OTP__');
    this.macros.set('\\showOTP', '__OMEGA_SHOW_OTP__');
    this.macros.set('\\XeTeXcharclass', '__OMEGA_XETEX_CHARCLASS__');
    this.macros.set('\\XeTeXinterchartoks', '__OMEGA_XETEX_INTERCHAR_TOKS__');
    this.macros.set('\\XeTeXinterchartokenstate', '__OMEGA_XETEX_INTERCHAR_STATE__');
  }

  setDirection(dir) {
    if (dir === 'rtl' || dir === 'ltr') {
      this.direction = dir;
    }
  }

  getDirection() {
    return this.direction;
  }

  registerOTP(name, processFn) {
    this.otpProcesses.set(name, processFn);
  }

  processOTP(source) {
    let result = source;
    for (const [name, fn] of this.otpProcesses) {
      try {
        result = fn(result);
      } catch {
        // Silently skip failing OTP processes
      }
    }
    return result;
  }

  processOmegaCommands(source) {
    let result = source;
    result = result.replace(/\\lefttoright/g, '');
    result = result.replace(/\\righttoleft/g, '');
    result = result.replace(/__OMEGA_[A-Z_]+__/g, '');
    return result;
  }

  clone() {
    const copy = new OmegaExtensions();
    copy.macros = new Map(this.macros);
    copy.definedCommands = new Set(this.definedCommands);
    copy.direction = this.direction;
    copy.otpProcesses = new Map(this.otpProcesses);
    for (const type of Object.keys(this.registers)) {
      copy.registers[type] = new Map(this.registers[type]);
    }
    return copy;
  }
}
