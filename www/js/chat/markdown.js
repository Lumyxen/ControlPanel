/**
 * Comprehensive Markdown Parser v2
 * Fully rewritten with robust table support, improved tokenization,
 * and cleaner architecture.
 *
 * Supports:
 * - GitHub Flavored Markdown (GFM): Tables, strikethrough, task lists, autolinks
 * - Basic Markdown: Headers, lists, links, images, bold/italic, code blocks, blockquotes, HRs
 * - Obsidian-style: WikiLinks [[...]], highlights ==text==, callouts/admonitions
 * - Discord-style: Spoilers ||text||, mentions, timestamps
 * - Syntax highlighting for 15+ languages
 * - BibTeX: ```bibtex code blocks intercepted and rendered as bibliography cards
 */

import { parseBibtex, getAllBibtexEntries } from './latex/index.js';
import { renderLatexCodeblock } from './latex/math.js';
import { BibTeXEngine } from '../latex/engines/bibtex-engine.js';

function escapeHtml(text) {
	if (!text) return '';
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

class Renderer {
	constructor(options = {}) {
		this.options = { gfm: true, breaks: true, langPrefix: 'language-', ...options };
	}

	code(code, infostring) {
		const lang = ((infostring || '').match(/\S*/)[0] || '').toLowerCase();

		const BIBTEX_RX = /^\s*@(?:article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|proceedings|inbook|unpublished|manual|booklet|patent|dataset|software|report)\s*[\{(]/i;
		const isBibtex = lang === 'bibtex' || lang === 'bib' || BIBTEX_RX.test(code);

		if (isBibtex) {
			const engine = new BibTeXEngine();
			const entries = engine.parse(code);
			const blockKeys = entries.map(e => e.key);
			const count = blockKeys.length;
			const countLabel = count === 1 ? '1 entry' : `${count} entries`;
			let entryRows = '';
			for (const key of blockKeys) {
				const e = engine.getEntry(key);
				if (!e) continue;
				const firstAuthorRaw = (e.fields?.author || e.fields?.editor || '').split(/\s+and\s+/i)[0] || '';
				const authorShort = firstAuthorRaw.includes(',')
					? firstAuthorRaw.split(',')[0].trim()
					: firstAuthorRaw.split(/\s+/).pop() || '';
				const titleShort = e.fields?.title
					? escapeHtml(e.fields.title.slice(0, 72) + (e.fields.title.length > 72 ? '…' : ''))
					: '';
				const infoParts = [
					authorShort ? escapeHtml(authorShort) : null,
					titleShort ? `<em>${titleShort}</em>` : null,
					e.fields?.year ? escapeHtml(e.fields.year) : null,
				].filter(Boolean);
				entryRows +=
					`<div class="bib-source-entry">` +
					`<span class="bib-source-entry-key">${escapeHtml(key)}</span>` +
					`<span class="bib-source-entry-info">${infoParts.join(', ')}</span>` +
					`</div>`;
			}
			const rawEscaped = escapeHtml(code);
			return (
				`<details class="bib-source-card">` +
				`<summary>` +
				`<span class="bib-source-icon"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg></span>` +
				`<span class="bib-source-title">Bibliography Source</span>` +
				`<span class="bib-source-count">${escapeHtml(countLabel)}</span>` +
				`<span class="bib-source-chevron"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>` +
				`</summary>` +
				(entryRows ? `<div class="bib-source-entries">${entryRows}</div>` : '') +
				`<div class="bib-source-raw">${rawEscaped}</div>` +
				`</details>\n`
			);
		}

		if (lang === 'latex' || lang === 'tex') {
			const rendered = renderLatexCodeblock(code);
			const className = ` class="${this.options.langPrefix}${escapeHtml(lang)}"`;
			return `<div class="md-code-wrapper md-code-latex">
<div class="md-code-header" title="Click to collapse/expand">
<span class="md-code-lang">${escapeHtml(lang)}</span>
<div class="md-code-actions">
<button type="button" class="md-code-copy" aria-label="Copy code" title="Copy code">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 5.00005C7.01165 5.00082 6.49359 5.01338 6.09202 5.21799C5.71569 5.40973 5.40973 5.71569 5.21799 6.09202C5 6.51984 5 7.07989 5 8.2V17.8C5 18.9201 5 19.4802 5.21799 19.908C5.40973 20.2843 5.71569 20.5903 6.09202 20.782C6.51984 21 7.07989 21 8.2 21H15.8C16.9201 21 17.4802 21 17.908 20.782C18.2843 20.5903 18.5903 20.2843 18.782 19.908C19 19.4802 19 18.9201 19 17.8V8.2C19 7.07989 19 6.51984 18.782 6.09202C18.5903 5.71569 18.2843 5.40973 17.908 5.21799C17.5064 5.01338 16.9884 5.00082 16 5.00005M8 5.00005V7H16V5.00005M8 5.00005V4.70711C8 4.25435 8.17986 3.82014 8.5 3.5C8.82014 3.17986 9.25435 3 9.70711 3H14.2929C14.7456 3 15.1799 3.17986 15.5 3.5C15.8201 3.82014 16 4.25435 16 4.70711V5.00005" /></svg>
</button>
<span class="md-code-collapse-icon">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" class="collapse-chevron"><path d="M6 9l6 6 6-6"/></svg>
</span>
</div>
</div>
<div class="md-code-body">
<pre class="md-code-block"><code${className}>${rendered}</code></pre>
</div>
</div>\n`;
		}

		const displayLang = lang || 'text';
		const className = lang ? ` class="${this.options.langPrefix}${escapeHtml(lang)}"` : '';
		const highlighted = lang ? highlightCode(code, lang) : escapeHtml(code);

		return `<div class="md-code-wrapper">
<div class="md-code-header" title="Click to collapse/expand">
<span class="md-code-lang">${escapeHtml(displayLang)}</span>
<div class="md-code-actions">
<button type="button" class="md-code-copy" aria-label="Copy code" title="Copy code">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 5.00005C7.01165 5.00082 6.49359 5.01338 6.09202 5.21799C5.71569 5.40973 5.40973 5.71569 5.21799 6.09202C5 6.51984 5 7.07989 5 8.2V17.8C5 18.9201 5 19.4802 5.21799 19.908C5.40973 20.2843 5.71569 20.5903 6.09202 20.782C6.51984 21 7.07989 21 8.2 21H15.8C16.9201 21 17.4802 21 17.908 20.782C18.2843 20.5903 18.5903 20.2843 18.782 19.908C19 19.4802 19 18.9201 19 17.8V8.2C19 7.07989 19 6.51984 18.782 6.09202C18.5903 5.71569 18.2843 5.40973 17.908 5.21799C17.5064 5.01338 16.9884 5.00082 16 5.00005M8 5.00005V7H16V5.00005M8 5.00005V4.70711C8 4.25435 8.17986 3.82014 8.5 3.5C8.82014 3.17986 9.25435 3 9.70711 3H14.2929C14.7456 3 15.1799 3.17986 15.5 3.5C15.8201 3.82014 16 4.25435 16 4.70711V5.00005" /></svg>
</button>
<span class="md-code-collapse-icon">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" class="collapse-chevron"><path d="M6 9l6 6 6-6"/></svg>
</span>
</div>
</div>
<div class="md-code-body">
<pre class="md-code-block"><code${className}>${highlighted}</code></pre>
</div>
</div>\n`;
	}

	table(header, body) {
		return `<div class="md-table-wrapper"><table class="md-table">\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table></div>\n`;
	}

	tablerow(content) {
		return `<tr class="md-table-row">\n${content}</tr>\n`;
	}

	tablecell(content, flags) {
		const type = flags.header ? 'th' : 'td';
		const align = flags.align ? ` align="${flags.align}"` : '';
		const className = flags.header ? 'md-table-header' : 'md-table-cell';
		return `<${type} class="${className}"${align}>${content}</${type}>\n`;
	}

	strong(text) {
		return `<strong>${text}</strong>`;
	}

	em(text) {
		return `<em>${text}</em>`;
	}

	codespan(text) {
		return `<code class="md-code md-code-inline">${text}</code>`;
	}

	br() {
		return '<br>';
	}

	del(text) {
		return `<del>${text}</del>`;
	}

	paragraph(text) {
		return `<p class="md-paragraph">${text}</p>\n`;
	}

	link(href, title, text) {
		const cleanHref = encodeURI(href).replace(/%25/g, '%');
		let out = `<a href="${escapeHtml(cleanHref)}" class="md-link"`;
		if (title) out += ` title="${escapeHtml(title)}"`;
		out += ` target="_blank" rel="noopener noreferrer">${text}</a>`;
		return out;
	}

	image(href, title, text) {
		const cleanHref = encodeURI(href).replace(/%25/g, '%');
		let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}" class="md-image">`;
		if (title) out += ` title="${escapeHtml(title)}"`;
		return `<div class="md-image-container">${out}</div>`;
	}

	heading(text, level) {
		const tag = `h${Math.min(Math.max(level, 1), 6)}`;
		return `<${tag} class="md-heading md-heading-${level}">${text}</${tag}>\n`;
	}

	blockquote(text) {
		return `<blockquote class="md-blockquote">${text}</blockquote>\n`;
	}

	hr() {
		return '<hr class="md-hr">\n';
	}

	html(text) {
		return text;
	}

	list(body, ordered, start) {
		const tag = ordered ? 'ol' : 'ul';
		const startAttr = ordered && start && start !== 1 ? ` start="${start}"` : '';
		return `<${tag} class="md-list md-list-${ordered ? 'ordered' : 'unordered'}"${startAttr}>\n${body}</${tag}>\n`;
	}

	listitem(text, task, checked) {
		const taskHtml = task ? `<label class="md-task-label"><input type="checkbox" class="md-task-checkbox"${checked ? ' checked' : ''} disabled> </label>` : '';
		return `<li class="md-list-item">${taskHtml}${text}</li>\n`;
	}

	deflist(body) {
		return `<dl class="md-deflist">${body}</dl>\n`;
	}

	defterm(text) {
		return `<dt class="md-defterm">${text}</dt>\n`;
	}

	defdesc(text) {
		return `<dd class="md-defdesc">${text}</dd>\n`;
	}
}

class InlineParser {
	constructor(renderer, options = {}) {
		this.renderer = renderer;
		this.options = { gfm: true, breaks: true, ...options };
	}

	parse(src) {
		let out = '';
		src = src || '';

		while (src) {
			let match = src.match(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/);
			if (match) {
				out += match[1];
				src = src.substring(match[0].length);
				continue;
			}

			if (src[0] === '<') {
				const tagMatch = src.match(/^<[^>]+>/);
				if (tagMatch) {
					out += tagMatch[0];
					src = src.substring(tagMatch[0].length);
					continue;
				}
			}

			match = src.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]+)>/);
			if (match) {
				out += this.renderer.link(match[1], null, match[1]);
				src = src.substring(match[0].length);
				continue;
			}

			if (this.options.gfm) {
				match = src.match(/^https?:\/\/[^\s<]+[^<.,:;"')\]\s]/);
				if (match) {
					out += this.renderer.link(match[0], null, match[0]);
					src = src.substring(match[0].length);
					continue;
				}
			}

			match = src.match(/^<!--[\s\S]*?-->/);
			if (match) {
				out += match[0];
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^!?\[([^\]]*)\]\(([^)]+)\)/);
			if (match) {
				const isImage = match[0][0] === '!';
				const linkText = match[1];
				const href = match[2].split('"')[0].trim();
				const titleMatch = match[2].match(/"([^"]*)"/);
				const title = titleMatch ? titleMatch[1] : null;
				if (isImage) {
					out += this.renderer.image(href, title, linkText);
				} else {
					out += this.renderer.link(href, title, linkText);
				}
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^\*\*\*([\s\S]+?)\*\*\*(?!\*)/);
			if (match) {
				out += this.renderer.strong(this.renderer.em(match[1]));
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^___([\s\S]+?)___(?!_)/);
			if (match) {
				out += this.renderer.strong(this.renderer.em(match[1]));
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^\*\*([\s\S]+?)\*\*(?!\*)/);
			if (match) {
				out += this.renderer.strong(match[1]);
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^__([\s\S]+?)__(?!_)/);
			if (match) {
				out += this.renderer.strong(match[1]);
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^\*([\s\S]+?)\*(?!\*)/);
			if (match) {
				out += this.renderer.em(match[1]);
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^_([\s\S]+?)_(?!_)/);
			if (match) {
				out += this.renderer.em(match[1]);
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^(`+)([\s\S]*?[^\s`]|[\s\S]*?[^\s`][\s\S]*?[^\s`])\1(?!`)/);
			if (!match) {
				match = src.match(/^(`+)([^`]+)\1(?!`)/);
			}
			if (match) {
				out += this.renderer.codespan(match[2]);
				src = src.substring(match[0].length);
				continue;
			}

			match = src.match(/^ {2,}\n/);
			if (match) {
				out += this.renderer.br();
				src = src.substring(match[0].length);
				continue;
			}

			if (this.options.gfm) {
				match = src.match(/^~~([\s\S]+?)~~(?!~)/);
				if (match) {
					out += this.renderer.del(match[1]);
					src = src.substring(match[0].length);
					continue;
				}
			}

			match = src.match(/^[\s\S]+?(?=[\\<!\[`*~_]|https?:\/\/|\n|$)/);
			if (match) {
				out += match[0];
				src = src.substring(match[0].length);
				continue;
			}

			if (src) {
				out += src[0];
				src = src.substring(1);
			}
		}

		return out;
	}
}

function tryParseTable(src) {
	const lines = src.split('\n');
	if (lines.length < 3) return null;

	let headerLine = lines[0];
	let alignLine = lines[1];

	const isAlignLine = /^\s*\|?[\s\-:|]+\|?\s*$/.test(alignLine) && /-/.test(alignLine);
	if (!isAlignLine) return null;

	const parseCells = (row) => {
		const trimmed = row.replace(/^ {0,3}\|?/, '').replace(/\|\s*$/, '');
		return trimmed.split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
	};

	const header = parseCells(headerLine);
	if (header.length < 2) return null;
	if (header.every(c => c === '')) return null;

	const alignCells = parseCells(alignLine);
	const align = alignCells.map(s => {
		s = s.trim();
		if (/^:-+:$/.test(s)) return 'center';
		if (/^:-+/.test(s)) return 'left';
		if (/-+:$/.test(s)) return 'right';
		return null;
	});

	const bodyLines = [];
	for (let i = 2; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') break;
		if (!/\|/.test(line)) break;
		bodyLines.push(line);
	}

	if (bodyLines.length === 0) return null;

	const cells = bodyLines.map(parseCells);

	let consumed = 0;
	for (let i = 0; i < 2 + bodyLines.length && i < lines.length; i++) {
		consumed += lines[i].length + (i < lines.length - 1 ? 1 : 0);
	}

	return { header, align, cells, consumed };
}

function tryParseDefList(src) {
	const lines = src.split('\n');
	if (lines.length < 2) return null;

	const defLineRx = /^ {0,3}:[ \t]+/;
	const termLineRx = /^[^\n\S]*[^\n\s:][^\n]*$/;

	const items = [];
	let consumed = 0;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '') {
			if (items.length > 0) break;
			consumed += line.length + 1;
			i++;
			continue;
		}

		if (defLineRx.test(line)) {
			if (items.length === 0) return null;
			const text = line.replace(/^ {0,3}:[ \t]+/, '').trim();
			if (text) {
				items[items.length - 1].defs.push(text);
			}
			consumed += line.length + 1;
			i++;
			continue;
		}

		if (items.length > 0) {
			const nextDefIdx = i + 1;
			if (nextDefIdx < lines.length && defLineRx.test(lines[nextDefIdx])) {
				const text = line.trim();
				if (text) {
					items.push({ term: text, defs: [] });
				}
				consumed += line.length + 1;
				i++;
				continue;
			}
			break;
		}

		const text = line.trim();
		if (text) {
			items.push({ term: text, defs: [] });
		}
		consumed += line.length + 1;
		i++;
	}

	if (items.length === 0 || !items.some(item => item.defs.length > 0)) return null;

	return { items, consumed };
}

function tryParseList(src) {
	const bulletRx = /^( {0,3})([-*+]|\d+\.)\s+/;
	const match = src.match(bulletRx);
	if (!match) return null;

	const baseIndent = match[1].length;
	const bull = match[2];
	const ordered = /^\d/.test(bull);
	const start = ordered ? parseInt(bull, 10) : 1;

	const lines = src.split('\n');
	const items = [];
	let currentLines = [];
	let inItem = false;
	let consumed = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.trim() === '') {
			if (items.length > 0 || currentLines.length > 0) {
				let j = i + 1;
				while (j < lines.length && lines[j].trim() === '') j++;
				if (j < lines.length && /^( {0,3})([-*+]|\d+\.)\s+/.test(lines[j])) {
					currentLines.push(line);
					consumed += line.length + 1;
					continue;
				}
				if (currentLines.length > 0) {
					const text = currentLines.join('\n').trimEnd();
					const parsed = parseListItem(text);
					if (parsed) items.push(parsed);
				}
				break;
			}
			consumed += line.length + 1;
			continue;
		}

		const itemMatch = line.match(/^( {0,3})([-*+]|\d+\.)\s+/);
		if (itemMatch && itemMatch[1].length <= baseIndent + 2) {
			if (currentLines.length > 0) {
				const text = currentLines.join('\n').trimEnd();
				const parsed = parseListItem(text);
				if (parsed) items.push(parsed);
			}
			currentLines = [line];
			inItem = true;
		} else if (inItem) {
			currentLines.push(line);
		} else {
			break;
		}

		consumed += line.length + 1;
	}

	if (currentLines.length > 0) {
		const text = currentLines.join('\n').trimEnd();
		const parsed = parseListItem(text);
		if (parsed) items.push(parsed);
	}

	if (items.length === 0) return null;

	return { ordered, start, items, consumed };
}

function parseListItem(raw) {
	const bulletRx = /^( {0,3})([-*+]|\d+\.)\s+/;
	const match = raw.match(bulletRx);
	if (!match) return null;

	const indent = match[0].length;
	let content = raw.substring(indent);

	let task = false;
	let checked = false;
	if (/^\[[ xX]\][ \t]/.test(content)) {
		task = true;
		checked = /^\[[xX]\]/.test(content);
		content = content.substring(4);
	}

	const unindented = content.split('\n').map((line, idx) => {
		if (idx === 0) return line;
		const spaces = Math.min(indent, line.match(/^ */)?.[0].length || 0);
		return line.substring(spaces);
	}).join('\n');

	return { text: unindented.trimEnd(), task, checked };
}

function tokenize(src) {
	const tokens = [];
	src = (src || '').replace(/\r\n|\r/g, '\n');

	while (src) {
		if (src[0] === '\n') {
			src = src.replace(/^\n+/, '');
			continue;
		}

		const codeMatch = src.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n)? {0,3}\1[~`]* *(?:\n+|$)/);
		if (codeMatch) {
			tokens.push({ type: 'code', lang: codeMatch[2].trim(), text: codeMatch[3] });
			src = src.substring(codeMatch[0].length);
			continue;
		}

		const headingMatch = src.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s*\n+|$)/);
		if (headingMatch) {
			tokens.push({ type: 'heading', depth: headingMatch[1].length, text: headingMatch[2].trim() });
			src = src.substring(headingMatch[0].length);
			continue;
		}

		const tableResult = tryParseTable(src);
		if (tableResult) {
			tokens.push({ type: 'table', header: tableResult.header, align: tableResult.align, cells: tableResult.cells });
			src = src.substring(tableResult.consumed);
			continue;
		}

		const hrMatch = src.match(/^ {0,3}([*_-])(?:[ ]*\1){2,}[ ]*(?:\n+|$)/);
		if (hrMatch) {
			tokens.push({ type: 'hr' });
			src = src.substring(hrMatch[0].length);
			continue;
		}

		const bqMatch = src.match(/^( {0,3}>[^\n]*\n?)+/);
		if (bqMatch) {
			const text = bqMatch[0].replace(/^[ \t]*>[ \t]?/gm, '').trim();
			tokens.push({ type: 'blockquote', text });
			src = src.substring(bqMatch[0].length);
			continue;
		}

		const listResult = tryParseList(src);
		if (listResult) {
			tokens.push({ type: 'list', ordered: listResult.ordered, start: listResult.start, items: listResult.items });
			src = src.substring(listResult.consumed);
			continue;
		}

		const defListResult = tryParseDefList(src);
		if (defListResult) {
			tokens.push({ type: 'deflist', items: defListResult.items });
			src = src.substring(defListResult.consumed);
			continue;
		}

		const indentedMatch = src.match(/^( {4}[^\n]+\n*)+/);
		if (indentedMatch) {
			const text = indentedMatch[0].replace(/^ {4}/gm, '').trim();
			tokens.push({ type: 'code', text });
			src = src.substring(indentedMatch[0].length);
			continue;
		}

		const htmlBlockMatch = src.match(/^ {0,3}<(div|details|summary|table|blockquote|pre|ul|ol|li|p)[\s>][\s\S]*?(?:<\/\1>|$)/i);
		if (htmlBlockMatch) {
			tokens.push({ type: 'html', text: htmlBlockMatch[0].trim() });
			src = src.substring(htmlBlockMatch[0].length);
			continue;
		}

		const paraMatch = src.match(/^([^\n]+(?:\n(?! {0,3}#{1,6}\s| {0,3}>| {0,3}[-*+]| {0,3}\d+\.| {0,3}`{3}| {0,3}~{3}| {0,3}[*_-]{3,}|\n)[^\n]+)*)/);
		if (paraMatch) {
			const text = paraMatch[1].trim();
			if (text) {
				tokens.push({ type: 'paragraph', text });
			}
			src = src.substring(paraMatch[0].length);
			continue;
		}

		if (src) {
			src = src.substring(1);
		}
	}

	return tokens;
}

function renderToken(token, renderer, inlineParser) {
	switch (token.type) {
		case 'code':
			return renderer.code(token.text, token.lang);
		case 'blockquote':
			return renderer.blockquote(inlineParser.parse(token.text));
		case 'heading':
			return renderer.heading(inlineParser.parse(token.text), token.depth);
		case 'html':
			return renderer.html(token.text);
		case 'hr':
			return renderer.hr();
		case 'list': {
			let body = '';
			for (const item of token.items) {
				body += renderer.listitem(renderItemContent(item.text, inlineParser, renderer), item.task, item.checked);
			}
			return renderer.list(body, token.ordered, token.start);
		}
		case 'deflist': {
			let body = '';
			for (const item of token.items) {
				body += `<dt class="md-deflist-term">${inlineParser.parse(item.term)}</dt>\n`;
				for (const def of item.defs) {
					body += `<dd class="md-deflist-def">${inlineParser.parse(def)}</dd>\n`;
				}
			}
			return renderer.deflist(body);
		}
		case 'deflist': {
			let body = '';
			for (const item of token.items) {
				body += `<dt class="md-deflist-term">${inlineParser.parse(item.term)}</dt>\n`;
				for (const def of item.defs) {
					body += `<dd class="md-deflist-def">${inlineParser.parse(def)}</dd>\n`;
				}
			}
			return renderer.deflist(body);
		}
		case 'table': {
			let header = '';
			for (let i = 0; i < token.header.length; i++) {
				header += renderer.tablecell(inlineParser.parse(token.header[i]), { header: true, align: token.align[i] });
			}
			header = renderer.tablerow(header);
			let tbody = '';
			for (const row of token.cells) {
				let cells = '';
				for (let i = 0; i < row.length; i++) {
					const align = token.align && i < token.align.length ? token.align[i] : null;
					cells += renderer.tablecell(inlineParser.parse(row[i] || ''), { header: false, align });
				}
				tbody += renderer.tablerow(cells);
			}
			return renderer.table(header, tbody);
		}
		case 'paragraph':
			return renderer.paragraph(inlineParser.parse(token.text));
		default:
			return '';
	}
}

function renderItemContent(src, inlineParser, renderer) {
	src = (src || '').replace(/\r\n|\r/g, '\n');
	const tokens = tokenize(src);
	let out = '';
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === 'paragraph' && i === 0) {
			out += inlineParser.parse(token.text) + '\n';
		} else {
			out += renderToken(token, renderer, inlineParser);
		}
	}
	return out;
}

function highlightCode(code, language) {
	if (!language) return escapeHtml(code);
	const lang = language.toLowerCase();
	let src = code;
	const placeholders = { strings: [], comments: [] };

	if (['javascript', 'typescript', 'java', 'cpp', 'c', 'go', 'rust', 'css'].includes(lang)) {
		src = src.replace(/(\/\*[\s\S]*?\*\/)/g, m => { const id = `__COM${placeholders.comments.length}__`; placeholders.comments.push(m); return id; });
		src = src.replace(/(\/\/.*$)/gm, m => { const id = `__COM${placeholders.comments.length}__`; placeholders.comments.push(m); return id; });
	} else if (['python', 'bash', 'shell', 'sh'].includes(lang)) {
		src = src.replace(/(#.*$)/gm, m => { const id = `__COM${placeholders.comments.length}__`; placeholders.comments.push(m); return id; });
	} else if (lang === 'sql') {
		src = src.replace(/(--.*$)/gm, m => { const id = `__COM${placeholders.comments.length}__`; placeholders.comments.push(m); return id; });
	} else if (lang === 'html') {
		src = src.replace(/(<!--[\s\S]*?-->)/g, m => { const id = `__COM${placeholders.comments.length}__`; placeholders.comments.push(m); return id; });
	}

	src = src.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, m => {
		const id = `__STR${placeholders.strings.length}__`;
		placeholders.strings.push(m);
		return id;
	});

	src = escapeHtml(src);

	const keywords = {
		javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'default'],
		typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace', 'module', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'default', 'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint', 'as', 'satisfies', 'infer', 'keyof', 'readonly', 'abstract', 'private', 'protected', 'public', 'static', 'get', 'set', 'declare'],
		python: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'lambda', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'pass', 'break', 'continue', 'del', 'assert', 'global', 'nonlocal', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await', 'match', 'case'],
		java: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'extends', 'implements', 'return', 'void', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'true', 'false', 'null', 'import', 'package', 'instanceof', 'synchronized', 'volatile', 'transient', 'native', 'strictfp', 'const', 'goto'],
		cpp: ['int', 'float', 'double', 'char', 'void', 'bool', 'auto', 'const', 'static', 'volatile', 'extern', 'inline', 'virtual', 'explicit', 'mutable', 'constexpr', 'consteval', 'constinit', 'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue', 'return', 'goto', 'try', 'catch', 'throw', 'class', 'struct', 'union', 'enum', 'typedef', 'typename', 'template', 'namespace', 'using', 'public', 'private', 'protected', 'friend', 'operator', 'new', 'delete', 'sizeof', 'typeid', 'decltype', 'nullptr', 'true', 'false', 'this', 'override', 'final', 'noexcept', 'concept', 'requires', 'co_await', 'co_return', 'co_yield'],
		c: ['int', 'float', 'double', 'char', 'void', 'short', 'long', 'signed', 'unsigned', 'const', 'static', 'volatile', 'extern', 'auto', 'register', 'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue', 'return', 'goto', 'struct', 'union', 'enum', 'typedef', 'sizeof', 'inline', 'restrict'],
		go: ['package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'fallthrough', 'return', 'goto', 'defer', 'go', 'select', 'make', 'new', 'len', 'cap', 'append', 'copy', 'close', 'delete', 'panic', 'recover', 'nil', 'true', 'false', 'iota'],
		rust: ['fn', 'let', 'mut', 'const', 'static', 'type', 'struct', 'enum', 'trait', 'impl', 'pub', 'use', 'mod', 'crate', 'super', 'self', 'if', 'else', 'match', 'while', 'loop', 'for', 'in', 'break', 'continue', 'return', 'async', 'await', 'move', 'ref', 'where', 'unsafe', 'extern', 'as', 'dyn', 'yield', 'macro', 'union', 'typeof'],
		json: ['true', 'false', 'null'],
		html: ['DOCTYPE', 'html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style', 'div', 'span', 'p', 'a', 'img', 'br', 'hr', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'nav', 'header', 'footer', 'main', 'section', 'article', 'aside'],
		css: ['import', 'media', 'keyframes', 'font-face', 'supports', 'charset', 'important', 'color', 'background', 'border', 'margin', 'padding', 'width', 'height', 'display', 'position', 'top', 'left', 'right', 'bottom', 'float', 'clear', 'font', 'text', 'align', 'content', 'overflow', 'visibility', 'opacity', 'transform', 'transition', 'animation', 'flex', 'grid', 'min', 'max', 'calc', 'var'],
		sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'VIEW', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'CAST', 'CONVERT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'VALUES', 'INTO', 'SET'],
		bash: ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'in', 'function', 'return', 'break', 'continue', 'shift', 'exit', 'export', 'local', 'readonly', 'unset', 'declare', 'typeset', 'source', 'alias', 'unalias', 'trap', 'wait', 'exec', 'eval', 'echo', 'printf', 'read', 'test', 'true', 'false', 'cd', 'pwd', 'ls', 'cat', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'head', 'tail', 'chmod', 'chown', 'mkdir', 'rm', 'cp', 'mv', 'tar', 'gzip', 'gunzip', 'find', 'xargs', 'curl', 'wget', 'ssh', 'scp', 'sudo', 'su', 'ps', 'kill', 'top', 'df', 'du', 'free', 'uptime', 'date', 'time', 'sleep', 'jobs', 'fg', 'bg', 'disown', 'nohup', 'env', 'set', 'shopt', 'getopts', 'command', 'builtin', 'type', 'hash', 'ulimit', 'umask', 'caller', 'logout', 'exit'],
		sh: ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'in', 'function', 'return', 'break', 'continue', 'exit', 'export', 'local', 'echo', 'printf', 'read', 'cd', 'ls', 'cat', 'grep', 'awk', 'sed', 'true', 'false'],
		latex: ['documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'chapter', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'newcommand', 'renewcommand', 'include', 'input', 'cite', 'ref', 'label', 'bibliography', 'bibliographystyle', 'usebibliography', 'addbibresource', 'printbibliography'],
		tex: ['documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'chapter', 'title', 'author', 'date', 'maketitle', 'tableofcontents', 'newcommand', 'renewcommand', 'include', 'input', 'cite', 'ref', 'label', 'bibliography', 'bibliographystyle', 'usebibliography', 'addbibresource', 'printbibliography'],
	};

	const langKeywords = keywords[lang] || [];
	if (langKeywords.length > 0) {
		const keywordRegex = new RegExp('\\b(' + langKeywords.join('|') + ')\\b', 'g');
		src = src.replace(keywordRegex, '<span class="md-keyword">$1</span>');
	}

	src = src.replace(/\b(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, '<span class="md-number">$1</span>');

	placeholders.strings.forEach((str, i) => {
		const id = `__STR${i}__`;
		const escaped = escapeHtml(str);
		src = src.replace(id, `<span class="md-string">${escaped}</span>`);
	});

	placeholders.comments.forEach((com, i) => {
		const id = `__COM${i}__`;
		const escaped = escapeHtml(com);
		src = src.replace(id, `<span class="md-comment">${escaped}</span>`);
	});

	if (lang === 'html' || lang === 'xml') {
		src = src.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="md-keyword">$2</span>');
	}

	return src;
}

function formatRelativeTime(date) {
	const now = new Date();
	const diff = Math.floor((now - date) / 1000);
	if (diff < 60) return 'just now';
	if (diff < 3600) return Math.floor(diff / 60) + ' minutes ago';
	if (diff < 86400) return Math.floor(diff / 3600) + ' hours ago';
	if (diff < 604800) return Math.floor(diff / 86400) + ' days ago';
	return date.toLocaleDateString();
}

function preprocessMarkdown(text) {
	if (!text) return '';
	let result = text;

	result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, page, display) => {
		const linkText = display || page;
		const href = '#' + page.toLowerCase().replace(/\s+/g, '-');
		return `<a href="${href}" class="md-wikilink">${linkText}</a>`;
	});

	result = result.replace(/==([^=]+)==/g, '<mark class="md-highlight">$1</mark>');

	result = result.replace(/\|\|([^|]+)\|\|/g, '<span class="md-spoiler" onclick="this.classList.add(\'revealed\')">$1</span>');

	result = result.replace(/<@!?(\d+)>/g, '<span class="md-mention">@user</span>');
	result = result.replace(/<#(\d+)>/g, '<span class="md-mention">#channel</span>');

	result = result.replace(/<t:(\d+)(?::([a-zA-Z]))?>/g, (match, timestamp, format) => {
		const date = new Date(timestamp * 1000);
		const formatStr = format || 'f';
		const formatMap = {
			't': date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
			'T': date.toLocaleTimeString(),
			'd': date.toLocaleDateString(),
			'D': date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
			'f': date.toLocaleString([], { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
			'F': date.toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
			'R': formatRelativeTime(date)
		};
		return `<time class="md-timestamp" datetime="${date.toISOString()}">${formatMap[formatStr] || formatMap['f']}</time>`;
	});

	return result;
}

function postprocessCallouts(html) {
	const iconMap = {
		'note': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info-icon lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>', 'info': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info-icon lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>', 'tip': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb-icon lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>', 'hint': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb-icon lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>', 'important': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-octagon-alert-icon lucide-octagon-alert"><path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/></svg>',
		'warning': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>', 'caution': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>', 'danger': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-octagon-alert-icon lucide-octagon-alert"><path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/></svg>', 'error': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ban-icon lucide-ban"><circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/></svg>',
		'success': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>', 'check': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>', 'done': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>', 'question': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
		'help': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>', 'faq': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>', 'example': '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-notebook-pen-icon lucide-notebook-pen"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 1-.62-.62l2.87-.837a2 2 0 0 1 .854-.506z"/></svg>', 'quote': '\u201C', 'cite': '\u201C',
	};

	const openCallout = (type, title) => {
		const calloutType = type.toLowerCase();
		const calloutTitle = title.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);
		const icon = iconMap[calloutType] || '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info-icon lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
		return (
			'<div class="md-callout md-callout-' + calloutType + '">' +
			'<div class="md-callout-header">' +
			'<span class="md-callout-icon">' + icon + '</span>' +
			'<span class="md-callout-title">' + calloutTitle + '</span>' +
			'</div>' +
			'<div class="md-callout-content">'
		);
	};

	let result = html.replace(
		/<blockquote class="md-blockquote">\s*<p(?:\s+class="md-paragraph")?>\[!([\w]+)\]\s*(.*?)<\/p>([\s\S]*?)<\/blockquote>/g,
		(match, type, title, body) => openCallout(type, title) + body + '</div></div>'
	);

	result = result.replace(
		/<p(?:\s+class="md-paragraph")?>\[!([\w]+)\]\s*([\s\S]*?)<\/p>/g,
		(match, type, content) => {
			const split = content.match(/^(.{1,60}?)\s*(?:[—–]|-{2,}(?!-)\s)\s*([\s\S]+)$/);
			let title, body;
			if (split) {
				title = split[1].trim();
				body = split[2].trim() ? '<p class="md-paragraph">' + split[2].trim() + '</p>' : '';
			} else {
				title = '';
				body = content.trim() ? '<p class="md-paragraph">' + content.trim() + '</p>' : '';
			}
			return openCallout(type, title) + body + '</div></div>';
		}
	);

	return result;
}

function parseMarkdownInternal(src, options = {}) {
	if (!src) return '';
	const opts = { gfm: true, breaks: true, ...options };
	const renderer = new Renderer(opts);
	const inlineParser = new InlineParser(renderer, opts);
	const tokens = tokenize(src);
	let out = '';
	for (const token of tokens) {
		out += renderToken(token, renderer, inlineParser);
	}
	return out;
}

export function parseMarkdown(text) {
	if (!text) return '';

	const preprocessed = preprocessMarkdown(text);

	let html = parseMarkdownInternal(preprocessed, { gfm: true, breaks: true });
	html = postprocessCallouts(html);

	return html;
}

export default parseMarkdown;
