// www/js/latex/utils/html-utils.js
// Shared HTML-escaping helpers used across the LaTeX subsystem.
// Import these instead of redefining them locally.

/**
 * Escape text content for safe HTML insertion.
 * Encodes &, <, >, and ".
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape a value for use inside an HTML attribute (quoted with ").
 * Encodes &, ", <, and >.
 * @param {string} text
 * @returns {string}
 */
export function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}