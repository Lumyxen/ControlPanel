// www/js/latex/packages/booktabs.js
// Professional table rules: \toprule, \midrule, \bottomrule, \cmidrule, \addlinespace.

export function processBooktabs(source) {
  let result = source;
  result = result.replace(/\\toprule/g, '<tr class="latex-booktabs-toprule"><td colspan="100%" class="latex-booktabs-cell"></td></tr>');
  result = result.replace(/\\midrule/g, '<tr class="latex-booktabs-midrule"><td colspan="100%" class="latex-booktabs-cell"></td></tr>');
  result = result.replace(/\\bottomrule/g, '<tr class="latex-booktabs-bottomrule"><td colspan="100%" class="latex-booktabs-cell"></td></tr>');
  result = result.replace(/\\cmidrule\s*(?:\([lr]*\))?\s*\{([^}]*)\}/g, (_, range) => {
    return `<tr class="latex-booktabs-cmidrule"><td colspan="${range}" class="latex-booktabs-cell"></td></tr>`;
  });
  result = result.replace(/\\addlinespace\s*(?:\[([^\]]*)\])?/g, (_, len) => {
    const height = len || '6pt';
    return `<tr class="latex-booktabs-addlinespace" style="height:${height}"><td></td></tr>`;
  });
  return result;
}
