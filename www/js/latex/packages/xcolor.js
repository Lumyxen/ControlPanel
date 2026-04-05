// www/js/latex/packages/xcolor.js
// Color handling: named colors, models, \color, \textcolor, \colorbox, \fcolorbox.

import { parseColor, mixColors, colorWithOpacity } from '../utils/color-parser.js';

const NAMED_COLORS = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
  blue: '#0000FF', cyan: '#00FFFF', magenta: '#FF00FF', yellow: '#FFFF00',
  darkgray: '#404040', gray: '#808080', lightgray: '#C0C0C0',
  brown: '#A52A2A', lime: '#00FF00', olive: '#808000', orange: '#FFA500',
  pink: '#FFC0CB', purple: '#800080', teal: '#008080', violet: '#EE82EE',
};

export function processColor(source) {
  let result = source;

  result = result.replace(/\\definecolor\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, name, model, spec) => {
    const color = parseColor(`${model}(${spec})`) || parseColor(spec);
    if (color) NAMED_COLORS[name] = color;
    return '';
  });

  result = result.replace(/\\color\s*\{([^}]*)\}/g, (_, name) => {
    const color = NAMED_COLORS[name] || parseColor(name);
    return color ? `<span style="color:${color}">` : '';
  });

  result = result.replace(/\\textcolor\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, name, text) => {
    const color = NAMED_COLORS[name] || parseColor(name);
    return color ? `<span style="color:${color}">${text}</span>` : text;
  });

  result = result.replace(/\\colorbox\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, name, text) => {
    const color = NAMED_COLORS[name] || parseColor(name);
    return color ? `<span style="background-color:${color};padding:2px 4px;border-radius:2px">${text}</span>` : text;
  });

  result = result.replace(/\\fcolorbox\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (_, borderName, bgName, text) => {
    const borderColor = NAMED_COLORS[borderName] || parseColor(borderName);
    const bgColor = NAMED_COLORS[bgName] || parseColor(bgName);
    if (borderColor && bgColor) {
      return `<span style="background-color:${bgColor};color:${borderColor};padding:2px 4px;border:1px solid ${borderColor};border-radius:2px">${text}</span>`;
    }
    return text;
  });

  return result;
}

export function getNamedColors() {
  return { ...NAMED_COLORS };
}

export { parseColor, mixColors, colorWithOpacity };
