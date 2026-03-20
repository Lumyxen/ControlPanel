// www/js/chat/latex/bibliography.js
// BibTeX v3 parser, bibliography database, citation rendering, and tooltip support.

import { escapeHtml, isExternalUrl, resolveEntryHref } from './math.js';

// ─── String macros & database ─────────────────────────────────────────────────

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

const bibliographyDatabase = new Map();
let bibliographyStyle = 'plain';

// ─── Low-level brace parser ───────────────────────────────────────────────────

function _findMatchingBrace(str, startIdx) {
	let depth = 1;
	for (let i = startIdx + 1; i < str.length; i++) {
		const ch = str[i];
		if (ch === '\\') { i++; continue; }
		if (ch === '{') depth++;
		else if (ch === '}') { depth--; if (depth === 0) return i; }
	}
	return str.length - 1;
}

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
		if (str[i] === '#') { i++; readSegment(); } else break;
	}
	return { value: parts.join(''), endIdx: i };
}

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
		.replace(/\\v\{([a-zA-Z])\}/g, (_, c) => (c + '\u030C').normalize('NFC'))
		.replace(/\\ss\b/g, 'ß')
		.replace(/\\ae\b/gi, m => m[1] === 'A' ? 'Æ' : 'æ')
		.replace(/\\oe\b/gi, m => m[1] === 'O' ? 'Œ' : 'œ')
		.replace(/\\o\b/gi,  m => m[1] === 'O' ? 'Ø' : 'ø')
		.replace(/\\l\b/gi,  m => m[1] === 'L' ? 'Ł' : 'ł')
		.replace(/\\(?:emph|textit|textbf|textrm|texttt|textsf|textsc|textmd|textup)\{([^}]+)\}/g, '$1')
		.replace(/\{([^{}]*)\}/g, '$1')
		.replace(/^\s+|\s+$/g, '').replace(/\s{2,}/g, ' ');
}

function parseBibtexEntry(entryText) {
	if (!entryText) return null;
	const entry = {};
	const typeMatch = entryText.match(/^@(\w+)\s*[\{(]\s*/);
	if (!typeMatch) return null;
	entry.type = typeMatch[1].toLowerCase();
	let i = typeMatch[0].length;
	let keyEnd = i;
	while (keyEnd < entryText.length && entryText[keyEnd] !== ',' && entryText[keyEnd] !== '}' && entryText[keyEnd] !== ')') keyEnd++;
	entry.id = entryText.slice(i, keyEnd).trim();
	if (!entry.id) return null;
	i = keyEnd;
	if (i < entryText.length && (entryText[i] === ',' || entryText[i] === ' ')) i++;
	while (i < entryText.length) {
		while (i < entryText.length && /[\s,]/.test(entryText[i])) i++;
		if (i >= entryText.length || entryText[i] === '}' || entryText[i] === ')') break;
		let nameEnd = i;
		while (nameEnd < entryText.length && /[a-zA-Z_\-]/.test(entryText[nameEnd])) nameEnd++;
		if (nameEnd === i) { i++; continue; }
		const fieldName = entryText.slice(i, nameEnd).toLowerCase();
		i = nameEnd;
		while (i < entryText.length && /\s/.test(entryText[i])) i++;
		if (i >= entryText.length || entryText[i] !== '=') continue;
		i++;
		const { value, endIdx } = _parseBibtexFieldValue(entryText, i);
		entry[fieldName] = _cleanBibtexValue(value);
		i = endIdx;
	}
	return entry;
}

// ─── Public parse API ─────────────────────────────────────────────────────────

export function parseBibtex(bibContent, style) {
	if (style) bibliographyStyle = style;
	if (!bibContent || !bibContent.trim()) return bibliographyDatabase.size;

	let src = bibContent;
	src = src.replace(/@comment\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, '');
	src = src.replace(/@comment[^\n]*/gi, '');

	const strRx = /@string\s*[\{(]\s*(\w+)\s*=\s*/gi;
	let sm;
	while ((sm = strRx.exec(src)) !== null) {
		const { value } = _parseBibtexFieldValue(src, strRx.lastIndex);
		_bibStringMacros.set(sm[1].toLowerCase(), _cleanBibtexValue(value));
	}

	const atRx = /@(\w+)\s*[\{(]/g;
	let atM;
	while ((atM = atRx.exec(src)) !== null) {
		const typeLower = atM[1].toLowerCase();
		if (typeLower === 'string' || typeLower === 'preamble' || typeLower === 'comment') continue;
		const openIdx = atM.index + atM[0].length - 1;
		let closeIdx;
		if (src[openIdx] === '{') {
			closeIdx = _findMatchingBrace(src, openIdx);
		} else {
			let depth = 1, j = openIdx + 1;
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

export function addBibtexEntry(entry) {
	if (entry && entry.id) bibliographyDatabase.set(entry.id, entry);
}

export function getBibtexEntry(id) {
	return bibliographyDatabase.get(id) || null;
}

export function getAllBibtexEntries() {
	return bibliographyDatabase;
}

export function clearBibliography() {
	bibliographyDatabase.clear();
}

// ─── Author name helpers ──────────────────────────────────────────────────────

function _splitAuthors(str) {
	if (!str) return [];
	return str.split(/\s+and\s+/i).map(a => a.trim()).filter(Boolean);
}

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

export function _lastNameOf(raw) {
	raw = (raw || '').trim();
	if (raw.includes(',')) return raw.split(',')[0].trim();
	const parts = raw.split(/\s+/);
	return parts[parts.length - 1] || raw;
}

function _authorsShort(authorsStr) {
	const authors = _splitAuthors(authorsStr);
	if (!authors.length) return '';
	if (authors[0].toLowerCase().trim() === 'others' || authors[0].trim() === '') return 'et al.';
	const ln0 = _lastNameOf(authors[0]);
	if (authors.length === 1) return ln0;
	if (authors.length === 2 && authors[1].toLowerCase().trim() !== 'others')
		return ln0 + ' & ' + _lastNameOf(authors[1]);
	return ln0 + ' et al.';
}

function _authorsLong(authorsStr, maxFull = 6) {
	const authors = _splitAuthors(authorsStr);
	if (!authors.length) return '';
	const formatted = authors.map(_formatOneAuthor);
	const hasOthers = formatted[formatted.length - 1] === 'et al.';
	if (hasOthers) return formatted.slice(0, -1).join(', ') + ', et al.';
	if (formatted.length <= maxFull) {
		if (formatted.length === 1) return formatted[0];
		return formatted.slice(0, -1).join(', ') + ' & ' + formatted[formatted.length - 1];
	}
	return formatted.slice(0, 3).join(', ') + ', et al.';
}

function _alphaLabel(entry) {
	const authors = _splitAuthors(entry.author || entry.editor || '');
	const year2 = (entry.year || '??').replace(/\D/g, '').slice(-2);
	if (!authors.length) return (entry.id || 'anon').slice(0, 4) + year2;
	if (authors.length === 1) return _lastNameOf(authors[0]).slice(0, 3) + year2;
	return authors.slice(0, 3).map(a => (_lastNameOf(a)[0] || '?').toUpperCase()).join('') + year2;
}

// ─── Per-type badge & link helpers ───────────────────────────────────────────

const _TYPE_LABELS = {
	article: 'Article', book: 'Book', inproceedings: 'Conf.', conference: 'Conf.',
	proceedings: 'Proceedings', incollection: 'Book Ch.', inbook: 'Book Ch.',
	phdthesis: 'PhD Thesis', mastersthesis: "Master's", techreport: 'Tech Rep.',
	report: 'Report', misc: 'Misc', online: 'Online', electronic: 'Online', www: 'Online',
	software: 'Software', dataset: 'Dataset', unpublished: 'Unpub.',
	manual: 'Manual', booklet: 'Booklet', patent: 'Patent',
};

function _typeBadge(type) {
	const label = _TYPE_LABELS[type] || type;
	return `<span class="bib-type-badge bib-type-${escapeHtml(type)}">${escapeHtml(label)}</span>`;
}

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

// ─── Per-type entry body renderer ─────────────────────────────────────────────

function _renderEntryBody(entry) {
	const eh = escapeHtml;
	const authors = _authorsLong(entry.author);
	const editors = _authorsLong(entry.editor);
	const title     = entry.title     || '';
	const year      = entry.year      || 'n.d.';
	const journal   = entry.journal   || '';
	const booktitle = entry.booktitle || '';
	const publisher = entry.publisher || '';
	const address   = entry.address   || '';
	const volume    = entry.volume    || '';
	const number    = entry.number    || '';
	const pages     = entry.pages     || '';
	const chapter   = entry.chapter   || '';
	const school    = entry.school || entry.institution || '';
	const institution = entry.institution || '';
	const howpub    = entry.howpublished || '';
	const edition   = entry.edition   || '';
	const series    = entry.series    || '';
	const note      = entry.note      || '';
	const doi       = entry.doi       || '';
	const url       = entry.url       || '';
	const version   = entry.version   || '';
	const urldate   = entry.urldate || entry.visited || '';
	const pubStr    = [publisher, address].filter(Boolean).join(', ');

	const A   = authors ? `<span class="bib-authors">${eh(authors)}.</span> ` : '';
	const Ed  = editors ? `<span class="bib-authors">${eh(editors)}, ${editors.includes('&') ? 'Eds.' : 'Ed.'}</span> ` : '';
	const Y   = ` <span class="bib-year">(${eh(year)})</span>.`;
	const T   = title ? ` \u201C<span class="bib-title">${eh(title)}</span>.\u201D` : '';
	const TI  = title ? ` <em class="bib-title">${eh(title)}</em>.` : '';
	const V   = volume ? `, <strong>${eh(volume)}</strong>` : '';
	const NN  = number ? `(${eh(number)})` : '';
	const PP  = pages ? (journal ? ':' + eh(pages) : ` pp.\u00A0${eh(pages)}`) : '';
	const DOI = _doiLink(doi);
	const URL = !doi && url ? _urlLink(url) : '';
	const NOTE = note ? ` <span style="color:var(--bib-text-dim)">${eh(note)}.</span>` : '';
	const PUB = pubStr ? ` ${eh(pubStr)}.` : '';
	const SER = series ? ` <em>${eh(series)}</em>.` : '';

	switch (entry.type) {
		case 'article':
			return A + Y + T + (journal ? ` <em class="bib-venue">${eh(journal)}</em>` : '') + V + NN + PP + '.' + DOI + URL + NOTE;
		case 'book':
			return (authors ? A : Ed) + Y + TI + (edition ? ` ${eh(edition)}\u00A0ed.` : '') + SER + PUB + DOI + URL + NOTE;
		case 'inproceedings': case 'conference':
			return A + Y + T + (booktitle ? ` In <em class="bib-venue">${eh(booktitle)}</em>.` : '') +
				(editors ? ` Ed.\u00A0${eh(_authorsLong(entry.editor))}.` : '') +
				(pages ? ` pp.\u00A0${eh(pages)}.` : '') + PUB + DOI + URL + NOTE;
		case 'proceedings':
			return (authors ? A : Ed) + Y + TI + SER + PUB + DOI + URL + NOTE;
		case 'incollection':
			return A + Y + T + (booktitle ? ` In <em class="bib-venue">${eh(booktitle)}</em>` : '') +
				(editors ? `, ed.\u00A0${eh(_authorsLong(entry.editor))}` : '') +
				(pages ? `, pp.\u00A0${eh(pages)}` : '') + '.' + PUB + DOI + URL + NOTE;
		case 'inbook':
			return A + Y + TI + (chapter ? ` Ch.\u00A0${eh(chapter)}.` : '') +
				(pages ? ` pp.\u00A0${eh(pages)}.` : '') + PUB + DOI + URL + NOTE;
		case 'phdthesis':
			return A + Y + TI + ' PhD thesis' + (school ? `, ${eh(school)}` : '') + '.' + URL + NOTE;
		case 'mastersthesis':
			return A + Y + TI + " Master\u2019s thesis" + (school ? `, ${eh(school)}` : '') + '.' + URL + NOTE;
		case 'techreport': case 'report':
			return A + Y + TI + ' Technical Report' +
				(entry.number ? `\u00A0${eh(entry.number)}` : '') +
				(institution ? `, ${eh(institution)}` : '') + '.' + URL + NOTE;
		case 'manual':
			return (authors ? A : (entry.organization ? `<span class="bib-authors">${eh(entry.organization)}.</span> ` : '')) +
				Y + TI + (entry.organization && authors ? ` ${eh(entry.organization)}.` : '') +
				(edition ? ` ${eh(edition)}\u00A0ed.` : '') + URL + NOTE;
		case 'booklet':
			return A + Y + TI + (howpub ? ` ${eh(howpub)}.` : '') + URL + NOTE;
		case 'unpublished':
			return A + Y + T + ' Unpublished manuscript.' + NOTE;
		case 'patent':
			return A + Y + T + (entry.number ? ` Patent\u00A0${eh(entry.number)}.` : '') + NOTE;
		case 'misc': case 'online': case 'electronic': case 'www': case 'software': case 'dataset': {
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
				(journal ? ` <em>${eh(journal)}</em>.` : '') +
				(booktitle ? ` <em>${eh(booktitle)}</em>.` : '') +
				PUB + DOI + URL + NOTE;
	}
}

// ─── Inline source card (bare @TYPE{...} blocks in plain text) ────────────────

function _renderInlineSourceCard(entry, rawText) {
	const key = entry.id || '';
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

	return (
		`<details class="bib-source-card">` +
		`<summary>` +
		`<span class="bib-source-icon">\uD83D\uDCDA</span>` +
		`<span class="bib-source-title">Bibliography Source</span>` +
		`<span class="bib-source-count">1 entry</span>` +
		`<span class="bib-source-chevron">\u25BC</span>` +
		`</summary>` +
		`<div class="bib-source-entries">${entryRow}</div>` +
		`<div class="bib-source-raw">${escapeHtml(rawText)}</div>` +
		`</details>`
	);
}

// ─── Tooltip HTML ─────────────────────────────────────────────────────────────

function _tooltipHtml(entry) {
	const authors = _authorsShort(entry.author || entry.editor || '');
	const title = entry.title || '';
	const year  = entry.year  || 'n.d.';
	const venue = entry.journal || entry.booktitle || entry.school || entry.institution || entry.howpublished || '';
	let html = `<div class="bib-tooltip-key">${escapeHtml(entry.id)}</div>`;
	if (authors) html += `<div class="bib-tooltip-authors">${escapeHtml(authors)}</div>`;
	if (title)   html += `<div class="bib-tooltip-title">${escapeHtml(title.slice(0, 120) + (title.length > 120 ? '…' : ''))}</div>`;
	if (venue || year) {
		html += `<div class="bib-tooltip-venue">`;
		if (venue) html += escapeHtml(venue.slice(0, 80) + (venue.length > 80 ? '…' : ''));
		if (venue && year) html += ', ';
		if (year)  html += `<span class="bib-tooltip-year">${escapeHtml(year)}</span>`;
		html += `</div>`;
	}
	return html;
}

// ─── generateBibliography ─────────────────────────────────────────────────────

export function generateBibliography(opts, citationNumbers) {
	const style  = (opts && opts.style)  ? opts.style  : bibliographyStyle;
	const filter = (opts && opts.filter) ? opts.filter : null;
	const cn     = citationNumbers instanceof Map ? citationNumbers : new Map();

	let entries = Array.from(bibliographyDatabase.values());
	if (filter) entries = entries.filter(filter);
	if (!entries.length) return '';

	if (style === 'ieee' || style === 'vancouver') {
		entries.sort((a, b) => {
			const na = cn.has(a.id) ? cn.get(a.id) : Infinity;
			const nb = cn.has(b.id) ? cn.get(b.id) : Infinity;
			return na !== nb ? na - nb : a.id.localeCompare(b.id);
		});
	} else if (style === 'alpha') {
		entries.sort((a, b) => _alphaLabel(a).localeCompare(_alphaLabel(b)));
	} else {
		entries.sort((a, b) => {
			const la = _authorsShort(a.author || a.editor || '').toLowerCase();
			const lb = _authorsShort(b.author || b.editor || '').toLowerCase();
			const cmp = la.localeCompare(lb);
			return cmp !== 0 ? cmp : (a.year || '').localeCompare(b.year || '');
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
		if (style === 'alpha') label = '[' + _alphaLabel(entry) + ']';
		else if (isAuthorYear) label = '';
		else { const n = cn.has(entry.id) ? cn.get(entry.id) : idx + 1; label = '[' + n + ']'; }

		const anchorId = 'cite-entry-' + entry.id.replace(/[^a-zA-Z0-9_-]/g, '_');
		html += `<div class="latex-bibliography-entry" id="${anchorId}" data-cite-key="${escapeHtml(entry.id)}">`;
		if (!isAuthorYear) html += `<div class="bib-label-col"><span class="bib-number">${escapeHtml(label)}</span></div>`;
		html += `<div class="bib-content-col">${_renderEntryBody(entry)}${_typeBadge(entry.type)}</div>`;
		html += `</div>`;
	});
	html += '</div>';
	return html;
}

// ─── Citation inline renderer ─────────────────────────────────────────────────

function _renderCitation(keys, command, citationNumbers, style, preNote, postNote) {
	if (!keys.length) return '';
	const isNumbered = !['authoryear','apa','harvard','chicago','mla'].includes(style);

	if (isNumbered) {
		keys.forEach(key => {
			if (!citationNumbers.has(key)) citationNumbers.set(key, citationNumbers.size + 1);
		});
	}

	const entries = keys.map(k => bibliographyDatabase.get(k) || null);

	const makeLabel = (entry, key) => {
		if (!entry) {
			return `<span class="latex-citation-missing" title="Citation key \u2018${escapeHtml(key)}\u2019 not found in bibliography">${escapeHtml(key)}\u00A0\u26A0</span>`;
		}
		const paperHref = resolveEntryHref(entry);
		const target = paperHref ? ' target="_blank" rel="noopener noreferrer"' : '';
		const tipHtml  = _tooltipHtml(entry);
		const tipAttr  = ` data-bib-tooltip="${escapeHtml(tipHtml)}" data-cite-key="${escapeHtml(key)}"`;
		const wrapLink = (inner) => paperHref
			? `<a class="latex-citation-link" href="${escapeHtml(paperHref)}"${target}${tipAttr}>${inner}</a>`
			: `<span class="latex-citation-link"${tipAttr}>${inner}</span>`;

		if (style === 'alpha') return wrapLink(escapeHtml(_alphaLabel(entry)));
		if (isNumbered) return wrapLink(String(citationNumbers.get(key) || '?'));
		const auth = _authorsShort(entry.author || entry.editor || '');
		const yr   = entry.year || 'n.d.';
		return wrapLink(escapeHtml(auth) + '\u00A0' + escapeHtml(yr));
	};

	const preStr  = preNote  ? escapeHtml(preNote) + '\u00A0'  : '';
	const postStr = postNote ? ',\u00A0' + escapeHtml(postNote) : '';
	const cmd = command.toLowerCase();

	if (cmd === 'citeauthor') {
		return entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const tipAttr = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const href = resolveEntryHref(e);
			const tgt  = href ? ' target="_blank" rel="noopener noreferrer"' : '';
			const inner = escapeHtml(_authorsShort(e.author || e.editor || ''));
			return href
				? `<a class="latex-citation-link" href="${escapeHtml(href)}"${tgt}${tipAttr}>${inner}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${inner}</span>`;
		}).join(', ');
	}

	if (cmd === 'citeyear' || cmd === 'citeyearpar') {
		const yrs = entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const tipAttr = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const href = resolveEntryHref(e);
			const tgt  = href ? ' target="_blank" rel="noopener noreferrer"' : '';
			const inner = escapeHtml(e.year || 'n.d.');
			return href
				? `<a class="latex-citation-link" href="${escapeHtml(href)}"${tgt}${tipAttr}>${inner}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${inner}</span>`;
		});
		const inner = yrs.join(', ');
		return cmd === 'citeyearpar' ? `(${inner})` : inner;
	}

	if (cmd === 'citet' || cmd === 'textcite' || cmd === 'citet*' || cmd === 'textcite*') {
		return entries.map((e, i) => {
			if (!e) return `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`;
			const tipAttr = ` data-bib-tooltip="${escapeHtml(_tooltipHtml(e))}" data-cite-key="${escapeHtml(keys[i])}"`;
			const auth = _authorsShort(e.author || e.editor || '');
			if (isNumbered) {
				const n = citationNumbers.get(keys[i]) || '?';
				const href = resolveEntryHref(e);
				const tgt  = href ? ' target="_blank" rel="noopener noreferrer"' : '';
				const nEl  = href
					? `<a class="latex-citation-link" href="${escapeHtml(href)}"${tgt}${tipAttr}>${n}</a>`
					: `<span class="latex-citation-link"${tipAttr}>${n}</span>`;
				return `${escapeHtml(auth)}\u00A0${nEl}`;
			}
			const href = resolveEntryHref(e);
			const tgt  = href ? ' target="_blank" rel="noopener noreferrer"' : '';
			const ayInner = `(${escapeHtml(e.year || 'n.d.')}${postStr})`;
			const ayEl = href
				? `<a class="latex-citation-link" href="${escapeHtml(href)}"${tgt}${tipAttr}>${ayInner}</a>`
				: `<span class="latex-citation-link"${tipAttr}>${ayInner}</span>`;
			return `${escapeHtml(auth)}\u00A0${ayEl}`;
		}).join('; ');
	}

	if (cmd === 'footcite' || cmd === 'footcitetext') {
		const full = entries.map((e, i) => e
			? _authorsShort(e.author || e.editor || '') + (e.year ? ' (' + e.year + ')' : '') + (e.title ? '. ' + e.title : '')
			: keys[i]
		).join('; ');
		return `<sup class="latex-footnote-cite" title="${escapeHtml(full)}">[note]</sup>`;
	}

	if (cmd === 'fullcite') {
		return entries.map((e, i) => e
			? `<span class="latex-citation" style="display:block;margin:0.25em 0">${_renderEntryBody(e)}</span>`
			: `<span class="latex-citation-missing">${escapeHtml(keys[i])}</span>`
		).join('');
	}

	if (cmd === 'nocite') return '';

	// Default: \cite, \citep, \parencite, \autocite, etc.
	const labels = keys.map((k, i) => makeLabel(entries[i], k));
	if (isNumbered || style === 'alpha') return `${preStr}${labels.join(', ')}${postStr}`;
	return `(${preStr}${labels.join('; ')}${postStr})`;
}

// ─── thebibliography environment ─────────────────────────────────────────────

function _processThebibliography(text) {
	return text.replace(
		/\\begin\{thebibliography\}\s*\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/g,
		(_, body) => {
			const items = [];
			const itemRx = /\\bibitem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|$)/g;
			let m;
			while ((m = itemRx.exec(body)) !== null) {
				items.push({ label: m[1] || '', key: m[2].trim(), content: m[3].trim() });
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

// ─── processBibliography ──────────────────────────────────────────────────────

export function processBibliography(text) {
	if (!text) return text;

	const citationNumbers = new Map();
	const style = bibliographyStyle;
	let hasPrintBib = false;
	let p = text;

	p = _processThebibliography(p);

	// Intercept bare @TYPE{...} blocks in plain text
	{
		const ENTRY_TYPES = 'article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|manual|booklet|proceedings|inbook|unpublished|patent|dataset|software|report';
		const inlineRx = new RegExp('@(?:' + ENTRY_TYPES + ')\\s*[\\{(]', 'gi');
		let em, out = '', last = 0;
		inlineRx.lastIndex = 0;
		while ((em = inlineRx.exec(p)) !== null) {
			const startIdx = em.index;
			const openCh   = em[0].slice(-1);
			const openIdx  = startIdx + em[0].length - 1;
			let depth = 1, closeIdx = -1;
			for (let ci = openIdx + 1; ci < p.length; ci++) {
				const ch = p[ci];
				if (ch === '\\') { ci++; continue; }
				if (openCh === '{' && ch === '{') depth++;
				else if (openCh === '{' && ch === '}') { depth--; if (depth === 0) { closeIdx = ci; break; } }
				else if (openCh === '(' && ch === '(') depth++;
				else if (openCh === '(' && ch === ')') { depth--; if (depth === 0) { closeIdx = ci; break; } }
			}
			if (closeIdx === -1) continue;
			const entryText = p.slice(startIdx, closeIdx + 1);
			const entry = parseBibtexEntry(entryText);
			if (entry && entry.id) {
				bibliographyDatabase.set(entry.id, entry);
				out += p.slice(last, startIdx);
				out += _renderInlineSourceCard(entry, entryText);
				last = closeIdx + 1;
				inlineRx.lastIndex = last;
			}
		}
		p = out + p.slice(last);
	}

	p = p.replace(/\\addbibresource\s*\{[^}]+\}/g, '');
	p = p.replace(/\\bibliographystyle\s*\{([^}]+)\}/g, (_, s) => { bibliographyStyle = s.toLowerCase(); return ''; });

	p = p.replace(/\\bibliography\s*\{([^}]+)\}/g, (_, files) => {
		hasPrintBib = true;
		return bibliographyDatabase.size > 0
			? generateBibliography({}, citationNumbers)
			: `<div class="latex-bibliography-note"><em>Bibliography source: ${escapeHtml(files)}</em></div>`;
	});

	const CITE_RX = /\\(cite[a-zA-Z]*|textcite|Textcite|parencite|Parencite|autocite|Autocite|footcite|footcitetext|fullcite|supercite|volcite|Volcite|notecite|Notecite|pnotecite|Pnotecite|fnotecite|Fnotecite)\*?\s*(?:\[([^\]]*)\])?\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
	p = p.replace(CITE_RX, (_, cmd, bracketA, bracketB, keysRaw) => {
		const keys     = keysRaw.split(/\s*,\s*/).map(k => k.trim()).filter(Boolean);
		const preNote  = bracketB !== undefined ? (bracketA || '') : '';
		const postNote = bracketB !== undefined ? (bracketB || '') : (bracketA || '');
		return _renderCitation(keys, cmd, citationNumbers, style, preNote, postNote);
	});

	p = p.replace(/\\printbibliography\s*(?:\[([^\]]*)\])?/g, (_, optStr) => {
		hasPrintBib = true;
		const opts = {};
		if (optStr) {
			const sm = optStr.match(/style\s*=\s*(\w+)/);
			if (sm) opts.style = sm[1].toLowerCase();
			const tm = optStr.match(/type\s*=\s*(\w+)/);
			if (tm) opts.filter = e => e.type === tm[1].toLowerCase();
			const km = optStr.match(/keyword\s*=\s*(\w+)/);
			if (km) { const kw = km[1].toLowerCase(); opts.filter = e => (e.keywords || '').toLowerCase().includes(kw); }
			const ntm = optStr.match(/nottype\s*=\s*(\w+)/);
			if (ntm) opts.filter = e => e.type !== ntm[1].toLowerCase();
		}
		return generateBibliography(opts, citationNumbers);
	});

	if (citationNumbers.size > 0 && !hasPrintBib && bibliographyDatabase.size > 0) {
		p += '\n\n' + generateBibliography({}, citationNumbers);
	}

	return p;
}

// ─── Citation hover tooltips ──────────────────────────────────────────────────

let _tooltipEl = null;
let _bibTooltipOver = null;
let _bibTooltipMove = null;
let _bibTooltipOut  = null;

function _positionTooltip(cx, cy) {
	if (!_tooltipEl) return;
	const margin = 14;
	const tw = _tooltipEl.offsetWidth  || 320;
	const th = _tooltipEl.offsetHeight || 80;
	let x = cx + margin, y = cy + margin;
	const vw = window.innerWidth  || 800;
	const vh = window.innerHeight || 600;
	if (x + tw > vw - 8) x = Math.max(4, cx - tw - margin);
	if (y + th > vh - 8) y = Math.max(4, cy - th - margin);
	_tooltipEl.style.left = x + 'px';
	_tooltipEl.style.top  = y + 'px';
}

export function initBibTooltips() {
	if (typeof window === 'undefined' || typeof document === 'undefined') return;

	if (!_tooltipEl) {
		_tooltipEl = document.createElement('div');
		_tooltipEl.className = 'bib-tooltip';
		_tooltipEl.setAttribute('aria-hidden', 'true');
		_tooltipEl.setAttribute('role', 'tooltip');
		document.body.appendChild(_tooltipEl);
	}

	let hideTimer = null;
	const show = (e) => {
		const target = e.target?.closest?.('[data-bib-tooltip]');
		if (!target) return;
		clearTimeout(hideTimer);
		_tooltipEl.innerHTML = target.dataset.bibTooltip || '';
		_tooltipEl.classList.add('visible');
		_positionTooltip(e.clientX, e.clientY);
	};
	const move = (e) => { if (_tooltipEl.classList.contains('visible')) _positionTooltip(e.clientX, e.clientY); };
	const hide = (e) => {
		if (!e.target?.closest?.('[data-bib-tooltip]')) return;
		hideTimer = setTimeout(() => _tooltipEl?.classList.remove('visible'), 150);
	};

	document.removeEventListener('mouseover', _bibTooltipOver, true);
	document.removeEventListener('mousemove', _bibTooltipMove, true);
	document.removeEventListener('mouseout',  _bibTooltipOut,  true);

	_bibTooltipOver = show;
	_bibTooltipMove = move;
	_bibTooltipOut  = hide;

	document.addEventListener('mouseover', _bibTooltipOver, true);
	document.addEventListener('mousemove', _bibTooltipMove, true);
	document.addEventListener('mouseout',  _bibTooltipOut,  true);
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBibTooltips);
	else initBibTooltips();
}
