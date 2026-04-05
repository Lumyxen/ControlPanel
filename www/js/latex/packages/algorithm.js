// www/js/latex/packages/algorithm.js
// Algorithm/algorithmic environments: pseudocode with keyword highlighting and indentation.

const ALGO_KEYWORDS = new Set([
  'if','then','else','elsif','elseif','endif','fi',
  'for','forall','do','done','endfor',
  'while','endwhile',
  'repeat','until',
  'loop','endloop',
  'begin','end',
  'function','procedure',
  'return','exit',
  'break','continue',
  'call',
  'print','read',
  'input','output',
  'require','ensure',
  'and','or','not',
  'true','false',
  'null','nil',
  'to','downto',
  'step',
  'each',
  'in',
  'of',
  'set','get',
  'new',
  'throw','catch','try',
  'assert',
  'comment',
]);

export function processAlgorithm(source) {
  let result = source;

  result = result.replace(/\\begin\s*\{algorithm\}/g, '<div class="latex-algorithm">');
  result = result.replace(/\\end\s*\{algorithm\}/g, '</div>');
  result = result.replace(/\\begin\s*\{algorithmic\}(?:\[([0-9]+)\])?/g, (_, num) => {
    const numbered = num ? ' data-numbered="' + num + '"' : '';
    return `<div class="latex-algorithmic"${numbered}>`;
  });
  result = result.replace(/\\end\s*\{algorithmic\}/g, '</div>');
  result = result.replace(/\\begin\s*\{algpseudocode\}/g, '<div class="latex-algpseudocode">');
  result = result.replace(/\\end\s*\{algpseudocode\}/g, '</div>');
  result = result.replace(/\\begin\s*\{algorithm2e\}/g, '<div class="latex-algorithm2e">');
  result = result.replace(/\\end\s*\{algorithm2e\}/g, '</div>');

  result = result.replace(/\\State\s*/g, '<span class="latex-algo-line">');
  result = result.replace(/\\Statex\s*/g, '<span class="latex-algo-line latex-algo-statex">');
  result = result.replace(/\\If\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">if</span> ');
  result = result.replace(/\\Else\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">else</span>');
  result = result.replace(/\\ElsIf\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">elsif</span> ');
  result = result.replace(/\\For\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">for</span> ');
  result = result.replace(/\\While\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">while</span> ');
  result = result.replace(/\\Repeat\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">repeat</span>');
  result = result.replace(/\\Until\s*/g, '<span class="latex-algo-kw">until</span> ');
  result = result.replace(/\\Loop\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">loop</span>');
  result = result.replace(/\\Function\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">function</span> ');
  result = result.replace(/\\Return\s*/g, '<span class="latex-algo-kw">return</span> ');
  result = result.replace(/\\Comment\s*\{([^}]*)\}/g, '<span class="latex-algo-comment">// $1</span>');
  result = result.replace(/\\Require\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">Require:</span> ');
  result = result.replace(/\\Ensure\s*/g, '<span class="latex-algo-line"><span class="latex-algo-kw">Ensure:</span> ');
  result = result.replace(/\\caption\s*\{([^}]*)\}/g, '<div class="latex-algo-caption">$1</div>');
  result = result.replace(/\\label\s*\{([^}]*)\}/g, '');
  result = result.replace(/\\EndIf/g, '</span>');
  result = result.replace(/\\EndFor/g, '</span>');
  result = result.replace(/\\EndWhile/g, '</span>');
  result = result.replace(/\\EndLoop/g, '</span>');
  result = result.replace(/\\EndFunction/g, '</span>');
  result = result.replace(/\\EndRepeat/g, '</span>');

  result = result.replace(/\\algorithmic(?:if|for|while|loop|function|repeat|until|require|ensure|comment|print|input|return|state|statex|else|elsif)/g, '');

  return result;
}

export function highlightAlgorithmKeyword(word) {
  if (ALGO_KEYWORDS.has(word.toLowerCase())) {
    return `<span class="latex-algo-kw">${word}</span>`;
  }
  return word;
}

export function getAlgoKeywords() {
  return Array.from(ALGO_KEYWORDS);
}
