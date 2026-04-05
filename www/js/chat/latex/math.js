// www/js/chat/latex/math.js
// Handles math delimiter normalisation, placeholder extraction, and KaTeX/MathJax rendering.

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
				inlineMath: [['$', '$'], ['\\(', '\\)']],
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
	'|(?<!\\$)\\$(?!\\$)(?:\\\\.|[^\\n$])+?(?<!\\s)\\$(?!\\$)' +
	'|\\\\begin\\{(' + MATH_ENV_NAMES + ')(?:\\{[^}]*\\})?\\}[\\s\\S]*?\\\\end\\{\\1(?:\\*)?\\}',
	'g'
);

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
	if (match.startsWith('$$')) return true;
	if (match.startsWith('\\[')) return true;
	if (/^\\begin\{(?:displaymath|equation|align|gather|multline|flalign|alignat|eqnarray|subequations|split|[bpvVB]?matrix|smallmatrix|cases|dcases|rcases)/.test(match)) return true;
	if (match.startsWith('\\begin{math}')) return false;
	return false;
}

function extractMathContent(match) {
	if (match.startsWith('$$')) return match.slice(2, -2);
	if (match.startsWith('\\[')) return match.slice(2, -2);
	if (match.startsWith('\\(')) return match.slice(2, -2);
	if (match.startsWith('$')) return match.slice(1, -1);
	return match;
}

export function normaliseMathDelimiters(text) {
	if (!text) return '';
	let t = text;
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

export function extractMath(text) {
	if (!text) return { text: '', mathBlocks: [] };
	text = normaliseMathDelimiters(text);
	const codeBlocks = [];
	let ci = 0;
	let safe = text.replace(CODE_BLOCK_REGEX, (m) => {
		const ph = `\u26FFCODEBLOCK${ci}\u26FF`;
		codeBlocks.push({ ph, m });
		ci++;
		return ph;
	});
	const mathBlocks = [];
	let mi = 0;
	safe = safe.replace(MATH_REGEX, (match) => {
		const ph = `\u26FFMATHBLOCK${mi}\u26FF`;
		const isBlock = isDisplayMode(match);
		const content = extractMathContent(match);
		mathBlocks.push({ placeholder: ph, content, isBlock, rawMatch: match });
		mi++;
		return ph;
	});
	for (const { ph, m } of codeBlocks) safe = safe.replace(ph, m);
	return { text: safe, mathBlocks };
}

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

// ─── xparse / NewDocumentCommand support ──────────────────────────────────────

function matchBraceContent(source, start) {
	if (source[start] !== '{') return null;
	let depth = 0, i = start;
	while (i < source.length) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return { content: source.slice(start + 1, i), end: i };
		}
		i++;
	}
	return null;
}

function matchBracketContent(source, start) {
	if (source[start] !== '[') return null;
	let depth = 0, i = start;
	while (i < source.length) {
		if (source[i] === '[') depth++;
		else if (source[i] === ']') {
			depth--;
			if (depth === 0) return { content: source.slice(start + 1, i), end: i };
		}
		i++;
	}
	return null;
}

function findMacroBodyEnd(source, start) {
	let depth = 1, i = start + 1;
	while (i < source.length) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth <= 0) return i;
		}
		i++;
	}
	if (depth > 0) {
		i = start + 1;
		while (i < source.length) {
			if (source[i] === '}') {
				const prev = source[i - 1];
				if (prev === '\n' || prev === ' ' || prev === '\t' || i === start + 1) return i;
			}
			i++;
		}
	}
	return -1;
}

function stripLatexComments(text) {
	return text.split('\n').map(line => {
		let result = '';
		let inEscape = false;
		for (let i = 0; i < line.length; i++) {
			if (inEscape) { result += line[i]; inEscape = false; continue; }
			if (line[i] === '\\') { result += line[i]; inEscape = true; continue; }
			if (line[i] === '%') break;
			result += line[i];
		}
		return result;
	}).join('\n');
}

function extractBracedArg(source, start) {
	if (start >= source.length || source[start] !== '{') return null;
	let depth = 0, i = start;
	while (i < source.length) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return { content: source.slice(start + 1, i), end: i };
		}
		i++;
	}
	return null;
}

function processIfNoValueTF(text) {
	const rx = /\\IfNoValueTF/g;
	let result = '';
	let lastEnd = 0;
	let m;
	while ((m = rx.exec(text)) !== null) {
		result += text.slice(lastEnd, m.index);
		const afterCmd = m.index + m[0].length;
		const condArg = extractBracedArg(text, afterCmd);
		if (condArg) {
			const argVal = condArg.content;
			const afterCond = condArg.end + 1;
			const trueArg = extractBracedArg(text, afterCond);
			if (trueArg) {
				const falseArg = extractBracedArg(text, trueArg.end + 1);
				if (falseArg) {
					result += (argVal === '-NoValue-') ? trueArg.content : falseArg.content;
					lastEnd = falseArg.end + 1;
				} else { result += m[0] + condArg.content + '{'; lastEnd = afterCond + 1; }
			} else { result += m[0] + condArg.content + '{'; lastEnd = afterCond + 1; }
		} else { result += m[0]; lastEnd = afterCmd; }
	}
	result += text.slice(lastEnd);
	return result;
}

function processIfValueTF(text) {
	const rx = /\\IfValueTF/g;
	let result = '';
	let lastEnd = 0;
	let m;
	while ((m = rx.exec(text)) !== null) {
		result += text.slice(lastEnd, m.index);
		const afterCmd = m.index + m[0].length;
		const condArg = extractBracedArg(text, afterCmd);
		if (condArg) {
			const argVal = condArg.content;
			const afterCond = condArg.end + 1;
			const trueArg = extractBracedArg(text, afterCond);
			if (trueArg) {
				const falseArg = extractBracedArg(text, trueArg.end + 1);
				if (falseArg) {
					result += (argVal !== '-NoValue-') ? trueArg.content : falseArg.content;
					lastEnd = falseArg.end + 1;
				} else { result += m[0] + condArg.content + '{'; lastEnd = afterCond + 1; }
			} else { result += m[0] + condArg.content + '{'; lastEnd = afterCond + 1; }
		} else { result += m[0]; lastEnd = afterCmd; }
	}
	result += text.slice(lastEnd);
	return result;
}

function cleanMacroBody(text) {
	let cleaned = stripLatexComments(text);
	cleaned = cleaned.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
	let depth = 0;
	for (const ch of cleaned) {
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
	}
	if (depth > 0) cleaned += '}'.repeat(depth);
	return cleaned.trim();
}

function extractNewDocumentCommands(source) {
	const commands = [];
	const rx = /\\NewDocumentCommand\s*/g;
	let m;
	while ((m = rx.exec(source)) !== null) {
		let pos = m.index + m[0].length;
		if (pos >= source.length || source[pos] !== '{') continue;
		const nameMatch = matchBraceContent(source, pos);
		if (!nameMatch) continue;
		const name = nameMatch.content.trim();
		pos = nameMatch.end + 1;
		while (pos < source.length && /\s/.test(source[pos])) pos++;
		if (pos >= source.length || source[pos] !== '{') continue;
		const specMatch = matchBraceContent(source, pos);
		if (!specMatch) continue;
		const spec = specMatch.content.trim();
		pos = specMatch.end + 1;
		while (pos < source.length && /\s/.test(source[pos])) pos++;
		if (pos >= source.length || source[pos] !== '{') continue;
		const bodyEnd = findMacroBodyEnd(source, pos);
		if (bodyEnd === -1) continue;
		const body = cleanMacroBody(source.slice(pos + 1, bodyEnd));
		commands.push({ name, spec, body });
	}
	return commands;
}

function parseArgSpec(argSpec) {
	const args = [];
	let i = 0;
	while (i < argSpec.length) {
		if (argSpec[i] === 'm') { args.push({ type: 'm' }); i++; }
		else if (argSpec[i] === 'O') {
			const m = matchBraceContent(argSpec, i + 1);
			if (m) { args.push({ type: 'O', default: m.content }); i = m.end + 1; }
			else { i++; }
		}
		else if (argSpec[i] === 'o') { args.push({ type: 'o', default: '-NoValue-' }); i++; }
		else if (argSpec[i] === 's') { args.push({ type: 's' }); i++; }
		else { i++; }
	}
	return args;
}

function expandMacroCall(body, callArgs, args) {
	const optCallArgs = [];
	const mandCallArgs = [];
	for (const arg of callArgs) {
		if (arg.startsWith('[') && arg.endsWith(']')) {
			optCallArgs.push(arg.slice(1, -1));
		} else {
			let val = arg;
			if (val.startsWith('{') && val.endsWith('}')) val = val.slice(1, -1);
			mandCallArgs.push(val);
		}
	}
	const filledArgs = [];
	let optIdx = 0, mandIdx = 0;
	for (let i = 0; i < args.length; i++) {
		if (args[i].type === 'O' || args[i].type === 'o') {
			if (optIdx < optCallArgs.length) {
				filledArgs.push(optCallArgs[optIdx++]);
			} else {
				filledArgs.push(args[i].type === 'O' ? args[i].default : '-NoValue-');
			}
		} else {
			if (mandIdx < mandCallArgs.length) {
				filledArgs.push(mandCallArgs[mandIdx++]);
			} else {
				filledArgs.push('');
			}
		}
	}
	let result = body;
	for (let i = filledArgs.length; i >= 1; i--) {
		result = result.split('#' + i).join(filledArgs[i - 1] || '');
	}
	result = processIfNoValueTF(result);
	result = processIfValueTF(result);
	result = result.replace(/\\IfNoValueT\{[^}]*\}\{[^}]*\}/g, '');
	result = result.replace(/\\IfValueT\{[^}]*\}\{[^}]*\}/g, '');
	result = result.replace(/\\IfNoValueF\{[^}]*\}\{[^}]*\}/g, '');
	result = result.replace(/\\IfValueF\{[^}]*\}\{[^}]*\}/g, '');
	return result.trim();
}

function inlineMacroCalls(content, commands) {
	let result = content;
	for (const { name, spec, body } of commands) {
		const args = parseArgSpec(spec);
		const totalArgs = args.length;
		const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const rx = new RegExp(escapedName, 'g');
		let m;
		const replacements = [];
		while ((m = rx.exec(result)) !== null) {
			const callStart = m.index + m[0].length;
			const callArgs = extractCallArgs(result, callStart, totalArgs);
			if (callArgs && callArgs.args.length >= 1) {
				const expanded = expandMacroCall(body, callArgs.args, args);
				replacements.push({ start: m.index, end: callArgs.end, replacement: expanded });
			}
		}
		for (let i = replacements.length - 1; i >= 0; i--) {
			const r = replacements[i];
			result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
		}
	}
	return result;
}

function extractCallArgs(source, start, expectedCount) {
	const args = [];
	let pos = start;
	while (pos < source.length && /\s/.test(source[pos])) pos++;
	while (pos < source.length && args.length < expectedCount) {
		if (source[pos] === '{') {
			const m = matchBraceContent(source, pos);
			if (m) { args.push('{' + m.content + '}'); pos = m.end + 1; }
			else break;
		} else if (source[pos] === '[') {
			const m = matchBracketContent(source, pos);
			if (m) { args.push('[' + m.content + ']'); pos = m.end + 1; }
			else break;
		} else if (args.length < expectedCount - 1) {
			break;
		} else {
			const rest = source.slice(pos).trimEnd();
			if (rest) { args.push(rest); pos = source.length; }
			break;
		}
	}
	if (args.length === 0) return null;
	return { args, end: pos };
}

// ─── renderLatexCodeblock ─────────────────────────────────────────────────────

export function renderLatexCodeblock(code) {
	if (!code || !code.trim()) return escapeHtml(code);

	const xparseCommands = extractNewDocumentCommands(code);

	const mathBlocks = [];
	let mi = 0;
	let safe = code.replace(MATH_REGEX, (match) => {
		const ph = `\u26FFLATEXCODEMATH${mi}\u26FF`;
		const isBlock = isDisplayMode(match);
		const content = extractMathContent(match);
		mathBlocks.push({ placeholder: ph, content, isBlock, rawMatch: match });
		mi++;
		return ph;
	});

	for (let bi = 0; bi < mathBlocks.length; bi++) {
		mathBlocks[bi].content = inlineMacroCalls(mathBlocks[bi].content, xparseCommands);
	}

	safe = escapeHtml(safe);

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
		safe = safe.replace(escapeHtml(placeholder), rendered);
	}

	return safe;
}

// ─── retryPendingMath ─────────────────────────────────────────────────────────

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
