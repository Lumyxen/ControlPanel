// www/js/latex/utils/length-parser.js
// Parse LaTeX length units and convert to CSS equivalents.

const UNIT_TO_PX = {
  pt: 1,
  mm: 2.83465,
  cm: 28.3465,
  in: 72.27,
  bp: 1,
  dd: 1.07003,
  cc: 12.8404,
  pc: 12,
  sp: 1 / 65536,
  ex: 10,
  em: 16,
  mu: 0.05555,
  px: 1,
  rem: 16,
  vw: 0,
  vh: 0,
  '%': 0,
};

export function parseLength(str, baseFontSize = 16) {
  if (!str) return '0px';
  str = str.trim();
  const match = str.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]+)?$/i);
  if (!match) return '0px';
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'pt').toLowerCase();

  if (unit === 'ex') return `${value * baseFontSize * 0.5}px`;
  if (unit === 'em') return `${value * baseFontSize}px`;
  if (unit === 'mu') return `${value * 0.05555}em`;
  if (unit === '%') return `${value}%`;
  if (unit === 'vw' || unit === 'vh') return `${value}${unit}`;
  if (unit === 'px' || unit === 'bp') return `${value}px`;

  const factor = UNIT_TO_PX[unit];
  if (factor !== undefined) return `${value * factor}px`;
  return `${value}px`;
}

export function parseLengthExpression(expr, baseFontSize = 16) {
  if (!expr) return '0px';
  expr = expr.trim();

  const parts = expr.split(/\s*([+-])\s*/);
  if (parts.length === 1) return parseLength(expr, baseFontSize);

  let total = 0;
  total += parseLengthToPx(parts[0], baseFontSize);
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    const val = parseLengthToPx(parts[i + 1], baseFontSize);
    total = op === '+' ? total + val : total - val;
  }
  return `${total}px`;
}

function parseLengthToPx(str, baseFontSize) {
  const pxStr = parseLength(str, baseFontSize);
  return parseFloat(pxStr) || 0;
}

export function lengthToCSS(str, baseFontSize = 16) {
  return parseLength(str, baseFontSize);
}
