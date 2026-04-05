// www/js/latex/environments/math-envs.js
// Math environment handlers: equation, align, gather, matrices, etc.

export const MATH_ENVIRONMENTS = new Set([
  'equation','equation*','align','align*','gather','gather*',
  'multline','multline*','flalign','flalign*',
  'alignat','alignat*','eqnarray','eqnarray*',
  'subequations','split','displaymath',
  'bmatrix','bmatrix*','pmatrix','pmatrix*',
  'vmatrix','vmatrix*','Vmatrix','Vmatrix*',
  'Bmatrix','Bmatrix*','matrix','matrix*','smallmatrix',
  'cases','dcases','rcases','rcases*',
  'gathered','aligned','alignedat',
  'math','displaymath',
]);

export function isMathEnvironment(name) {
  return MATH_ENVIRONMENTS.has(name);
}

export function getMathEnvConfig(name) {
  const base = name.replace(/\*$/, '');
  const starred = name.endsWith('*');
  const configs = {
    equation: { numbered: !starred, display: true },
    align: { numbered: !starred, display: true, aligned: true },
    gather: { numbered: !starred, display: true, gathered: true },
    multline: { numbered: !starred, display: true, multline: true },
    flalign: { numbered: !starred, display: true, fullAligned: true },
    alignat: { numbered: !starred, display: true, alignat: true },
    eqnarray: { numbered: !starred, display: true, eqnarray: true },
    subequations: { numbered: true, display: true, subeq: true },
    split: { numbered: false, display: true, split: true },
    displaymath: { numbered: false, display: true },
    bmatrix: { numbered: false, display: true, brackets: ['[', ']'] },
    pmatrix: { numbered: false, display: true, brackets: ['(', ')'] },
    vmatrix: { numbered: false, display: true, brackets: ['|', '|'] },
    Vmatrix: { numbered: false, display: true, brackets: ['\\|', '\\|'] },
    Bmatrix: { numbered: false, display: true, brackets: ['\\{', '\\}'] },
    matrix: { numbered: false, display: true, brackets: null },
    smallmatrix: { numbered: false, display: false, brackets: null, small: true },
    cases: { numbered: false, display: true, cases: true, brackets: ['\\{', ''] },
    dcases: { numbered: false, display: true, cases: true, brackets: ['\\{', ''], displayStyle: true },
    rcases: { numbered: false, display: true, cases: true, brackets: ['', '\\}'] },
    gathered: { numbered: false, display: true, gathered: true },
    aligned: { numbered: false, display: true, aligned: true },
    alignedat: { numbered: false, display: true, alignat: true },
  };
  return configs[base] || { numbered: !starred, display: true };
}

export function renderMathEnvironment(name, content, config = {}) {
  const envConfig = getMathEnvConfig(name);
  const displayClass = envConfig.display ? 'latex-display-math' : 'latex-inline-math';
  const numberedClass = envConfig.numbered ? 'latex-numbered' : '';

  if (envConfig.cases) {
    return `<div class="latex-math-env latex-cases ${displayClass}">${content}</div>`;
  }
  if (envConfig.brackets) {
    const [left, right] = envConfig.brackets;
    return `<div class="latex-math-env latex-matrix-env ${displayClass} ${numberedClass}" data-left="${left}" data-right="${right}">${content}</div>`;
  }

  return `<div class="latex-math-env ${displayClass} ${numberedClass}" data-env="${name}">${content}</div>`;
}
