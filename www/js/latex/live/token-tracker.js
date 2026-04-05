// www/js/latex/live/token-tracker.js
// Counts tokens in the streaming response and triggers LaTeX processing every N tokens.

export class TokenTracker {
  constructor(options = {}) {
    this.threshold = options.threshold || 0; // 0 = only on completion
    this.onThreshold = options.onThreshold || (() => {});
    this._count = 0;
    this._totalTokens = 0;
    this._active = false;
  }

  start() {
    this._count = 0;
    this._totalTokens = 0;
    this._active = true;
  }

  addTokens(count) {
    if (!this._active) return;
    this._count += count;
    this._totalTokens += count;

    if (this.threshold > 0 && this._count >= this.threshold) {
      this._count = 0;
      this.onThreshold(this._totalTokens);
    }
  }

  addText(text) {
    if (!this._active || !text) return;
    const tokenCount = this._estimateTokens(text);
    this.addTokens(tokenCount);
  }

  complete() {
    if (!this._active) return;
    this._active = false;
    this.onThreshold(this._totalTokens);
  }

  reset() {
    this._count = 0;
    this._totalTokens = 0;
    this._active = false;
  }

  setThreshold(n) {
    this.threshold = Math.max(0, n);
    if (this.threshold === 0) {
      this._count = 0;
    }
  }

  getTotalTokens() {
    return this._totalTokens;
  }

  isActive() {
    return this._active;
  }

  _estimateTokens(text) {
    if (!text) return 0;
    const words = text.split(/\s+/).filter(Boolean);
    let count = words.length;
    for (const word of words) {
      if (word.length > 6) count += Math.floor(word.length / 6);
    }
    return Math.max(1, count);
  }
}
