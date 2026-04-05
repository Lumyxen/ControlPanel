// www/js/latex/live/pending-manager.js
// Manages pending/incomplete math blocks during streaming.

export class PendingManager {
  constructor() {
    this._pending = new Map();
    this._resolved = new Set();
  }

  registerPending(id, content, element) {
    this._pending.set(id, {
      content,
      element,
      timestamp: Date.now(),
      retries: 0,
      maxRetries: 10,
    });
  }

  resolvePending(id) {
    this._resolved.add(id);
    this._pending.delete(id);
  }

  getPending() {
    return Array.from(this._pending.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));
  }

  retryPending(id, renderFn) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    if (entry.retries >= entry.maxRetries) {
      this._markFailed(id);
      return false;
    }

    entry.retries++;
    try {
      const result = renderFn(entry.content);
      if (result) {
        this.resolvePending(id);
        return true;
      }
    } catch {
      // Will retry on next cycle
    }
    return false;
  }

  retryAll(renderFn) {
    const resolved = [];
    for (const [id] of this._pending) {
      if (this.retryPending(id, renderFn)) {
        resolved.push(id);
      }
    }
    return resolved;
  }

  _markFailed(id) {
    const entry = this._pending.get(id);
    if (entry && entry.element) {
      entry.element.classList.add('latex-failed');
      entry.element.innerHTML = `<span class="latex-failed-text">${this._escapeHtml(entry.content)}</span>`;
    }
    this._pending.delete(id);
  }

  markComplete(id) {
    const entry = this._pending.get(id);
    if (entry && entry.element) {
      entry.element.classList.remove('latex-pending');
      entry.element.classList.add('latex-complete');
    }
    this.resolvePending(id);
  }

  markStreaming(id) {
    const entry = this._pending.get(id);
    if (entry && entry.element) {
      entry.element.classList.add('latex-pending');
      entry.element.classList.remove('latex-complete', 'latex-failed');
    }
  }

  clear() {
    this._pending.clear();
    this._resolved.clear();
  }

  isComplete(id) {
    return this._resolved.has(id);
  }

  hasPending() {
    return this._pending.size > 0;
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
