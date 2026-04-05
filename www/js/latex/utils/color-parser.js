// www/js/latex/utils/color-parser.js
// Parse LaTeX color specifications to CSS color strings.

const NAMED_COLORS = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
  blue: '#0000FF', cyan: '#00FFFF', magenta: '#FF00FF', yellow: '#FFFF00',
  darkgray: '#404040', gray: '#808080', lightgray: '#C0C0C0',
  brown: '#A52A2A', lime: '#00FF00', olive: '#808000', orange: '#FFA500',
  pink: '#FFC0CB', purple: '#800080', teal: '#008080', violet: '#EE82EE',
  apricot: '#FFB17A', aquamarina: '#7FFFD4', azure: '#F0FFFF', beige: '#F5F5DC',
  bisque: '#FFE4C4', brickred: '#CB4154', buff: '#F0DC82', cadetblue: '#5F9EA0',
  caramel: '#FFD59A', carnationpink: '#FFA6C9', cerulean: '#007BA7',
  cornflowerblue: '#6495ED', crimson: '#DC143C', dandelion: '#F09780',
  emerald: '#50C878', forestgreen: '#228B22', fuchsia: '#FF00FF',
  gold: '#FFD700', goldenrod: '#DAA520', grayish: '#B0B0B0',
  jungle: '#29AB87', lavender: '#E6E6FA', lilac: '#C8A2C8',
  limegreen: '#32CD32', mahogany: '#CD4F3F', maroon: '#800000',
  melon: '#FDBCB4', midnightblue: '#191970', mint: '#98FF98',
  moccasin: '#FFE4B5', mulberry: '#C54B8C', navyblue: '#000080',
  ochre: '#CC7722', olivedrab: '#6B8E23', orchid: '#DA70D6',
  peach: '#FFE5B4', periwinkle: '#CCCCFF', pine: '#01796F',
  plum: '#DDA0DD', processblue: '#009ADE', rawsienna: '#D68A59',
  redorange: '#FF5346', redviolet: '#C0448F', rhodamine: '#E15B9A',
  royalblue: '#4169E1', royalpurple: '#6B3FA0', rubinered: '#9B111E',
  salmone: '#FF8C69', seagreen: '#2E8B57', sepia: '#704214',
  skyblue: '#87CEEB', springgreen: '#00FF7F', tan: '#D2B48C',
  thistle: '#D8BFD8', turquoise: '#40E0D0', violetred: '#F06292',
  wheat: '#F5DEB3', wildstrawberry: '#FC6C85', yellowgreen: '#9ACD32',
  yelloworange: '#FFAE42',
};

/**
 * Parse a color specification into a hex string.
 * Supports: named colors, #RGB, #RRGGBB, #RRGGBBAA, rgb(), cmyk(), hsl(), gray()
 */
export function parseColor(spec) {
  if (!spec) return null;
  spec = spec.trim().toLowerCase();

  if (NAMED_COLORS[spec]) return NAMED_COLORS[spec];

  if (spec.startsWith('#')) {
    const hex = spec.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return '#' + hex.split('').map(c => c + c).join('');
    }
    if (/^[0-9a-f]{6}$/.test(hex)) return '#' + hex;
    if (/^[0-9a-f]{8}$/.test(hex)) return '#' + hex.slice(0, 6);
  }

  const rgbMatch = spec.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    const r = Math.min(255, parseInt(rgbMatch[1], 10));
    const g = Math.min(255, parseInt(rgbMatch[2], 10));
    const b = Math.min(255, parseInt(rgbMatch[3], 10));
    return `rgb(${r},${g},${b})`;
  }

  const cmykMatch = spec.match(/^cmyk\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
  if (cmykMatch) {
    const c = parseFloat(cmykMatch[1]);
    const m = parseFloat(cmykMatch[2]);
    const y = parseFloat(cmykMatch[3]);
    const k = parseFloat(cmykMatch[4]);
    const r = Math.round(255 * (1 - c) * (1 - k));
    const g = Math.round(255 * (1 - m) * (1 - k));
    const b = Math.round(255 * (1 - y) * (1 - k));
    return `rgb(${r},${g},${b})`;
  }

  const hslMatch = spec.match(/^hsl\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)$/);
  if (hslMatch) {
    return `hsl(${hslMatch[1]},${hslMatch[2]}%,${hslMatch[3]}%)`;
  }

  const grayMatch = spec.match(/^gray\s*([\d.]+)$/);
  if (grayMatch) {
    const v = Math.round(parseFloat(grayMatch[1]) * 255);
    return `rgb(${v},${v},${v})`;
  }

  return null;
}

/**
 * Mix two colors at a given ratio (0 = all color1, 1 = all color2).
 * Handles both hex and named colors safely.
 */
export function mixColors(color1, color2, ratio = 0.5) {
  const c1 = parseColor(color1);
  const c2 = parseColor(color2);
  if (!c1 || !c2) return c1 || c2;

  // Ensure both are hex
  const hex1 = c1.startsWith('#') ? c1 : cssToHex(c1);
  const hex2 = c2.startsWith('#') ? c2 : cssToHex(c2);
  if (!hex1 || !hex2) return c1 || c2;

  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);

  const r = Math.round(r1 * (1 - ratio) + r2 * ratio);
  const g = Math.round(g1 * (1 - ratio) + g2 * ratio);
  const b = Math.round(b1 * (1 - ratio) + b2 * ratio);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Apply opacity to a color, returning rgba().
 */
export function colorWithOpacity(color, opacity) {
  const parsed = parseColor(color);
  if (!parsed) return color;

  if (parsed.startsWith('rgb(')) {
    return parsed.replace('rgb(', 'rgba(').replace(')', `,${opacity})`);
  }
  if (parsed.startsWith('#')) {
    const r = parseInt(parsed.slice(1, 3), 16);
    const g = parseInt(parsed.slice(3, 5), 16);
    const b = parseInt(parsed.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${opacity})`;
  }
  return parsed;
}

/**
 * Convert a CSS rgb() string to hex.
 */
function cssToHex(css) {
  const m = css.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!m) return null;
  const r = parseInt(m[1], 10).toString(16).padStart(2, '0');
  const g = parseInt(m[2], 10).toString(16).padStart(2, '0');
  const b = parseInt(m[3], 10).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}
