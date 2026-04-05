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
	['theorem','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-marked-icon lucide-book-marked"><path d="M10 2v8l3-3 3 3V2"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg>','Theorem'],   ['lemma','tip','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb-icon lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>','Lemma'],
	['corollary','tip','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pin-icon lucide-pin"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>','Corollary'],  ['proposition','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notebook-text-icon lucide-notebook-text"><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9.5 8h5"/><path d="M9.5 12H16"/><path d="M9.5 16H14"/></svg>','Proposition'],
	['definition','example','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-open-icon lucide-book-open"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>','Definition'], ['remark','note','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square-text-icon lucide-message-square-text"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/></svg>','Remark'],
	['note','note','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sticky-note-icon lucide-sticky-note"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/></svg>','Note'],           ['example','example','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-test-tube-icon lucide-test-tube"><path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2"/><path d="M8.5 2h7"/><path d="M14.5 16h-5"/></svg>','Example'],
	['axiom','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-scale-icon lucide-scale"><path d="M12 3v18"/><path d="m19 8 3 8a5 5 0 0 1-6 0zV7"/><path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1"/><path d="m5 8 3 8a5 5 0 0 1-6 0zV7"/><path d="M7 21h10"/></svg>','Axiom'],         ['conjecture','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-minus-icon lucide-book-minus"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M9 10h6"/></svg>','Conjecture'],
	['hypothesis','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-microscope-icon lucide-microscope"><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/></svg>','Hypothesis'], ['observation','note','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search-icon lucide-search"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>','Observation'],
	['notation','example','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-marked-icon lucide-book-marked"><path d="M10 2v8l3-3 3 3V2"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg>','Notation'], ['claim','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-alert-icon lucide-book-alert"><path d="M12 13h.01"/><path d="M12 6v3"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg>','Claim'],
	['exercise','example','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sport-shoe-icon lucide-sport-shoe"><path d="m15 10.42 4.8-5.07"/><path d="M19 18h3"/><path d="M9.5 22 21.414 9.415A2 2 0 0 0 21.2 6.4l-5.61-4.208A1 1 0 0 0 14 3v2a2 2 0 0 1-1.394 1.906L8.677 8.053A1 1 0 0 0 8 9c-.155 6.393-2.082 9-4 9a2 2 0 0 0 0 4h14"/></svg>','Exercise'], ['problem','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>','Problem'],
	['solution','success','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-line-icon lucide-check-line"><path d="M20 4L9 15"/><path d="M21 19L3 19"/><path d="M9 15L4 10"/></svg>','Solution'], ['fact','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pin-icon lucide-pin"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>','Fact'],
	['assumption','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-badge-question-mark-icon lucide-badge-question-mark"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>','Assumption'], ['criterion','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ruler-icon lucide-ruler"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>','Criterion'],
	['assertion','info','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert-icon lucide-circle-alert"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>','Assertion'], ['property','tip','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-key-round-icon lucide-key-round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>','Property'],
	['condition','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-checks-icon lucide-list-checks"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>','Condition'], ['question','warning','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>','Question'],
	['answer','success','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square-text-icon lucide-message-square-text"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/></svg>','Answer'],   ['summary','note','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notebook-pen-icon lucide-notebook-pen"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 1 .854-.506z"/></svg>','Summary'],
	['conclusion','success','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flag-icon lucide-flag"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/></svg>','Conclusion'], ['case','note','<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open-icon lucide-folder-open"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>','Case'],
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
		.replace(/(?<!\n)(?<!\|)(?<!:)(?<!-)(?<!—)(?<!–)---(?!—)(?!–)(?!-)(?!\|)(?!\n)/g, '—').replace(/(?<!\n)(?<!\|)(?<!:)(?<!-)(?<!—)(?<!–)--(?!—)(?!–)(?!-)(?!\|)(?!\n)/g, '–')
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
		p = `<details class="latex-preamble"><summary><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sticky-note-icon lucide-sticky-note"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/></svg> Document Configuration</summary>\n\`\`\`latex\n${preamble.trim()}\n\`\`\`\n</details>\n\n` + p;
	}

	p = p.replace(/\\maketitle\b/g,       '<div class="latex-maketitle"><!-- title block generated here --></div>');
	p = p.replace(/\\tableofcontents\b/g, '<div class="latex-toc-placeholder"><em>Table of Contents</em></div>');
	p = p.replace(/\\listoffigures\b/g,   '<div class="latex-toc-placeholder"><em>List of Figures</em></div>');
	p = p.replace(/\\listoftables\b/g,    '<div class="latex-toc-placeholder"><em>List of Tables</em></div>');
	p = p.replace(/\\appendix\b/g,        '\n---\n### Appendix\n');

	p = p.replace(/\\begin\{document\}/g, '').replace(/\\end\{document\}/g, '');
	p = p.replace(/\\begin\{abstract\}/g, makeCallout('note', '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sticky-note-icon lucide-sticky-note"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/></svg>', 'Abstract'));
	p = p.replace(/\\end\{abstract\}/g,   CALLOUT_END);

	for (const [env, type, icon, title] of THEOREM_ENVS) {
		p = p.replace(
			new RegExp(`\\\\begin\\{${env}\\*?\\}(?:\\[([^\\]]+)\\])?(?:\\\\label\\{[^}]+\\})?`, 'g'),
			(_, customTitle) => makeCallout(type, icon, customTitle ? `${title}: ${customTitle}` : title)
		);
		p = p.replace(new RegExp(`\\\\end\\{${env}\\*?\\}`, 'g'), CALLOUT_END);
	}

	p = p.replace(/\\begin\{proof\}(?:\[([^\]]+)\])?/g, (_, hint) =>
		makeCallout('note', '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notebook-pen-icon lucide-notebook-pen"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 1-.62-.62l2.87-.837a2 2 0 0 1 .854-.506z"/></svg>', hint ? `Proof (${hint})` : 'Proof')
	);
	p = p.replace(/\\end\{proof\}/g, '\n\n<span class="latex-qed">□</span>' + CALLOUT_END);
	p = p.replace(/\\(?:qed|QED)\b/g, '<span class="latex-qed">□</span>');

	p = p.replace(/\\begin\{algorithm\}(?:\[.*?\])?(?:\{([^}]*)\})?/g, (_, title) =>
		makeCallout('example', '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-cog-icon lucide-cog"><path d="M11 10.27 7 3.34"/><path d="m11 13.73-4 6.93"/><path d="M12 22v-2"/><path d="M12 2v2"/><path d="M14 12h8"/><path d="m17 20.66-1-1.73"/><path d="m17 3.34-1 1.73"/><path d="M2 12h2"/><path d="m20.66 17-1.73-1"/><path d="m20.66 7-1.73 1"/><path d="m3.34 17 1.73-1"/><path d="m3.34 7 1.73 1"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="8"/></svg>', title || 'Algorithm')
	);
	p = p.replace(/\\end\{algorithm\}/g, CALLOUT_END);
	p = p.replace(/\\begin\{algorithm2e\}(?:\[.*?\])?/g, makeCallout('example', '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-cog-icon lucide-cog"><path d="M11 10.27 7 3.34"/><path d="m11 13.73-4 6.93"/><path d="M12 22v-2"/><path d="M12 2v2"/><path d="M14 12h8"/><path d="m17 20.66-1-1.73"/><path d="m17 3.34-1 1.73"/><path d="M2 12h2"/><path d="m20.66 17-1.73-1"/><path d="m20.66 7-1.73 1"/><path d="m3.34 17 1.73-1"/><path d="m3.34 7 1.73 1"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="8"/></svg>', 'Algorithm'));
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
		return makeCallout('note', '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-projector-icon lucide-projector"><path d="M5 7 3 5"/><path d="M9 6V3"/><path d="m13 7 2-2"/><circle cx="9" cy="13" r="3"/><path d="M11.83 12H20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2.17"/><path d="M16 16h2"/></svg>', t);
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
		(_, opts, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chart-column-icon lucide-chart-column"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg> TikZ Diagram (source shown below)</div>\n\`\`\`latex\n\\begin{tikzpicture}${opts||''}${code}\\end{tikzpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{pgfpicture\}([\s\S]*?)\\end\{pgfpicture\}/g,
		(_, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chart-column-icon lucide-chart-column"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg> PGF Picture (source shown below)</div>\n\`\`\`latex\n\\begin{pgfpicture}${code}\\end{pgfpicture}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\begin\{axis\}([\s\S]*?)\\end\{axis\}/g,
		(_, code) => `\n<div class="latex-figure-container"><div class="latex-figure-placeholder"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chart-spline-icon lucide-chart-spline"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7"/></svg> pgfplots Axis (source shown below)</div>\n\`\`\`latex\n\\begin{axis}${code}\\end{axis}\n\`\`\`\n</div>\n`
	);
	p = p.replace(
		/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/g,
		(_, filename) => `\n<div class="latex-figure-card"><span class="latex-figure-icon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image-icon lucide-image"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></span><span class="latex-figure-name">Figure: <code>${filename}</code></span><span class="latex-figure-note">(requires compilation)</span></div>\n`
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
