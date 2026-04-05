// www/js/chat/colour-utils.js
// Detect and render colour codes in chat messages

/**
 * Convert RGB values to hex
 */
function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Convert hex to RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Apply alpha to white background
 */
function applyAlphaToWhite(r, g, b, a) {
  const white = 255;
  return {
    r: Math.round(r * a + white * (1 - a)),
    g: Math.round(g * a + white * (1 - a)),
    b: Math.round(b * a + white * (1 - a))
  };
}

/**
 * Render a colour preview block
 */
function renderColourBlock(colourText, colourValue) {
  const rgb = colourValue.startsWith('#') ? hexToRgb(colourValue) : null;
  if (!rgb && !colourValue.startsWith('rgb(')) return colourText;

  let displayColour = colourValue;
  if (colourValue.startsWith('#') && colourValue.length === 9) {
    // #rrggbbaa format
    const alpha = parseInt(colourValue.slice(7, 9), 16) / 255;
    const baseRgb = hexToRgb(colourValue.slice(0, 7));
    if (baseRgb) {
      const blended = applyAlphaToWhite(baseRgb.r, baseRgb.g, baseRgb.b, alpha);
      displayColour = rgbToHex(blended.r, blended.g, blended.b);
    }
  } else if (colourValue.startsWith('rgb(') && colourValue.includes(',')) {
    // rgb(r,g,b) format
    const match = colourValue.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      displayColour = rgbToHex(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
    }
  }

  return `<span class="colour-preview" style="--preview-colour: ${displayColour}" title="${colourText}">${colourText}</span>`;
}

/**
 * Detect colour codes in text and replace with preview blocks
 */
export function detectAndRenderColours(html) {
  // Pattern for rgb(r,g,b) - with word boundaries to prevent false matches
  html = html.replace(/\brgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)\b/g, (match) => {
    const r = Math.min(255, Math.max(0, parseInt(RegExp.$1)));
    const g = Math.min(255, Math.max(0, parseInt(RegExp.$2)));
    const b = Math.min(255, Math.max(0, parseInt(RegExp.$3)));
    const colourValue = `rgb(${r},${g},${b})`;
    const hexValue = rgbToHex(r, g, b);
    return renderColourBlock(match, hexValue);
  });

  // Pattern for #rrggbb - without word boundaries as # can appear in various contexts
  html = html.replace(/#([a-fA-F0-9]{6})(?![a-fA-F0-9])/g, (match) => {
    return renderColourBlock(match, match.toLowerCase());
  });

  // Pattern for #rrggbbaa - without word boundaries, negative lookahead to avoid matching longer strings
  html = html.replace(/#([a-fA-F0-9]{8})(?![a-fA-F0-9])/g, (match, hexDigits) => {
    const alpha = parseInt(hexDigits.slice(6, 8), 16) / 255;
    const baseRgb = hexToRgb('#' + hexDigits.slice(0, 6));
    if (baseRgb) {
      const blended = applyAlphaToWhite(baseRgb.r, baseRgb.g, baseRgb.b, alpha);
      const blendedHex = rgbToHex(blended.r, blended.g, blended.b);
      return renderColourBlock(match, blendedHex);
    }
    return match;
  });

  return html;
}