/**
 * Comprehensive LaTeX math & structural renderer (v3)
 *
 * Math delimiter support (all common variants models/editors produce):
 *   Inline  : $...$   \(...\)   \begin{math}...\end{math}
 *   Display : $$...$$ \[...\]   \begin{displaymath}...\end{displaymath}
 *   Envs    : equation(*), align(*), gather(*), multline(*), flalign(*),
 *             alignat(*){n}, eqnarray(*), subequations, split,
 *             matrix / bmatrix / pmatrix / vmatrix / Vmatrix / Bmatrix /
 *             smallmatrix, cases / dcases / rcases
 *
 * Text-mode structural support:
 *   • Preamble / document metadata
 *   • Theorem-class environments (theorem, lemma, corollary, proposition,
 *     definition, remark, example, axiom, conjecture, hypothesis,
 *     observation, notation, claim, exercise, problem, solution, fact)
 *   • Proof environment (with QED box)
 *   • Abstract
 *   • Algorithm / algorithmic / algorithm2e pseudocode
 *   • Beamer frames
 *   • TikZ / pgfplots / pgfpicture (source preview)
 *   • Tables: tabular / tabularx / longtable / booktabs
 *   • Lists: itemize / enumerate / description / compactitem /
 *     compactenum / tasks / checklist
 *   • Quote environments: quote / quotation / verse
 *   • Verbatim: verbatim / lstlisting / minted / Verbatim
 *   • Figure / table float wrappers
 *   • Sectioning: \part → \subparagraph
 *   • Inline formatting: bf, it, emph, underline, strikeout, sc, tt,
 *     rm, sf, md, up, sl + nested-braces fallback
 *   • Font size commands
 *   • Color: \textcolor, \colorbox, \fcolorbox, \color{...}
 *   • Boxes: \fbox, \mbox, \framebox, \boxed, \parbox, \raisebox
 *   • Spacing: \vspace, \hspace, \medskip, \bigskip, \smallskip, \noindent
 *   • Typography: \ldots/\dots/\cdots, \textquoteleft/right,
 *     \enquote, \guillemets, ligature replacements (-- / --- / ~)
 *   • Special escaped characters: \& \% \$ \# \_ \{ \}  \^ \~
 *   • Hyperlinks: \url, \href
 *   • Footnotes: \footnote
 *   • Cross-references: \label, \ref, \eqref, \pageref, \nameref, \autoref
 *   • Citations: \cite, \citet, \citep, \citeauthor, \citeyear, \citeyearpar,
 *     \citealt, \nocite — full natbib & BibLaTeX suite
 *   • BibTeX support (v3): robust multi-level brace parser, @string/@comment/
 *     @preamble support, #-concatenation, 18+ entry types with per-type
 *     academic formatting, multiple styles (plain, ieee, alpha, authoryear,
 *     apa, chicago, harvard, mla, vancouver), anchor navigation, interactive
 *     hover tooltips, auto-bibliography generation, ```bibtex code block
 *     interception, \addbibresource, \bibliographystyle, pre/post notes,
 *     thebibliography/\bibitem environment, DOI/URL links, type badges
 *   • Misc: \maketitle, \tableofcontents, \listoffigures, \listoftables,
 *     \appendix, \bibliography, \printbibliography, \newpage, \clearpage,
 *     \linebreak, \nolinebreak, \pagebreak, \par, \indent, \centering,
 *     \raggedright, \raggedleft, \justify, \rule, \hrule, \vline, \today
 *
 * Rendering:
 *   • KaTeX (preferred) — dynamically injected if not already loaded
 *   • MathJax 3 (auto-fallback if KaTeX not available after wait)
 *   • Plain <span> fallback (always safe)
 */

// ─────────────────────────────────────────────────────────────────────────────
// KaTeX + MathJax dynamic injection
// ─────────────────────────────────────────────────────────────────────────────

(function initMathRenderers() {
	if (typeof window === 'undefined') return;

	// ── KaTeX ──────────────────────────────────────────────────────────────
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

	// ── MathJax 3 (fallback) ───────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared Regex Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Matches fenced code blocks (triple-backtick or single-backtick inline). */
const CODE_BLOCK_REGEX = /(```[\s\S]*?```|`[^`\n]+`)/g;

const MATH_ENV_NAMES = [
	'equation', 'equation\\*',
	'align', 'align\\*',
	'gather', 'gather\\*',
	'multline', 'multline\\*',
	'flalign', 'flalign\\*',
	'alignat', 'alignat\\*',
	'eqnarray', 'eqnarray\\*',
	'subequations',
	'split',
	'displaymath',
	'math',
	'bmatrix', 'bmatrix\\*',
	'pmatrix', 'pmatrix\\*',
	'vmatrix', 'vmatrix\\*',
	'Vmatrix', 'Vmatrix\\*',
	'Bmatrix', 'Bmatrix\\*',
	'matrix',  'matrix\\*',
	'smallmatrix',
	'cases', 'dcases', 'rcases',
].join('|');

const MATH_REGEX = new RegExp(
	'\\$\\$[\\s\\S]*?\\$\\$' +
	'|\\\\\\[[\\s\\S]*?\\\\\\]' +
	'|\\\\\\([\\s\\S]*?\\\\\\)' +
	'|(?<!\$)\$(?!\$)(?:\\\\.|[^\n$])+?(?<!\s)\$(?!\$)' +
	'|\\\\begin\\{(' + MATH_ENV_NAMES + ')(?:\\{[^}]*\\})?\\}[\\s\\S]*?\\\\end\\{\\1(?:\\*)?\\}',
	'g'
);

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(text) {
	if (!text) return '';
	return String(text)
		.replace(/&/g,  '&amp;')
		.replace(/</g,  '&lt;')
		.replace(/>/g,  '&gt;')
		.replace(/"/g,  '&quot;')
		.replace(/'/g,  '&#39;');
}

// Returns true only for absolute http/https URLs — anything else (relative
// paths, bare anchors, doi: URIs without a protocol, etc.) is considered
// invalid for opening in a new tab and must NOT be used as an href.
function isExternalUrl(url) {
	if (!url || typeof url !== 'string') return false;
	const t = url.trim();
	return t.startsWith('https://') || t.startsWith('http://');
}

// Resolve a raw doi or url field into a full https URL, or null if neither
// is a valid external link.
function resolveEntryHref(entry) {
	if (!entry) return null;
	const doi = entry.doi || '';
	if (doi) {
		const full = doi.startsWith('http') ? doi : 'https://doi.org/' + doi;
		if (isExternalUrl(full)) return full;
	}
	const url = entry.url || '';
	if (isExternalUrl(url)) return url;
	return null;
}

function isDisplayMode(match) {
	if (match.startsWith('$$'))            return true;
	if (match.startsWith('\\['))           return true;
	if (/^\\begin\{(?:displaymath|equation|align|gather|multline|flalign|alignat|eqnarray|subequations|split|[bpvVB]?matrix|smallmatrix|cases|dcases|rcases)/.test(match)) return true;
	if (match.startsWith('\\begin{math}')) return false;
	return false;
}

function extractMathContent(match) {
	if (match.startsWith('$$'))   return match.slice(2, -2);
	if (match.startsWith('\\['))  return match.slice(2, -2);
	if (match.startsWith('\\('))  return match.slice(2, -2);
	if (match.startsWith('$'))    return match.slice(1, -1);
	return match;
}

// ─────────────────────────────────────────────────────────────────────────────
// Algorithm formatter
// ─────────────────────────────────────────────────────────────────────────────

function formatAlgorithmic(content) {
	const lines = content.split('\n');
	let html = '<div class="latex-algorithm">';
	let indentLevel = 0;

	for (let raw of lines) {
		let line = raw.trim();
		if (!line) continue;

		if (/^\\(EndIf|EndFor|EndWhile|EndFunction|EndProcedure|Until|Else|ElsIf|Elsif|uElse|uElsIf)\b/.test(line)) {
			indentLevel = Math.max(0, indentLevel - 1);
		}

		const pad = indentLevel * 20;

		line = line.replace(/\\KwData\s*\{([^}]+)\}/g,    '<span class="alg-keyword">Input:</span> $1');
		line = line.replace(/\\KwResult\s*\{([^}]+)\}/g,  '<span class="alg-keyword">Output:</span> $1');
		line = line.replace(/\\KwIn\s*\{([^}]+)\}/g,      '<span class="alg-keyword">Input:</span> $1');
		line = line.replace(/\\KwOut\s*\{([^}]+)\}/g,     '<span class="alg-keyword">Output:</span> $1');
		line = line.replace(/\\KwRet\s*\{([^}]+)\}/g,     '<span class="alg-keyword">return</span> $1');
		line = line.replace(/\\Return\b/g,                 '<span class="alg-keyword">return</span>');
		line = line.replace(/\\eIf\s*\{([^}]+)\}/g,       '<span class="alg-keyword">if</span> $1 <span class="alg-keyword">then</span>');
		line = line.replace(/\\uIf\s*\{([^}]+)\}/g,       '<span class="alg-keyword">if</span> $1 <span class="alg-keyword">then</span>');
		line = line.replace(/\\lIf\s*\{([^}]+)\}\s*\{([^}]+)\}/g, '<span class="alg-keyword">if</span> $1 <span class="alg-keyword">then</span> $2');
		line = line.replace(/\\uElse\b/g,                  '<span class="alg-keyword">else</span>');
		line = line.replace(/\\lElse\s*\{([^}]+)\}/g,     '<span class="alg-keyword">else</span> $1');
		line = line.replace(/\\ForEach\s*\{([^}]+)\}/g,   '<span class="alg-keyword">foreach</span> $1 <span class="alg-keyword">do</span>');
		line = line.replace(/\\ForAll\s*\{([^}]+)\}/g,    '<span class="alg-keyword">for all</span> $1 <span class="alg-keyword">do</span>');
		line = line.replace(/\\Repeat\b/g,                 '<span class="alg-keyword">repeat</span>');
		line = line.replace(/\\State\s*/g,                 '<span class="alg-keyword"></span>');
		line = line.replace(/\\Statex\s*/g,                '<span class="alg-keyword"></span>');
		line = line.replace(/\\Require\s*/g,               '<span class="alg-keyword">Require:</span> ');
		line = line.replace(/\\Ensure\s*/g,                '<span class="alg-keyword">Ensure:</span> ');
		line = line.replace(/\\If\s*\{([^}]+)\}/g,        '<span class="alg-keyword">if</span> $1 <span class="alg-keyword">then</span>');
		line = line.replace(/\\ElsIf\s*\{([^}]+)\}/g,     '<span class="alg-keyword">else if</span> $1 <span class="alg-keyword">then</span>');
		line = line.replace(/\\Elsif\s*\{([^}]+)\}/g,     '<span class="alg-keyword">else if</span> $1 <span class="alg-keyword">then</span>');
		line = line.replace(/\\Else\b/g,                   '<span class="alg-keyword">else</span>');
		line = line.replace(/\\EndIf\b/g,                  '<span class="alg-keyword">end if</span>');
		line = line.replace(/\\For\s*\{([^}]+)\}/g,       '<span class="alg-keyword">for</span> $1 <span class="alg-keyword">do</span>');
		line = line.replace(/\\EndFor\b/g,                 '<span class="alg-keyword">end for</span>');
		line = line.replace(/\\While\s*\{([^}]+)\}/g,     '<span class="alg-keyword">while</span> $1 <span class="alg-keyword">do</span>');
		line = line.replace(/\\EndWhile\b/g,               '<span class="alg-keyword">end while</span>');
		line = line.replace(/\\Until\s*\{([^}]+)\}/g,     '<span class="alg-keyword">until</span> $1');
		line = line.replace(/\\Loop\b/g,                   '<span class="alg-keyword">loop</span>');
		line = line.replace(/\\EndLoop\b/g,                '<span class="alg-keyword">end loop</span>');
		line = line.replace(/\\Function\s*\{([^}]+)\}\s*\{([^}]*)\}/g, '<span class="alg-keyword">function</span> $1($2)');
		line = line.replace(/\\EndFunction\b/g,            '<span class="alg-keyword">end function</span>');
		line = line.replace(/\\Procedure\s*\{([^}]+)\}\s*\{([^}]*)\}/g, '<span class="alg-keyword">procedure</span> $1($2)');
		line = line.replace(/\\EndProcedure\b/g,           '<span class="alg-keyword">end procedure</span>');
		line = line.replace(/\\Call\s*\{([^}]+)\}\s*\{([^}]*)\}/g, '<span class="alg-function">$1</span>($2)');
		line = line.replace(/\\Comment\s*\{([^}]+)\}/g,   '<span class="alg-comment">▷ $1</span>');
		line = line.replace(/\\tcp\*?\{([^}]+)\}/g,        '<span class="alg-comment">// $1</span>');

		html += `<div class="alg-line" style="padding-left:${pad}px">${line}</div>`;

		if (/class="alg-keyword">(if|else if|else|for|foreach|for all|while|loop|repeat|function|procedure)\b/.test(line)) {
			indentLevel++;
		}
	}

	html += '</div>';
	return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table formatter
// ─────────────────────────────────────────────────────────────────────────────

function formatTabular(body, isLong = false) {
	let clean = body
		.replace(/\\toprule(\[.*?\])?/g,  '')
		.replace(/\\midrule(\[.*?\])?/g,  '')
		.replace(/\\bottomrule(\[.*?\])?/g, '')
		.replace(/\\hline/g,              '')
		.replace(/\\cline\{[\d-]+\}/g,    '')
		.replace(/\\cmidrule(\(.*?\))?\{[\d-]+\}/g, '')
		.replace(/\\specialrule\{.*?\}\{.*?\}\{.*?\}/g, '');

	clean = clean.replace(/\\rowcolor(\[.*?\])?\{[^}]*\}/g, '');
	clean = clean.replace(/\\cellcolor(\[.*?\])?\{[^}]*\}/g, '');

	const rows = clean.split('\\\\').filter(r => r.trim());
	const cls = isLong ? 'latex-table longtable' : 'latex-table';
	let html = `<div class="latex-table-wrapper"><table class="${cls}"><tbody>`;

	for (const row of rows) {
		html += '<tr>';
		const cells = row.split(/(?<!\\)&/);

		for (let cell of cells) {
			cell = cell.trim();
			let colspan = 1, rowspan = 1, align = '';

			const mcM = cell.match(/^\\multicolumn\{(\d+)\}\{([^}]*)\}\{([\s\S]*)\}$/);
			if (mcM) {
				colspan = parseInt(mcM[1], 10);
				align   = mcM[2].includes('c') ? 'center' : mcM[2].includes('r') ? 'right' : 'left';
				cell    = mcM[3];
			}

			const mrM = cell.match(/^\\multirow\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
			if (mrM) {
				rowspan = parseInt(mrM[1], 10);
				cell    = mrM[2];
			}

			cell = applyInlineFormatting(cell);

			let attrs = '';
			if (colspan > 1) attrs += ` colspan="${colspan}"`;
			if (rowspan > 1) attrs += ` rowspan="${rowspan}"`;
			if (align)       attrs += ` style="text-align:${align}"`;

			html += `<td${attrs}>${cell}</td>`;
		}

		html += '</tr>';
	}

	html += '</tbody></table></div>';
	return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline LaTeX formatting helper
// ─────────────────────────────────────────────────────────────────────────────

function applyInlineFormatting(text) {
	text = text.replace(/\\textbf\{([^}]+)\}/g,      '<strong>$1</strong>');
	text = text.replace(/\\textit\{([^}]+)\}/g,       '<em>$1</em>');
	text = text.replace(/\\emph\{([^}]+)\}/g,         '<em>$1</em>');
	text = text.replace(/\\textsl\{([^}]+)\}/g,       '<span style="font-style:oblique">$1</span>');
	text = text.replace(/\\textsc\{([^}]+)\}/g,       '<span style="font-variant:small-caps">$1</span>');
	text = text.replace(/\\texttt\{([^}]+)\}/g,       '<code>$1</code>');
	text = text.replace(/\\textrm\{([^}]+)\}/g,       '<span style="font-family:serif">$1</span>');
	text = text.replace(/\\textsf\{([^}]+)\}/g,       '<span style="font-family:sans-serif">$1</span>');
	text = text.replace(/\\textmd\{([^}]+)\}/g,       '<span style="font-weight:normal">$1</span>');
	text = text.replace(/\\textup\{([^}]+)\}/g,       '<span style="font-style:normal">$1</span>');
	text = text.replace(/\\textnormal\{([^}]+)\}/g,   '$1');
	text = text.replace(/\\underline\{([^}]+)\}/g,    '<u>$1</u>');
	text = text.replace(/\\sout\{([^}]+)\}/g,         '<s>$1</s>');
	text = text.replace(/\\xout\{([^}]+)\}/g,         '<s>$1</s>');
	text = text.replace(/\\uwave\{([^}]+)\}/g,        '<u style="text-decoration:underline wavy">$1</u>');

	text = text.replace(/\\textcolor\{([^}]+)\}\{([^}]+)\}/g,       '<span style="color:$1">$2</span>');
	text = text.replace(/\\colorbox\{([^}]+)\}\{([^}]+)\}/g,        '<span style="background:$1;padding:0 2px">$2</span>');
	text = text.replace(/\\fcolorbox\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, '<span style="border:1px solid $1;background:$2;padding:0 2px">$3</span>');

	text = text.replace(/\\fbox\{([^}]+)\}/g,         '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>');
	text = text.replace(/\\mbox\{([^}]+)\}/g,         '<span style="white-space:nowrap">$1</span>');
	text = text.replace(/\\framebox(?:\[.*?\])?\{([^}]+)\}/g, '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>');
	text = text.replace(/\\raisebox\{[^}]+\}\{([^}]+)\}/g,   '<span style="vertical-align:super;font-size:0.75em">$1</span>');

	text = text.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, (_, url, label) => {
		if (!isExternalUrl(url)) return escapeHtml(label);
		return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>';
	});
	text = text.replace(/\\url\{([^}]+)\}/g, (_, url) => {
		if (!isExternalUrl(url)) return '<code class="latex-url">' + escapeHtml(url) + '</code>';
		return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" class="latex-url">' + escapeHtml(url) + '</a>';
	});
	text = text.replace(/\\nolinkurl\{([^}]+)\}/g,         '<code class="latex-url">$1</code>');

	text = text.replace(/\\footnote\{([^}]+)\}/g,
		'<sup class="latex-footnote" title="$1">[note]</sup>');

	text = text.replace(/\\&/g,    '&amp;');
	text = text.replace(/\\%/g,    '%');
	text = text.replace(/\\\$/g,   '$');
	text = text.replace(/\\#/g,    '#');
	text = text.replace(/\\_/g,    '_');
	text = text.replace(/\\\{/g,   '{');
	text = text.replace(/\\\}/g,   '}');
	text = text.replace(/\\\^{}/g, '^');
	text = text.replace(/\\~{}/g,  '~');

	text = text.replace(/\\ldots\b/g,               '…');
	text = text.replace(/\\dots\b/g,                '…');
	text = text.replace(/\\cdots\b/g,               '⋯');
	text = text.replace(/\\vdots\b/g,               '⋮');
	text = text.replace(/\\ddots\b/g,               '⋱');
	text = text.replace(/---/g,                     '—');
	text = text.replace(/--/g,                      '–');
	text = text.replace(/``/g,                      '\u201C');
	text = text.replace(/''/g,                      '\u201D');
	text = text.replace(/`/g,                       '\u2018');
	text = text.replace(/\\textquoteleft\b/g,       '\u2018');
	text = text.replace(/\\textquoteright\b/g,      '\u2019');
	text = text.replace(/\\enquote\{([^}]+)\}/g,    '\u201C$1\u201D');
	text = text.replace(/\\guillemotleft\b/g,        '«');
	text = text.replace(/\\guillemotright\b/g,       '»');
	text = text.replace(/\\glqq\b/g,               '„');
	text = text.replace(/\\grqq\b/g,               '\u201D');
	text = text.replace(/\\glq\b/g,                '\u201A');
	text = text.replace(/\\grq\b/g,                '\u2018');
	text = text.replace(/\\tilde\{([^}]+)\}/g,      '$1\u0303');
	text = text.replace(/\\today\b/g,               new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));

	text = text.replace(/\\textregistered\b/g,  '®');
	text = text.replace(/\\texttrademark\b/g,   '™');
	text = text.replace(/\\copyright\b/g,       '©');
	text = text.replace(/\\dag\b/g,             '†');
	text = text.replace(/\\ddag\b/g,            '‡');
	text = text.replace(/\\S\b/g,               '§');
	text = text.replace(/\\P\b/g,               '¶');
	text = text.replace(/\\textbackslash\b/g,   '\\');
	text = text.replace(/\\textbar\b/g,         '|');
	text = text.replace(/\\slash\b/g,           '/');

	text = text.replace(/\\,/g,       '\u2009');
	text = text.replace(/\\;/g,       '\u2002');
	text = text.replace(/\\:/g,       '\u205F');
	text = text.replace(/\\!/g,       '');
	text = text.replace(/\\ /g,       '\u00A0');
	text = text.replace(/~(?!\w)/g,   '\u00A0');
	text = text.replace(/\\quad\b/g,  '\u2003');
	text = text.replace(/\\qquad\b/g, '\u2003\u2003');

	text = text.replace(/\\'([aeiouAEIOU])/g, (_, c) => c.normalize ? (c + '\u0301').normalize('NFC') : c);
	text = text.replace(/\\`([aeiouAEIOU])/g, (_, c) => (c + '\u0300').normalize('NFC'));
	text = text.replace(/\\"([aeiouAEIOU])/g, (_, c) => (c + '\u0308').normalize('NFC'));
	text = text.replace(/\\c\{([cC])\}/g, (_, c) => (c + '\u0327').normalize('NFC'));
	text = text.replace(/\\v\{([a-zA-Z])\}/g, (_, c) => (c + '\u030C').normalize('NFC'));

	text = text.replace(/\{\}/g, '');

	return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Callout factory helpers
// ─────────────────────────────────────────────────────────────────────────────

const CALLOUT_END = '\n\n</div></div>\n\n';

function makeCallout(type, icon, title) {
	return `\n\n<div class="md-callout md-callout-${type}"><div class="md-callout-header"><span class="md-callout-icon">${icon}</span><span class="md-callout-title">${escapeHtml(title)}</span></div><div class="md-callout-content">\n\n`;
}

const THEOREM_ENVS = [
	['theorem',       'info',       '🏛️',  'Theorem'],
	['lemma',         'tip',        '💡',  'Lemma'],
	['corollary',     'tip',        '📌',  'Corollary'],
	['proposition',   'info',       '📐',  'Proposition'],
	['definition',    'example',    '📖',  'Definition'],
	['remark',        'note',       '💬',  'Remark'],
	['note',          'note',       '📋',  'Note'],
	['example',       'example',    '🧪',  'Example'],
	['axiom',         'info',       '⚖️',  'Axiom'],
	['conjecture',    'warning',    '🔮',  'Conjecture'],
	['hypothesis',    'warning',    '🔬',  'Hypothesis'],
	['observation',   'note',       '👁️',  'Observation'],
	['notation',      'example',    '✏️',  'Notation'],
	['claim',         'info',       '📣',  'Claim'],
	['exercise',      'example',    '🏋️',  'Exercise'],
	['problem',       'warning',    '❓',  'Problem'],
	['solution',      'success',    '✅',  'Solution'],
	['fact',          'info',       '📌',  'Fact'],
	['assumption',    'warning',    '🔷',  'Assumption'],
	['criterion',     'info',       '📏',  'Criterion'],
	['assertion',     'info',       '📢',  'Assertion'],
	['property',      'tip',        '🔑',  'Property'],
	['condition',     'warning',    '🚦',  'Condition'],
	['question',      'warning',    '❓',  'Question'],
	['answer',        'success',    '💬',  'Answer'],
	['summary',       'note',       '📝',  'Summary'],
	['conclusion',    'success',    '🎯',  'Conclusion'],
	['case',          'note',       '🗂️',  'Case'],
];

// ─────────────────────────────────────────────────────────────────────────────
// preprocessLatexText — main text-mode LaTeX → HTML/Markdown converter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts structural (text-mode) LaTeX into clean Markdown + HTML that
 * the downstream Markdown parser and KaTeX injection can handle.
 *
 * Processing order is important:
 *  0. Pre-scan ```bibtex fenced blocks → populate DB before shielding
 *  1. Protect code blocks
 *  2. Protect math blocks
 *  3. Apply text-mode transformations
 *  4. Process bibliography (BibTeX)
 *  5. Restore math then code
 */
export function preprocessLatexText(text) {
	if (!text) return '';

	// ── Step -1: Rescue citation commands from $...$ math wrapping ──────────
	// AI models sometimes write  $ \cite{key} $  as a display example.
	// These are bibliography commands, not math — strip the dollars so they
	// are processed correctly by processBibliography in Step 4.
	text = text.replace(
		/\$\s*(\\(?:cite[a-zA-Z]*|textcite|Textcite|parencite|Parencite|autocite|Autocite|fullcite|footcite|footcitetext|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^}]+\})\s*\$/g,
		(_, inner) => inner.trim()
	);

	// Normalise non-standard delimiter variants before anything else
	text = normaliseMathDelimiters(text);

	// ── Step 0: Pre-scan ALL fenced blocks for BibTeX content ─────────────────
	// Must happen BEFORE code blocks are shielded so the DB is populated
	// before citation commands are processed in Step 4.
	// Catches ```bibtex, ```bib, ```latex, untagged ```, or ANY tag when the
	// block content itself begins with a BibTeX entry type declaration.
	{
		const _bibEntryStartRx = /^\s*@(?:article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|proceedings|inbook|unpublished|manual|booklet|patent|dataset|software|report)\s*[\{(]/im;
		const bibFenceRx = /^```[^\n]*\r?\n([\s\S]*?)\n```/gim;
		let _bm;
		while ((_bm = bibFenceRx.exec(text)) !== null) {
			if (_bibEntryStartRx.test(_bm[1])) {
				parseBibtex(_bm[1]);
			}
		}
	}

	// ── Step 1: Shield code blocks ──────────────────────────────────────────
	const codeBlocks = [];
	let ci = 0;
	let p = text.replace(CODE_BLOCK_REGEX, (m) => {
		const ph = `⚿CODEBLOCK${ci}⚿`;
		codeBlocks.push({ ph, m });
		ci++;
		return ph;
	});

	// ── Step 2: Shield math blocks ──────────────────────────────────────────
	const mathBlocks = [];
	let mi = 0;
	p = p.replace(MATH_REGEX, (m) => {
		const ph = `⚿MATHBLOCK${mi}⚿`;
		mathBlocks.push({ ph, m });
		mi++;
		return ph;
	});

	// ── Step 3: Text-mode transformations ───────────────────────────────────

	// === Preamble / Metadata — collect and collapse ===
	const preambleCommands = [
		'documentclass', 'usepackage', 'newcommand', 'renewcommand',
		'providecommand', 'newenvironment', 'renewenvironment',
		'author', 'title', 'date', 'institute', 'affiliation',
		'DeclareMathOperator', 'DeclareMathOperator\\*',
		'newtheorem', 'newtheorem\\*',
		'setlength', 'setcounter', 'setlist',
		'geometry', 'hypersetup', 'definecolor',
		'lstset', 'fancyhead', 'fancyfoot', 'pagestyle',
	];
	const preambleRegex = new RegExp(
		'^\\\\(?:' + preambleCommands.join('|') + ').*$', 'gm'
	);
	let preamble = '';
	p = p.replace(preambleRegex, (m) => { preamble += m + '\n'; return ''; });

	if (preamble.trim()) {
		p = `<details class="latex-preamble"><summary>📄 Document Configuration</summary>\n\`\`\`latex\n${preamble.trim()}\n\`\`\`\n</details>\n\n` + p;
	}

	// === \maketitle / \tableofcontents / \listof* ===
	p = p.replace(/\\maketitle\b/g,         '<div class="latex-maketitle"><!-- title block generated here --></div>');
	p = p.replace(/\\tableofcontents\b/g,   '<div class="latex-toc-placeholder"><em>Table of Contents</em></div>');
	p = p.replace(/\\listoffigures\b/g,     '<div class="latex-toc-placeholder"><em>List of Figures</em></div>');
	p = p.replace(/\\listoftables\b/g,      '<div class="latex-toc-placeholder"><em>List of Tables</em></div>');
	p = p.replace(/\\appendix\b/g,         '\n---\n### Appendix\n');

	// === Document wrappers ===
	p = p.replace(/\\begin\{document\}/g, '');
	p = p.replace(/\\end\{document\}/g,   '');
	p = p.replace(/\\begin\{abstract\}/g, makeCallout('note', '📄', 'Abstract'));
	p = p.replace(/\\end\{abstract\}/g,   CALLOUT_END);

	// === Theorem-class environments ===
	for (const [env, type, icon, title] of THEOREM_ENVS) {
		p = p.replace(
			new RegExp(`\\\\begin\\{${env}\\*?\\}(?:\\[([^\\]]+)\\])?(?:\\\\label\\{[^}]+\\})?`, 'g'),
			(_, customTitle) => makeCallout(type, icon, customTitle ? `${title}: ${customTitle}` : title)
		);
		p = p.replace(new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g'), CALLOUT_END);
	}

	// === Proof environment ===
	p = p.replace(/\\begin\{proof\}(?:\[([^\]]+)\])?/g, (_, hint) =>
		makeCallout('note', '📝', hint ? `Proof (${hint})` : 'Proof')
	);
	p = p.replace(/\\end\{proof\}/g, '\n\n<span class="latex-qed">□</span>' + CALLOUT_END);
	p = p.replace(/\\(?:qed|QED)\b/g, '<span class="latex-qed">□</span>');

	// === Algorithm environments ===
	p = p.replace(/\\begin\{algorithm\}(?:\[.*?\])?(?:\{([^}]*)\})?/g, (_, title) =>
		makeCallout('example', '⚙️', title || 'Algorithm')
	);
	p = p.replace(/\\end\{algorithm\}/g, CALLOUT_END);
	p = p.replace(/\\begin\{algorithm2e\}(?:\[.*?\])?/g, makeCallout('example', '⚙️', 'Algorithm'));
	p = p.replace(/\\end\{algorithm2e\}/g,                CALLOUT_END);
	p = p.replace(
		/\\begin\{algorithmic\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithmic\}/g,
		(_, body) => formatAlgorithmic(body)
	);
	p = p.replace(
		/\\begin\{algorithm2e-body\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm2e-body\}/g,
		(_, body) => formatAlgorithmic(body)
	);

	// === Beamer frames ===
	p = p.replace(/\\begin\{frame\}(?:\[.*?\])?(?:\{([^}]*)\})?(?:\{([^}]*)\})?/g, (_, title, subtitle) => {
		const t = [title, subtitle].filter(Boolean).join(' — ') || 'Slide';
		return makeCallout('note', '📽️', t);
	});
	p = p.replace(/\\frametitle\{([^}]+)\}/g, '**$1**\n');
	p = p.replace(/\\framesubtitle\{([^}]+)\}/g, '*$1*\n');
	p = p.replace(/\\end\{frame\}/g, CALLOUT_END);
	p = p.replace(/\\begin\{block\}\{([^}]+)\}/g, () => `\n\n**$1**\n\n`);
	p = p.replace(/\\end\{block\}/g, '\n');
	p = p.replace(/\\pause\b/g, '');
	p = p.replace(/\\only<[^>]+>\{([^}]+)\}/g, '$1');
	p = p.replace(/\\uncover<[^>]+>\{([^}]+)\}/g, '$1');
	p = p.replace(/\\visible<[^>]+>\{([^}]+)\}/g, '$1');
	p = p.replace(/\\invisible<[^>]+>\{([^}]+)\}/g, '');
	p = p.replace(/\\alert(?:<[^>]+>)?\{([^}]+)\}/g, '<mark>$1</mark>');
	p = p.replace(/\\structure\{([^}]+)\}/g, '**$1**');

	// === TikZ / pgfplots / pgfpicture ===
	p = p.replace(
		/\\begin\{tikzpicture\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{tikzpicture\}/g,
		(_, opts, code) =>
			`\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📊 TikZ Diagram (source shown below)</div>\n\`\`\`latex\n\\begin{tikzpicture}${opts||''}${code}\\end{tikzpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{pgfpicture\}([\s\S]*?)\\end\{pgfpicture\}/g,
		(_, code) =>
			`\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📊 PGF Picture (source shown below)</div>\n\`\`\`latex\n\\begin{pgfpicture}${code}\\end{pgfpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{axis\}([\s\S]*?)\\end\{axis\}/g,
		(_, code) =>
			`\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📈 pgfplots Axis (source shown below)</div>\n\`\`\`latex\n\\begin{axis}${code}\\end{axis}\n\`\`\`\n</div>\n`
	);

	// \includegraphics
	p = p.replace(
		/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g,
		(_, filename) =>
			`\n<div class="latex-figure-card"><span class="latex-figure-icon">🖼️</span><span class="latex-figure-name">Figure: <code>${filename}</code></span><span class="latex-figure-note">(requires compilation)</span></div>\n`
	);

	// === Verbatim environments ===
	p = p.replace(
		/\\begin\{(?:verbatim|Verbatim)\*?\}([\s\S]*?)\\end\{(?:verbatim|Verbatim)\*?\}/g,
		(_, body) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`
	);
	p = p.replace(
		/\\begin\{lstlisting\}(?:\[.*?\])?([\s\S]*?)\\end\{lstlisting\}/g,
		(_, body) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`
	);
	p = p.replace(
		/\\begin\{minted\}(?:\[.*?\])?\{([^}]+)\}([\s\S]*?)\\end\{minted\}/g,
		(_, lang, body) => `\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`
	);
	p = p.replace(/\\verb([^a-zA-Z\s])(.*?)\1/g, (_, _d, body) => `\`${body}\``);

	// === Tables ===
	p = p.replace(
		/\\begin\{tabularx\}\s*\{[^}]+\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{tabularx\}/g,
		(_, body) => formatTabular(body)
	);
	p = p.replace(
		/\\begin\{longtable\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{longtable\}/g,
		(_, body) => formatTabular(body, true)
	);
	p = p.replace(
		/\\begin\{tabular\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{tabular\}/g,
		(_, body) => formatTabular(body)
	);
	p = p.replace(
		/\\begin\{array\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{array\}/g,
		(_, body) => formatTabular(body)
	);

	// === Figure / Table float wrappers ===
	p = p.replace(/\\begin\{figure\}(\[.*?\])?/g, '\n');
	p = p.replace(/\\end\{figure\}/g,              '\n');
	p = p.replace(/\\begin\{table\}(\[.*?\])?/g,  '\n');
	p = p.replace(/\\end\{table\}/g,              '\n');
	p = p.replace(/\\begin\{wrapfigure\}\{[^}]+\}\{[^}]+\}/g, '\n');
	p = p.replace(/\\end\{wrapfigure\}/g,          '\n');
	p = p.replace(/\\centering\b/g,                '');
	p = p.replace(/\\caption\{([^}]+)\}/g,         '\n<div class="latex-caption">$1</div>\n');
	p = p.replace(/\\captionof\{[^}]+\}\{([^}]+)\}/g, '\n<div class="latex-caption">$1</div>\n');
	p = p.replace(/\\subcaption\{([^}]+)\}/g,      '<div class="latex-subcaption">$1</div>');

	// === Sectioning ===
	p = p.replace(/\\part\*?\{([^}]+)\}/g,          '\n# $1\n');
	p = p.replace(/\\chapter\*?\{([^}]+)\}/g,       '\n# $1\n');
	p = p.replace(/\\section\*?\{([^}]+)\}/g,       '\n## $1\n');
	p = p.replace(/\\subsection\*?\{([^}]+)\}/g,    '\n### $1\n');
	p = p.replace(/\\subsubsection\*?\{([^}]+)\}/g, '\n#### $1\n');
	p = p.replace(/\\paragraph\*?\{([^}]+)\}/g,     '\n##### $1\n');
	p = p.replace(/\\subparagraph\*?\{([^}]+)\}/g,  '\n###### $1\n');

	// === Quote environments ===
	p = p.replace(
		/\\begin\{quote\}([\s\S]*?)\\end\{quote\}/g,
		(_, body) => `\n> ${body.trim().split('\n').join('\n> ')}\n`
	);
	p = p.replace(
		/\\begin\{quotation\}([\s\S]*?)\\end\{quotation\}/g,
		(_, body) => `\n> ${body.trim().split('\n').join('\n> ')}\n`
	);
	p = p.replace(
		/\\begin\{verse\}([\s\S]*?)\\end\{verse\}/g,
		(_, body) => {
			const lines = body.trim().split('\n').map(l => `> *${l.trim()}*`);
			return '\n' + lines.join('\n') + '\n';
		}
	);

	// === Lists ===
	function convertList(body, ordered) {
		let result = body
			.replace(/\\item\s*\[([^\]]+)\]/g, ordered ? '\n1. **$1** ' : '\n- **$1** ')
			.replace(/\\item\b/g,              ordered ? '\n1. '         : '\n- ');
		return result;
	}

	for (let pass = 0; pass < 4; pass++) {
		p = p.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g,
			(_, body) => convertList(body, false) + '\n');
		p = p.replace(/\\begin\{enumerate\}(?:\[.*?\])?([\s\S]*?)\\end\{enumerate\}/g,
			(_, body) => convertList(body, true) + '\n');
		p = p.replace(/\\begin\{description\}([\s\S]*?)\\end\{description\}/g,
			(_, body) => convertList(body, false) + '\n');
		p = p.replace(/\\begin\{compactitem\}(?:\[.*?\])?([\s\S]*?)\\end\{compactitem\}/g,
			(_, body) => convertList(body, false) + '\n');
		p = p.replace(/\\begin\{compactenum\}(?:\[.*?\])?([\s\S]*?)\\end\{compactenum\}/g,
			(_, body) => convertList(body, true) + '\n');
		p = p.replace(/\\begin\{tasks\}(?:\[.*?\])?(?:\(\d+\))?([\s\S]*?)\\end\{tasks\}/g,
			(_, body) => body.replace(/\\task\b/g, '\n- ') + '\n');
		p = p.replace(/\\begin\{checklist\}([\s\S]*?)\\end\{checklist\}/g,
			(_, body) => body
				.replace(/\\checkitem\b/g, '\n- [x]')
				.replace(/\\uncheckitem\b/g, '\n- [ ]') + '\n'
		);
	}

	// === Inline Formatting ===
	p = applyInlineFormatting(p);

	// === Font size commands ===
	const fontSizes = [
		['\\\\tiny',         '0.6em'],
		['\\\\scriptsize',   '0.7em'],
		['\\\\footnotesize', '0.8em'],
		['\\\\small',        '0.9em'],
		['\\\\normalsize',   '1em'],
		['\\\\large',        '1.17em'],
		['\\\\Large',        '1.4em'],
		['\\\\LARGE',        '1.7em'],
		['\\\\huge',         '2em'],
		['\\\\Huge',         '2.5em'],
	];
	for (const [cmd, size] of fontSizes) {
		p = p.replace(new RegExp(`${cmd}\\{([^}]+)\\}`, 'g'),
			`<span style="font-size:${size}">$1</span>`);
		p = p.replace(new RegExp(`(?<=\\{\\s*)${cmd}\\s+([^}]+)(?=\\s*\\})`, 'g'),
			`<span style="font-size:${size}">$1</span>`);
	}

	// === Alignment declarations ===
	p = p.replace(/\\centering\b/g,    '<div style="text-align:center">');
	p = p.replace(/\\raggedright\b/g,  '<div style="text-align:left">');
	p = p.replace(/\\raggedleft\b/g,   '<div style="text-align:right">');
	p = p.replace(/\\justify\b/g,      '<div style="text-align:justify">');
	p = p.replace(/\\begin\{center\}([\s\S]*?)\\end\{center\}/g,
		'<div style="text-align:center">$1</div>');
	p = p.replace(/\\begin\{flushleft\}([\s\S]*?)\\end\{flushleft\}/g,
		'<div style="text-align:left">$1</div>');
	p = p.replace(/\\begin\{flushright\}([\s\S]*?)\\end\{flushright\}/g,
		'<div style="text-align:right">$1</div>');

	// === Spacing / page breaks ===
	p = p.replace(/\\vspace\*?\{[^}]+\}/g,  '\n');
	p = p.replace(/\\hspace\*?\{[^}]+\}/g,  ' ');
	p = p.replace(/\\vskip\s*[\d.]+\s*(?:pt|em|ex|cm|mm|in|bp|pc|dd|cc|sp)\b/g, '\n');
	p = p.replace(/\\hskip\s*[\d.]+\s*(?:pt|em|ex|cm|mm|in|bp|pc|dd|cc|sp)\b/g, ' ');
	p = p.replace(/\\medskip\b/g,           '\n');
	p = p.replace(/\\bigskip\b/g,           '\n\n');
	p = p.replace(/\\smallskip\b/g,         '\n');
	p = p.replace(/\\newpage\b/g,           '\n\n---\n\n');
	p = p.replace(/\\clearpage\b/g,         '\n\n---\n\n');
	p = p.replace(/\\cleardoublepage\b/g,   '\n\n---\n\n');
	p = p.replace(/\\pagebreak(?:\[\d\])?\b/g, '\n\n---\n\n');
	p = p.replace(/\\linebreak(?:\[\d\])?\b/g, '  \n');
	p = p.replace(/\\nolinebreak(?:\[\d\])?\b/g, '');
	p = p.replace(/\\newline\b/g,           '  \n');
	p = p.replace(/\\\\\s*(\[.*?\])?/g,     '  \n');
	p = p.replace(/\\par\b/g,              '\n\n');
	p = p.replace(/\\indent\b/g,           '');
	p = p.replace(/\\noindent\b/g,         '');

	// === Rules / lines ===
	p = p.replace(/\\hrule\b/g,                  '\n---\n');
	p = p.replace(/\\rule\{[^}]+\}\{[^}]+\}/g,   '<hr>');

	// === Labels / Cross-refs ===
	p = p.replace(/\\label\{([^}]+)\}/g,         '');
	p = p.replace(/\\autoref\{([^}]+)\}/g,        '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\cref\{([^}]+)\}/g,           '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\nameref\{([^}]+)\}/g,        '<span class="latex-ref">$1</span>');
	p = p.replace(/\\eqref\{([^}]+)\}/g,          '<span class="latex-ref">($1)</span>');
	p = p.replace(/\\ref\{([^}]+)\}/g,            '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\pageref\{([^}]+)\}/g,        '<span class="latex-ref">p.$1</span>');
	p = p.replace(/~\\(?:ref|cite|autoref|cref)\b/g, (m) => ' ' + m.slice(1));

	// === Glossaries ===
	p = p.replace(/\\gls\{([^}]+)\}/g,            '<span class="latex-gls">$1</span>');
	p = p.replace(/\\glspl\{([^}]+)\}/g,          '<span class="latex-gls">$1s</span>');
	p = p.replace(/\\Gls\{([^}]+)\}/g,            (_, k) => `<span class="latex-gls">${k.charAt(0).toUpperCase()+k.slice(1)}</span>`);
	p = p.replace(/\\GLS\{([^}]+)\}/g,            (_, k) => `<span class="latex-gls">${k.toUpperCase()}</span>`);
	p = p.replace(/\\glsentrylong\{([^}]+)\}/g,   '<span class="latex-gls">$1</span>');
	p = p.replace(/\\glsentryshort\{([^}]+)\}/g,  '<span class="latex-gls">$1</span>');
	p = p.replace(/\\acrshort\{([^}]+)\}/g,       '<abbr class="latex-acr">$1</abbr>');
	p = p.replace(/\\acrlong\{([^}]+)\}/g,        '<span class="latex-acr-long">$1</span>');
	p = p.replace(/\\acrfull\{([^}]+)\}/g,        '<span class="latex-acr-full">$1</span>');

	// === Miscellaneous cleanup ===
	p = p.replace(/\\color\{[^}]+\}/g, '');
	p = p.replace(/\\(?:selectfont|normalfont|usefont\{[^}]+\}\{[^}]+\}\{[^}]+\}\{[^}]+\})\b/g, '');
	p = p.replace(/\\protect\b/g, '');
	p = p.replace(/\\(?:h|v)?phantom\{[^}]+\}/g, '');
	p = p.replace(/\\ensuremath\{([^}]+)\}/g, '$$$1$$');

	// Collapse 3+ blank lines → 2
	p = p.replace(/\n{3,}/g, '\n\n');

	// ── Step 4: Process bibliography (BibTeX) ────────────────────────────────
	p = processBibliography(p);

	// ── Step 5: Restore math then code ──────────────────────────────────────
	for (const { ph, m } of mathBlocks)  p = p.replace(ph, m);
	for (const { ph, m } of codeBlocks)  p = p.replace(ph, m);

	return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractMath — shield all math from the Markdown parser
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// injectMath — replace placeholders with rendered HTML
// ─────────────────────────────────────────────────────────────────────────────

export function injectMath(html, mathBlocks) {
	if (!mathBlocks || mathBlocks.length === 0) return html;

	let result = html;

	const katexMacros = {
		'\\R':    '\\mathbb{R}',
		'\\N':    '\\mathbb{N}',
		'\\Z':    '\\mathbb{Z}',
		'\\Q':    '\\mathbb{Q}',
		'\\C':    '\\mathbb{C}',
		'\\F':    '\\mathbb{F}',
		'\\P':    '\\mathbb{P}',
		'\\E':    '\\mathbb{E}',
		'\\eps':  '\\varepsilon',
		'\\ph':   '\\varphi',
		'\\T':    '^{\\top}',
		'\\inv':  '^{-1}',
		'\\abs':  '\\left|#1\\right|',
		'\\norm': '\\left\\|#1\\right\\|',
		'\\set':  '\\left\\{#1\\right\\}',
		'\\ceil': '\\left\\lceil#1\\right\\rceil',
		'\\floor':'\\left\\lfloor#1\\right\\rfloor',
		'\\d':    '\\,\\mathrm{d}',
		'\\diff': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
		'\\pdiff':'\\frac{\\partial #1}{\\partial #2}',
		'\\tfrac':'\\frac{#1}{#2}',
		'\\bm':  '\\boldsymbol',
		'\\1':    '\\mathbf{1}',
		'\\tr':   '\\operatorname{tr}',
		'\\rank': '\\operatorname{rank}',
		'\\diag': '\\operatorname{diag}',
		'\\sign': '\\operatorname{sign}',
		'\\Var':  '\\operatorname{Var}',
		'\\Cov':  '\\operatorname{Cov}',
		'\\KL':   'D_{\\mathrm{KL}}',
		'\\coloneqq': '\\mathrel{:=}',
		'\\eqqcolon': '\\mathrel{=:}',
	};

	for (const block of mathBlocks) {
		let rendered = '';
		const { content, isBlock, rawMatch, placeholder } = block;

		try {
			if (window.katex) {
				rendered = window.katex.renderToString(content, {
					displayMode:  isBlock,
					throwOnError: false,
					trust:        true,
					strict:       false,
					output:       'htmlAndMathml',
					leqno:        false,
					fleqn:        false,
					macros:       { ...katexMacros },
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

		if (isBlock && rendered) {
			rendered = `<div class="latex-display-wrapper">${rendered}</div>`;
		}

		result = result.replace(placeholder, rendered);
	}

	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async MathJax retry
// ─────────────────────────────────────────────────────────────────────────────

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
		const src    = el.dataset.latex || '';
		const isDisp = el.classList.contains('latex-block');
		try {
			const node = window.MathJax.tex2svg(src, { display: isDisp });
			el.replaceWith(node);
		} catch (_) { /* leave as-is */ }
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// normaliseMathDelimiters
// ─────────────────────────────────────────────────────────────────────────────

export function normaliseMathDelimiters(text) {
	if (!text) return '';

	let t = text;

	// ── 0. Rescue citation commands from $...$ wrapping (same as preprocessLatexText step -1)
	// extractMath calls normaliseMathDelimiters directly, so we need this here too.
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

	t = t.replace(/\$\$[ \t]*\n([\s\S]*?)[ \t]*\n[ \t]*\$\$/g,
		(_, inner) => `$$\n${inner.trim()}\n$$`
	);

	t = t.replace(/\\\[\s*\n/g, '\\[\n');
	t = t.replace(/\n\s*\\\]/g, '\n\\]');
	t = t.replace(/\\\(\s*\n/g, '\\(');
	t = t.replace(/\n\s*\\\)/g, '\\)');
	t = t.replace(/\u2032/g, "'");
	t = t.replace(/\u2212/g, '-');

	return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX Parser & Bibliography Database (v3)
//
//  Key improvements over v1/v2:
//   • Depth-aware brace parser handles arbitrarily nested braces and values
//   • Full @string / @comment / @preamble support
//   • # concatenation in field values
//   • All 18 standard entry types with per-type academic formatting
//   • Multiple bibliography styles: plain, ieee, alpha, authoryear,
//     apa, chicago, harvard, mla, vancouver
//   • Per-message citation numbering (correct for IEEE ordering)
//   • Anchor navigation: clicking [N] scrolls to the reference entry
//   • Hover tooltip cards (initialised in initBibTooltips below)
//   • \addbibresource / \bibliographystyle silently consumed
//   • \printbibliography[style=…,type=…] option parsing
//   • thebibliography / \bibitem environment
//   • Auto-bibliography: appended if citations exist but no \printbibliography
//   • ```bibtex code blocks are pre-scanned (Step 0 of preprocessLatexText)
//     and also intercepted by the markdown renderer in markdown.js
//   • DOI / URL rendered as clickable links
//   • Entry-type badges (Article / Book / Conf. etc.)
//   • Missing-key citations rendered with a distinct warning style
// ─────────────────────────────────────────────────────────────────────────────

// ── Built-in month string macros (also populated from @string entries) ────────
const _bibStringMacros = new Map([
	['jan','January'],  ['feb','February'], ['mar','March'],
	['apr','April'],    ['may','May'],       ['jun','June'],
	['jul','July'],     ['aug','August'],    ['sep','September'],
	['oct','October'],  ['nov','November'],  ['dec','December'],
	['january','January'],   ['february','February'],  ['march','March'],
	['april','April'],       ['june','June'],           ['july','July'],
	['august','August'],     ['september','September'], ['october','October'],
	['november','November'], ['december','December'],
]);

/**
 * Global bibliography database — accumulates across messages in the conversation.
 * Keys are citation keys (strings), values are entry objects.
 */
const bibliographyDatabase = new Map();

/** Current default style — changed by \bibliographystyle{} or parseBibtex(src, style) */
let bibliographyStyle = 'plain';

// ── Low-level brace parser ────────────────────────────────────────────────────

/**
 * Find the index of the closing brace that matches the opening brace at startIdx.
 * Skips escaped characters and handles nesting.
 */
function _findMatchingBrace(str, startIdx) {
	let depth = 1;
	for (let i = startIdx + 1; i < str.length; i++) {
		const ch = str[i];
		if (ch === '\\') { i++; continue; } // skip escaped char
		if (ch === '{') depth++;
		else if (ch === '}') { depth--; if (depth === 0) return i; }
	}
	return str.length - 1;
}

/**
 * Parse a BibTeX field value starting right after the '=' character.
 * Handles {brace groups}, "quoted strings", bare numbers/macro names,
 * and # concatenation.
 * Returns { value: string, endIdx: number }
 */
function _parseBibtexFieldValue(str, startIdx) {
	let i = startIdx;
	while (i < str.length && /[ \t\r\n]/.test(str[i])) i++;
	if (i >= str.length) return { value: '', endIdx: i };

	const parts = [];

	const readSegment = () => {
		while (i < str.length && /[ \t\r\n]/.test(str[i])) i++;
		if (i >= str.length) return false;

		if (str[i] === '{') {
			const close = _findMatchingBrace(str, i);
			parts.push(str.slice(i + 1, close));
			i = close + 1;
			return true;
		}

		if (str[i] === '"') {
			let j = i + 1;
			while (j < str.length) {
				if (str[j] === '"' && str[j - 1] !== '\\') break;
				j++;
			}
			parts.push(str.slice(i + 1, j));
			i = j + 1;
			return true;
		}

		// Bare token: number or @string macro name
		let j = i;
		while (j < str.length && /[^\s,}#]/.test(str[j])) j++;
		const token = str.slice(i, j).trim();
		if (token) {
			const expanded = _bibStringMacros.get(token.toLowerCase());
			parts.push(expanded !== undefined ? expanded : token);
		}
		i = j;
		return token.length > 0;
	};

	readSegment();
	while (i < str.length) {
		while (i < str.length && /[ \t\r\n]/.test(str[i])) i++;
		if (str[i] === '#') { i++; readSegment(); }
		else break;
	}

	return { value: parts.join(''), endIdx: i };
}

/** Strip LaTeX accent commands and braces from a field value string */
function _cleanBibtexValue(val) {
	if (!val) return '';
	return val
		.replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\\$/g, '$')
		.replace(/\\#/g, '#').replace(/\\_/g, '_')
		.replace(/\\{/g, '{').replace(/\\}/g, '}')
		.replace(/\\~/g, '~').replace(/\\ /g, ' ')
		.replace(/\\'([a-zA-Z])/g, (_, c) => (c + '\u0301').normalize('NFC'))
		.replace(/\\`([a-zA-Z])/g,  (_, c) => (c + '\u0300').normalize('NFC'))
		.replace(/\\"([a-zA-Z])/g,  (_, c) => (c + '\u0308').normalize('NFC'))
		.replace(/\\c\{([cCsStT])\}/g, (_, c) => (c + '\u0327').normalize('NFC'))
		.replace(/\\v\{([a-zA-Z])\}/g,  (_, c) => (c + '\u030C').normalize('NFC'))
		.replace(/\\ss\b/g, 'ß')
		.replace(/\\ae\b/gi, (m) => m[1] === 'A' ? 'Æ' : 'æ')
		.replace(/\\oe\b/gi, (m) => m[1] === 'O' ? 'Œ' : 'œ')
		.replace(/\\o\b/gi,  (m) => m[1] === 'O' ? 'Ø' : 'ø')
		.replace(/\\l\b/gi,  (m) => m[1] === 'L' ? 'Ł' : 'ł')
		.replace(/\\(?:emph|textit|textbf|textrm|texttt|textsf|textsc|textmd|textup)\{([^}]+)\}/g, '$1')
		.replace(/\{([^{}]*)\}/g, '$1')   // unwrap remaining simple brace groups
		.replace(/^\s+|\s+$/g, '')
		.replace(/\s{2,}/g, ' ');
}

/**
 * Parse one complete @TYPE{key, field=value, ...} block string into an entry object.
 * Returns null if parsing fails.
 */
function parseBibtexEntry(entryText) {
	if (!entryText) return null;
	const entry = {};

	const typeMatch = entryText.match(/^@(\w+)\s*[\{(]\s*/);
	if (!typeMatch) return null;
	entry.type = typeMatch[1].toLowerCase();
	let i = typeMatch[0].length;

	// Citation key: everything up to the first comma or closing delimiter
	let keyEnd = i;
	while (keyEnd < entryText.length && entryText[keyEnd] !== ',' && entryText[keyEnd] !== '}' && entryText[keyEnd] !== ')') keyEnd++;
	entry.id = entryText.slice(i, keyEnd).trim();
	if (!entry.id) return null;
	i = keyEnd;
	if (i < entryText.length && (entryText[i] === ',' || entryText[i] === ' ')) i++;

	// Field loop
	while (i < entryText.length) {
		// Skip whitespace / commas
		while (i < entryText.length && /[\s,]/.test(entryText[i])) i++;
		if (i >= entryText.length || entryText[i] === '}' || entryText[i] === ')') break;

		// Field name
		let nameEnd = i;
		while (nameEnd < entryText.length && /[a-zA-Z_\-]/.test(entryText[nameEnd])) nameEnd++;
		if (nameEnd === i) { i++; continue; }
		const fieldName = entryText.slice(i, nameEnd).toLowerCase();
		i = nameEnd;

		// Skip to '='
		while (i < entryText.length && /\s/.test(entryText[i])) i++;
		if (i >= entryText.length || entryText[i] !== '=') continue;
		i++; // consume '='

		const { value, endIdx } = _parseBibtexFieldValue(entryText, i);
		entry[fieldName] = _cleanBibtexValue(value);
		i = endIdx;
	}

	return entry;
}

/**
 * Parse a full BibTeX source string (file content or inline block).
 * Processes @string, @comment, @preamble, and all entry types.
 * Results are merged into the global bibliographyDatabase.
 *
 * @param {string} bibContent - Raw BibTeX source
 * @param {string} [style]    - Bibliography style name
 * @returns {number} Total number of entries in database
 */
export function parseBibtex(bibContent, style) {
	if (style) bibliographyStyle = style;
	if (!bibContent || !bibContent.trim()) return bibliographyDatabase.size;

	// ── @comment{...} — remove wholesale ────────────────────────────────────
	// Use a depth-aware approach
	let src = bibContent;
	src = src.replace(/@comment\s*\{/gi, (m, offset) => {
		// Just mark; we'll strip below
		return m;
	});
	// Simple regex is sufficient since @comment blocks don't typically nest
	src = src.replace(/@comment\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, '');
	src = src.replace(/@comment[^\n]*/gi, '');

	// ── @string{name = {value}} — register macros ────────────────────────────
	const strRx = /@string\s*[\{(]\s*(\w+)\s*=\s*/gi;
	let sm;
	while ((sm = strRx.exec(src)) !== null) {
		const { value } = _parseBibtexFieldValue(src, strRx.lastIndex);
		_bibStringMacros.set(sm[1].toLowerCase(), _cleanBibtexValue(value));
	}

	// ── All other @TYPE entries — depth-aware scan ───────────────────────────
	const atRx = /@(\w+)\s*[\{(]/g;
	let atM;
	while ((atM = atRx.exec(src)) !== null) {
		const typeLower = atM[1].toLowerCase();
		if (typeLower === 'string' || typeLower === 'preamble' || typeLower === 'comment') continue;

		// Find the open delimiter position (last char of match)
		const openIdx = atM.index + atM[0].length - 1;
		let closeIdx;
		if (src[openIdx] === '{') {
			closeIdx = _findMatchingBrace(src, openIdx);
		} else {
			// Parenthesised form @type(...) — find matching )
			let depth = 1;
			let j = openIdx + 1;
			while (j < src.length && depth > 0) {
				if (src[j] === '(') depth++;
				else if (src[j] === ')') depth--;
				j++;
			}
			closeIdx = j - 1;
		}

		const entryText = src.slice(atM.index, closeIdx + 1);
		const entry = parseBibtexEntry(entryText);
		if (entry && entry.id && entry.type !== 'string' && entry.type !== 'preamble') {
			bibliographyDatabase.set(entry.id, entry);
		}
	}

	return bibliographyDatabase.size;
}

// ── Exported utility API ──────────────────────────────────────────────────────

/** Add or overwrite a single entry by object */
export function addBibtexEntry(entry) {
	if (entry && entry.id) bibliographyDatabase.set(entry.id, entry);
}

/** Retrieve one entry by citation key, or null */
export function getBibtexEntry(id) {
	return bibliographyDatabase.get(id) || null;
}

/** Return the full database Map */
export function getAllBibtexEntries() {
	return bibliographyDatabase;
}

/** Clear the entire database */
export function clearBibliography() {
	bibliographyDatabase.clear();
}

// ── Author name helpers ───────────────────────────────────────────────────────

/**
 * Split an author/editor string on " and " (case-insensitive).
 * Returns an array of individual author strings.
 */
function _splitAuthors(str) {
	if (!str) return [];
	return str.split(/\s+and\s+/i).map(a => a.trim()).filter(Boolean);
}

/**
 * Convert a single BibTeX author string to display form.
 * Handles both "Last, First" and "First Last" formats.
 */
function _formatOneAuthor(raw) {
	raw = (raw || '').trim();
	if (!raw) return '';
	if (raw.toLowerCase() === 'others') return 'et al.';
	if (raw.includes(',')) {
		const [last, ...rest] = raw.split(',');
		const first = rest.join(',').trim();
		return first ? first + ' ' + last.trim() : last.trim();
	}
	return raw;
}

/**
 * Extract just the last name from a BibTeX author token.
 */
function _lastNameOf(raw) {
	raw = (raw || '').trim();
	if (raw.includes(',')) return raw.split(',')[0].trim();
	const parts = raw.split(/\s+/);
	return parts[parts.length - 1] || raw;
}

/**
 * Short author string for inline citations.
 * "Smith", "Smith & Jones", "Smith et al."
 */
function _authorsShort(authorsStr) {
	const authors = _splitAuthors(authorsStr);
	if (!authors.length) return '';
	if (authors[0].toLowerCase().trim() === 'others' || authors[0].trim() === '') return 'et al.';
	const ln0 = _lastNameOf(authors[0]);
	if (authors.length === 1) return ln0;
	if (authors.length === 2 && authors[1].toLowerCase().trim() !== 'others') {
		return ln0 + ' & ' + _lastNameOf(authors[1]);
	}
	return ln0 + ' et al.';
}

/**
 * Full author string for bibliography entries (up to 6 before et al.).
 */
function _authorsLong(authorsStr, maxFull = 6) {
	const authors = _splitAuthors(authorsStr);
	if (!authors.length) return '';
	const formatted = authors.map(_formatOneAuthor);
	// Handle explicit "others"
	const hasOthers = formatted[formatted.length - 1] === 'et al.';
	if (hasOthers) {
		const main = formatted.slice(0, -1);
		return main.join(', ') + ', et al.';
	}
	if (formatted.length <= maxFull) {
		if (formatted.length === 1) return formatted[0];
		return formatted.slice(0, -1).join(', ') + ' & ' + formatted[formatted.length - 1];
	}
	return formatted.slice(0, 3).join(', ') + ', et al.';
}

// ── Alpha label generator ─────────────────────────────────────────────────────

function _alphaLabel(entry) {
	const authors = _splitAuthors(entry.author || entry.editor || '');
	const year2 = (entry.year || '??').replace(/\D/g, '').slice(-2);

	if (!authors.length) {
		return (entry.id || 'anon').slice(0, 4) + year2;
	}
	if (authors.length === 1) {
		const ln = _lastNameOf(authors[0]);
		return ln.slice(0, 3) + year2;
	}
	// Multiple: first letter of each last name, up to 3
	const initials = authors
		.slice(0, 3)
		.map(a => (_lastNameOf(a)[0] || '?').toUpperCase())
		.join('');
	return initials + year2;
}

// ── Entry-type badge ──────────────────────────────────────────────────────────

const _TYPE_LABELS = {
	article:         'Article',
	book:            'Book',
	inproceedings:   'Conf.',
	conference:      'Conf.',
	proceedings:     'Proceedings',
	incollection:    'Book Ch.',
	inbook:          'Book Ch.',
	phdthesis:       'PhD Thesis',
	mastersthesis:   "Master's",
	techreport:      'Tech Rep.',
	report:          'Report',
	misc:            'Misc',
	online:          'Online',
	electronic:      'Online',
	www:             'Online',
	software:        'Software',
	dataset:         'Dataset',
	unpublished:     'Unpub.',
	manual:          'Manual',
	booklet:         'Booklet',
	patent:          'Patent',
};

function _typeBadge(type) {
	const label = _TYPE_LABELS[type] || type;
	// CSS class uses the type name directly (see bibliography.css)
	return `<span class="bib-type-badge bib-type-${escapeHtml(type)}">${escapeHtml(label)}</span>`;
}

// ── Link helpers ──────────────────────────────────────────────────────────────

function _doiLink(doi) {
	if (!doi) return '';
	const href = /^https?:\/\//i.test(doi) ? doi : 'https://doi.org/' + doi;
	const label = doi.replace(/^https?:\/\/doi\.org\//i, '');
	return ` <a href="${escapeHtml(href)}" class="bib-doi-link" target="_blank" rel="noopener noreferrer">doi:${escapeHtml(label)}</a>`;
}

function _urlLink(url, label) {
	if (!url) return '';
	return ` <a href="${escapeHtml(url)}" class="bib-url-link" target="_blank" rel="noopener noreferrer">${escapeHtml(label || url)}</a>`;
}

// ── Per-type entry content renderer ──────────────────────────────────────────

/**
 * Renders the text body of a bibliography entry (everything after the label).
 * Returns an HTML string.
 */
function _renderEntryBody(entry) {
	const eh = escapeHtml; // shorthand

	const authors    = _authorsLong(entry.author);
	const editors    = _authorsLong(entry.editor);
	const title      = entry.title      || '';
	const year       = entry.year       || 'n.d.';
	const journal    = entry.journal    || '';
	const booktitle  = entry.booktitle  || '';
	const publisher  = entry.publisher  || '';
	const address    = entry.address    || '';
	const volume     = entry.volume     || '';
	const number     = entry.number     || '';
	const pages      = entry.pages      || '';
	const chapter    = entry.chapter    || '';
	const school     = entry.school || entry.institution || '';
	const institution= entry.institution || '';
	const howpub     = entry.howpublished || '';
	const edition    = entry.edition    || '';
	const series     = entry.series     || '';
	const note       = entry.note       || '';
	const doi        = entry.doi        || '';
	const url        = entry.url        || '';
	const version    = entry.version    || '';
	const urldate    = entry.urldate || entry.visited || '';

	// Build publisher+address string
	const pubStr = [publisher, address].filter(Boolean).join(', ');

	// Common HTML fragments
	const A   = authors ? `<span class="bib-authors">${eh(authors)}.</span> ` : '';
	const Ed  = editors ? `<span class="bib-authors">${eh(editors)}, ${editors.includes('&') ? 'Eds.' : 'Ed.'}</span> ` : '';
	const Y   = ` <span class="bib-year">(${eh(year)})</span>.`;
	const T   = title ? ` \u201C<span class="bib-title">${eh(title)}</span>.\u201D` : '';
	const TI  = title ? ` <em class="bib-title">${eh(title)}</em>.` : '';   // italic (for books)
	const V   = volume ? `, <strong>${eh(volume)}</strong>` : '';
	const NN  = number ? `(${eh(number)})` : '';
	const PP  = pages  ? (journal ? ':' + eh(pages) : ` pp.\u00A0${eh(pages)}`) : '';
	const DOI = _doiLink(doi);
	const URL = !doi && url ? _urlLink(url) : '';
	const NOTE= note ? ` <span style="color:var(--bib-text-dim)">${eh(note)}.</span>` : '';
	const PUB = pubStr ? ` ${eh(pubStr)}.` : '';
	const SER = series ? ` <em>${eh(series)}</em>.` : '';

	switch (entry.type) {
		case 'article':
			return A + Y + T +
				(journal ? ` <em class="bib-venue">${eh(journal)}</em>` : '') +
				V + NN + PP + '.' + DOI + URL + NOTE;

		case 'book':
			return (authors ? A : Ed) + Y + TI +
				(edition ? ` ${eh(edition)}\u00A0ed.` : '') +
				SER + PUB + DOI + URL + NOTE;

		case 'inproceedings':
		case 'conference':
			return A + Y + T +
				(booktitle ? ` In <em class="bib-venue">${eh(booktitle)}</em>.` : '') +
				(editors   ? ` Ed.\u00A0${eh(_authorsLong(entry.editor))}.` : '') +
				(pages     ? ` pp.\u00A0${eh(pages)}.` : '') +
				PUB + DOI + URL + NOTE;

		case 'proceedings':
			return (authors ? A : Ed) + Y + TI + SER + PUB + DOI + URL + NOTE;

		case 'incollection':
			return A + Y + T +
				(booktitle ? ` In <em class="bib-venue">${eh(booktitle)}</em>` : '') +
				(editors   ? `, ed.\u00A0${eh(_authorsLong(entry.editor))}` : '') +
				(pages     ? `, pp.\u00A0${eh(pages)}` : '') + '.' +
				PUB + DOI + URL + NOTE;

		case 'inbook':
			return A + Y + TI +
				(chapter   ? ` Ch.\u00A0${eh(chapter)}.` : '') +
				(pages     ? ` pp.\u00A0${eh(pages)}.` : '') +
				PUB + DOI + URL + NOTE;

		case 'phdthesis':
			return A + Y + TI +
				' PhD thesis' + (school ? `, ${eh(school)}` : '') + '.' + URL + NOTE;

		case 'mastersthesis':
			return A + Y + TI +
				" Master\u2019s thesis" + (school ? `, ${eh(school)}` : '') + '.' + URL + NOTE;

		case 'techreport':
		case 'report':
			return A + Y + TI +
				' Technical Report' +
				(entry.number ? `\u00A0${eh(entry.number)}` : '') +
				(institution  ? `, ${eh(institution)}`        : '') + '.' +
				URL + NOTE;

		case 'manual':
			return (authors
				? A
				: (entry.organization ? `<span class="bib-authors">${eh(entry.organization)}.</span> ` : '')) +
				Y + TI +
				(entry.organization && authors ? ` ${eh(entry.organization)}.` : '') +
				(edition ? ` ${eh(edition)}\u00A0ed.` : '') +
				URL + NOTE;

		case 'booklet':
			return A + Y + TI + (howpub ? ` ${eh(howpub)}.` : '') + URL + NOTE;

		case 'unpublished':
			return A + Y + T + ' Unpublished manuscript.' + NOTE;

		case 'patent':
			return A + Y + T +
				(entry.number ? ` Patent\u00A0${eh(entry.number)}.` : '') + NOTE;

		case 'misc':
		case 'online':
		case 'electronic':
		case 'www':
		case 'software':
		case 'dataset': {
			let out = (authors ? A : '') + Y;
			if (title)   out += T;
			if (version) out += ` v${eh(version)}.`;
			if (howpub)  out += ` ${eh(howpub)}.`;
			if (doi)     out += DOI;
			else if (url) out += _urlLink(url);
			if (urldate) out += ` [Accessed: ${eh(urldate)}].`;
			if (note)    out += NOTE;
			return out;
		}

		default:
			return (authors ? A : '') + Y + T +
				(journal    ? ` <em>${eh(journal)}</em>.`    : '') +
				(booktitle  ? ` <em>${eh(booktitle)}</em>.`  : '') +
				PUB + DOI + URL + NOTE;
	}
}

// ── Inline source card renderer ─────────────────────────────────────────────

/**
 * Render a single parsed BibTeX entry as a .bib-source-card HTML string.
 * Used when the AI pastes a bare @TYPE{...} block outside a code fence.
 */
function _renderInlineSourceCard(entry, rawText) {
	const key    = entry.id || '';
	const type   = entry.type || '';
	const firstAuthorRaw = (entry.author || entry.editor || '').split(/\s+and\s+/i)[0] || '';
	const authorShort = firstAuthorRaw.includes(',')
		? firstAuthorRaw.split(',')[0].trim()
		: firstAuthorRaw.split(/\s+/).pop() || '';
	const titleShort = entry.title
		? escapeHtml(entry.title.slice(0, 72) + (entry.title.length > 72 ? '\u2026' : ''))
		: '';
	const infoParts = [
		authorShort ? escapeHtml(authorShort) : null,
		titleShort  ? `<em>${titleShort}</em>` : null,
		entry.year  ? escapeHtml(entry.year) : null,
	].filter(Boolean);

	const entryRow =
		`<div class="bib-source-entry">` +
		`<span class="bib-source-entry-key">${escapeHtml(key)}</span>` +
		`<span class="bib-source-entry-info">${infoParts.join(', ')}</span>` +
		`</div>`;

	const rawEscaped = escapeHtml(rawText);

	return (
		`<details class="bib-source-card">` +
		`<summary>` +
		`<span class="bib-source-icon">\uD83D\uDCDA</span>` +
		`<span class="bib-source-title">Bibliography Source</span>` +
		`<span class="bib-source-count">1 entry</span>` +
		`<span class="bib-source-chevron">\u25BC</span>` +
		`</summary>` +
		`<div class="bib-source-entries">${entryRow}</div>` +
		`<div class="bib-source-raw">${rawEscaped}</div>` +
		`</details>`
	);
}


// ── Tooltip HTML builder ──────────────────────────────────────────────────────

function _tooltipHtml(entry) {
	const authors = _authorsShort(entry.author || entry.editor || '');
	const title   = entry.title  || '';
	const year    = entry.year   || 'n.d.';
	const venue   = entry.journal || entry.booktitle || entry.school ||
	                entry.institution || entry.howpublished || '';
	let html = `<div class="bib-tooltip-key">${escapeHtml(entry.id)}</div>`;
	if (authors) html += `<div class="bib-tooltip-authors">${escapeHtml(authors)}</div>`;
	if (title)   html += `<div class="bib-tooltip-title">${escapeHtml(title.slice(0, 120) + (title.length > 120 ? '…' : ''))}</div>`;
	if (venue || year) {
		html += `<div class="bib-tooltip-venue">`;
		if (venue) html += escapeHtml(venue.slice(0, 80) + (venue.length > 80 ? '…' : ''));
		if (venue && year) html += ', ';
		if (year) html += `<span class="bib-tooltip-year">${escapeHtml(year)}</span>`;
		html += `</div>`;
	}
	return html;
}

// ── Bibliography generator ────────────────────────────────────────────────────

/**
 * Generate the complete bibliography HTML for all (or filtered) database entries.
 *
 * @param {object} opts - { style?: string, filter?: (entry) => boolean }
 * @param {Map}    citationNumbers - key → citation number (mutable; determines sort/labels for ieee)
 * @returns {string} HTML string
 */
export function generateBibliography(opts, citationNumbers) {
	const style  = (opts && opts.style)  ? opts.style  : bibliographyStyle;
	const filter = (opts && opts.filter) ? opts.filter : null;
	const cn     = citationNumbers instanceof Map ? citationNumbers : new Map();

	let entries = Array.from(bibliographyDatabase.values());
	if (filter) entries = entries.filter(filter);
	if (!entries.length) return '';

	// ── Sort ──────────────────────────────────────────────────────────────────
	if (style === 'ieee' || style === 'vancouver') {
		// Order of first citation; uncited entries go to the end alphabetically
		entries.sort((a, b) => {
			const na = cn.has(a.id) ? cn.get(a.id) : Infinity;
			const nb = cn.has(b.id) ? cn.get(b.id) : Infinity;
			if (na !== nb) return na - nb;
			return a.id.localeCompare(b.id);
		});
	} else if (style === 'alpha') {
		entries.sort((a, b) => _alphaLabel(a).localeCompare(_alphaLabel(b)));
	} else {
		// All other styles: alphabetical by first author surname, then year
		entries.sort((a, b) => {
			const la = _authorsShort(a.author || a.editor || '').toLowerCase();
			const lb = _authorsShort(b.author || b.editor || '').toLowerCase();
			const cmp = la.localeCompare(lb);
			if (cmp !== 0) return cmp;
			return (a.year || '').localeCompare(b.year || '');
		});
	}

	const count = entries.length;
	const isAuthorYear = ['authoryear','apa','chicago','harvard','mla'].includes(style);

	let html = `<div class="latex-bibliography style-${escapeHtml(style)}">` +
		`<div class="latex-bibliography-header">` +
		`<span class="latex-bibliography-header-icon">📚</span>` +
		`<span>References</span>` +
		`<span class="latex-bibliography-header-count">${count} entr${count === 1 ? 'y' : 'ies'}</span>` +
		`</div>`;

	entries.forEach((entry, idx) => {
		let label;
		if (style === 'alpha') {
			label = '[' + _alphaLabel(entry) + ']';
		} else if (isAuthorYear) {
			label = '';
		} else {
			// Numbered: use citation-order number when available, else sequential
			const n = cn.has(entry.id) ? cn.get(entry.id) : idx + 1;
			label = '[' + n + ']';
		}

		const anchorId = 'cite-entry-' + entry.id.replace(/[^a-zA-Z0-9_-]/g, '_');

		html += `<div class="latex-bibliography-entry" id="${anchorId}" data-cite-key="${escapeHtml(entry.id)}">`;
		if (!isAuthorYear) {
			html += `<div class="bib-label-col"><span class="bib-number">${escapeHtml(label)}</span></div>`;
		}
		html += `<div class="bib-content-col">${_renderEntryBody(entry)}${_typeBadge(entry.type)}</div>`;
		html += `</div>`;
	});

	html += '</div>';
	return html;
}

// ── Citation inline renderer ──────────────────────────────────────────────────

/**
 * Render a set of citation keys to HTML according to the command and style.
 *
 * @param {string[]} keys           - Citation keys
 * @param {string}   command        - Cite command (e.g. 'cite', 'citet', 'citeauthor')
 * @param {Map}      citationNumbers - Per-render citation numbering map (mutable)
 * @param {string}   style          - Bibliography style
 * @param {string}   [preNote]      - Optional prenote text
 * @param {string}   [postNote]     - Optional postnote text
 * @returns {string} HTML string
 */
function _renderCitation(keys, command, citationNumbers, style, preNote, postNote) {
	if (!keys.length) return '';

	const isNumbered = !['authoryear','apa','harvard','chicago','mla'].includes(style);

	// Assign citation numbers for numbered styles in order of first appearance
	if (isNumbered) {
		keys.forEach(key => {
			if (!citationNumbers.has(key)) {
				citationNumbers.set(key, citationNumbers.size + 1);
			}
		});
	}

	const entries = keys.map(k => bibliographyDatabase.get(k) || null);

	// Build a single cited label for one entry
	const makeLabel = (entry, key) => {
		if (!entry) {
			return `<span class="latex-citation-missing" title="Citation key \u2018${escapeHtml(key)}\u2019 not found in bibliography">${escapeHtml(key)}\u00A0\u26A0</span>`;
		}
		// Resolve a valid external URL/DOI for this entry (may be null).
		// When null we render a non-navigating <span> so the SPA hash router
		// is never triggered by a bare '#cite-entry-…' href.
		const paperHref = resolveEntryHref(entry);
		const target = paperHref ? ' target="_blank" rel="noopener noreferrer"' : '';
		const tipHtml   = _tooltipHtml(entry);
		const tipAttr   = ` data-bib-tooltip="${escapeHtml(tipHtml)}" data-cite-key="${escapeHtml(key)}"`;

		// When there's no valid external link, use a non-navigating <span>
		const wrapLink = (inner) => paperHref
			? `<a class="latex-citation-link" href="${escapeHtml(paperHref)}"${target}${tipAttr}>${inner}</a>`
			: `<span class="latex-citation-link"${tipAttr}>${inner}</span>`;

		if (style === 'alpha') {
			return wrapLink(escapeHtml(_alphaLabel(entry)));
		}
		if (isNumbered) {
			const n = citationNumbers.get(key) || '?';
			return wrapLink(String(n));
		}
		// Author-year
		const auth = _authorsShort(entry.author || entry.editor || '');
		const yr   = entry.year || 'n.d.';
		return wrapLink(escapeHtml(auth) + '\u00A0' + escapeHtml(yr));
	};

	const preStr  = preNote  ? escapeHtml(preNote) + '\u00A0'  : '';
	const postStr = postNote ? ',\u00A0' + escapeHtml(postNote) : '';

	const cmd = command.toLowerCase();

	// ── \citeauthor / \Citeauthor ───────────────────────────────────────────
	if (cmd === 'citeauthor') {
		return entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const anchorId = 'cite-entry-' + keys[i].replace(/[^a-zA-Z0-9_-]/g, '_');
			const tipAttr  = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const _aHref2 = resolveEntryHref(e);
			const _aTgt2  = _aHref2 ? ' target="_blank" rel="noopener noreferrer"' : '';
			const _aInner2 = escapeHtml(_authorsShort(e.author || e.editor || ''));
			return _aHref2
				? `<a class="latex-citation-link" href="${escapeHtml(_aHref2)}"${_aTgt2}${tipAttr}>${_aInner2}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${_aInner2}</span>`;
		}).join(', ');
	}

	// ── \citeyear / \citeyearpar ─────────────────────────────────────────────
	if (cmd === 'citeyear' || cmd === 'citeyearpar') {
		const yrs = entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const _yId   = 'cite-entry-' + keys[i].replace(/[^a-zA-Z0-9_-]/g, '_');
			const _yHref = resolveEntryHref(e);
			const _yTgt  = _yHref ? ' target="_blank" rel="noopener noreferrer"' : '';
			const tipAttr  = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const _yInner = escapeHtml(e.year || 'n.d.');
			return _yHref
				? `<a class="latex-citation-link" href="${escapeHtml(_yHref)}"${_yTgt}${tipAttr}>${_yInner}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${_yInner}</span>`;
		});
		const inner = yrs.join(', ');
		return cmd === 'citeyearpar' ? `(${inner})` : inner;
	}

	// ── \citet / \textcite — "Author [N]" or "Author (Year)" ────────────────
	if (cmd === 'citet' || cmd === 'textcite' || cmd === 'citet*' || cmd === 'textcite*') {
		return entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const anchorId = 'cite-entry-' + keys[i].replace(/[^a-zA-Z0-9_-]/g, '_');
			const tipAttr  = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const auth     = _authorsShort(e.author || e.editor || '');
			if (isNumbered) {
				const n = citationNumbers.get(keys[i]) || '?';
				const _hrefT = resolveEntryHref(e);
				const _tgtT  = _hrefT ? ' target="_blank" rel="noopener noreferrer"' : '';
				const _nEl   = _hrefT
					? `<a class="latex-citation-link" href="${escapeHtml(_hrefT)}"${_tgtT}${tipAttr}>${n}</a>`
					: `<span class="latex-citation-link"${tipAttr}>${n}</span>`;
				return `${escapeHtml(auth)}\u00A0${_nEl}`;
			}
			// author-year: link to paper URL/DOI if available, else plain span
			const _hrefAY = resolveEntryHref(e);
			const _tgtAY  = _hrefAY ? ' target="_blank" rel="noopener noreferrer"' : '';
			const _ayInner = `(${escapeHtml(e.year || 'n.d.')}${postStr})`;
			const _ayEl = _hrefAY
				? `<a class="latex-citation-link" href="${escapeHtml(_hrefAY)}"${_tgtAY}${tipAttr}>${_ayInner}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${_ayInner}</span>`;
			return `${escapeHtml(auth)}\u00A0${_ayEl}`;
		}).join('; ');
	}

	// ── \footcite / \footcitetext ─────────────────────────────────────────────
	if (cmd === 'footcite' || cmd === 'footcitetext') {
		const full = entries.map((e, i) => e
			? _authorsShort(e.author || e.editor || '') + (e.year ? ' (' + e.year + ')' : '') + (e.title ? '. ' + e.title : '')
			: keys[i]
		).join('; ');
		return `<sup class="latex-footnote-cite" title="${escapeHtml(full)}">[note]</sup>`;
	}

	// ── \fullcite ─────────────────────────────────────────────────────────────
	if (cmd === 'fullcite') {
		return entries.map((e, i) => e
			? `<span class="latex-citation" style="display:block;margin:0.25em 0">${_renderEntryBody(e)}</span>`
			: `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`
		).join('');
	}

	// ── \nocite ───────────────────────────────────────────────────────────────
	if (cmd === 'nocite') return '';

	// ── Default: \cite, \citep, \parencite, \autocite, etc. ──────────────────
	const labels = keys.map((k, i) => makeLabel(entries[i], k));
	if (isNumbered || style === 'alpha') {
		// CSS badge box provides visual enclosure; no literal [ ] needed
		return `${preStr}${labels.join(', ')}${postStr}`;
	}
	return `(${preStr}${labels.join('; ')}${postStr})`;
}

// ── thebibliography / \bibitem environment ────────────────────────────────────

function _processThebibliography(text) {
	return text.replace(
		/\\begin\{thebibliography\}\s*\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/g,
		(_, body) => {
			const items = [];
			const itemRx = /\\bibitem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|$)/g;
			let m;
			while ((m = itemRx.exec(body)) !== null) {
				items.push({
					label:   m[1] || '',
					key:     m[2].trim(),
					content: m[3].trim(),
				});
			}
			if (!items.length) return body;

			const count = items.length;
			let html = `<div class="latex-thebibliography">` +
				`<div class="latex-bibliography-header">` +
				`<span class="latex-bibliography-header-icon">📚</span>` +
				`<span>References</span>` +
				`<span class="latex-bibliography-header-count">${count} entr${count === 1 ? 'y' : 'ies'}</span>` +
				`</div>`;

			items.forEach((item, idx) => {
				const anchorId = 'cite-entry-' + item.key.replace(/[^a-zA-Z0-9_-]/g, '_');
				const labelStr = item.label || String(idx + 1);
				html += `<div class="latex-bibitem" id="${anchorId}" data-cite-key="${escapeHtml(item.key)}">` +
					`<span class="latex-bibitem-label">[${escapeHtml(labelStr)}]</span>` +
					`<span class="latex-bibitem-content">${item.content}</span>` +
					`</div>`;
			});

			return html + '</div>';
		}
	);
}

// ── Main bibliography processor ───────────────────────────────────────────────

/**
 * Process all BibTeX-related commands in a preprocessed text string.
 * Called at Step 4 of preprocessLatexText.
 *
 * Creates a fresh per-render citationNumbers Map so each message starts its
 * own citation ordering — this is correct for numbered styles.
 *
 * Returns the processed text with all bibliography commands replaced by HTML.
 */
export function processBibliography(text) {
	if (!text) return text;

	// Per-render state
	const citationNumbers = new Map();
	const style = bibliographyStyle;
	let hasPrintBib = false;

	let p = text;

	// ── 1. thebibliography environment ──────────────────────────────────────
	p = _processThebibliography(p);

	// ── 2. Inline raw @TYPE{...} entries ────────────────────────────────────────────────
	// Depth-aware single-pass scan: finds @TYPENAME{...} blocks anywhere in text,
	// parses them into the DB, and replaces them with rendered source cards.
	// This covers entries pasted bare in plain text (outside any code fence).
	{
		const _ENTRY_TYPES = 'article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|manual|booklet|proceedings|inbook|unpublished|patent|dataset|software|report';
		const _inlineRx = new RegExp('@(?:' + _ENTRY_TYPES + ')\\s*[\\{(]', 'gi');
		let _em2, _out2 = '', _last2 = 0;
		_inlineRx.lastIndex = 0;
		while ((_em2 = _inlineRx.exec(p)) !== null) {
			const _startIdx = _em2.index;
			const _openCh   = _em2[0].slice(-1); // '{' or '('
			const _openIdx  = _startIdx + _em2[0].length - 1;
			// Find matching close delimiter (depth-aware)
			let _depth2 = 1, _closeIdx2 = -1;
			for (let _ci = _openIdx + 1; _ci < p.length; _ci++) {
				const _ch = p[_ci];
				if (_ch === '\\') { _ci++; continue; } // skip escaped
				if (_openCh === '{' && _ch === '{') _depth2++;
				else if (_openCh === '{' && _ch === '}') { _depth2--; if (_depth2 === 0) { _closeIdx2 = _ci; break; } }
				else if (_openCh === '(' && _ch === '(') _depth2++;
				else if (_openCh === '(' && _ch === ')') { _depth2--; if (_depth2 === 0) { _closeIdx2 = _ci; break; } }
			}
			if (_closeIdx2 === -1) continue; // unmatched — skip
			const _entryText2 = p.slice(_startIdx, _closeIdx2 + 1);
			const _entry2 = parseBibtexEntry(_entryText2);
			if (_entry2 && _entry2.id) {
				bibliographyDatabase.set(_entry2.id, _entry2);
				_out2 += p.slice(_last2, _startIdx);
				_out2 += _renderInlineSourceCard(_entry2, _entryText2);
				_last2 = _closeIdx2 + 1;
				_inlineRx.lastIndex = _last2; // skip past what we consumed
			}
		}
		p = _out2 + p.slice(_last2);
	}

		// ── 3. Silently consume resource / style declarations ────────────────────
	p = p.replace(/\\addbibresource\s*\{[^}]+\}/g, '');
	p = p.replace(/\\bibliographystyle\s*\{([^}]+)\}/g, (_, s) => {
		bibliographyStyle = s.toLowerCase();
		return '';
	});

	// ── 4. \bibliography{file} ───────────────────────────────────────────────
	p = p.replace(/\\bibliography\s*\{([^}]+)\}/g, (_, files) => {
		hasPrintBib = true;
		if (bibliographyDatabase.size > 0) {
			return generateBibliography({}, citationNumbers);
		}
		return `<div class="latex-bibliography-note"><em>Bibliography source: ${escapeHtml(files)}</em></div>`;
	});

	// ── 5. All citation commands ─────────────────────────────────────────────
	//
	// Unified regex covering all natbib, BibLaTeX, and custom cite commands.
	// Handles:
	//   \cmd{keys}
	//   \cmd[postnote]{keys}
	//   \cmd[prenote][postnote]{keys}
	//   \cmd*{...}  (starred variants)
	//   Multiple keys: \cite{key1,key2,key3}
	//
	const CITE_RX = /\\(cite[a-zA-Z]*|textcite|Textcite|parencite|Parencite|autocite|Autocite|footcite|footcitetext|fullcite|supercite|volcite|Volcite|notecite|Notecite|pnotecite|Pnotecite|fnotecite|Fnotecite)\*?\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;

	p = p.replace(CITE_RX, (_, cmd, bracketA, bracketB, keysRaw) => {
		const keys     = keysRaw.split(/\s*,\s*/).map(k => k.trim()).filter(Boolean);
		// Two optional brackets: [prenote][postnote]; one: [postnote]
		const preNote  = bracketB !== undefined ? (bracketA || '') : '';
		const postNote = bracketB !== undefined ? (bracketB || '') : (bracketA || '');
		return _renderCitation(keys, cmd, citationNumbers, style, preNote, postNote);
	});

	// ── 6. \printbibliography ────────────────────────────────────────────────
	p = p.replace(
		/\\printbibliography\s*(?:\[([^\]]*)\])?/g,
		(_, optStr) => {
			hasPrintBib = true;
			const opts = {};
			if (optStr) {
				const sm = optStr.match(/style\s*=\s*(\w+)/);
				if (sm) opts.style = sm[1].toLowerCase();
				const tm = optStr.match(/type\s*=\s*(\w+)/);
				if (tm) opts.filter = e => e.type === tm[1].toLowerCase();
				const km = optStr.match(/keyword\s*=\s*(\w+)/);
				if (km) {
					const kw = km[1].toLowerCase();
					opts.filter = e => (e.keywords || '').toLowerCase().includes(kw);
				}
				// nottype= filter
				const ntm = optStr.match(/nottype\s*=\s*(\w+)/);
				if (ntm) opts.filter = e => e.type !== ntm[1].toLowerCase();
			}
			return generateBibliography(opts, citationNumbers);
		}
	);

	// ── 7. Auto-bibliography ─────────────────────────────────────────────────
	// If citations were made but no \printbibliography / \bibliography command
	// appeared, automatically append a bibliography section.
	if (citationNumbers.size > 0 && !hasPrintBib && bibliographyDatabase.size > 0) {
		p += '\n\n' + generateBibliography({}, citationNumbers);
	}

	return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation hover tooltip initialiser
//
// Call once after the chat page DOM is ready (e.g. from chat-page.js).
// The tooltip element is appended to <body> and positioned via JS on
// mouseover of any [data-bib-tooltip] element.
// Also exported so callers can re-init if needed (e.g. after a full
// page re-render).
// ─────────────────────────────────────────────────────────────────────────────

let _tooltipEl = null;

export function initBibTooltips() {
	if (typeof window === 'undefined' || typeof document === 'undefined') return;

	// Create tooltip element (only once)
	if (!_tooltipEl) {
		_tooltipEl = document.createElement('div');
		_tooltipEl.className = 'bib-tooltip';
		_tooltipEl.setAttribute('aria-hidden', 'true');
		_tooltipEl.setAttribute('role', 'tooltip');
		document.body.appendChild(_tooltipEl);
	}

	let _hideTimer = null;

	const show = (e) => {
		const target = e.target && e.target.closest
			? e.target.closest('[data-bib-tooltip]')
			: null;
		if (!target) return;
		clearTimeout(_hideTimer);
		_tooltipEl.innerHTML = target.dataset.bibTooltip || '';
		_tooltipEl.classList.add('visible');
		_positionTooltip(e.clientX, e.clientY);
	};

	const move = (e) => {
		if (_tooltipEl.classList.contains('visible')) {
			_positionTooltip(e.clientX, e.clientY);
		}
	};

	const hide = (e) => {
		if (!e.target || !e.target.closest || !e.target.closest('[data-bib-tooltip]')) return;
		_hideTimer = setTimeout(() => {
			_tooltipEl && _tooltipEl.classList.remove('visible');
		}, 150);
	};

	// Remove previous listeners by using capture-phase identifiers
	document.removeEventListener('mouseover', _bibTooltipOver,  true);
	document.removeEventListener('mousemove', _bibTooltipMove,  true);
	document.removeEventListener('mouseout',  _bibTooltipOut,   true);

	_bibTooltipOver = show;
	_bibTooltipMove = move;
	_bibTooltipOut  = hide;

	document.addEventListener('mouseover', _bibTooltipOver, true);
	document.addEventListener('mousemove', _bibTooltipMove, true);
	document.addEventListener('mouseout',  _bibTooltipOut,  true);
}

// Module-level references to allow cleanup/re-init
let _bibTooltipOver = null;
let _bibTooltipMove = null;
let _bibTooltipOut  = null;

function _positionTooltip(cx, cy) {
	if (!_tooltipEl) return;
	const margin = 14;
	const tw = _tooltipEl.offsetWidth  || 320;
	const th = _tooltipEl.offsetHeight || 80;
	let x = cx + margin;
	let y = cy + margin;
	const vw = window.innerWidth  || document.documentElement.clientWidth  || 800;
	const vh = window.innerHeight || document.documentElement.clientHeight || 600;
	if (x + tw > vw - 8) x = Math.max(4, cx - tw - margin);
	if (y + th > vh - 8) y = Math.max(4, cy - th - margin);
	_tooltipEl.style.left = x + 'px';
	_tooltipEl.style.top  = y + 'px';
}

// Auto-init when the DOM is ready
if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initBibTooltips);
	} else {
		// DOM already ready (module loaded late)
		initBibTooltips();
	}
}
