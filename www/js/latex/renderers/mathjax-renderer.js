// www/js/latex/renderers/mathjax-renderer.js
// MathJax 3 integration with SVG output and incremental typesetting.

export class MathJaxRenderer {
  constructor(options = {}) {
    this.options = {
      tex: {
        packages: ['base', 'ams', 'noerrors', 'noundefined', 'color', 'boldsymbol', 'braket', 'cancel', 'cases', 'mathtools'],
        inlineMath: [['$', '$'], ['\\(', '\\)']],
        displayMath: [['$$', '$$'], ['\\[', '\\]']],
        processEscapes: true,
        processEnvironments: true,
        macros: {},
      },
      svg: { fontCache: 'global', scale: 1 },
      options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'], enableMenu: false },
      ...options,
    };
    this.available = typeof MathJax !== 'undefined' && MathJax.typesetPromise;
    this._pending = new Set();
  }

  async render(mathContent, displayMode = true) {
    if (!this.available) return null;

    const content = typeof mathContent === 'string' ? mathContent : this._extractContent(mathContent);
    if (!content || !content.trim()) return null;

    try {
      const wrapper = document.createElement('div');
      wrapper.style.display = displayMode ? 'block' : 'inline';
      wrapper.textContent = displayMode ? `$$${content}$$` : `$${content}$`;
      document.body.appendChild(wrapper);

      await MathJax.typesetPromise([wrapper]);
      const html = wrapper.innerHTML;
      document.body.removeChild(wrapper);
      return html;
    } catch (err) {
      return this._renderError(content, err);
    }
  }

  renderSync(mathContent, displayMode = true) {
    if (!this.available) return null;

    const content = typeof mathContent === 'string' ? mathContent : this._extractContent(mathContent);
    if (!content || !content.trim()) return null;

    try {
      const wrapper = document.createElement('div');
      wrapper.style.display = displayMode ? 'block' : 'inline';
      wrapper.textContent = displayMode ? `$$${content}$$` : `$${content}$`;
      document.body.appendChild(wrapper);

      MathJax.typesetClear([wrapper]);
      MathJax.typeset([wrapper]);
      const html = wrapper.innerHTML;
      document.body.removeChild(wrapper);
      return html;
    } catch (err) {
      return this._renderError(content, err);
    }
  }

  async typesetElements(elements) {
    if (!this.available || !elements || elements.length === 0) return;
    try {
      await MathJax.typesetPromise(elements);
    } catch (err) {
      console.warn('[MathJax] Typeset error:', err);
    }
  }

  _extractContent(mathContent) {
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
    return `<span class="latex-mathjax-error" title="${this._escapeAttr(err.message || 'MathJax error')}">
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
    this.options.tex.macros[name] = expansion;
  }

  isAvailable() {
    return this.available;
  }
}

export function renderMathJax(mathContent, displayMode = true, options = {}) {
  const renderer = new MathJaxRenderer(options);
  return renderer.renderSync(mathContent, displayMode);
}
