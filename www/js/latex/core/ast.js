// www/js/latex/core/ast.js
// AST node types and utilities for the LaTeX parser.

import { Severity, createError } from './errors.js';

// ─── Node Type Constants ──────────────────────────────────────────────────────

export const NodeType = {
  DOCUMENT: 'Document',
  COMMAND: 'Command',
  ENVIRONMENT: 'Environment',
  GROUP: 'Group',
  TEXT: 'Text',
  MATH: 'Math',
  MATH_INLINE: 'MathInline',
  MATH_DISPLAY: 'MathDisplay',
  PARAMETER: 'Parameter',
  COMMENT: 'Comment',
  WHITESPACE: 'Whitespace',
  SUPERSCRIPT: 'Superscript',
  SUBSCRIPT: 'Subscript',
  FRACTION: 'Fraction',
  MATRIX: 'Matrix',
  TABLE: 'Table',
  TABLE_ROW: 'TableRow',
  TABLE_CELL: 'TableCell',
  LIST: 'List',
  LIST_ITEM: 'ListItem',
  SECTION: 'Section',
  ARGUMENT: 'Argument',
  OPTIONAL_ARGUMENT: 'OptionalArgument',
  MANDATORY_ARGUMENT: 'MandatoryArgument',
  RAW: 'Raw',
};

// ─── Base Node ────────────────────────────────────────────────────────────────

export class LatexNode {
  constructor(type, props = {}) {
    this.type = type;
    this.children = props.children || [];
    this.location = props.location || null;
    this.raw = props.raw || '';
    this.errors = props.errors || [];
    this.content = props.content || null;
    this.name = props.name || null;
    this.args = props.args || [];
    this.options = props.options || {};
    this.value = props.value || '';
  }

  addChild(node) {
    this.children.push(node);
    return this;
  }

  addError(error) {
    if (error instanceof LatexNode) {
      this.errors.push(error);
    } else {
      this.errors.push(createError(error, this.location, this.raw));
    }
    return this;
  }

  clone() {
    const node = new LatexNode(this.type, {
      children: this.children.map(c => c.clone()),
      location: this.location ? { ...this.location } : null,
      raw: this.raw,
      errors: this.errors.map(e => ({ ...e })),
      content: this.content,
      name: this.name,
      args: this.args.map(a => a.clone ? a.clone() : { ...a }),
      options: { ...this.options },
      value: this.value,
    });
    return node;
  }

  toLaTeX() {
    return this.children.map(c => c.toLaTeX()).join('');
  }

  findErrors() {
    const errors = [...this.errors];
    for (const child of this.children) {
      if (child.findErrors) errors.push(...child.findErrors());
    }
    if (this.content && this.content.findErrors) {
      errors.push(...this.content.findErrors());
    }
    return errors;
  }

  visit(visitor) {
    visitor.enter(this);
    for (const child of this.children) {
      if (child.visit) child.visit(visitor);
    }
    if (this.content && this.content.visit) {
      this.content.visit(visitor);
    }
    visitor.exit(this);
  }

  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find ? child.find(predicate) : null;
      if (found) return found;
    }
    if (this.content && this.content.find) {
      return this.content.find(predicate);
    }
    return null;
  }

  findAll(predicate) {
    const results = [];
    if (predicate(this)) results.push(this);
    for (const child of this.children) {
      if (child.findAll) results.push(...child.findAll(predicate));
    }
    if (this.content && this.content.findAll) {
      results.push(...this.content.findAll(predicate));
    }
    return results;
  }
}

// ─── Node Factories ───────────────────────────────────────────────────────────

export function createDocument(children = [], props = {}) {
  return new LatexNode(NodeType.DOCUMENT, { children, ...props });
}

export function createCommand(name, args = [], children = [], props = {}) {
  return new LatexNode(NodeType.COMMAND, { name, args, children, ...props });
}

export function createEnvironment(name, options = null, children = [], props = {}) {
  return new LatexNode(NodeType.ENVIRONMENT, { name, options, children, ...props });
}

export function createGroup(children = [], props = {}) {
  return new LatexNode(NodeType.GROUP, { children, ...props });
}

export function createText(value, props = {}) {
  return new LatexNode(NodeType.TEXT, { value, ...props });
}

export function createMath(content, displayMode = false, props = {}) {
  return new LatexNode(displayMode ? NodeType.MATH_DISPLAY : NodeType.MATH_INLINE, {
    content,
    value: content,
    ...props,
  });
}

export function createParameter(index, props = {}) {
  return new LatexNode(NodeType.PARAMETER, { value: String(index), content: index, ...props });
}

export function createComment(value, props = {}) {
  return new LatexNode(NodeType.COMMENT, { value, ...props });
}

export function createWhitespace(value, props = {}) {
  return new LatexNode(NodeType.WHITESPACE, { value, ...props });
}

export function createSuperscript(content, props = {}) {
  return new LatexNode(NodeType.SUPERSCRIPT, { children: content, content: content[0] || null, ...props });
}

export function createSubscript(content, props = {}) {
  return new LatexNode(NodeType.SUBSCRIPT, { children: content, content: content[0] || null, ...props });
}

export function createFraction(numerator, denominator, props = {}) {
  return new LatexNode(NodeType.FRACTION, {
    children: [numerator, denominator],
    content: { numerator, denominator },
    ...props,
  });
}

export function createMatrix(rows, props = {}) {
  return new LatexNode(NodeType.MATRIX, {
    content: { rows },
    children: rows,
    ...props,
  });
}

export function createTable(body, props = {}) {
  return new LatexNode(NodeType.TABLE, { content: { body }, children: body, ...props });
}

export function createTableRow(cells, props = {}) {
  return new LatexNode(NodeType.TABLE_ROW, { children: cells, content: { cells }, ...props });
}

export function createTableCell(children, props = {}) {
  return new LatexNode(NodeType.TABLE_CELL, { children, ...props });
}

export function createList(items, ordered = false, props = {}) {
  return new LatexNode(NodeType.LIST, {
    children: items,
    options: { ordered },
    ...props,
  });
}

export function createListItem(children, props = {}) {
  return new LatexNode(NodeType.LIST_ITEM, { children, ...props });
}

export function createSection(level, title, children = [], props = {}) {
  return new LatexNode(NodeType.SECTION, {
    name: `level${level}`,
    content: { level, title },
    children,
    ...props,
  });
}

export function createArgument(children, optional = false, props = {}) {
  return new LatexNode(optional ? NodeType.OPTIONAL_ARGUMENT : NodeType.MANDATORY_ARGUMENT, {
    children,
    ...props,
  });
}

export function createRaw(value, props = {}) {
  return new LatexNode(NodeType.RAW, { value, ...props });
}

// ─── Visitor Pattern ──────────────────────────────────────────────────────────

export class Visitor {
  enter(node) {}
  exit(node) {}
}

export class TransformVisitor extends Visitor {
  transform(node) {
    node.visit(this);
    return node;
  }
}

// ─── Utility: Flatten text from AST subtree ───────────────────────────────────

export function flattenText(node) {
  if (!node) return '';
  if (node.type === NodeType.TEXT) return node.value;
  if (node.type === NodeType.WHITESPACE) return node.value;
  if (node.type === NodeType.COMMENT) return '';
  if (node.children) return node.children.map(flattenText).join('');
  return '';
}

// ─── Utility: Check if node is empty ──────────────────────────────────────────

export function isEmpty(node) {
  if (!node) return true;
  if (node.children && node.children.length > 0) return false;
  if (node.value && node.value.trim()) return false;
  return true;
}
