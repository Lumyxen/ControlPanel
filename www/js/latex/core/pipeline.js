// www/js/latex/core/pipeline.js
// Full LaTeX processing pipeline: tokenize -> parse -> transform -> render -> math typeset.
// Supports streaming updates and incremental re-rendering.

import { tokenize } from './tokenizer.js';
import { Parser } from './parser.js';
import { collectErrors } from './errors.js';
import { HTMLRenderer } from '../renderers/html-renderer.js';

export class LaTeXPipeline {
  constructor(options = {}) {
    this.options = {
      mathEngine: options.mathEngine || 'katex', // 'katex' | 'mathjax' | 'html'
      mathOptions: options.mathOptions || {},
      enableStreaming: options.enableStreaming !== false,
      debounceMs: options.debounceMs || 150,
      maxErrors: options.maxErrors || 100,
      ...options,
    };
    this._renderer = null;
    this._mathRenderer = null;
    this._streamTimer = null;
    this._lastSource = '';
    this._lastResult = null;
  }

  /**
   * Process a complete LaTeX source string through the full pipeline.
   * Returns { html, mathBlocks, renderedMath, errors, ast, tokens }.
   */
  async process(source) {
    this._lastSource = source;

    // Stage 1: Tokenize
    const { tokens, errors: tokenErrors } = tokenize(source);

    // Stage 2: Parse
    const parser = new Parser(tokens, []);
    const ast = parser.parse();
    const parseErrors = parser.errors;

    // Stage 3: Collect all errors
    const astErrors = collectErrors(ast);
    const errors = [...tokenErrors, ...parseErrors, ...astErrors].slice(0, this.options.maxErrors);

    // Stage 4: HTML render
    const htmlRenderer = new HTMLRenderer();
    const html = htmlRenderer.render(ast);
    const mathBlocks = htmlRenderer.getMathBlocks();

    // Stage 5: Math render
    const renderedMath = [];
    for (const block of mathBlocks) {
      const content = typeof block.content === 'string' ? block.content : '';
      const displayMode = block.type === 'MathDisplay';
      const rendered = await this._renderMath(content, displayMode);
      renderedMath.push(rendered);
    }

    this._lastResult = { html, mathBlocks, renderedMath, errors, ast, tokens };
    return this._lastResult;
  }

  /**
   * Process LaTeX source synchronously (math rendering is deferred).
   * Returns { html, mathBlocks, errors, ast, tokens } - no renderedMath.
   */
  processSync(source) {
    this._lastSource = source;

    const { tokens, errors: tokenErrors } = tokenize(source);
    const parser = new Parser(tokens, []);
    const ast = parser.parse();
    const parseErrors = parser.errors;
    const astErrors = collectErrors(ast);
    const errors = [...tokenErrors, ...parseErrors, ...astErrors].slice(0, this.options.maxErrors);

    const htmlRenderer = new HTMLRenderer();
    const html = htmlRenderer.render(ast);
    const mathBlocks = htmlRenderer.getMathBlocks();

    this._lastResult = { html, mathBlocks, renderedMath: [], errors, ast, tokens };
    return this._lastResult;
  }

  /**
   * Render math blocks from a sync process result.
   */
  async renderMathBlocks(mathBlocks) {
    const renderedMath = [];
    for (const block of mathBlocks) {
      const content = typeof block.content === 'string' ? block.content : '';
      const displayMode = block.type === 'MathDisplay';
      const rendered = await this._renderMath(content, displayMode);
      renderedMath.push(rendered);
    }
    return renderedMath;
  }

  /**
   * Schedule a streaming update (debounced).
   * Calls the provided callback with the result when ready.
   */
  scheduleUpdate(source, callback) {
    if (!this.options.enableStreaming) return;

    if (this._streamTimer) clearTimeout(this._streamTimer);

    this._streamTimer = setTimeout(async () => {
      const result = await this.process(source);
      if (callback) callback(result);
    }, this.options.debounceMs);
  }

  /**
   * Cancel any pending streaming update.
   */
  cancelUpdate() {
    if (this._streamTimer) {
      clearTimeout(this._streamTimer);
      this._streamTimer = null;
    }
  }

  /**
   * Get the last processing result.
   */
  getLastResult() {
    return this._lastResult;
  }

  /**
   * Render math content using the configured engine.
   */
  async _renderMath(content, displayMode) {
    if (!content || !content.trim()) return null;

    switch (this.options.mathEngine) {
      case 'katex':
        return this._renderKatex(content, displayMode);
      case 'mathjax':
        return this._renderMathJax(content, displayMode);
      default:
        return `<span class="latex-math-raw">${this._escapeHtml(content)}</span>`;
    }
  }

  async _renderKatex(content, displayMode) {
    if (typeof katex === 'undefined') {
      return `<span class="latex-katex-unavailable" title="KaTeX not loaded">${this._escapeHtml(content)}</span>`;
    }
    try {
      return katex.renderToString(content, {
        displayMode,
        throwOnError: false,
        output: 'html',
        trust: true,
        strict: 'warn',
        ...this.options.mathOptions,
      });
    } catch (err) {
      return `<span class="latex-katex-error" title="${this._escapeAttr(err.message)}">
        <code class="latex-error-raw">${this._escapeHtml(content)}</code>
      </span>`;
    }
  }

  async _renderMathJax(content, displayMode) {
    if (typeof MathJax === 'undefined' || !MathJax.typesetPromise) {
      return `<span class="latex-mathjax-unavailable" title="MathJax not loaded">${this._escapeHtml(content)}</span>`;
    }
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
      return `<span class="latex-mathjax-error" title="${this._escapeAttr(err.message)}">
        <code class="latex-error-raw">${this._escapeHtml(content)}</code>
      </span>`;
    }
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Set the math rendering engine.
   */
  setMathEngine(engine) {
    if (engine === 'katex' || engine === 'mathjax' || engine === 'html') {
      this.options.mathEngine = engine;
    }
  }

  /**
   * Get pipeline statistics.
   */
  getStats() {
    if (!this._lastResult) return null;
    return {
      tokenCount: this._lastResult.tokens?.length || 0,
      errorCount: this._lastResult.errors?.length || 0,
      mathBlockCount: this._lastResult.mathBlocks?.length || 0,
      hasErrors: (this._lastResult.errors?.length || 0) > 0,
    };
  }
}

/**
 * Convenience: process LaTeX source through the full pipeline.
 */
export async function processLatex(source, options = {}) {
  const pipeline = new LaTeXPipeline(options);
  return pipeline.process(source);
}
