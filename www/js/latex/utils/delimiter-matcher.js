// www/js/latex/utils/delimiter-matcher.js
// Balanced brace/bracket/parenthesis matching.

export function findMatchingBrace(str, startIdx, openChar = '{', closeChar = '}') {
  let depth = 1;
  for (let i = startIdx + 1; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function findAllMatchingBraces(str) {
  const pairs = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') {
      const close = findMatchingBrace(str, i);
      if (close !== -1) {
        pairs.push({ open: i, close });
        i = close;
      }
    }
  }
  return pairs;
}

export function isBalanced(str, openChar = '{', closeChar = '}') {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === openChar) depth++;
    else if (str[i] === closeChar) { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

export function extractBraceContent(str, startIdx = 0) {
  while (startIdx < str.length && str[startIdx] !== '{') startIdx++;
  if (startIdx >= str.length) return null;
  const close = findMatchingBrace(str, startIdx);
  if (close === -1) return null;
  return { content: str.slice(startIdx + 1, close), start: startIdx, end: close };
}

export function extractBracketContent(str, startIdx = 0) {
  while (startIdx < str.length && str[startIdx] !== '[') startIdx++;
  if (startIdx >= str.length) return null;
  const close = findMatchingBrace(str, startIdx, '[', ']');
  if (close === -1) return null;
  return { content: str.slice(startIdx + 1, close), start: startIdx, end: close };
}
