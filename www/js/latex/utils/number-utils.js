// www/js/latex/utils/number-utils.js
// Shared number-formatting helpers used across the LaTeX subsystem.

/**
 * Convert an integer to a Roman numeral string.
 * Returns String(num) for values outside [1, 3999].
 * @param {number} num
 * @returns {string}
 */
export function toRoman(num) {
  if (num <= 0 || num > 3999) return String(num);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
  }
  return result;
}