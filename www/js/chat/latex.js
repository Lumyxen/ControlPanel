/**
 * Comprehensive LaTeX math & structural renderer (v2)
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
 *   • Spacing: \vspace, \hspace, \\medskip, \bigskip, \smallskip, \noindent
 *   • Typography: \ldots/\dots/\cdots, \textquoteleft/right,
 *     \enquote, \guillemets, ligature replacements (-- / --- / ~)
 *   • Special escaped characters: \& \% \$ \# \_ \{ \}  \^ \~
 *   • Hyperlinks: \url, \href
 *   • Footnotes: \footnote
 *   • Cross-references: \label, \ref, \eqref, \pageref, \nameref, \autoref
 *   • Citations: \cite, \citet, \citep, \citeauthor, \citeyear, \citeyearpar,
 *     \citealt, \nocite
 *   • Natbib & BibLaTeX citation variants
 *   • Glossaries: \gls, \glspl, \Gls, \GLS, \glsentrylong, \acrshort, \acrlong
 *   • BibTeX support: parsing, citation rendering, bibliography generation
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
		// Also load the auto-render extension so environments render properly
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
	// Only load if KaTeX is explicitly absent and MathJax isn't already configured
	if (!window.MathJax && !document.getElementById('mathjax-script')) {
		// Configure MathJax before the script loads
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
			startup: { typeset: false }, // We handle typesetting manually
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

/**
 * MATH_REGEX — matches every common math delimiter combination:
 *
 *  Display:
 *    $$...$$
 *    \[...\]
 *    \begin{displaymath}...\end{displaymath}
 *    \begin{equation(*)}...\end{equation(*)}
 *    \begin{align(*)}...\end{align(*)}
 *    \begin{gather(*)}...\end{gather(*)}
 *    \begin{multline(*)}...\end{multline(*)}
 *    \begin{flalign(*)}...\end{flalign(*)}
 *    \begin{alignat(*){n}}...\end{alignat(*)}
 *    \begin eqnarray(*)}...\end{eqarray(*)}
 *    \begin{subequations}...\end{subequations}
 *    \begin{split}...\end{split}
 *    \begin{(b|p|v|V|B)?matrix}...\end{...matrix}
 *    \begin{smallmatrix}...\end{smallmatrix}
 *    \begin{cases}...\end{cases}
 *    \begin{dcases}...\end{dcases}
 *    \begin{rcases}...\end{rcases}
 *
 *  Inline:
 *    $...$   (not $$ and not whitespace-bordered)
 *    \(...\)
 *    \begin{math}...\end{math}
 *
 * Uses backreference \1 so \begin{X}...\end{X} is strictly paired.
 */
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

// Build a single regex with all the variants
const MATH_REGEX = new RegExp(
	// Display: $$...$$
	'\\$\\$[\\s\\S]*?\\$\\$' +
	// Display: \[...\]
	'|\\\\\\[[\\s\\S]*?\\\\\\]' +
	// Inline: \(...\)
	'|\\\\\\([\\s\\S]*?\\\\\\)' +
	// Inline: $...$ — not $$, not starting/ending with whitespace
	// Uses negative lookahead/lookbehind to avoid matching $$
	'|(?<!\$)\$(?!\$)(?:\\\\.|[^\n$])+?(?<!\s)\$(?!\$)' +
	// Named environments — backreference ensures matching pairs
	'|\\\\begin\\{(' + MATH_ENV_NAMES + ')(?:\\{[^}]*\\})?\\}[\\s\\S]*?\\\\end\\{\\1(?:\\*)?\\}',
	'g'
);

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(text) {
	if (!text) return '';
	return text
		.replace(/&/g,  '&')
		.replace(/</g,  '<')
		.replace(/>/g,  '>')
		.replace(/"/g,  '"')
		.replace(/'/g,  '&#39;');
}

/**
 * Determine whether a math match is display-mode or inline.
 * Handles all recognised delimiter prefixes.
 */
function isDisplayMode(match) {
	// $$ or \[ or \begin{displaymath} or any of the multi-line environments
	if (match.startsWith('$$'))             return true;
	if (match.startsWith('\\['))            return true;
	if (/^\\begin\{(?:displaymath|equation|align|gather|multline|flalign|alignat|eqnarray|subequations|split|[bpvVB]?matrix|smallmatrix|cases|dcases|rcases)/.test(match)) return true;
	// \begin{math}...\end{math} is inline
	if (match.startsWith('\\begin{math}')) return false;
	// \(...\) is inline; $...$ is inline
	return false;
}

/**
 * Strip outer delimiters to get the raw LaTeX content for KaTeX/MathJax.
 * For named \begin...\end environments we pass the whole string so KaTeX
 * can render the environment natively.
 */
function extractMathContent(match) {
	if (match.startsWith('$$'))    return match.slice(2, -2);
	if (match.startsWith('\\['))   return match.slice(2, -2);
	if (match.startsWith('\\('))   return match.slice(2, -2);
	if (match.startsWith('$'))     return match.slice(1, -1);
	// For all \begin{...}...\end{...} pass verbatim — KaTeX handles them
	return match;
}

// ─────────────────────────────────────────────────────────────────────────────
// Algorithm formatter (for \begin{algorithmic}...\end{algorithmic}
//                       and \begin{algorithm2e}...\end{algorithm2e})
// ─────────────────────────────────────────────────────────────────────────────

function formatAlgorithmic(content) {
	const lines = content.split('\n');
	let html = '<div class="latex-algorithm">';
	let indentLevel = 0;

	for (let raw of lines) {
		let line = raw.trim();
		if (!line) continue;

		// ── Decrease indent before rendering these ──
		if (/^\\(EndIf|EndFor|EndWhile|EndFunction|EndProcedure|Until|Else|ElsIf|Elsif|uElse|uElsIf)\b/.test(line)) {
			indentLevel = Math.max(0, indentLevel - 1);
		}

		const pad = indentLevel * 20;

		// ── algorithm2e style ──
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

		// ── algorithmicx / algpseudocode style ──
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
		line = line.replace(/\\tcp\*?\{([^}]+)\}/g,        '<span class="alg-comment">// $1</span>');  // algorithm2e style comment

		html += `<div class="alg-line" style="padding-left:${pad}px">${line}</div>`;

		// ── Increase indent after block-opening keywords ──
		if (/class="alg-keyword">(if|else if|else|for|foreach|for all|while|loop|repeat|function|procedure)\b/.test(line)) {
			indentLevel++;
		}
	}

	html += '</div>';
	return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table formatter
// Supports: tabular, tabularx, longtable — booktabs rules, \multicolumn,
// \multirow (with * width), \cline, row-coloring (\rowcolor)
// ─────────────────────────────────────────────────────────────────────────────

function formatTabular(body, isLong = false) {
	// Strip booktabs and hline/cline decorators
	let clean = body
		.replace(/\\toprule(\[.*?\])?/g,  '')
		.replace(/\\midrule(\[.*?\])?/g,  '')
		.replace(/\\bottomrule(\[.*?\])?/g, '')
		.replace(/\\hline/g,              '')
		.replace(/\\cline\{[\d-]+\}/g,    '')
		.replace(/\\cmidrule(\(.*?\))?\{[\d-]+\}/g, '')
		.replace(/\\specialrule\{.*?\}\{.*?\}\{.*?\}/g, '');

	// Strip \rowcolor{...} (row background — not easily translatable to plain HTML here)
	clean = clean.replace(/\\rowcolor(\[.*?\])?\{[^}]*\}/g, '');
	// Strip \cellcolor too
	clean = clean.replace(/\\cellcolor(\[.*?\])?\{[^}]*\}/g, '');

	const rows = clean.split('\\\\').filter(r => r.trim());
	const cls = isLong ? 'latex-table longtable' : 'latex-table';
	let html = `<div class="latex-table-wrapper"><table class="${cls}"><tbody>`;

	for (const row of rows) {
		html += '<tr>';
		// Split cells on & but not on \& (escaped ampersand)
		const cells = row.split(/(?<!\\)&/);

		for (let cell of cells) {
			cell = cell.trim();
			let colspan = 1, rowspan = 1, align = '';

			// \multicolumn{n}{align}{content}
			const mcM = cell.match(/^\\multicolumn\{(\d+)\}\{([^}]*)\}\{([\s\S]*)\}$/);
			if (mcM) {
				colspan = parseInt(mcM[1], 10);
				align   = mcM[2].includes('c') ? 'center' : mcM[2].includes('r') ? 'right' : 'left';
				cell    = mcM[3];
			}

			// \multirow{n}{width}{content} — width can be * or a length
			const mrM = cell.match(/^\\multirow\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
			if (mrM) {
				rowspan = parseInt(mrM[1], 10);
				cell    = mrM[2];
			}

			// Inline formatting inside cells
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
// Handles text-mode commands that can appear inside table cells, captions, etc.
// ─────────────────────────────────────────────────────────────────────────────

function applyInlineFormatting(text) {
	// Font weight / style
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
	text = text.replace(/\\sout\{([^}]+)\}/g,         '<s>$1</s>');    // ulem package
	text = text.replace(/\\xout\{([^}]+)\}/g,         '<s>$1</s>');
	text = text.replace(/\\uwave\{([^}]+)\}/g,        '<u style="text-decoration:underline wavy">$1</u>');

	// Color
	text = text.replace(/\\textcolor\{([^}]+)\}\{([^}]+)\}/g,       '<span style="color:$1">$2</span>');
	text = text.replace(/\\colorbox\{([^}]+)\}\{([^}]+)\}/g,        '<span style="background:$1;padding:0 2px">$2</span>');
	text = text.replace(/\\fcolorbox\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, '<span style="border:1px solid $1;background:$2;padding:0 2px">$3</span>');

	// Boxes
	text = text.replace(/\\fbox\{([^}]+)\}/g,         '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>');
	text = text.replace(/\\mbox\{([^}]+)\}/g,         '<span style="white-space:nowrap">$1</span>');
	text = text.replace(/\\framebox(?:\[.*?\])?\{([^}]+)\}/g, '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>');
	text = text.replace(/\\raisebox\{[^}]+\}\{([^}]+)\}/g,   '<span style="vertical-align:super;font-size:0.75em">$1</span>');

	// Hyperlinks
	text = text.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g,  '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>');
	text = text.replace(/\\url\{([^}]+)\}/g,               '<a href="$1" target="_blank" rel="noopener noreferrer" class="latex-url">$1</a>');
	text = text.replace(/\\nolinkurl\{([^}]+)\}/g,         '<code class="latex-url">$1</code>');

	// Footnotes (inline rendering as superscript with title)
	text = text.replace(/\\footnote\{([^}]+)\}/g,
		'<sup class="latex-footnote" title="$1">[note]</sup>');

	// Special escaped characters
	text = text.replace(/\\&/g,    '&');
	text = text.replace(/\\%/g,    '%');
	text = text.replace(/\\\$/g,   '$');
	text = text.replace(/\\#/g,    '#');
	text = text.replace(/\\_/g,    '_');
	text = text.replace(/\\\{/g,   '{');
	text = text.replace(/\\\}/g,   '}');
	text = text.replace(/\\\^{}/g, '^');
	text = text.replace(/\\~{}/g,  '~');

	// Typography / dashes / quotes
	text = text.replace(/\\ldots\b/g,               '…');
	text = text.replace(/\\dots\b/g,                '…');
	text = text.replace(/\\cdots\b/g,               '⋯');
	text = text.replace(/\\vdots\b/g,               '⋮');
	text = text.replace(/\\ddots\b/g,               '⋱');
	text = text.replace(/---/g,                     '—');
	text = text.replace(/--/g,                      '–');
	text = text.replace(/``/g,                      '「');
	text = text.replace(/''/g,                      '」');
	text = text.replace(/`/g,                       '『');
	text = text.replace(/\\textquoteleft\b/g,       '『');
	text = text.replace(/\\textquoteright\b/g,      '』');
	text = text.replace(/\\enquote\{([^}]+)\}/g,    '「$1」');
	text = text.replace(/\\guillemotleft\b/g,       '«');
	text = text.replace(/\\guillemotright\b/g,      '»');
	text = text.replace(/\\glqq\b/g,               '„');
	text = text.replace(/\\grqq\b/g,               '"');
	text = text.replace(/\\glq\b/g,                '\u201A');
	text = text.replace(/\\grq\b/g,                '\u2018');
	text = text.replace(/\\tilde\{([^}]+)\}/g,      '$1̃');
	text = text.replace(/\\today\b/g,               new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));

	// Misc symbols
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

	// Spacing macros (mostly remove, but add thin space where relevant)
	text = text.replace(/\\,/g,       '\u2009'); // thin space
	text = text.replace(/\\;/g,       '\u2002'); // en space
	text = text.replace(/\\:/g,       '\u205F'); // medium math space
	text = text.replace(/\\!/g,       '');       // negative thin space
	text = text.replace(/\\ /g,       '\u00A0'); // non-breaking space
	text = text.replace(/~(?!\w)/g,   '\u00A0'); // tilde as NBSP (when not followed by word char)
	text = text.replace(/\\quad\b/g,  '\u2003'); // em space
	text = text.replace(/\\qquad\b/g, '\u2003\u2003');

	// Accents
	text = text.replace(/\\'([aeiouAEIOU])/g, (_, c) => c.normalize ? (c + '\u0301').normalize('NFC') : c);
	text = text.replace(/\\`([aeiouAEIOU])/g, (_, c) => (c + '\u0300').normalize('NFC'));
	text = text.replace(/\\"([aeiouAEIOU])/g, (_, c) => (c + '\u0308').normalize('NFC'));
	text = text.replace(/\\c\{([cC])\}/g, (_, c) => (c + '\u0327').normalize('NFC'));
	text = text.replace(/\\v\{([a-zA-Z])\}/g, (_, c) => (c + '\u030C').normalize('NFC'));

	// Clean empty braces left over from macros
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

/** Named theorem-class environments with optional \label{...} on the same line */
const THEOREM_ENVS = [
	// [envName,      calloutType,  icon,  displayTitle]
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
 *  1. Protect code blocks
 *  2. Protect math blocks
 *  3. Apply text-mode transformations
 *  4. Restore math then code
 */
export function preprocessLatexText(text) {
	if (!text) return '';

	// Normalise non-standard delimiter variants before anything else
	text = normaliseMathDelimiters(text);

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
		// 'bibliographystyle', 'bibliography', 'addbibresource', // Now handled by processBibliography
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
	// \printbibliography is now handled by processBibliography() below
	p = p.replace(/\\appendix\b/g,         '\n---\n### Appendix\n');

	// === Document wrappers ===
	p = p.replace(/\\begin\{document\}/g, '');
	p = p.replace(/\\end\{document\}/g,   '');
	p = p.replace(/\\begin\{abstract\}/g, makeCallout('note', '📄', 'Abstract'));
	p = p.replace(/\\end\{abstract\}/g,   CALLOUT_END);

	// === Theorem-class environments ===
	// Support optional starred variant and optional title arg: \begin{theorem}[Title]
	for (const [env, type, icon, title] of THEOREM_ENVS) {
		// With optional title: \begin{theor em}[Custom Title]
		p = p.replace(
			new RegExp(`\\\\begin\\{${env}\\*?\\}(?:\\[([^\\]]+)\\])?(?:\\\\label\\{[^}]+\\})?`, 'g'),
			(_, customTitle) => makeCallout(type, icon, customTitle ? `${title}: ${customTitle}` : title)
		);
		p = p.replace(new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g'), CALLOUT_END);
	}

	// === Proof environment (special: ends with QED box □) ===
	p = p.replace(/\\begin\{proof\}(?:\[([^\]]+)\])?/g, (_, hint) =>
		makeCallout('note', '📝', hint ? `Proof (${hint})` : 'Proof')
	);
	p = p.replace(/\\end\{proof\}/g, '\n\n<span class="latex-qed">□</span>' + CALLOUT_END);

	// \\qed and \\QED standalone
	p = p.replace(/\\(?:qed|QED)\b/g, '<span class="latex-qed">□</span>');

	// === Algorithm environments ===
	p = p.replace(/\\begin\{algorithm\}(?:\[.*?\])?(?:\{([^}]*)\})?/g, (_, title) =>
		makeCallout('example', '⚙️', title || 'Algorithm')
	);
	p = p.replace(/\\end\{algorithm\}/g, CALLOUT_END);

	// algorithm2e
	p = p.replace(/\\begin\{algorithm2e\}(?:\[.*?\])?/g, makeCallout('example', '⚙️', 'Algorithm'));
	p = p.replace(/\\end\{algorithm2e\}/g,                CALLOUT_END);

	// \caption inside algorithm (move to title)
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
	p = p.replace(/\\frame title\{([^}]+)\}/g, '**$1**\n');
	p = p.replace(/\\framesubtitle\{([^}]+)\}/g, '*$1*\n');
	p = p.replace(/\\end\{frame\}/g, CALLOUT_END);
	p = p.replace(/\\begin\{block\}\{([^}]+)\}/g, makeCallout => `\n\n**$1**\n\n`);
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
	// Handled here so their content isn't touched by inline formatters
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
	// \verb|...|  and  \verb!...!  and other single-char delimiters
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
	// Array environment inside math — normally handled by KaTeX, but if it leaks into text mode:
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

	// === Sectioning — \part through \subparagraph ===
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
	// Simple flat conversion; good enough for typical display usage
	// Nested lists are a hard problem without a full parser; we indent by detecting depth.
	function convertList(body, ordered) {
		// Replace \item[label] and \item
		let result = body
			.replace(/\\item\s*\[([^\]]+)\]/g, ordered ? '\n1. **$1** ' : '\n- **$1** ')
			.replace(/\\item\b/g,              ordered ? '\n1. '         : '\n- ');
		return result;
	}

	// We process inner lists first to handle nesting (innermost wins)
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
		// tasks package  (\task = \item equivalent)
		p = p.replace(/\\begin\{tasks\}(?:\[.*?\])?(?:\(\d+\))?([\s\S]*?)\\end\{tasks\}/g,
			(_, body) => body.replace(/\\task\b/g, '\n- ') + '\n');
		// checklist-style — \checkitem / \uncheckitem
		p = p.replace(/\\begin\{checklist\}([\s\S]*?)\\end\{checklist\}/g,
			(_, body) => body
				.replace(/\\checkitem\b/g, '\n- [x]')
				.replace(/\\uncheckitem\b/g, '\n- [ ]') + '\n'
		);
	}

	// === Inline Formatting (non-table context) ===
	p = applyInlineFormatting(p);

	// === Font size commands — map to styled spans ===
	const fontSizes = [
		['\\\\tiny',         '0.6em'],
		['\\\\scriptsiz e',   '0.7em'],
		['\\\\footnotes ize', '0.8em'],
		['\\\\small',        '0.9em'],
		['\\\\normalsize',   '1em'],
		['\\\\large',        '1.17em'],
		['\\\\Large',        '1.4em'],
		['\\\\LARGE',        '1.7em'],
		['\\\\huge',         '2em'],
		['\\\\Huge',         '2.5em'],
	];
	for (const [cmd, size] of fontSizes) {
		// Brace-grouped: \large{text}
		p = p.replace(new RegExp(`${cmd}\\{([^}]+)\\}`, 'g'),
			`<span style="font-size:${size}">$1</span>`);
		// Declaration form: {\large text} — handled as global scope change with \n\n guards
		p = p.replace(new RegExp(`(?<=\\{\\s*)${cmd}\\s+([^}]+)(?=\\s*\\})`, 'g'),
			`<span style="font-size:${size}">$1</span>`);
	}

	// === Alignment declarations (declaration form, no braces) ===
	p = p.replace(/\\centering\b/g,    '<div style="text-align:center">');
	p = p.replace(/\\raggedright\b/g,  '<div style="text-align:left">');
	p = p.replace(/\\raggedleft\b/g,   '<div style="text-align:right">');
	p = p.replace(/\\justify\b/g,      '<div style="text-align:justify">');
	// \begin{center} ... \end{center}
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
	p = p.replace(/\\med space\b/g,           '\n');
	p = p.replace(/\\bigskip\b/g,           '\n\n');
	p = p.replace(/\\smallskip\b/g,         '\n');
	p = p.replace(/\\newpage\b/g,           '\n\n---\n\n');
	p = p.replace(/\\clearpage\b/g,         '\n\n---\n\n');
	p = p.replace(/\\cleardoublepage\b/g,   '\n\n---\n\n');
	p = p.replace(/\\pagebreak(?:\[\d\])?\b/g, '\n\n---\n\n');
	p = p.replace(/\\linebreak(?:\[\d\])?\b/g, '  \n');   // Markdown hard line break
	p = p.replace(/\\nolinebreak(?:\[\d\])?\b/g, '');
	p = p.replace(/\\newline\b/g,           '  \n');
	p = p.replace(/\\\\\s*(\[.*?\])?/g,     '  \n');       // \\ = newline in LaTeX
	p = p.replace(/\\par\b/g,              '\n\n');
	p = p.replace(/\\indent\b/g,           '');
	p = p.replace(/\\no indent\b/g,         '');

	// === Rules / lines ===
	p = p.replace(/\\hrule\b/g,                  '\n---\n');
	p = p.replace(/\\rule\{[^}]+\}\{[^}]+\}/g,   '<hr>');

	// === Refs & Citations (full natbib + biblatex coverage) ===
	// Labels — strip silently (they have no visual output)
	p = p.replace(/\\label\{([^}]+)\}/g,         '');

	// Cross-refs — render as styled spans
	p = p.replace(/\\autoref\{([^}]+)\}/g,        '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\cref\{([^}]+)\}/g,           '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\cref\{([^}]+)\}/g,           '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\nameref\{([^}]+)\}/g,        '<span class="latex-ref">$1</span>');
	p = p.replace(/\\eqref\{([^}]+)\}/g,          '<span class="latex-ref">($1)</span>');
	p = p.replace(/\\ref\{([^}]+)\}/g,            '<span class="latex-ref">ref:$1</span>');
	p = p.replace(/\\pageref\{([^}]+)\}/g,        '<span class="latex-ref">p.$1</span>');
	// Handle ~ before \ref / \cite (non-breaking space used in source)
	p = p.replace(/~\\(?:ref|cite|autoref|cref)\b/g, (m) => ' ' + m.slice(1));

	// Natbib & biblatex citations - now handled by processBibliography() below

	// Glossaries (acronym package / glossaries)
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
	// Remove remaining \color{...} declarations (no closing brace, scope-based)
	p = p.replace(/\\color\{[^}]+\}/g, '');
	// Remove \selectfont, \normalfont etc.
	p = p.replace(/\\(?:selectfont|normalfont|usefont\{[^}]+\}\{[^}]+\}\{[^}]+\}\{[^}]+\})\b/g, '');
	// Remove \protect (transparent in HTML)
	p = p.replace(/\\protect\b/g, '');
	// Remove \phantom{...}, \hphantom, \vphantom
	p = p.replace(/\\(?:h|v)?phantom\{[^}]+\}/g, '');
	// \ensuremath — strip wrapper, content may be math (will be caught by MATH_REGEX earlier)
	p = p.replace(/\\ensuremath\{([^}]+)\}/g, '$$$1$$'); // re-wrap as inline math

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

/**
 * Scans `text` for all math delimiters (see MATH_REGEX) and replaces each
 * with a unique placeholder.  Also temporarily removes code blocks so they
 * are never mistakenly matched as math.
 *
 * Returns { text, mathBlocks } where each mathBlock is:
 *   { placeholder, content, isBlock, rawMatch }
 *
 *  - `content`  — the inner LaTeX (delimiters stripped for $, \(, \[, $$;
 *                 verbatim for \begin{...} envs so KaTeX can render them natively)
 *  - `isBlock`  — true for display-mode environments
 *  - `rawMatch` — original matched string for fallback rendering
 */
export function extractMath(text) {
	if (!text) return { text: '', mathBlocks: [] };

	// Normalise non-standard delimiter variants before anything else
	text = normaliseMathDelimiters(text);

	// Shield code blocks first
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

	// Restore code blocks
	for (const { ph, m } of codeBlocks) safe = safe.replace(ph, m);

	return { text: safe, mathBlocks };
}

// ─────────────────────────────────────────────────────────────────────────────
// injectMath — replace placeholders with rendered HTML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces each ⚿MATHBLOCKn⚿ placeholder in `html` with the rendered
 * math output.  Rendering priority:
 *   1. window.katex.renderToString (synchronous, preferred)
 *   2. window.MathJax.tex2svgPromise / tex2svg (async capable)
 *   3. Escaped plain-text fallback in a styled <span>
 *
 * KaTeX options used:
 *   • displayMode    — mirrors isBlock
 *   • throwOnError   — false (we handle errors manually)
 *   • trust          — true (allows \htmlClass etc.)
 *   • strict         — false (lenient on unknown macros)
 *   • macros         — common user-defined shorthand
 *   • output         — 'htmlAndMathml' for best accessibility
 *   • leqno          — false
 *   • fleqn          — false
 */
export function injectMath(html, mathBlocks) {
	if (!mathBlocks || mathBlocks.length === 0) return html;

	let result = html;

	// Common KaTeX macros that models/users frequently rely on
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
		'\\T':    '^{\\top}',           // transpose
		'\\inv':  '^{-1}',
		'\\abs':  '\\left|#1\\right|',
		'\\norm': '\\left\\|#1\\right\\|',
		'\\set':  '\\left\\{#1\\right\\}',
		'\\ceil': '\\left\\lceil#1\\right\\rceil',
		'\\floor':'\\left\\lfloor#1\\right\\rfloor',
		'\\d':    '\\,\\mathrm{d}',     // differential d
		'\\diff': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
		'\\pdiff':'\\frac{\\partial #1}{\\partial #2}',
		'\\tfrac':'\\frac{#1}{#2}',     // already in KaTeX but just in case
		'\\bm':  '\\boldsymbol',
		'\\1':    '\\mathbf{1}',        // indicator function
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
				// MathJax 3 synchronous path (when startup is complete)
				const node = window.MathJax.tex2svg(content, { display: isBlock });
				rendered = node.outerHTML || escapeHtml(rawMatch || content);
			} else {
				// Plain fallback — wrap in styled span so the raw source is at least visible
				const cls = isBlock ? 'latex-block latex-pending' : 'latex-inline latex-pending';
				rendered = `<span class="${cls}" data-latex="${escapeHtml(content)}">${escapeHtml(rawMatch || content)}</span>`;
			}
		} catch (err) {
			// KaTeX can still throw for very broken input even with throwOnError:false
			const cls = isBlock ? 'latex-block latex-error' : 'latex-inline latex-error';
			rendered = `<span class="${cls}" title="${escapeHtml(err.message)}">${escapeHtml(rawMatch || content)}</span>`;
		}

		// Wrap display-mode output in a scrollable container for overflow safety
		if (isBlock && rendered) {
			rendered = `<div class="latex-display-wrapper">${rendered}</div>`;
		}

		result = result.replace(placeholder, rendered);
	}

	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async MathJax retry — called after the page has fully loaded if KaTeX was
// unavailable at injection time.  Finds all .latex-pending spans and
// re-renders them with MathJax once it's ready.
// ─────────────────────────────────────────────────────────────────────────────

export async function retryPendingMath(containerEl = document.body) {
	if (!containerEl) return;
	const pending = Array.from(containerEl.querySelectorAll('.latex-pending[data-latex]'));
	if (pending.length === 0) return;

	// Wait up to 5 s for MathJax to become ready
	let waited = 0;
	while ((!window.MathJax || !window.MathJax.tex2svg) && waited < 5000) {
		await new Promise(r => setTimeout(r, 200));
		waited += 200;
	}

	if (!window.MathJax || !window.MathJax.tex2svg) return; // gave up

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
// Quick delimiter normaliser
// Some LLM outputs use non-standard forms; this normalises them before the
// main pipeline runs so nothing slips through MATH_REGEX.
//
//  Model quirks handled:
//    • Lone $ on its own line wrapping multi-line content  →  $$...$$
//        Several models (Claude, GPT-4o, etc.) emit display math as:
//            $
//            \begin{aligned}...\end{aligned}
//            $
//        instead of the standard $$...$$.
//    • Lone $ on its own line wrapping a single line     →  $$..$$
//    • $$ ... $$ with leading/trailing blank lines inside
//    • \[ ... \] or \( ... \) with stray newlines right inside the bracket
//    • Unicode prime ′ (U+2032) → ASCII apostrophe '
//    • Unicode minus − (U+2212) → ASCII hyphen-minus -
// ─────────────────────────────────────────────────────────────────────────────

export function normaliseMathDelimiters(text) {
	if (!text) return '';

	let t = text;

	// ── 1. Lone $ on its own line  →  $$ (multi-line content) ──────────────
	// Handles the pattern some models emit:
	//   $
	//   \begin{aligned}...\end{aligned}
	//   $
	// Matches a $ that is the only non-whitespace character on a line,
	// followed by at least one newline of content (2+ lines), closed by
	// another lone $, and rewrites to proper $$ delimiters.
	// The guard ensures we don't corrupt already-correct $$ blocks.
	t = t.replace(
		/(^|\n)([ \t]*)\$[ \t]*\n([\s\S]+?)\n([ \t]*)\$[ \t]*(?=\n|$)/g,
		(full, pre, _indent, inner, _indent2) => {
			// Already $$ — leave alone
			if (/^\$/.test(inner.trimStart()) || /\$$/.test(inner.trimEnd())) return full;
			return `${pre}\n$$\n${inner}\n$$`;
		}
	);

	// ── 2. Lone $ wrapping a single line of content ─────────────────────────
	// e.g.  "$\n x = y \n$"  on three lines
	t = t.replace(/(^|\n)[ \t]*\$[ \t]*\n([^\n$]+)\n[ \t]*\$[ \t]*(?=\n|$)/g,
		(_, pre, inner) => `${pre}\n$$${inner.trim()}$$`
	);

	// ── 3. Trim blank lines inside existing $$ blocks ───────────────────────
	t = t.replace(/\$\$[ \t]*\n([\s\S]*?)[ \t]*\n[ \t]*\$\$/g,
		(_, inner) => `$$\n${inner.trim()}\n$$`
	);

	// ── 4. \[ with stray spaces/newlines just inside the bracket ────────────
	t = t.replace(/\\\[\s*\n/g, '\\[\n');
	t = t.replace(/\n\s*\\\]/g, '\n\\]');

	// ── 5. \( with stray spaces/newlines just inside ─────────────────────────
	t = t.replace(/\\\(\s*\n/g, '\\(');
	t = t.replace(/\n\s*\\\)/g, '\\)');

	// ── 6. Unicode prime → ASCII apostrophe (valid in TeX math mode) ────────
	t = t.replace(/\u2032/g, "'");

	// ── 7. Unicode minus sign → ASCII hyphen-minus ──────────────────────────
	t = t.replace(/\u2212/g, '-');

	return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX Parser & Bibliography Database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global bibliography database - stores all parsed BibTeX entries.
 * Keys are citation IDs, values are entry objects with all fields.
 */
const bibliographyDatabase = new Map();

/**
 * Current bibliography style: 'plain', 'ieee', 'alpha', 'authoryear'
 */
let bibliographyStyle = 'plain';

/**
 * Parse a BibTeX entry string and extract all fields.
 * Handles standard BibTeX format:
 *   @article{key,
 *     author = {Author Name},
 *     title = {Title},
 *     journal = {Journal},
 *     year = {2024}
 *   }
 */
function parseBibtexEntry(entryText) {
	const entry = {};
	
	// Match entry type and key: @article{key, ...
	const typeMatch = entryText.match(/^@(\w+)\s*\{\s*([^,]+)\s*,/);
	if (!typeMatch) return null;
	
	entry.type = typeMatch[1].toLowerCase();
	entry.id = typeMatch[2].trim();
	
	// Find the content between the first { after the key and its matching }
	const keyIndex = entryText.indexOf(entry.id);
	const contentStart = entryText.indexOf('{', keyIndex) + 1;
	const contentEnd = findMatchingBrace(entryText, contentStart - 1);
	const content = entryText.slice(contentStart, contentEnd);
	
	// Extract fields: fieldname = {value} or fieldname = "value" or fieldname = value
	const fieldRegex = /(\w+)\s*=\s*(?:\{([\s\S]*?)\}|"([^"\\]*(?:\\.[^"\\]*)*)"|(\d+))/g;
	let fieldMatch;
	
	while ((fieldMatch = fieldRegex.exec(content)) !== null) {
		const fieldName = fieldMatch[1].toLowerCase();
		let fieldValue = fieldMatch[2] || fieldMatch[3] || fieldMatch[4] || '';
		
		// Clean up BibTeX escape sequences
		fieldValue = fieldValue
			.replace(/\\&/g, '&')
			.replace(/\\%/g, '%')
			.replace(/\\\$/g, '$')
			.replace(/\\#/g, '#')
			.replace(/\\_/g, '_')
			.replace(/\\{/g, '{')
			.replace(/\\}/g, '}')
			.replace(/\\~/g, '~')
			.replace(/\\ /g, ' ')
			.replace(/\{|\}/g, '')
			.trim();
		
		entry[fieldName] = fieldValue;
	}
	
	return entry;
}

/**
 * Find matching closing brace, handling nested braces.
 */
function findMatchingBrace(str, startIdx) {
	let depth = 1;
	for (let i = startIdx + 1; i < str.length; i++) {
		if (str[i] === '{') depth++;
		else if (str[i] === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return str.length;
}

/**
 * Parse a complete BibTeX file content and populate the database.
 * @param {string} bibContent - The raw BibTeX file content
 * @param {string} style - Bibliography style: 'plain', 'ieee', 'alpha', 'authoryear'
 */
export function parseBibtex(bibContent, style = 'plain') {
	bibliographyStyle = style;
	
	// Find all @entry{...} blocks - handle nested braces
	const entries = [];
	const entryRegex = /@\w+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
	let match;
	
	while ((match = entryRegex.exec(bibContent)) !== null) {
		entries.push(match[0]);
	}
	
	for (const entryText of entries) {
		const entry = parseBibtexEntry(entryText);
		if (entry && entry.id) {
			bibliographyDatabase.set(entry.id, entry);
		}
	}
	
	return bibliographyDatabase.size;
}

/**
 * Load a BibTeX file from a URL.
 * @param {string} url - URL to the .bib file
 * @param {string} style - Bibliography style
 * @returns {Promise<number>} - Number of entries loaded
 */
export async function loadBibtex(url, style = 'plain') {
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error('Failed to load BibTeX: ' + response.status);
		const content = await response.text();
		return parseBibtex(content, style);
	} catch (err) {
		console.error('Error loading BibTeX:', err);
		return 0;
	}
}

/**
 * Add a single BibTeX entry to the database.
 * @param {Object} entry - Entry object with type, id, and fields
 */
export function addBibtexEntry(entry) {
	if (entry && entry.id) {
		bibliographyDatabase.set(entry.id, entry);
	}
}

/**
 * Get a bibliography entry by ID.
 * @param {string} id - Citation key
 * @returns {Object|null} - Entry object or null if not found
 */
export function getBibtexEntry(id) {
	return bibliographyDatabase.get(id) || null;
}

/**
 * Get all bibliography entries.
 * @returns {Map} - Map of all entries
 */
export function getAllBibtexEntries() {
	return bibliographyDatabase;
}

/**
 * Clear the bibliography database.
 */
export function clearBibliography() {
	bibliographyDatabase.clear();
}

/**
 * Format author names for display.
 * Handles "Last, First" and "First Last" formats.
 */
function formatAuthors(authorsStr) {
	if (!authorsStr) return '';
	
	// Split by "and" (BibTeX separator)
	const authors = authorsStr.split(/\s+and\s+/i);
	
	if (authors.length === 1) {
		return formatSingleAuthor(authors[0]);
	} else if (authors.length === 2) {
		return formatSingleAuthor(authors[0]) + ' & ' + formatSingleAuthor(authors[1]);
	} else {
		return formatSingleAuthor(authors[0]) + ', et al.';
	}
}

/**
 * Format a single author name.
 */
function formatSingleAuthor(author) {
	author = author.trim();
	
	// Check for "Last, First" format
	if (author.includes(',')) {
		const parts = author.split(',');
		const lastName = parts[0].trim();
		const firstName = parts.slice(1).join(',').trim();
		return firstName ? firstName + ' ' + lastName : lastName;
	}
	
	return author;
}

/**
 * Format a single citation for display.
 * @param {Object} entry - BibTeX entry
 * @param {string} style - Citation style: 'author', 'year', 'number', 'full'
 * @returns {string} - Formatted citation
 */
function formatCitation(entry, style) {
	if (!entry) return '';
	
	var authorStr = formatAuthors(entry.author);
	var year = entry.year || 'n.d.';
	var title = entry.title || '';
	
	switch (style) {
		case 'author':
			return authorStr ? authorStr + ' (' + year + ')' : '(' + year + ')';
		case 'year':
			return '(' + year + ')';
		case 'number':
			return entry.id;
		case 'full':
			var full = '';
			if (authorStr) full += authorStr;
			if (year) full += (full ? ', ' : '') + year;
			if (title) full += (full ? '. ' : '') + title;
			if (entry.journal) full += (full ? '. ' : '') + '<em>' + entry.journal + '</em>';
			if (entry.volume) full += ', ' + entry.volume;
			if (entry.pages) full += ', ' + entry.pages;
			return full;
		default:
			return authorStr + ' (' + year + ')';
	}
}

/**
 * Render a bibliography entry in HTML.
 * @param {Object} entry - BibTeX entry
 * @param {string} style - Bibliography style
 * @param {number} index - Entry index for numbering
 * @returns {string} - HTML representation
 */
function renderBibliographyEntry(entry, style, index) {
	if (!entry) return '';
	
	var html = '<div class="latex-bibliography-entry" data-cite-key="' + entry.id + '">';
	
	var authors = formatAuthors(entry.author);
	var year = entry.year || 'n.d.';
	
	switch (style) {
		case 'plain':
		case 'ieee':
			// [N] Authors. Title. Journal, Volume(Number), Pages, Year.
			var numLabel = index + 1;
			html += '<span class="bib-number">[' + numLabel + ']</span> ';
			if (authors) html += authors + '. ';
			if (entry.title) html += '<em>' + entry.title + '</em>. ';
			if (entry.journal) html += entry.journal;
			if (entry.volume) html += ', ' + entry.volume;
			if (entry.number) html += '(' + entry.number + ')';
			if (entry.pages) html += ', ' + entry.pages;
			if (entry.year) html += ', ' + year;
			html += '.';
			break;
		
		case 'alpha':
			// [Abc94] Authors. Title. Journal, Year.
			var alphaLabel = generateAlphaLabel(entry);
			html += '<span class="bib-alpha">[' + alphaLabel + ']</span> ';
			if (authors) html += authors + '. ';
			if (entry.title) html += '<em>' + entry.title + '</em>. ';
			if (entry.journal) html += entry.journal;
			if (entry.year) html += ', ' + year;
			html += '.';
			break;
		
		case 'authoryear':
			// Authors (Year). Title. Journal, Volume(Number), Pages.
			if (authors) html += authors + ' ';
			html += '(' + year + '). ';
			if (entry.title) html += '<em>' + entry.title + '</em>. ';
			if (entry.journal) html += entry.journal;
			if (entry.volume) html += ', ' + entry.volume;
			if (entry.number) html += '(' + entry.number + ')';
			if (entry.pages) html += ', ' + entry.pages;
			html += '.';
			break;
		
		default:
			if (authors) html += authors + '. ';
			if (entry.title) html += '<em>' + entry.title + '</em>. ';
			if (entry.year) html += '(' + year + ')';
	}
	
	html += '</div>';
	return html;
}

/**
 * Generate an alpha-style label from entry.
 */
function generateAlphaLabel(entry) {
	var authors = entry.author || '';
	var year = entry.year || 'nd';
	
	// Get first author's last name
	var firstAuthor = authors.split(/\s+and\s+/i)[0].trim();
	var lastName = firstAuthor.includes(',') ? 
		firstAuthor.split(',')[0].trim() : 
		firstAuthor.split(' ').pop();
	
	// Get first 3 letters of last name
	var prefix = lastName.substring(0, 3).toLowerCase();
	
	// Get last 2 digits of year
	var yearSuffix = year.replace(/\D/g, '').slice(-2);
	
	return prefix + yearSuffix;
}

/**
 * Generate the full bibliography HTML.
 * @param {Object} options - Options for bibliography generation
 * @returns {string} - HTML bibliography
 */
export function generateBibliography(options) {
	var style = (options && options.style) ? options.style : bibliographyStyle;
	var filter = (options && typeof options.filter === 'function') ? options.filter : null;
	
	// Get all entries as array
	var entries = Array.from(bibliographyDatabase.values());
	
	// Apply filter if provided
	if (filter) {
		entries = entries.filter(filter);
	}
	
	// Sort entries based on style
	if (style === 'alpha' || style === 'plain') {
		entries.sort(function(a, b) {
			var authorA = (a.author || '').toLowerCase();
			var authorB = (b.author || '').toLowerCase();
			return authorA.localeCompare(authorB);
		});
	} else if (style === 'ieee') {
		// IEEE sorts by order of citation - use insertion order
		entries = Array.from(bibliographyDatabase.values());
	}
	
	// Generate HTML
	var html = '<div class="latex-bibliography">';
	
	entries.forEach(function(entry, idx) {
		html += renderBibliographyEntry(entry, style, idx);
	});
	
	html += '</div>';
	
	return html;
}

/**
 * Render a citation command to HTML.
 * @param {string} citationKeys - Comma-separated citation keys
 * @param {string} command - Citation command type
 * @returns {string} - HTML citation
 */
function renderCitation(citationKeys, command) {
	var keys = citationKeys.split(/\s*,\s*/).map(function(k) { return k.trim(); }).filter(function(k) { return k; });
	if (keys.length === 0) return '';
	
	var entries = keys.map(function(key) { return bibliographyDatabase.get(key); });
	
	// Check if we have data for any of the keys
	var hasData = entries.some(function(e) { return e !== null && e !== undefined; });
	
	// If no bibliography data, fall back to original placeholder behavior
	if (!hasData) {
		return '<span class="latex-citation">[' + citationKeys + ']</span>';
	}
	
	switch (command) {
		case 'textcite':
			// Author (Year)
			return entries.map(function(e) { return e ? formatCitation(e, 'author') : '[' + e + ']'; }).join(', ');
	
		case 'parencite':
		case 'citep':
		case 'cite':
			// (Author, Year)
			var parenCitations = entries.map(function(e) { return e ? formatCitation(e, 'author') : '[' + e + ']'; });
			return '<span class="latex-citation">(' + parenCitations.join(', ') + ')</span>';
	
		case 'citeauthor':
			return entries.map(function(e) { return e ? formatAuthors(e.author) : '[' + e + ']'; }).join(', ');
	
		case 'citeyear':
			return entries.map(function(e) { return e ? (e.year || 'n.d.') : '[' + e + ']'; }).join(', ');
	
		case 'citet':
			// Author (Year)
			return entries.map(function(e) { return e ? formatCitation(e, 'author') : '[' + e + ']'; }).join(', ');
	
		case 'footcite':
			var footContent = entries.map(function(e) { return e ? formatCitation(e, 'full') : '[' + e + ']'; }).join(', ');
			return '<sup class="latex-footnote" title="' + escapeHtml(footContent) + '">[cite]</sup>';
	
		case 'nocite':
			// nocite doesn't display, just registers the citation
			return '';
	
		default:
			// Default: (Author, Year)
			var defaultCitations = entries.map(function(e) { return e ? formatCitation(e, 'author') : '[' + e + ']'; });
			return '<span class="latex-citation">(' + defaultCitations.join(', ') + ')</span>';
	}
}

/**
 * Process bibliography commands in text and replace with rendered HTML.
 * This should be called after parseBibtex/loadBibtex to populate the database.
 */
export function processBibliography(text) {
	if (!text) return text;
	
	var processed = text;
	
	// First, detect and parse any raw BibTeX entries in the text
	// This handles entries like @article{key, ...} that might be pasted inline
	processed = processed.replace(
		/(@\w+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g,
		function(_, entryText) {
			// Try to parse this as a BibTeX entry
			const entry = parseBibtexEntry(entryText);
			if (entry && entry.id) {
				// Add to database
				bibliographyDatabase.set(entry.id, entry);
				// Return empty - we'll show the bibliography separately
				return '';
			}
			return _; // Return as-is if parsing fails
		}
	);
	
	// Process \bibliography{file} command (traditional BibTeX - specifies .bib file)
	// This just adds a note since we can't actually load the file without a URL
	processed = processed.replace(
		/\\bibliography\{([^}]+)\}/g,
		function(_, files) {
			return '<div class="latex-bibliography-note"><em>Bibliography: ' + files + '</em></div>';
		}
	);
	
	// Process \bibliographystyle{style} command
	processed = processed.replace(
		/\\bibliographystyle\{([^}]+)\}/g,
		function(_, style) {
			return ''; // Silent - style is set when parsing BibTeX
		}
	);
	
	// Process \printbibliography with options
	processed = processed.replace(
		/\\printbibliography\s*(?:\[([^\]]+)\])?/g,
		function(_, options) {
			// Parse options if present
			var opts = {};
			if (options) {
				// Extract style= option
				var styleMatch = options.match(/style=(\w+)/);
				if (styleMatch) opts.style = styleMatch[1];
				
				// Extract type= option (filter by entry type)
				var typeMatch = options.match(/type=(\w+)/);
				if (typeMatch) {
					var type = typeMatch[1];
					opts.filter = function(entry) { return entry.type === type; };
				}
			}
			return generateBibliography(opts);
		}
	);
	
	// Process Natbib citation commands
	processed = processed.replace(
		/\\textcite\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'textcite'); }
	);
	
	processed = processed.replace(
		/\\parencite\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'parencite'); }
	);
	
	processed = processed.replace(
		/\\footcite\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'footcite'); }
	);
	
	processed = processed.replace(
		/\\cite(?:t|p)?\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'cite'); }
	);
	
	processed = processed.replace(
		/\\citet\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'citet'); }
	);
	
	processed = processed.replace(
		/\\citep\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'citep'); }
	);
	
	processed = processed.replace(
		/\\citeauthor\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'citeauthor'); }
	);
	
	processed = processed.replace(
		/\\citeyear\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'citeyear'); }
	);
	
	processed = processed.replace(
		/\\citeyearpar\{([^}]+)\}/g,
		function(_, keys) {
			var entries = keys.split(/\s*,\s*/).map(function(k) { return bibliographyDatabase.get(k.trim()); });
			var years = entries.map(function(e) { return e ? (e.year || 'n.d.') : ''; }).filter(function(y) { return y; });
			return years.length ? '(' + years.join(', ') + ')' : '';
		}
	);
	
	processed = processed.replace(
		/\\citealt\*?\{([^}]+)\}/g,
		function(_, keys) { return renderCitation(keys, 'citet'); }
	);
	
	processed = processed.replace(
		/\\citealp\*?\{([^}]+)\}/g,
		function(_, keys) {
			var entries = keys.split(/\s*,\s*/).map(function(k) { return bibliographyDatabase.get(k.trim()); });
			return entries.map(function(e) { return e ? formatCitation(e, 'author') : ''; }).filter(function(x) { return x; }).join(', ');
		}
	);
	
	// Handle \nocite{*} (all entries)
	processed = processed.replace(
		/\\nocite\{([^}]+)\}/g,
		function(_, keys) {
			if (keys.trim() === '*') {
				// Show all entries
				return generateBibliography();
			}
			return renderCitation(keys, 'nocite');
		}
	);
	
	return processed;
}
