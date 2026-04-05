// www/js/latex/live/stream-processor.js
// Incremental diff + debounce during streaming for live LaTeX processing.

export class StreamProcessor {
  constructor(options = {}) {
    this.debounceMs = options.debounceMs || 200;
    this.tokenThreshold = options.tokenThreshold || 0;
    this.onUpdate = options.onUpdate || (() => {});
    this._timer = null;
    this._tokenCount = 0;
    this._lastProcessedLength = 0;
    this._lastRendered = new Map();
    this._pending = false;
  }

  scheduleUpdate(source, force = false) {
    if (!force && this.tokenThreshold > 0) {
      this._tokenCount++;
      if (this._tokenCount < this.tokenThreshold) return;
      this._tokenCount = 0;
    }

    if (this._timer) clearTimeout(this._timer);

    if (force) {
      this._process(source);
      return;
    }

    this._timer = setTimeout(() => {
      this._process(source);
    }, this.debounceMs);
  }

  _process(source) {
    if (source.length <= this._lastProcessedLength && !this._pending) return;
    this._lastProcessedLength = source.length;

    const changedBlocks = this._findChangedBlocks(source);
    if (changedBlocks.length === 0) return;

    this._lastRendered.clear();
    for (const block of changedBlocks) {
      this._lastRendered.set(block.id, block);
    }

    this.onUpdate(source, changedBlocks);
  }

  _findChangedBlocks(source) {
    const blocks = [];
    // Match all math delimiters: $$...$$, $...$, \[...\], \(...\)
    const mathRx = /\$\$([\s\S]*?)\$\$|\$([^\$\n]+?)\$|\\\[([\s\S]*?)\\\]|\\\(([^)]+?)\\\)/g;
    let match;
    let idx = 0;
    while ((match = mathRx.exec(source)) !== null) {
      const content = match[1] !== undefined ? match[1]
        : match[2] !== undefined ? match[2]
        : match[3] !== undefined ? match[3]
        : match[4] || '';
      const id = `math-${idx++}`;
      // $$ and \[ are display mode; $ and \( are inline
      const displayMode = match[1] !== undefined || match[3] !== undefined;
      const isComplete = this._isMathComplete(content);
      const existing = this._lastRendered.get(id);

      if (!existing || existing.content !== content || existing.complete !== isComplete) {
        blocks.push({ id, content, displayMode, complete: isComplete, raw: match[0] });
      }
    }
    return blocks;
  }

  _isMathComplete(content) {
    let depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\\' && i + 1 < content.length) { i++; continue; }
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
    }
    return depth === 0;
  }

  reset() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._tokenCount = 0;
    this._lastProcessedLength = 0;
    this._lastRendered.clear();
    this._pending = false;
  }

  setTokenThreshold(n) {
    this.tokenThreshold = Math.max(0, n);
  }

  setDebounceMs(ms) {
    this.debounceMs = Math.max(0, ms);
  }
}
