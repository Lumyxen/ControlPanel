// www/js/latex/core/crossref.js
// Cross-reference resolution system: \label, \ref, \pageref, \eqref, \autoref.

export class CrossRefResolver {
  constructor() {
    this.labels = new Map();
    this.counters = {
      section: 0, subsection: 0, subsubsection: 0,
      equation: 0, figure: 0, table: 0,
      theorem: 0, lemma: 0, definition: 0,
      page: 1,
    };
    this.labelTypes = new Map();
    this.unresolvedRefs = new Set();
  }

  /**
   * Register a label at the current position.
   */
  defineLabel(name, type = 'generic', counterValue = null, page = null) {
    this.labels.set(name, {
      type,
      counter: counterValue !== null ? counterValue : this._getCurrentCounter(type),
      page: page !== null ? page : this.counters.page,
    });
    this.labelTypes.set(name, type);
  }

  /**
   * Resolve a reference.
   */
  resolveRef(name) {
    const label = this.labels.get(name);
    if (!label) {
      this.unresolvedRefs.add(name);
      return { resolved: false, text: '??', name };
    }
    return { resolved: true, text: String(label.counter), name, type: label.type, page: label.page };
  }

  /**
   * Resolve a page reference.
   */
  resolvePageRef(name) {
    const label = this.labels.get(name);
    if (!label) {
      this.unresolvedRefs.add(name);
      return { resolved: false, text: '??', name };
    }
    return { resolved: true, text: String(label.page), name, page: label.page };
  }

  /**
   * Resolve an equation reference.
   */
  resolveEqRef(name) {
    const resolved = this.resolveRef(name);
    if (!resolved.resolved) return resolved;
    return { ...resolved, text: `(${resolved.text})` };
  }

  /**
   * Auto-resolve with type prefix (like hyperref's \autoref).
   */
  resolveAutoRef(name) {
    const label = this.labels.get(name);
    if (!label) {
      this.unresolvedRefs.add(name);
      return { resolved: false, text: '??', name };
    }

    const prefixes = {
      section: 'Section',
      subsection: 'Section',
      subsubsection: 'Section',
      equation: 'Eq.',
      figure: 'Figure',
      table: 'Table',
      theorem: 'Theorem',
      lemma: 'Lemma',
      definition: 'Definition',
      corollary: 'Corollary',
      proposition: 'Proposition',
      proof: 'Proof',
      example: 'Example',
      remark: 'Remark',
      chapter: 'Chapter',
      part: 'Part',
    };

    const prefix = prefixes[label.type] || '';
    return {
      resolved: true,
      text: `${prefix} ${label.counter}`,
      name,
      type: label.type,
      page: label.page,
    };
  }

  /**
   * Process cross-reference commands in source.
   */
  processRefCommands(source) {
    let result = source;

    // \label{name}
    result = result.replace(/\\label\s*\{([^}]*)\}/g, (match, name) => {
      // Label will be resolved during AST processing
      return `<span class="latex-label" data-label="${escapeAttr(name)}"></span>`;
    });

    // \ref{name}
    result = result.replace(/\\ref\s*\{([^}]*)\}/g, (match, name) => {
      const resolved = this.resolveRef(name);
      return `<span class="latex-ref" data-ref="${escapeAttr(name)}" data-resolved="${resolved.resolved}">${resolved.text}</span>`;
    });

    // \pageref{name}
    result = result.replace(/\\pageref\s*\{([^}]*)\}/g, (match, name) => {
      const resolved = this.resolvePageRef(name);
      return `<span class="latex-pageref" data-ref="${escapeAttr(name)}" data-resolved="${resolved.resolved}">${resolved.text}</span>`;
    });

    // \eqref{name}
    result = result.replace(/\\eqref\s*\{([^}]*)\}/g, (match, name) => {
      const resolved = this.resolveEqRef(name);
      return `<span class="latex-eqref" data-ref="${escapeAttr(name)}" data-resolved="${resolved.resolved}">${resolved.text}</span>`;
    });

    // \autoref{name}
    result = result.replace(/\\autoref\s*\{([^}]*)\}/g, (match, name) => {
      const resolved = this.resolveAutoRef(name);
      return `<a class="latex-autoref" href="#${escapeAttr(name)}" data-ref="${escapeAttr(name)}" data-type="${resolved.type || ''}" data-resolved="${resolved.resolved}">${resolved.text}</a>`;
    });

    // \nameref{name}
    result = result.replace(/\\nameref\s*\{([^}]*)\}/g, (match, name) => {
      const label = this.labels.get(name);
      if (!label) {
        this.unresolvedRefs.add(name);
        return `<span class="latex-nameref" data-ref="${escapeAttr(name)}" data-resolved="false">??</span>`;
      }
      return `<a class="latex-nameref" href="#${escapeAttr(name)}" data-ref="${escapeAttr(name)}">${label.name || name}</a>`;
    });

    return result;
  }

  /**
   * Get all unresolved references.
   */
  getUnresolved() {
    return Array.from(this.unresolvedRefs);
  }

  /**
   * Check if all references are resolved.
   */
  allResolved() {
    return this.unresolvedRefs.size === 0;
  }

  /**
   * Get all labels.
   */
  getAllLabels() {
    return Array.from(this.labels.entries()).map(([name, data]) => ({
      name, ...data,
    }));
  }

  /**
   * Increment a counter and return the new value.
   */
  incrementCounter(type) {
    if (this.counters[type] !== undefined) {
      this.counters[type]++;
      return this.counters[type];
    }
    return 0;
  }

  /**
   * Set a counter value.
   */
  setCounter(type, value) {
    this.counters[type] = value;
  }

  /**
   * Get current counter value.
   */
  getCounter(type) {
    return this.counters[type] || 0;
  }

  _getCurrentCounter(type) {
    return this.counters[type] || 0;
  }

  /**
   * Reset all state.
   */
  reset() {
    this.labels.clear();
    this.labelTypes.clear();
    this.unresolvedRefs.clear();
    this.counters = {
      section: 0, subsection: 0, subsubsection: 0,
      equation: 0, figure: 0, table: 0,
      theorem: 0, lemma: 0, definition: 0,
      page: 1,
    };
  }
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
