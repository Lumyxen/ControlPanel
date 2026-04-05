// www/js/latex/renderers/image-export.js
// Copy LaTeX as image functionality (SVG/PNG via KaTeX/MathJax).

export class ImageExporter {
  constructor(options = {}) {
    this.options = {
      format: options.format || 'png',
      background: options.background || 'transparent',
      scale: options.scale || 2,
      padding: options.padding || 16,
    };
  }

  async exportMath(mathContent, container) {
    const katexEl = container?.querySelector('.katex, .katex-html');
    if (!katexEl) return null;

    const svg = this._extractSVG(katexEl);
    if (!svg) return null;

    if (this.options.format === 'svg') {
      return this._exportSVG(svg);
    }
    return this._exportPNG(svg);
  }

  _extractSVG(container) {
    const svgEl = container.querySelector('svg');
    if (svgEl) return svgEl.outerHTML;

    const htmlEl = container.querySelector('.katex-html');
    if (htmlEl) {
      const clone = htmlEl.cloneNode(true);
      clone.style.display = 'inline-block';
      return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml">${clone.outerHTML}</div>
        </foreignObject>
      </svg>`;
    }
    return null;
  }

  _exportSVG(svgContent) {
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    return { blob, url: URL.createObjectURL(blob), type: 'svg' };
  }

  async _exportPNG(svgContent) {
    const scale = this.options.scale;
    const padding = this.options.padding;
    const bg = this.options.background;

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = (img.width + padding * 2) * scale;
        canvas.height = (img.height + padding * 2) * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        if (bg === 'white') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
        } else if (bg === 'dark') {
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
        }

        ctx.drawImage(img, padding, padding);
        canvas.toBlob((blob) => {
          resolve({ blob, url: URL.createObjectURL(blob), type: 'png' });
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgContent);
    });
  }

  async copyToClipboard(mathContent, container) {
    const result = await this.exportMath(mathContent, container);
    if (!result) return false;

    try {
      if (result.type === 'png' && navigator.clipboard?.write) {
        const item = new ClipboardItem({ 'image/png': result.blob });
        await navigator.clipboard.write([item]);
        return true;
      }
      if (result.type === 'svg') {
        const item = new ClipboardItem({ 'image/svg+xml': result.blob });
        await navigator.clipboard.write([item]);
        return true;
      }
    } catch {
      const a = document.createElement('a');
      a.href = result.url;
      a.download = `latex-equation.${result.type}`;
      a.click();
      return true;
    }
    return false;
  }

  setFormat(format) {
    this.options.format = format;
  }

  setBackground(bg) {
    this.options.background = bg;
  }

  setScale(scale) {
    this.options.scale = scale;
  }
}

export function exportMathImage(mathContent, container, options = {}) {
  const exporter = new ImageExporter(options);
  return exporter.exportMath(mathContent, container);
}
