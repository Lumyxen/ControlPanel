// www/js/latex/renderers/katex-renderer.js
// Enhanced KaTeX rendering with live update support and error boundaries.

import { isMathEnvironment, getMathEnvConfig } from '../environments/math-envs.js';

export class KaTeXRenderer {
  constructor(options = {}) {
    this.options = {
      displayMode: true,
      throwOnError: false,
      errorColor: 'var(--latex-error-color, #cc0000)',
      trust: true,
      strict: 'warn',
      output: 'html',
      macros: {},
      ...options,
    };
    this.available = typeof katex !== 'undefined';
  }

  async render(mathContent, displayMode = true) {
    if (!this.available) return null;

    const content = typeof mathContent === 'string' ? mathContent : this._extractMathContent(mathContent);
    if (!content || !content.trim()) return null;

    try {
      const html = katex.renderToString(content, {
        ...this.options,
        displayMode,
        macros: this.options.macros,
      });
      return html;
    } catch (err) {
      return this._renderError(content, err);
    }
  }

  renderSync(mathContent, displayMode = true) {
    if (!this.available) return null;

    const content = typeof mathContent === 'string' ? mathContent : this._extractMathContent(mathContent);
    if (!content || !content.trim()) return null;

    try {
      return katex.renderToString(content, {
        ...this.options,
        displayMode,
        macros: this.options.macros,
      });
    } catch (err) {
      return this._renderError(content, err);
    }
  }

  _extractMathContent(mathContent) {
    if (Array.isArray(mathContent)) {
      return mathContent.map(n => {
        if (typeof n === 'string') return n;
        if (n && n.value) return n.value;
        if (n && n.raw) return n.raw;
        return '';
      }).join('');
    }
    if (typeof mathContent === 'string') return mathContent;
    return '';
  }

  _renderError(content, err) {
    return `<span class="latex-katex-error" title="${this._escapeAttr(err.message || 'KaTeX error')}">
      <span class="latex-error-icon">&#9888;</span>
      <code class="latex-error-raw">${this._escapeHtml(content)}</code>
    </span>`;
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  registerMacro(name, expansion) {
    this.options.macros[name] = expansion;
  }

  registerMacros(macros) {
    Object.assign(this.options.macros, macros);
  }

  clearMacros() {
    this.options.macros = {};
  }

  isAvailable() {
    return this.available;
  }
}

export function renderKatex(mathContent, displayMode = true, options = {}) {
  const renderer = new KaTeXRenderer(options);
  return renderer.renderSync(mathContent, displayMode);
}
