/**
 * Comprehensive LaTeX math & structural renderer
 * - Uses KaTeX if available for equation rendering.
 * - Extracts and hides code blocks to avoid math parsing bugs.
 * - Preprocesses raw LaTeX (like \begin{theorem}, \begin{tikzpicture}, and \begin{tabular}) into clean HTML/Markdown.
 */

// Dynamically inject KaTeX (redundant safety if index.html doesn't have it)
(function initKaTeX() {
	if (typeof window !== 'undefined' && !window.katex && !document.getElementById('katex-script')) {
		const css = document.createElement('link');
		css.rel = 'stylesheet';
		css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
		document.head.appendChild(css);

		const script = document.createElement('script');
		script.id = 'katex-script';
		script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
		script.defer = true;
		document.head.appendChild(script);
	}
})();

// Shared Regexes
const CODE_BLOCK_REGEX = /(```[\s\S]*?```|`[^`\n]+`)/g;
// Uses backreference \1 to ensure \begin{env} strictly matches its corresponding \end{env}, safely ignoring nested environments like pmatrix
const MATH_REGEX = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\s)(?:\\.|[^\n$])+?(?<!\s)\$|\\begin\{((?:equation|align|gather|eqnarray|multline|matrix|bmatrix|pmatrix|vmatrix|Vmatrix|cases)\*?)\}[\s\S]*?\\end\{\1\}/g;

/**
 * Helper to process algorithmic blocks into readable pseudocode
 */
function formatAlgorithmic(content) {
	const lines = content.split('\n');
	let html = '<div class="latex-algorithm">';
	let indentLevel = 0;
	
	lines.forEach(line => {
		let trim = line.trim();
		if (!trim) return;
		
		// Handle Indentation adjustments before rendering
		if (trim.match(/^\\(End|Until|Else)/i)) indentLevel = Math.max(0, indentLevel - 1);
		
		const padding = indentLevel * 20; // 20px indent per level
		
		// Formatting keywords
		trim = trim.replace(/\\State\s*/g, '<span class="alg-keyword"></span>');
		trim = trim.replace(/\\Require\s*/g, '<span class="alg-keyword">Require:</span> ');
		trim = trim.replace(/\\Ensure\s*/g, '<span class="alg-keyword">Ensure:</span> ');
		trim = trim.replace(/\\Return\s*/g, '<span class="alg-keyword">return</span> ');
		trim = trim.replace(/\\If\s*\{([^}]+)\}/g, '<span class="alg-keyword">if</span> $1 <span class="alg-keyword">then</span>');
		trim = trim.replace(/\\Else/g, '<span class="alg-keyword">else</span>');
		trim = trim.replace(/\\EndIf/g, '<span class="alg-keyword">end if</span>');
		trim = trim.replace(/\\For\s*\{([^}]+)\}/g, '<span class="alg-keyword">for</span> $1 <span class="alg-keyword">do</span>');
		trim = trim.replace(/\\EndFor/g, '<span class="alg-keyword">end for</span>');
		trim = trim.replace(/\\While\s*\{([^}]+)\}/g, '<span class="alg-keyword">while</span> $1 <span class="alg-keyword">do</span>');
		trim = trim.replace(/\\EndWhile/g, '<span class="alg-keyword">end while</span>');
		trim = trim.replace(/\\Function\s*\{([^}]+)\}\s*\{([^}]+)\}/g, '<span class="alg-keyword">function</span> $1($2)');
		trim = trim.replace(/\\EndFunction/g, '<span class="alg-keyword">end function</span>');
		trim = trim.replace(/\\Comment\s*\{([^}]+)\}/g, '<span class="alg-comment">▷ $1</span>');
		
		html += `<div class="alg-line" style="padding-left:${padding}px">${trim}</div>`;
		
		// Handle Indentation adjustments after rendering
		if (trim.match(/class="alg-keyword">(if|else|for|while|function|procedure)/i)) indentLevel++;
	});
	
	html += '</div>';
	return html;
}

/**
 * Helper to process tabular environments into HTML Tables
 * HTML tables support colspan/rowspan which Markdown tables do not.
 */
function formatTabular(body) {
	// Remove structural commands that don't map to HTML structure directly
	let cleanBody = body
		.replace(/\\hline/g, '')
		.replace(/\\toprule/g, '')
		.replace(/\\midrule/g, '')
		.replace(/\\bottomrule/g, '')
		.replace(/\\cline\{.*?\}/g, '');

	const rows = cleanBody.split('\\\\').filter(r => r.trim());
	let html = '<div class="latex-table-wrapper"><table class="latex-table"><tbody>';
	
	rows.forEach(row => {
		html += '<tr>';
		// Split by & but respect escaping
		const cells = row.split(/(?<!\\)&/); 
		
		cells.forEach(cell => {
			let content = cell.trim();
			let colspan = 1;
			let rowspan = 1;
			
			// Handle \multicolumn{cols}{align}{text}
			const multiColMatch = content.match(/^\\multicolumn\{(\d+)\}\{(.*?)\}\{(.*?)\}$/);
			if (multiColMatch) {
				colspan = parseInt(multiColMatch[1]);
				// alignment is in group 2 (e.g. 'c', '|c|'), ignored for now
				content = multiColMatch[3];
			}
			
			// Handle \multirow{rows}{width}{text}
			const multiRowMatch = content.match(/^\\multirow\{(\d+)\}\{(.*?)\}\{(.*?)\}$/);
			if (multiRowMatch) {
				rowspan = parseInt(multiRowMatch[1]);
				content = multiRowMatch[3];
			}
			
			// Handle \multirow{2}{*}{Text} where * is width
			const multiRowStar = content.match(/^\\multirow\{(\d+)\}\{\*\}\{(.*?)\}$/);
			if (multiRowStar) {
				rowspan = parseInt(multiRowStar[1]);
				content = multiRowStar[2];
			}

			// Bold headers if simple text
			content = content.replace(/\\textbf\{([^}]+)\}/g, '<b>$1</b>');
			
			// Wildcard replacement to clean up lingering braces from simple wrappers
			if (content === '{}') content = '';

			let attrs = '';
			if (colspan > 1) attrs += ` colspan="${colspan}"`;
			if (rowspan > 1) attrs += ` rowspan="${rowspan}"`;
			
			html += `<td${attrs}>${content}</td>`;
		});
		html += '</tr>';
	});
	html += '</tbody></table></div>';
	return html;
}

/**
 * Parses raw text-mode LaTeX (like lists, theorems, algorithms, and tables) into clean markdown
 * so the UI renders beautiful boxes instead of raw or broken text.
 */
export function preprocessLatexText(text) {
	if (!text) return '';

	// Step 1: Protect code blocks from any replacements
	const codeBlocks =[];
	let codeIndex = 0;
	let safeText = text.replace(CODE_BLOCK_REGEX, (match) => {
		const placeholder = `⚿CODEBLOCK${codeIndex}⚿`;
		codeBlocks.push({ placeholder, content: match });
		codeIndex++;
		return placeholder;
	});

	// Step 2: Protect math blocks so we don't accidentally modify equations.
	const mathBlocks =[];
	let mathIndex = 0;
	safeText = safeText.replace(MATH_REGEX, (match) => {
		const placeholder = `⚿MATHBLOCK${mathIndex}⚿`;
		mathBlocks.push({ placeholder, content: match });
		mathIndex++;
		return placeholder;
	});

	// Step 3: Perform text-mode LaTeX structural conversions
	let p = safeText;

	// === Preamble / Metadata Hiding ===
	// Collect all preamble stuff into one block
	const preambleRegex = /^\\(?:documentclass|usepackage|newcommand|renewcommand|bibliographystyle|bibliography|author|title|date|DeclareMathOperator).*$/gm;
	let preambleContent = '';
	p = p.replace(preambleRegex, (match) => {
		preambleContent += match + '\n';
		return ''; // Remove from main flow
	});
	
	if (preambleContent.trim()) {
		// Prepend a collapsed details block with the preamble
		p = `<details class="latex-preamble"><summary>Document Configuration</summary>\n\`\`\`latex\n${preambleContent.trim()}\n\`\`\`\n</details>\n\n` + p;
	}

	// === Callouts (Theorems, Proofs, etc.) ===
	const makeCallout = (type, icon, title) => `\n\n<div class="md-callout md-callout-${type}"><div class="md-callout-header"><span class="md-callout-icon">${icon}</span><span class="md-callout-title">${title}</span></div><div class="md-callout-content">\n\n`;
	const endCallout = '\n\n</div></div>\n\n';

	p = p.replace(/\\begin\{theorem\}/g, makeCallout('info', '🏛️', 'Theorem'));
	p = p.replace(/\\end\{theorem\}/g, endCallout);

	p = p.replace(/\\begin\{proof\}/g, makeCallout('note', '📝', 'Proof'));
	p = p.replace(/\\end\{proof\}/g, endCallout);

	p = p.replace(/\\begin\{lemma\}/g, makeCallout('tip', '💡', 'Lemma'));
	p = p.replace(/\\end\{lemma\}/g, endCallout);

	p = p.replace(/\\begin\{definition\}/g, makeCallout('example', '📖', 'Definition'));
	p = p.replace(/\\end\{definition\}/g, endCallout);

	// === Algorithms ===
	p = p.replace(/\\begin\{algorithm\}(?:\[.*?\])?/g, makeCallout('example', '⚙️', 'Algorithm'));
	p = p.replace(/\\end\{algorithm\}/g, endCallout);
	// Use custom algorithmic formatter
	p = p.replace(/\\begin\{algorithmic\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithmic\}/g, (match, content) => {
		return formatAlgorithmic(content);
	});

	// === Beamer Frames ===
	p = p.replace(/\\begin\{frame\}(?:\[.*?\])?(?:\{([^}]*)\})?/g, (match, title) => {
		return makeCallout('note', '📽️', title || 'Slide');
	});
	p = p.replace(/\\frametitle\{([^}]+)\}/g, '**$1**\n');
	p = p.replace(/\\end\{frame\}/g, endCallout);

	// === TikZ & Graphics ===
	p = p.replace(/\\begin\{tikzpicture\}([\s\S]*?)\\end\{tikzpicture\}/g, (match, code) => {
		return `\n<div class="latex-figure-container"><div class="latex-figure-placeholder">TikZ Graphics (Code Source)</div>\n\`\`\`latex\n\\begin{tikzpicture}${code}\\end{tikzpicture}\n\`\`\`\n</div>\n`;
	});

	p = p.replace(/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g, (match, filename) => {
		return `\n<div class="latex-figure-card"><div class="latex-figure-icon">🖼️</div><div class="latex-figure-details"><div class="latex-figure-name">Figure: ${filename}</div><div class="latex-figure-note">Image rendering requires compiling</div></div></div>\n`;
	});

	// === Tables (HTML Conversion) ===
	p = p.replace(/\\begin\{tabular\}\s*(?:\{[^\n]*?\})?([\s\S]*?)\\end\{tabular\}/g, (match, body) => {
		return formatTabular(body);
	});

	// === Headers ===
	p = p.replace(/\\section\*?\{([^}]+)\}/g, '\n# $1\n');
	p = p.replace(/\\subsection\*?\{([^}]+)\}/g, '\n## $1\n');
	p = p.replace(/\\subsubsection\*?\{([^}]+)\}/g, '\n### $1\n');

	// === Inline Formatting ===
	p = p.replace(/\\textbf\{([^}]+)\}/g, '**$1**');
	p = p.replace(/\\textit\{([^}]+)\}/g, '*$1*');
	p = p.replace(/\\emph\{([^}]+)\}/g, '*$1*');
	p = p.replace(/\\underline\{([^}]+)\}/g, '<u>$1</u>');
	p = p.replace(/\\textcolor\{([^}]+)\}\{([^}]+)\}/g, '<span style="color: $1;">$2</span>');
	p = p.replace(/\\mycommand\{([^}]+)\}/g, '`$1`'); // Handle example custom command gracefully

	// === Refs & Citations ===
	p = p.replace(/~(\\ref|\\pageref|\\cite)/g, ' $1'); 
	p = p.replace(/\\cite(?:\[.*?\])?\{([^}]+)\}/g, '<span class="latex-citation">[$1]</span>');
	p = p.replace(/\\ref\{([^}]+)\}/g, '<span class="latex-ref">ref: $1</span>');
	p = p.replace(/\\pageref\{([^}]+)\}/g, '<span class="latex-ref">page: $1</span>');
	p = p.replace(/\\label\{([^}]+)\}/g, ''); 

	// === Lists ===
	// Simple replacements often break nesting, but for display this usually suffices
	p = p.replace(/\\begin\{itemize\}/g, '\n');
	p = p.replace(/\\end\{itemize\}/g, '\n');
	p = p.replace(/\\begin\{enumerate\}/g, '\n');
	p = p.replace(/\\end\{enumerate\}/g, '\n');
	p = p.replace(/\\begin\{description\}/g, '\n');
	p = p.replace(/\\end\{description\}/g, '\n');
	p = p.replace(/\\item\s*\[(.*?)\]/g, '\n- **$1:** ');
	p = p.replace(/\\item/g, '\n- ');

	// === Wrappers ===
	p = p.replace(/\\begin\{table\}(\[.*?\])?/g, '\n');
	p = p.replace(/\\end\{table\}/g, '\n');
	p = p.replace(/\\begin\{figure\}(\[.*?\])?/g, '\n');
	p = p.replace(/\\end\{figure\}/g, '\n');
	p = p.replace(/\\centering/g, '');
	p = p.replace(/\\caption\{([^}]+)\}/g, '\n<div class="latex-caption">$1</div>\n');

	// General Document Wrappers
	p = p.replace(/\\begin\{document\}/g, '');
	p = p.replace(/\\end\{document\}/g, '');

	// Cleanup
	p = p.replace(/\n{3,}/g, '\n\n');

	// Step 4: Restore math and code placeholders
	for (const block of mathBlocks) {
		p = p.replace(block.placeholder, block.content);
	}
	for (const block of codeBlocks) {
		p = p.replace(block.placeholder, block.content);
	}

	return p;
}

/**
 * Extracts math into safe blocks so the Markdown parser ignores it.
 * Code blocks are also temporarily shielded from the math parser.
 */
export function extractMath(text) {
	if (!text) return { text: '', mathBlocks:[] };
	
	const codeBlocks =[];
	let codeIndex = 0;
	let textWithoutCode = text.replace(CODE_BLOCK_REGEX, (match) => {
		const placeholder = `⚿CODEBLOCK${codeIndex}⚿`;
		codeBlocks.push({ placeholder, content: match });
		codeIndex++;
		return placeholder;
	});

	const mathBlocks =[];
	let mathIndex = 0;
	
	let textWithMathExtracted = textWithoutCode.replace(MATH_REGEX, (match) => {
		const placeholder = `⚿MATHBLOCK${mathIndex}⚿`;
		let isBlock = false;
		let content = match;
		
		if (match.startsWith('$$')) {
			isBlock = true;
			content = match.substring(2, match.length - 2);
		} else if (match.startsWith('\\[')) {
			isBlock = true;
			content = match.substring(2, match.length - 2);
		} else if (match.startsWith('\\(')) {
			isBlock = false;
			content = match.substring(2, match.length - 2);
		} else if (match.startsWith('$')) {
			isBlock = false;
			content = match.substring(1, match.length - 1);
		} else if (match.startsWith('\\begin{')) {
			isBlock = true;
			content = match;
		}
		
		mathBlocks.push({ placeholder, content, isBlock });
		mathIndex++;
		return placeholder;
	});
	
	let finalText = textWithMathExtracted;
	for (const block of codeBlocks) {
		finalText = finalText.replace(block.placeholder, block.content);
	}
	
	return { text: finalText, mathBlocks };
}

function escapeHtml(text) {
	if (!text) return '';
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function injectMath(html, mathBlocks) {
	let finalHtml = html;
	
	for (const block of mathBlocks) {
		let rendered = '';
		try {
			if (window.katex) {
				rendered = window.katex.renderToString(block.content, {
					displayMode: block.isBlock,
					throwOnError: false,
					trust: true,
					strict: false
				});
			} else {
				const className = block.isBlock ? 'latex-block' : 'latex-inline';
				rendered = `<span class="${className}">${escapeHtml(block.content)}</span>`;
			}
		} catch (e) {
			const className = block.isBlock ? 'latex-block error' : 'latex-inline error';
			rendered = `<span class="${className}" title="${escapeHtml(e.message)}">${escapeHtml(block.content)}</span>`;
		}
		
		finalHtml = finalHtml.replace(block.placeholder, rendered);
	}
	
	return finalHtml;
}