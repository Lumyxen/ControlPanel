// www/js/chat/latex/preprocessor.js
// Converts structural (text-mode) LaTeX into Markdown + HTML for downstream rendering.
// Math blocks are shielded before processing and restored afterwards.

import { CODE_BLOCK_REGEX, MATH_REGEX, escapeHtml, isExternalUrl, normaliseMathDelimiters } from './math.js';
import { processBibliography, parseBibtex } from './bibliography.js';

// ─── Callout factory ──────────────────────────────────────────────────────────

const CALLOUT_END = '\n\n</div></div>\n\n';

function makeCallout(type, icon, title) {
	return `\n\n<div class="md-callout md-callout-${type}"><div class="md-callout-header"><span class="md-callout-icon">${icon}</span><span class="md-callout-title">${escapeHtml(title)}</span></div><div class="md-callout-content">\n\n`;
}

const THEOREM_ENVS = [
	['theorem','info','🏛️','Theorem'],   ['lemma','tip','💡','Lemma'],
	['corollary','tip','📌','Corollary'],  ['proposition','info','📐','Proposition'],
	['definition','example','📖','Definition'], ['remark','note','💬','Remark'],
	['note','note','📋','Note'],           ['example','example','🧪','Example'],
	['axiom','info','⚖️','Axiom'],         ['conjecture','warning','🔮','Conjecture'],
	['hypothesis','warning','🔬','Hypothesis'], ['observation','note','👁️','Observation'],
	['notation','example','✏️','Notation'], ['claim','info','📣','Claim'],
	['exercise','example','🏋️','Exercise'], ['problem','warning','❓','Problem'],
	['solution','success','✅','Solution'], ['fact','info','📌','Fact'],
	['assumption','warning','🔷','Assumption'], ['criterion','info','📏','Criterion'],
	['assertion','info','📢','Assertion'], ['property','tip','🔑','Property'],
	['condition','warning','🚦','Condition'], ['question','warning','❓','Question'],
	['answer','success','💬','Answer'],   ['summary','note','📝','Summary'],
	['conclusion','success','🎯','Conclusion'], ['case','note','🗂️','Case'],
];

// ─── Algorithm (pseudocode) formatter ────────────────────────────────────────

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

		const KW = (kw) => `<span class="alg-keyword">${kw}</span>`;
		line = line
			.replace(/\\KwData\s*\{([^}]+)\}/g,  `${KW('Input:')} $1`)
			.replace(/\\KwResult\s*\{([^}]+)\}/g, `${KW('Output:')} $1`)
			.replace(/\\KwIn\s*\{([^}]+)\}/g,     `${KW('Input:')} $1`)
			.replace(/\\KwOut\s*\{([^}]+)\}/g,    `${KW('Output:')} $1`)
			.replace(/\\KwRet\s*\{([^}]+)\}/g,    `${KW('return')} $1`)
			.replace(/\\Return\b/g,                KW('return'))
			.replace(/\\eIf\s*\{([^}]+)\}/g,      `${KW('if')} $1 ${KW('then')}`)
			.replace(/\\uIf\s*\{([^}]+)\}/g,      `${KW('if')} $1 ${KW('then')}`)
			.replace(/\\lIf\s*\{([^}]+)\}\s*\{([^}]+)\}/g, `${KW('if')} $1 ${KW('then')} $2`)
			.replace(/\\uElse\b/g,                 KW('else'))
			.replace(/\\lElse\s*\{([^}]+)\}/g,    `${KW('else')} $1`)
			.replace(/\\ForEach\s*\{([^}]+)\}/g,  `${KW('foreach')} $1 ${KW('do')}`)
			.replace(/\\ForAll\s*\{([^}]+)\}/g,   `${KW('for all')} $1 ${KW('do')}`)
			.replace(/\\Repeat\b/g,                KW('repeat'))
			.replace(/\\State\s*/g,                '<span class="alg-keyword"></span>')
			.replace(/\\Statex\s*/g,               '<span class="alg-keyword"></span>')
			.replace(/\\Require\s*/g,              `${KW('Require:')} `)
			.replace(/\\Ensure\s*/g,               `${KW('Ensure:')} `)
			.replace(/\\If\s*\{([^}]+)\}/g,        `${KW('if')} $1 ${KW('then')}`)
			.replace(/\\ElsIf\s*\{([^}]+)\}/g,    `${KW('else if')} $1 ${KW('then')}`)
			.replace(/\\Elsif\s*\{([^}]+)\}/g,    `${KW('else if')} $1 ${KW('then')}`)
			.replace(/\\Else\b/g,                  KW('else'))
			.replace(/\\EndIf\b/g,                 KW('end if'))
			.replace(/\\For\s*\{([^}]+)\}/g,       `${KW('for')} $1 ${KW('do')}`)
			.replace(/\\EndFor\b/g,                KW('end for'))
			.replace(/\\While\s*\{([^}]+)\}/g,    `${KW('while')} $1 ${KW('do')}`)
			.replace(/\\EndWhile\b/g,              KW('end while'))
			.replace(/\\Until\s*\{([^}]+)\}/g,    `${KW('until')} $1`)
			.replace(/\\Loop\b/g,                  KW('loop'))
			.replace(/\\EndLoop\b/g,               KW('end loop'))
			.replace(/\\Function\s*\{([^}]+)\}\s*\{([^}]*)\}/g, `${KW('function')} $1($2)`)
			.replace(/\\EndFunction\b/g,           KW('end function'))
			.replace(/\\Procedure\s*\{([^}]+)\}\s*\{([^}]*)\}/g, `${KW('procedure')} $1($2)`)
			.replace(/\\EndProcedure\b/g,          KW('end procedure'))
			.replace(/\\Call\s*\{([^}]+)\}\s*\{([^}]*)\}/g, '<span class="alg-function">$1</span>($2)')
			.replace(/\\Comment\s*\{([^}]+)\}/g,  '<span class="alg-comment">▷ $1</span>')
			.replace(/\\tcp\*?\{([^}]+)\}/g,       '<span class="alg-comment">// $1</span>');

		html += `<div class="alg-line" style="padding-left:${pad}px">${line}</div>`;
		if (/class="alg-keyword">(if|else if|else|for|foreach|for all|while|loop|repeat|function|procedure)\b/.test(line)) {
			indentLevel++;
		}
	}
	html += '</div>';
	return html;
}

// ─── Table formatter ──────────────────────────────────────────────────────────

function formatTabular(body, isLong = false) {
	let clean = body
		.replace(/\\toprule(\[.*?\])?/g,  '')
		.replace(/\\midrule(\[.*?\])?/g,  '')
		.replace(/\\bottomrule(\[.*?\])?/g, '')
		.replace(/\\hline/g,              '')
		.replace(/\\cline\{[\d-]+\}/g,    '')
		.replace(/\\cmidrule(\(.*?\))?\{[\d-]+\}/g, '')
		.replace(/\\specialrule\{.*?\}\{.*?\}\{.*?\}/g, '')
		.replace(/\\rowcolor(\[.*?\])?\{[^}]*\}/g, '')
		.replace(/\\cellcolor(\[.*?\])?\{[^}]*\}/g, '');

	const rows = clean.split('\\\\').filter(r => r.trim());
	const cls = isLong ? 'latex-table longtable' : 'latex-table';
	let html = `<div class="latex-table-wrapper"><table class="${cls}"><tbody>`;

	for (const row of rows) {
		html += '<tr>';
		for (let cell of row.split(/(?<!\\)&/)) {
			cell = cell.trim();
			let colspan = 1, rowspan = 1, align = '';
			const mcM = cell.match(/^\\multicolumn\{(\d+)\}\{([^}]*)\}\{([\s\S]*)\}$/);
			if (mcM) {
				colspan = parseInt(mcM[1], 10);
				align   = mcM[2].includes('c') ? 'center' : mcM[2].includes('r') ? 'right' : 'left';
				cell    = mcM[3];
			}
			const mrM = cell.match(/^\\multirow\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
			if (mrM) { rowspan = parseInt(mrM[1], 10); cell = mrM[2]; }
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

// ─── applyInlineFormatting ────────────────────────────────────────────────────

function applyInlineFormatting(text) {
	text = text
		.replace(/\\textbf\{([^}]+)\}/g,      '<strong>$1</strong>')
		.replace(/\\textit\{([^}]+)\}/g,       '<em>$1</em>')
		.replace(/\\emph\{([^}]+)\}/g,         '<em>$1</em>')
		.replace(/\\textsl\{([^}]+)\}/g,       '<span style="font-style:oblique">$1</span>')
		.replace(/\\textsc\{([^}]+)\}/g,       '<span style="font-variant:small-caps">$1</span>')
		.replace(/\\texttt\{([^}]+)\}/g,       '<code>$1</code>')
		.replace(/\\textrm\{([^}]+)\}/g,       '<span style="font-family:serif">$1</span>')
		.replace(/\\textsf\{([^}]+)\}/g,       '<span style="font-family:sans-serif">$1</span>')
		.replace(/\\textmd\{([^}]+)\}/g,       '<span style="font-weight:normal">$1</span>')
		.replace(/\\textup\{([^}]+)\}/g,       '<span style="font-style:normal">$1</span>')
		.replace(/\\textnormal\{([^}]+)\}/g,   '$1')
		.replace(/\\text\{([^}]+)\}/g,         '$1')  // Preserve \text command for math rendering
		.replace(/\\underline\{([^}]+)\}/g,    '<u>$1</u>')
		.replace(/\\sout\{([^}]+)\}/g,         '<s>$1</s>')
		.replace(/\\xout\{([^}]+)\}/g,         '<s>$1</s>')
		.replace(/\\uwave\{([^}]+)\}/g,        '<u style="text-decoration:underline wavy">$1</u>')
		.replace(/\\textcolor\{([^}]+)\}\{([^}]+)\}/g,       '<span style="color:$1">$2</span>')
		.replace(/\\colorbox\{([^}]+)\}\{([^}]+)\}/g,        '<span style="background:$1;padding:0 2px">$2</span>')
		.replace(/\\fcolorbox\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g, '<span style="border:1px solid $1;background:$2;padding:0 2px">$3</span>')
		.replace(/\\fbox\{([^}]+)\}/g,         '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>')
		.replace(/\\mbox\{([^}]+)\}/g,         '<span style="white-space:nowrap">$1</span>')
		.replace(/\\framebox(?:\[.*?\])?\{([^}]+)\}/g, '<span style="border:1px solid currentColor;padding:1px 4px">$1</span>')
		.replace(/\\raisebox\{[^}]+\}\{([^}]+)\}/g,   '<span style="vertical-align:super;font-size:0.75em">$1</span>')
		.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, (_, url, label) => {
			if (!isExternalUrl(url)) return escapeHtml(label);
			return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
		})
		.replace(/\\url\{([^}]+)\}/g, (_, url) => {
			if (!isExternalUrl(url)) return `<code class="latex-url">${escapeHtml(url)}</code>`;
			return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="latex-url">${escapeHtml(url)}</a>`;
		})
		.replace(/\\nolinkurl\{([^}]+)\}/g, '<code class="latex-url">$1</code>')
		.replace(/\\footnote\{([^}]+)\}/g,  '<sup class="latex-footnote" title="$1">[note]</sup>')
		.replace(/\\&/g, '&amp;').replace(/\\%/g, '%').replace(/\\\$/g, '$')
		.replace(/\\#/g, '#').replace(/\\_/g, '_').replace(/\\\{/g, '{').replace(/\\\}/g, '}')
		.replace(/\\\^{}/g, '^').replace(/\\~{}/g, '~')
		.replace(/\\ldots\b/g, '…').replace(/\\dots\b/g, '…')
		.replace(/\\cdots\b/g, '⋯').replace(/\\vdots\b/g, '⋮').replace(/\\ddots\b/g, '⋱')
		.replace(/(?<!\n)---(?!\n)/g, '—').replace(/(?<!\n)--(?!\n)/g, '–')
		.replace(/``/g, '\u201C').replace(/''/g, '\u201D')
		// Restore table alignment dashes that were converted to em/en dashes
		.replace(/\|—\|/g, '|---|').replace(/\|–\|/g, '|--|')
		.replace(/\|:—\|/g, '|:---|').replace(/\|—:\|/g, '|---:|')
		.replace(/\|:—:\|/g, '|:---:|')
		.replace(/\|—\|/g, '|---|').replace(/\|–\|/g, '|--|')
		.replace(/\|:—\|/g, '|:---|').replace(/\|—:\|/g, '|---:|')
		.replace(/\|:—:\|/g, '|:---:|')
		.replace(/`/g, '\u2018')
		.replace(/\\textquoteleft\b/g, '\u2018').replace(/\\textquoteright\b/g, '\u2019')
		.replace(/\\enquote\{([^}]+)\}/g, '\u201C$1\u201D')
		.replace(/\\guillemotleft\b/g, '«').replace(/\\guillemotright\b/g, '»')
		.replace(/\\glqq\b/g, '„').replace(/\\grqq\b/g, '\u201D')
		.replace(/\\glq\b/g, '\u201A').replace(/\\grq\b/g, '\u2018')
		.replace(/\\tilde\{([^}]+)\}/g, '$1\u0303')
		.replace(/\\today\b/g, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))
		.replace(/\\textregistered\b/g, '®').replace(/\\texttrademark\b/g, '™')
		.replace(/\\copyright\b/g, '©').replace(/\\dag\b/g, '†').replace(/\\ddag\b/g, '‡')
		.replace(/\\S\b/g, '§').replace(/\\P\b/g, '¶')
		.replace(/\\textbackslash\b/g, '\\').replace(/\\textbar\b/g, '|').replace(/\\slash\b/g, '/')
		.replace(/\\,/g, '\u2009').replace(/\\;/g, '\u2002').replace(/\\:/g, '\u205F')
		.replace(/\\!/g, '').replace(/\\ /g, '\u00A0').replace(/~(?!\w)/g, '\u00A0')
		.replace(/\\quad\b/g, '\u2003').replace(/\\qquad\b/g, '\u2003\u2003')
		.replace(/\\'([aeiouAEIOU])/g, (_, c) => (c + '\u0301').normalize('NFC'))
		.replace(/\\`([aeiouAEIOU])/g, (_, c) => (c + '\u0300').normalize('NFC'))
		.replace(/\\"([aeiouAEIOU])/g, (_, c) => (c + '\u0308').normalize('NFC'))
		.replace(/\\c\{([cC])\}/g, (_, c) => (c + '\u0327').normalize('NFC'))
		.replace(/\\v\{([a-zA-Z])\}/g, (_, c) => (c + '\u030C').normalize('NFC'))
		.replace(/\{\}/g, '');
	return text;
}

// ─── preprocessLatexText ─────────────────────────────────────────────────────

export function preprocessLatexText(text) {
	if (!text) return '';

	// Step -1: Rescue citation commands from $...$ wrapping
	text = text.replace(
		/\$\s*(\\(?:cite[a-zA-Z]*|textcite|Textcite|parencite|Parencite|autocite|Autocite|fullcite|footcite|footcitetext|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^}]+\})\s*\$/g,
		(_, inner) => inner.trim()
	);
	text = normaliseMathDelimiters(text);

	// Step 0: Pre-scan fenced blocks for BibTeX content
	{
		const bibEntryStartRx = /^\s*@(?:article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|proceedings|inbook|unpublished|manual|booklet|patent|dataset|software|report)\s*[\{(]/im;
		const bibFenceRx = /^```[^\n]*\r?\n([\s\S]*?)\n```/gim;
		let bm;
		while ((bm = bibFenceRx.exec(text)) !== null) {
			if (bibEntryStartRx.test(bm[1])) parseBibtex(bm[1]);
		}
	}

	// Step 1: Shield code blocks
	const codeBlocks = [];
	let ci = 0;
	let p = text.replace(CODE_BLOCK_REGEX, (m) => {
		const ph = `⚿CODEBLOCK${ci}⚿`;
		codeBlocks.push({ ph, m });
		ci++;
		return ph;
	});

	// Step 2: Shield math blocks
	const mathBlocks = [];
	let mi = 0;
	p = p.replace(MATH_REGEX, (m) => {
		const ph = `⚿MATHBLOCK${mi}⚿`;
		mathBlocks.push({ ph, m });
		mi++;
		return ph;
	});

	// Step 3: Text-mode transformations

	// Preamble / Metadata
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
	const preambleRegex = new RegExp('^\\\\(?:' + preambleCommands.join('|') + ').*$', 'gm');
	let preamble = '';
	p = p.replace(preambleRegex, (m) => { preamble += m + '\n'; return ''; });
	if (preamble.trim()) {
		p = `<details class="latex-preamble"><summary>📄 Document Configuration</summary>\n\`\`\`latex\n${preamble.trim()}\n\`\`\`\n</details>\n\n` + p;
	}

	p = p.replace(/\\maketitle\b/g,       '<div class="latex-maketitle"><!-- title block generated here --></div>');
	p = p.replace(/\\tableofcontents\b/g, '<div class="latex-toc-placeholder"><em>Table of Contents</em></div>');
	p = p.replace(/\\listoffigures\b/g,   '<div class="latex-toc-placeholder"><em>List of Figures</em></div>');
	p = p.replace(/\\listoftables\b/g,    '<div class="latex-toc-placeholder"><em>List of Tables</em></div>');
	p = p.replace(/\\appendix\b/g,        '\n---\n### Appendix\n');

	p = p.replace(/\\begin\{document\}/g, '').replace(/\\end\{document\}/g, '');
	p = p.replace(/\\begin\{abstract\}/g, makeCallout('note', '📄', 'Abstract'));
	p = p.replace(/\\end\{abstract\}/g,   CALLOUT_END);

	for (const [env, type, icon, title] of THEOREM_ENVS) {
		p = p.replace(
			new RegExp(`\\\\begin\\{${env}\\*?\\}(?:\\[([^\\]]+)\\])?(?:\\\\label\\{[^}]+\\})?`, 'g'),
			(_, customTitle) => makeCallout(type, icon, customTitle ? `${title}: ${customTitle}` : title)
		);
		p = p.replace(new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g'), CALLOUT_END);
	}

	p = p.replace(/\\begin\{proof\}(?:\[([^\]]+)\])?/g, (_, hint) =>
		makeCallout('note', '📝', hint ? `Proof (${hint})` : 'Proof')
	);
	p = p.replace(/\\end\{proof\}/g, '\n\n<span class="latex-qed">□</span>' + CALLOUT_END);
	p = p.replace(/\\(?:qed|QED)\b/g, '<span class="latex-qed">□</span>');

	p = p.replace(/\\begin\{algorithm\}(?:\[.*?\])?(?:\{([^}]*)\})?/g, (_, title) =>
		makeCallout('example', '⚙️', title || 'Algorithm')
	);
	p = p.replace(/\\end\{algorithm\}/g, CALLOUT_END);
	p = p.replace(/\\begin\{algorithm2e\}(?:\[.*?\])?/g, makeCallout('example', '⚙️', 'Algorithm'));
	p = p.replace(/\\end\{algorithm2e\}/g, CALLOUT_END);
	p = p.replace(
		/\\begin\{algorithmic\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithmic\}/g,
		(_, body) => formatAlgorithmic(body)
	);
	p = p.replace(
		/\\begin\{algorithm2e-body\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm2e-body\}/g,
		(_, body) => formatAlgorithmic(body)
	);

	p = p.replace(/\\begin\{frame\}(?:\[.*?\])?(?:\{([^}]*)\})?(?:\{([^}]*)\})?/g, (_, title, subtitle) => {
		const t = [title, subtitle].filter(Boolean).join(' — ') || 'Slide';
		return makeCallout('note', '📽️', t);
	});
	p = p.replace(/\\frametitle\{([^}]+)\}/g, '**$1**\n')
		 .replace(/\\framesubtitle\{([^}]+)\}/g, '*$1*\n')
		 .replace(/\\end\{frame\}/g, CALLOUT_END)
		 .replace(/\\begin\{block\}\{([^}]+)\}/g, () => `\n\n**$1**\n\n`)
		 .replace(/\\end\{block\}/g, '\n')
		 .replace(/\\pause\b/g, '')
		 .replace(/\\only<[^>]+>\{([^}]+)\}/g, '$1')
		 .replace(/\\uncover<[^>]+>\{([^}]+)\}/g, '$1')
		 .replace(/\\visible<[^>]+>\{([^}]+)\}/g, '$1')
		 .replace(/\\invisible<[^>]+>\{([^}]+)\}/g, '')
		 .replace(/\\alert(?:<[^>]+>)?\{([^}]+)\}/g, '<mark>$1</mark>')
		 .replace(/\\structure\{([^}]+)\}/g, '**$1**');

	p = p.replace(
		/\\begin\{tikzpicture\}(\[[\s\S]*?\])?([\s\S]*?)\\end\{tikzpicture\}/g,
		(_, opts, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📊 TikZ Diagram (source shown below)</div>\n\`\`\`latex\n\\begin{tikzpicture}${opts||''}${code}\\end{tikzpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{pgfpicture\}([\s\S]*?)\\end\{pgfpicture\}/g,
		(_, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📊 PGF Picture (source shown below)</div>\n\`\`\`latex\n\\begin{pgfpicture}${code}\\end{pgfpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{axis\}([\s\S]*?)\\end\{axis\}/g,
		(_, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder">📈 pgfplots Axis (source shown below)</div>\n\`\`\`latex\n\\begin{axis}${code}\\end{axis}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g,
		(_, filename) => `\n<div class="latex-figure-card"><span class="latex-figure-icon">🖼️</span><span class="latex-figure-name">Figure: <code>${filename}</code></span><span class="latex-figure-note">(requires compilation)</span></div>\n`
	);

	p = p
		.replace(/\\begin\{(?:verbatim|Verbatim)\*?\}([\s\S]*?)\\end\{(?:verbatim|Verbatim)\*?\}/g, (_, body) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`)
		.replace(/\\begin\{lstlisting\}(?:\[.*?\])?([\s\S]*?)\\end\{lstlisting\}/g, (_, body) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`)
		.replace(/\\begin\{minted\}(?:\[.*?\])?\{([^}]+)\}([\s\S]*?)\\end\{minted\}/g, (_, lang, body) => `\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`)
		.replace(/\\verb([^a-zA-Z\s])(.*?)\1/g, (_, _d, body) => `\`${body}\``);

	p = p
		.replace(/\\begin\{tabularx\}\s*\{[^}]+\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{tabularx\}/g, (_, body) => formatTabular(body))
		.replace(/\\begin\{longtable\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{longtable\}/g, (_, body) => formatTabular(body, true))
		.replace(/\\begin\{tabular\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{tabular\}/g, (_, body) => formatTabular(body))
		.replace(/\\begin\{array\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\{array\}/g, (_, body) => formatTabular(body));

	p = p
		.replace(/\\begin\{figure\}(\[.*?\])?/g, '\n').replace(/\\end\{figure\}/g, '\n')
		.replace(/\\begin\{table\}(\[.*?\])?/g, '\n').replace(/\\end\{table\}/g, '\n')
		.replace(/\\begin\{wrapfigure\}\{[^}]+\}\{[^}]+\}/g, '\n').replace(/\\end\{wrapfigure\}/g, '\n')
		.replace(/\\centering\b/g, '')
		.replace(/\\caption\{([^}]+)\}/g, '\n<div class="latex-caption">$1</div>\n')
		.replace(/\\captionof\{[^}]+\}\{([^}]+)\}/g, '\n<div class="latex-caption">$1</div>\n')
		.replace(/\\subcaption\{([^}]+)\}/g, '<div class="latex-subcaption">$1</div>');

	p = p
		.replace(/\\part\*?\{([^}]+)\}/g,          '\n# $1\n')
		.replace(/\\chapter\*?\{([^}]+)\}/g,        '\n# $1\n')
		.replace(/\\section\*?\{([^}]+)\}/g,        '\n## $1\n')
		.replace(/\\subsection\*?\{([^}]+)\}/g,     '\n### $1\n')
		.replace(/\\subsubsection\*?\{([^}]+)\}/g,  '\n#### $1\n')
		.replace(/\\paragraph\*?\{([^}]+)\}/g,      '\n##### $1\n')
		.replace(/\\subparagraph\*?\{([^}]+)\}/g,   '\n###### $1\n');

	p = p
		.replace(/\\begin\{quote\}([\s\S]*?)\\end\{quote\}/g, (_, body) => `\n> ${body.trim().split('\n').join('\n> ')}\n`)
		.replace(/\\begin\{quotation\}([\s\S]*?)\\end\{quotation\}/g, (_, body) => `\n> ${body.trim().split('\n').join('\n> ')}\n`)
		.replace(/\\begin\{verse\}([\s\S]*?)\\end\{verse\}/g, (_, body) => '\n' + body.trim().split('\n').map(l => `> *${l.trim()}*`).join('\n') + '\n');

	function convertList(body, ordered) {
		return body
			.replace(/\\item\s*\[([^\]]+)\]/g, ordered ? '\n1. **$1** ' : '\n- **$1** ')
			.replace(/\\item\b/g, ordered ? '\n1. ' : '\n- ');
	}
	for (let pass = 0; pass < 4; pass++) {
		p = p
			.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_, body) => convertList(body, false) + '\n')
			.replace(/\\begin\{enumerate\}(?:\[.*?\])?([\s\S]*?)\\end\{enumerate\}/g, (_, body) => convertList(body, true) + '\n')
			.replace(/\\begin\{description\}([\s\S]*?)\\end\{description\}/g, (_, body) => convertList(body, false) + '\n')
			.replace(/\\begin\{compactitem\}(?:\[.*?\])?([\s\S]*?)\\end\{compactitem\}/g, (_, body) => convertList(body, false) + '\n')
			.replace(/\\begin\{compactenum\}(?:\[.*?\])?([\s\S]*?)\\end\{compactenum\}/g, (_, body) => convertList(body, true) + '\n')
			.replace(/\\begin\{tasks\}(?:\[.*?\])?(?:\(\d+\))?([\s\S]*?)\\end\{tasks\}/g, (_, body) => body.replace(/\\task\b/g, '\n- ') + '\n')
			.replace(/\\begin\{checklist\}([\s\S]*?)\\end\{checklist\}/g, (_, body) => body.replace(/\\checkitem\b/g, '\n- [x]').replace(/\\uncheckitem\b/g, '\n- [ ]') + '\n');
	}

	p = applyInlineFormatting(p);

	const fontSizes = [
		['\\\\tiny','0.6em'], ['\\\\scriptsize','0.7em'], ['\\\\footnotesize','0.8em'],
		['\\\\small','0.9em'], ['\\\\normalsize','1em'], ['\\\\large','1.17em'],
		['\\\\Large','1.4em'], ['\\\\LARGE','1.7em'], ['\\\\huge','2em'], ['\\\\Huge','2.5em'],
	];
	for (const [cmd, size] of fontSizes) {
		p = p.replace(new RegExp(`${cmd}\\{([^}]+)\\}`, 'g'), `<span style="font-size:${size}">$1</span>`);
		p = p.replace(new RegExp(`(?<=\\{\\s*)${cmd}\\s+([^}]+)(?=\\s*\\})`, 'g'), `<span style="font-size:${size}">$1</span>`);
	}

	p = p
		.replace(/\\centering\b/g,   '<div style="text-align:center">')
		.replace(/\\raggedright\b/g, '<div style="text-align:left">')
		.replace(/\\raggedleft\b/g,  '<div style="text-align:right">')
		.replace(/\\justify\b/g,     '<div style="text-align:justify">')
		.replace(/\\begin\{center\}([\s\S]*?)\\end\{center\}/g, '<div style="text-align:center">$1</div>')
		.replace(/\\begin\{flushleft\}([\s\S]*?)\\end\{flushleft\}/g, '<div style="text-align:left">$1</div>')
		.replace(/\\begin\{flushright\}([\s\S]*?)\\end\{flushright\}/g, '<div style="text-align:right">$1</div>');

	p = p
		.replace(/\\vspace\*?\{[^}]+\}/g, '\n').replace(/\\hspace\*?\{[^}]+\}/g, ' ')
		.replace(/\\vskip\s*[\d.]+\s*(?:pt|em|ex|cm|mm|in|bp|pc|dd|cc|sp)\b/g, '\n')
		.replace(/\\hskip\s*[\d.]+\s*(?:pt|em|ex|cm|mm|in|bp|pc|dd|cc|sp)\b/g, ' ')
		.replace(/\\medskip\b/g, '\n').replace(/\\bigskip\b/g, '\n\n').replace(/\\smallskip\b/g, '\n')
		.replace(/\\newpage\b/g, '\n\n---\n\n').replace(/\\clearpage\b/g, '\n\n---\n\n')
		.replace(/\\cleardoublepage\b/g, '\n\n---\n\n')
		.replace(/\\pagebreak(?:\[\d\])?\b/g, '\n\n---\n\n')
		.replace(/\\linebreak(?:\[\d\])?\b/g, '  \n').replace(/\\nolinebreak(?:\[\d\])?\b/g, '')
		.replace(/\\newline\b/g, '  \n').replace(/\\\\\s*(\[.*?\])?/g, '  \n')
		.replace(/\\par\b/g, '\n\n').replace(/\\indent\b/g, '').replace(/\\noindent\b/g, '');

	p = p.replace(/\\hrule\b/g, '\n---\n').replace(/\\rule\{[^}]+\}\{[^}]+\}/g, '<hr>');

	p = p
		.replace(/\\label\{([^}]+)\}/g, '')
		.replace(/\\autoref\{([^}]+)\}/g, '<span class="latex-ref">ref:$1</span>')
		.replace(/\\cref\{([^}]+)\}/g,    '<span class="latex-ref">ref:$1</span>')
		.replace(/\\nameref\{([^}]+)\}/g, '<span class="latex-ref">$1</span>')
		.replace(/\\eqref\{([^}]+)\}/g,   '<span class="latex-ref">($1)</span>')
		.replace(/\\ref\{([^}]+)\}/g,     '<span class="latex-ref">ref:$1</span>')
		.replace(/\\pageref\{([^}]+)\}/g, '<span class="latex-ref">p.$1</span>')
		.replace(/~\\(?:ref|cite|autoref|cref)\b/g, m => ' ' + m.slice(1));

	p = p
		.replace(/\\gls\{([^}]+)\}/g,          '<span class="latex-gls">$1</span>')
		.replace(/\\glspl\{([^}]+)\}/g,         '<span class="latex-gls">$1s</span>')
		.replace(/\\Gls\{([^}]+)\}/g,           (_, k) => `<span class="latex-gls">${k.charAt(0).toUpperCase()+k.slice(1)}</span>`)
		.replace(/\\GLS\{([^}]+)\}/g,           (_, k) => `<span class="latex-gls">${k.toUpperCase()}</span>`)
		.replace(/\\acrshort\{([^}]+)\}/g,      '<abbr class="latex-acr">$1</abbr>')
		.replace(/\\acrlong\{([^}]+)\}/g,        '<span class="latex-acr-long">$1</span>')
		.replace(/\\acrfull\{([^}]+)\}/g,        '<span class="latex-acr-full">$1</span>');

	p = p
		.replace(/\\color\{[^}]+\}/g, '')
		.replace(/\\(?:selectfont|normalfont|usefont\{[^}]+\}\{[^}]+\}\{[^}]+\}\{[^}]+\})\b/g, '')
		.replace(/\\protect\b/g, '')
		.replace(/\\(?:h|v)?phantom\{[^}]+\}/g, '')
		.replace(/\\ensuremath\{([^}]+)\}/g, '$$$1$$');

	p = p.replace(/\n{3,}/g, '\n\n');

	// Step 4: Process bibliography (BibTeX)
	p = processBibliography(p);

	// Step 5: Restore math then code
	for (const { ph, m } of mathBlocks)  p = p.replace(ph, m);
	for (const { ph, m } of codeBlocks)  p = p.replace(ph, m);

	return p;
}
