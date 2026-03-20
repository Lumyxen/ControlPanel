// www/js/chat/latex/math.js
// Handles math delimiter normalisation, placeholder extraction, and KaTeX/MathJax rendering.

// ─── Dynamic renderer injection ──────────────────────────────────────────────
// Loads KaTeX (preferred) and MathJax (fallback) from CDN when not already present.

(function initMathRenderers() {
	if (typeof window === 'undefined') return;

	if (!window.katex && !document.getElementById('katex-script')) {
		const css = document.createElement('link');
		css.rel = 'stylesheet';
		css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
		css.crossOrigin = 'anonymous';
		document.head.appendChild(css);

		const script = document.createElement('script');
		script.id = 'katex-script';
		script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
		script.crossOrigin = 'anonymous';
		script.defer = true;
		script.onload = () => {
			const ar = document.createElement('script');
			ar.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js';
			ar.crossOrigin = 'anonymous';
			ar.defer = true;
			document.head.appendChild(ar);
		};
		document.head.appendChild(script);
	}

	if (!window.MathJax && !document.getElementById('mathjax-script')) {
		window.MathJax = {
			tex: {
				inlineMath:  [['$', '$'], ['\\(', '\\)']],
				displayMath: [['$$', '$$'], ['\\[', '\\]']],
				processEscapes: true,
				processEnvironments: true,
				packages: { '[+]': ['boldsymbol', 'amscd', 'color', 'action', 'newcommand'] },
				tags: 'ams',
			},
			svg: { fontCache: 'global' },
			options: {
				skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
				processHtmlClass: 'tex2jax_process',
				ignoreHtmlClass: 'tex2jax_ignore',
			},
			startup: { typeset: false },
		};
		const mj = document.createElement('script');
		mj.id = 'mathjax-script';
		mj.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
		mj.async = true;
		document.head.appendChild(mj);
	}
})();

// ─── Regex constants ──────────────────────────────────────────────────────────

/** Matches fenced code blocks (triple-backtick or single-backtick inline). */
export const CODE_BLOCK_REGEX = /(```[\s\S]*?```|`[^`\n]+`)/g;

const MATH_ENV_NAMES = [
	'equation', 'equation\\*', 'align', 'align\\*', 'gather', 'gather\\*',
	'multline', 'multline\\*', 'flalign', 'flalign\\*', 'alignat', 'alignat\\*',
	'eqnarray', 'eqnarray\\*', 'subequations', 'split', 'displaymath', 'math',
	'bmatrix', 'bmatrix\\*', 'pmatrix', 'pmatrix\\*', 'vmatrix', 'vmatrix\\*',
	'Vmatrix', 'Vmatrix\\*', 'Bmatrix', 'Bmatrix\\*', 'matrix', 'matrix\\*',
	'smallmatrix', 'cases', 'dcases', 'rcases',
].join('|');

export const MATH_REGEX = new RegExp(
	'\\$\\$[\\s\\S]*?\\$\\$' +
	'|\\\\\\[[\\s\\S]*?\\\\\\]' +
	'|\\\\\\([\\s\\S]*?\\\\\\)' +
	'|(?<!\$)\$(?!\$)(?:\\\\.|[^\n$])+?(?<!\s)\$(?!\$)' +
	'|\\\\begin\\{(' + MATH_ENV_NAMES + ')(?:\\{[^}]*\\})?\\}[\\s\\S]*?\\\\end\\{\\1(?:\\*)?\\}',
	'g'
);

// ─── Internal helpers ─────────────────────────────────────────────────────────

export function escapeHtml(text) {
	if (!text) return '';
	return String(text)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;')
		.replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isExternalUrl(url) {
	if (!url || typeof url !== 'string') return false;
	const t = url.trim();
	return t.startsWith('https://') || t.startsWith('http://');
}

export function resolveEntryHref(entry) {
	if (!entry) return null;
	const doi = entry.doi || '';
	if (doi) {
		const full = doi.startsWith('http') ? doi : 'https://doi.org/' + doi;
		if (isExternalUrl(full)) return full;
	}
	if (isExternalUrl(entry.url || '')) return entry.url;
	return null;
}

function isDisplayMode(match) {
	if (match.startsWith('$$'))  return true;
	if (match.startsWith('\\[')) return true;
	if (/^\\begin\{(?:displaymath|equation|align|gather|multline|flalign|alignat|eqnarray|subequations|split|[bpvVB]?matrix|smallmatrix|cases|dcases|rcases)/.test(match)) return true;
	if (match.startsWith('\\begin{math}')) return false;
	return false;
}

function extractMathContent(match) {
	if (match.startsWith('$$'))  return match.slice(2, -2);
	if (match.startsWith('\\[')) return match.slice(2, -2);
	if (match.startsWith('\\(')) return match.slice(2, -2);
	if (match.startsWith('$'))   return match.slice(1, -1);
	return match;
}

// ─── normaliseMathDelimiters ──────────────────────────────────────────────────

export function normaliseMathDelimiters(text) {
	if (!text) return '';
	let t = text;

	// Rescue citation commands that AI models sometimes wrap in $...$
	t = t.replace(
		/\$\s*(\\(?:cite[a-zA-Z]*|textcite|Textcite|parencite|Parencite|autocite|Autocite|fullcite|footcite|footcitetext|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^}]+\})\s*\$/g,
		(_, inner) => inner.trim()
	);

	t = t.replace(
		/(^|\n)([ \t]*)\$[ \t]*\n([\s\S]+?)\n([ \t]*)\$[ \t]*(?=\n|$)/g,
		(full, pre, _indent, inner, _indent2) => {
			if (/^\$/.test(inner.trimStart()) || /\$$/.test(inner.trimEnd())) return full;
			return `${pre}\n$$\n${inner}\n$$`;
		}
	);
	t = t.replace(/(^|\n)[ \t]*\$[ \t]*\n([^\n$]+)\n[ \t]*\$[ \t]*(?=\n|$)/g,
		(_, pre, inner) => `${pre}\n$$${inner.trim()}$$`
	);
	t = t.replace(/\$\$[ \t]*\n([\s\S]*?)[ \t]*\n[ \t]*\$\$/g, (_, inner) => `$$\n${inner.trim()}\n$$`);
	t = t.replace(/\\\[\s*\n/g, '\\[\n').replace(/\n\s*\\\]/g, '\n\\]');
	t = t.replace(/\\\(\s*\n/g, '\\(').replace(/\n\s*\\\)/g, '\\)');
	t = t.replace(/\u2032/g, "'").replace(/\u2212/g, '-');
	return t;
}

// ─── extractMath ─────────────────────────────────────────────────────────────
// Shields all math blocks from the Markdown parser using opaque placeholders.

export function extractMath(text) {
	if (!text) return { text: '', mathBlocks: [] };

	text = normaliseMathDelimiters(text);

	const codeBlocks = [];
	let ci = 0;
	let safe = text.replace(CODE_BLOCK_REGEX, (m) => {
		const ph = `⚿CODEBLOCK${ci}⚿`;
		codeBlocks.push({ ph, m });
		ci++;
		return ph;
	});

	const mathBlocks = [];
	let mi = 0;
	safe = safe.replace(MATH_REGEX, (match) => {
		const ph = `⚿MATHBLOCK${mi}⚿`;
		const isBlock = isDisplayMode(match);
		const content = extractMathContent(match);
		mathBlocks.push({ placeholder: ph, content, isBlock, rawMatch: match });
		mi++;
		return ph;
	});

	for (const { ph, m } of codeBlocks) safe = safe.replace(ph, m);
	return { text: safe, mathBlocks };
}

// ─── injectMath ──────────────────────────────────────────────────────────────
// Replaces placeholders produced by extractMath with rendered KaTeX/MathJax HTML.

const KATEX_MACROS = {
	'\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}',
	'\\Q': '\\mathbb{Q}', '\\C': '\\mathbb{C}', '\\F': '\\mathbb{F}',
	'\\P': '\\mathbb{P}', '\\E': '\\mathbb{E}',
	'\\eps': '\\varepsilon', '\\ph': '\\varphi',
	'\\T': '^{\\top}', '\\inv': '^{-1}',
	'\\abs': '\\left|#1\\right|', '\\norm': '\\left\\|#1\\right\\|',
	'\\set': '\\left\\{#1\\right\\}', '\\ceil': '\\left\\lceil#1\\right\\rceil',
	'\\floor': '\\left\\lfloor#1\\right\\rfloor',
	'\\d': '\\,\\mathrm{d}', '\\diff': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
	'\\pdiff': '\\frac{\\partial #1}{\\partial #2}',
	'\\tfrac': '\\frac{#1}{#2}', '\\bm': '\\boldsymbol', '\\1': '\\mathbf{1}',
	'\\tr': '\\operatorname{tr}', '\\rank': '\\operatorname{rank}',
	'\\diag': '\\operatorname{diag}', '\\sign': '\\operatorname{sign}',
	'\\Var': '\\operatorname{Var}', '\\Cov': '\\operatorname{Cov}',
	'\\KL': 'D_{\\mathrm{KL}}',
	'\\coloneqq': '\\mathrel{:=}', '\\eqqcolon': '\\mathrel{=:}',
};

export function injectMath(html, mathBlocks) {
	if (!mathBlocks || mathBlocks.length === 0) return html;
	let result = html;

	for (const { placeholder, content, isBlock, rawMatch } of mathBlocks) {
		let rendered = '';
		try {
			if (window.katex) {
				rendered = window.katex.renderToString(content, {
					displayMode: isBlock, throwOnError: false, trust: true,
					strict: false, output: 'htmlAndMathml', leqno: false, fleqn: false,
					macros: { ...KATEX_MACROS },
				});
			} else if (window.MathJax && window.MathJax.tex2svg) {
				const node = window.MathJax.tex2svg(content, { display: isBlock });
				rendered = node.outerHTML || escapeHtml(rawMatch || content);
			} else {
				const cls = isBlock ? 'latex-block latex-pending' : 'latex-inline latex-pending';
				rendered = `<span class="${cls}" data-latex="${escapeHtml(content)}">${escapeHtml(rawMatch || content)}</span>`;
			}
		} catch (err) {
			const cls = isBlock ? 'latex-block latex-error' : 'latex-inline latex-error';
			rendered = `<span class="${cls}" title="${escapeHtml(err.message)}">${escapeHtml(rawMatch || content)}</span>`;
		}

		if (isBlock && rendered) rendered = `<div class="latex-display-wrapper">${rendered}</div>`;
		result = result.replace(placeholder, rendered);
	}

	return result;
}

// ─── retryPendingMath ─────────────────────────────────────────────────────────
// Re-renders any .latex-pending elements once MathJax has loaded.

export async function retryPendingMath(containerEl = document.body) {
	if (!containerEl) return;
	const pending = Array.from(containerEl.querySelectorAll('.latex-pending[data-latex]'));
	if (pending.length === 0) return;

	let waited = 0;
	while ((!window.MathJax || !window.MathJax.tex2svg) && waited < 5000) {
		await new Promise(r => setTimeout(r, 200));
		waited += 200;
	}
	if (!window.MathJax || !window.MathJax.tex2svg) return;

	for (const el of pending) {
		const src = el.dataset.latex || '';
		const isDisp = el.classList.contains('latex-block');
		try {
			const node = window.MathJax.tex2svg(src, { display: isDisp });
			el.replaceWith(node);
		} catch (_) { /* leave as-is */ }
	}
}
