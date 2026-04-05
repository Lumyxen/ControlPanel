// www/js/latex/environments/structural-envs.js
// Theorem, proof, definition, and other structural environment renderers.
// Uses Lucide SVG icons - no emojis.

import { getIcon } from '../utils/icons.js';

const STRUCTURAL_TYPES = {
  theorem: { icon: 'landmark', label: 'Theorem', color: '--latex-theorem-color' },
  lemma: { icon: 'lightbulb', label: 'Lemma', color: '--latex-lemma-color' },
  corollary: { icon: 'pin', label: 'Corollary', color: '--latex-corollary-color' },
  proposition: { icon: 'triangle', label: 'Proposition', color: '--latex-proposition-color' },
  definition: { icon: 'book-open', label: 'Definition', color: '--latex-definition-color' },
  remark: { icon: 'message-square', label: 'Remark', color: '--latex-remark-color' },
  note: { icon: 'clipboard-list', label: 'Note', color: '--latex-note-color' },
  example: { icon: 'flask-conical', label: 'Example', color: '--latex-example-color' },
  axiom: { icon: 'scale', label: 'Axiom', color: '--latex-axiom-color' },
  conjecture: { icon: 'eye', label: 'Conjecture', color: '--latex-conjecture-color' },
  hypothesis: { icon: 'microscope', label: 'Hypothesis', color: '--latex-hypothesis-color' },
  observation: { icon: 'eye', label: 'Observation', color: '--latex-observation-color' },
  notation: { icon: 'pencil', label: 'Notation', color: '--latex-notation-color' },
  claim: { icon: 'megaphone', label: 'Claim', color: '--latex-claim-color' },
  exercise: { icon: 'dumbbell', label: 'Exercise', color: '--latex-exercise-color' },
  problem: { icon: 'circle-help', label: 'Problem', color: '--latex-problem-color' },
  solution: { icon: 'circle-check', label: 'Solution', color: '--latex-solution-color' },
  fact: { icon: 'bookmark', label: 'Fact', color: '--latex-fact-color' },
  assumption: { icon: 'shield-alert', label: 'Assumption', color: '--latex-assumption-color' },
  criterion: { icon: 'ruler', label: 'Criterion', color: '--latex-criterion-color' },
  assertion: { icon: 'speaker', label: 'Assertion', color: '--latex-assertion-color' },
  property: { icon: 'key', label: 'Property', color: '--latex-property-color' },
  condition: { icon: 'cone', label: 'Condition', color: '--latex-condition-color' },
  question: { icon: 'circle-help', label: 'Question', color: '--latex-question-color' },
  answer: { icon: 'message-circle', label: 'Answer', color: '--latex-answer-color' },
  summary: { icon: 'file-text', label: 'Summary', color: '--latex-summary-color' },
  conclusion: { icon: 'target', label: 'Conclusion', color: '--latex-conclusion-color' },
  case: { icon: 'folder-open', label: 'Case', color: '--latex-case-color' },
  proof: { icon: 'file-check', label: 'Proof', color: '--latex-proof-color' },
  abstract: { icon: 'file-text', label: 'Abstract', color: '--latex-abstract-color' },
};

export function getStructuralType(name) {
  return STRUCTURAL_TYPES[name] || null;
}

export function renderStructuralEnvironment(name, content, title = '', options = {}) {
  const type = getStructuralType(name);
  if (!type) return content;

  const iconSvg = getIcon(type.icon);
  const label = title || type.label;
  const qedSymbol = name === 'proof' ? '<span class="latex-qed">&#9633;</span>' : '';

  return `<div class="latex-callout latex-callout-${name}" data-latex-type="${name}">
  <div class="latex-callout-header">
    <span class="latex-callout-icon">${iconSvg}</span>
    <span class="latex-callout-title">${label}</span>
  </div>
  <div class="latex-callout-content">${content}${qedSymbol}</div>
</div>`;
}

export function getAllStructuralTypes() {
  return Object.keys(STRUCTURAL_TYPES);
}

export function isStructuralEnvironment(name) {
  return name in STRUCTURAL_TYPES;
}
