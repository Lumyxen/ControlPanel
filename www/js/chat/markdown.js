/**
 * Comprehensive markdown parser using marked.js architecture
 * Supports:
 * - GitHub Flavored Markdown (GFM): Tables, strikethrough, task lists, autolinks
 * - Basic Markdown: Headers, lists, links, images, bold/italic, code blocks, blockquotes, horizontal rules
 * - Obsidian-style: WikiLinks [[...]], highlights ==text==, callouts/admonitions
 * - Discord-style: Spoilers ||text||, mentions, timestamps
 * - Syntax highlighting for code blocks
 * - BibTeX: ```bibtex code blocks are intercepted, parsed into the DB,
 *   and rendered as collapsible source cards instead of raw code
 */

import { parseBibtex, getAllBibtexEntries } from './latex.js';

const markedModule = (function () {
	'use strict';

	const defaults = {
		gfm: true,
		breaks: true,
		langPrefix: 'language-'
	};

	function escapeHtml(html) {
		if (!html) return '';
		return String(html)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	class Renderer {
		constructor(options) {
			this.options = Object.assign({}, defaults, options);
		}

		code(code, infostring) {
			const lang = ((infostring || '').match(/\S*/)[0] || '').toLowerCase();

			// ── Intercept ```bibtex / ```bib blocks, AND unlabeled blocks whose
			//    content starts with a BibTeX entry type  ──────────────────────
			const BIBTEX_ENTRY_RX = /^\s*@(?:article|book|inproceedings|conference|incollection|phdthesis|mastersthesis|techreport|misc|online|electronic|www|proceedings|inbook|unpublished|manual|booklet|patent|dataset|software|report)\s*[\{(]/i;
			// Match explicit bibtex/bib tags, OR any block (regardless of label)
			// whose content opens with a BibTeX entry type — covers untagged
			// blocks and blocks labelled 'latex', 'text', 'tex', etc.
			const isBibtex = lang === 'bibtex' || lang === 'bib' ||
				BIBTEX_ENTRY_RX.test(code);

			if (isBibtex) {
				// Parse into the shared bibliography database.
				// parseBibtex is idempotent — re-parsing the same keys just overwrites them.
				parseBibtex(code);
				const db = getAllBibtexEntries();

				// Collect the keys defined in this specific block (in order)
				const blockKeys = [];
				const entryRx = /@\w+\s*[\{(]\s*([^,\s\}(]+)/g;
				let em;
				while ((em = entryRx.exec(code)) !== null) {
					const key = em[1].trim();
					if (key && !['string','preamble','comment'].includes(key.toLowerCase())) {
						blockKeys.push(key);
					}
				}

				const count = blockKeys.length;
				const countLabel = count === 1 ? '1 entry' : `${count} entries`;

				// Build the entry preview rows
				let entryRows = '';
				for (const key of blockKeys) {
					const e = db.get(key);
					if (!e) continue;

					// First author last name only
					const firstAuthorRaw = (e.author || e.editor || '').split(/\s+and\s+/i)[0] || '';
					const authorShort = firstAuthorRaw.includes(',')
						? firstAuthorRaw.split(',')[0].trim()
						: firstAuthorRaw.split(/\s+/).pop() || '';

					const titleShort = e.title
						? escapeHtml(e.title.slice(0, 72) + (e.title.length > 72 ? '…' : ''))
						: '';

					const infoParts = [
						authorShort ? escapeHtml(authorShort) : null,
						titleShort  ? `<em>${titleShort}</em>` : null,
						e.year      ? escapeHtml(e.year) : null,
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
					`<span class="bib-source-icon">📚</span>` +
					`<span class="bib-source-title">Bibliography Source</span>` +
					`<span class="bib-source-count">${escapeHtml(countLabel)}</span>` +
					`<span class="bib-source-chevron">▼</span>` +
					`</summary>` +
					(entryRows ? `<div class="bib-source-entries">${entryRows}</div>` : '') +
					`<div class="bib-source-raw">${rawEscaped}</div>` +
					`</details>\n`
				);
			}

			// ── Normal code block rendering ───────────────────────────────────
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

		blockquote(quote) {
			return `<blockquote class="md-blockquote">\n${quote}</blockquote>\n`;
		}

		html(html) {
			return html + '\n';
		}

		heading(text, level) {
			return `<h${level} class="md-header md-header-${level}">${text}</h${level}>\n`;
		}

		hr() {
			return `<hr class="md-hr">\n`;
		}

		list(body, ordered, start) {
			const type = ordered ? 'ol' : 'ul';
			const startatt = (ordered && start !== 1) ? (' start="' + start + '"') : '';
			return `<${type} class="md-list md-list-${type}"${startatt}>\n${body}</${type}>\n`;
		}

		listitem(text, task, checked) {
			if (task) {
				const checkbox = checked ? 'checked' : '';
				return `<li class="md-list-item md-task-list-item"><input type="checkbox" disabled ${checkbox}> ${text}</li>\n`;
			}
			return `<li class="md-list-item">${text}</li>\n`;
		}

		paragraph(text) {
			return `<p class="md-paragraph">${text}</p>\n`;
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

		link(href, title, text) {
			const cleanHref = encodeURI(href).replace(/%25/g, '%');
			let out = '<a href="' + escapeHtml(cleanHref) + '" class="md-link"';
			if (title) {
				out += ' title="' + escapeHtml(title) + '"';
			}
			out += ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
			return out;
		}

		image(href, title, text) {
			const cleanHref = encodeURI(href).replace(/%25/g, '%');
			let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}" class="md-image">`;
			if (title) {
				out += ` title="${escapeHtml(title)}"`;
			}
			return `<div class="md-image-container">${out}</div>`;
		}
	}

	class InlineParser {
		constructor(renderer, options) {
			this.renderer = renderer;
			this.options = Object.assign({}, defaults, options);
		}

		parse(src) {
			let out = '';
			src = src || '';

			while (src) {
				// Escape
				let match = src.match(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/);
				if (match) {
					out += match[1];
					src = src.substring(match[0].length);
					continue;
				}

				// Autolink
				match = src.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]+)>/);
				if (match) {
					out += this.renderer.link(match[1], null, match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				// URL (GFM)
				if (this.options.gfm) {
					match = src.match(/^https?:\/\/[^\s<]+[^<.,:;"')\]\s]/);
					if (match) {
						out += this.renderer.link(match[0], null, match[0]);
						src = src.substring(match[0].length);
						continue;
					}
				}

				// Tag
				match = src.match(/^<!--[\s\S]*?-->|^<\/?[a-zA-Z][\w:-]*\s*(?:[^>]*)>/);
				if (match) {
					out += match[0];
					src = src.substring(match[0].length);
					continue;
				}

				// Image or Link
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

				// Strong + Em
				match = src.match(/^\*\*\*([\s\S]+?)\*\*\*/);
				if (match) {
					out += this.renderer.strong(this.renderer.em(match[1]));
					src = src.substring(match[0].length);
					continue;
				}

				// Strong
				match = src.match(/^\*\*([\s\S]+?)\*\*/);
				if (match) {
					out += this.renderer.strong(match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				match = src.match(/^__([\s\S]+?)__/);
				if (match) {
					out += this.renderer.strong(match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				// Em
				match = src.match(/^\*([\s\S]+?)\*/);
				if (match) {
					out += this.renderer.em(match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				match = src.match(/^_([\s\S]+?)_/);
				if (match) {
					out += this.renderer.em(match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				// Code
				match = src.match(/^`([^`]+)`/);
				if (match) {
					out += this.renderer.codespan(match[1]);
					src = src.substring(match[0].length);
					continue;
				}

				// BR
				match = src.match(/^ {2,}\n/);
				if (match) {
					out += this.renderer.br();
					src = src.substring(match[0].length);
					continue;
				}

				// Del (GFM strikethrough)
				if (this.options.gfm) {
					match = src.match(/^~~([\s\S]+?)~~/);
					if (match) {
						out += this.renderer.del(match[1]);
						src = src.substring(match[0].length);
						continue;
					}
				}

				// Text
				match = src.match(/^[\s\S]+?(?=[\\<!\[`*~]|https?:\/\/|\n|$)/);
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

	class Parser {
		constructor(options) {
			this.options = Object.assign({}, defaults, options);
			this.renderer = new Renderer(this.options);
			this.inlineParser = new InlineParser(this.renderer, this.options);
		}

		parse(src) {
			src = (src || '').replace(/\r\n|\r/g, '\n');
			const tokens = this.tokenize(src);
			let out = '';

			for (const token of tokens) {
				out += this.render(token);
			}

			return out;
		}

		// Helper to render nested list elements accurately without wrapping the first top-level text in <p>
		parseItem(src) {
			src = (src || '').replace(/\r\n|\r/g, '\n');
			const tokens = this.tokenize(src);
			let out = '';

			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				if (token.type === 'paragraph' && i === 0) {
					out += this.inlineParser.parse(token.text) + '\n';
				} else {
					out += this.render(token);
				}
			}

			return out;
		}

		tokenize(src) {
			const tokens = [];

			while (src) {
				let match;

				// Newlines
				match = src.match(/^\n+/);
				if (match) {
					src = src.substring(match[0].length);
					continue;
				}

				// Fenced code block
				match = src.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n)? {0,3}\1[~`]* *(?:\n+|$)/);
				if (match) {
					tokens.push({ type: 'code', lang: match[2].trim(), text: match[3] });
					src = src.substring(match[0].length);
					continue;
				}

				// Heading
				match = src.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\n+|$)/);
				if (match) {
					tokens.push({ type: 'heading', depth: match[1].length, text: match[2].trim() });
					src = src.substring(match[0].length);
					continue;
				}

				// Table (GFM) - Robust to tables missing leading/trailing pipes
				const tableHeaderRegex = /^ {0,3}\|?([^\n]+)\|[^\n]*\n {0,3}\|?([ \t\-:|]+)\|[ \t\-:|]*(?:\n|$)/;
				if (src.match(tableHeaderRegex)) {
					const tableBlockRegex = /^(?: {0,3}\|?[^\n]+\|[^\n]*(?:\n|$))+/;
					const tableMatch = src.match(tableBlockRegex);
					if (tableMatch) {
						const lines = tableMatch[0].trim().split('\n');
						const headerLine = lines[0];
						const alignLine = lines[1];
						const rows = lines.slice(2);

						const splitCells = (row) => {
							const trimmed = row.replace(/^ {0,3}\|?|\|$/g, '');
							return trimmed.split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
						};

						const header = splitCells(headerLine);
						const alignRaw = splitCells(alignLine);
						const align = alignRaw.map(s => {
							if (/^:-+:$/.test(s)) return 'center';
							if (/^:-+/.test(s)) return 'left';
							if (/^-+:$/.test(s)) return 'right';
							return null;
						});

						const cells = rows.map(splitCells);

						tokens.push({ type: 'table', header, align, cells });
						src = src.substring(tableMatch[0].length);
						if (src.startsWith('\n')) src = src.substring(1);
						continue;
					}
				}

				// HR
				match = src.match(/^ {0,3}([-]{3,}|[_]{3,}|[*]{3,})(?:\n+|$)/);
				if (match) {
					tokens.push({ type: 'hr' });
					src = src.substring(match[0].length);
					continue;
				}

				// Blockquote
				match = src.match(/^( {0,3}> ?.+\n?)+/);
				if (match) {
					const text = match[0].replace(/^[ \t]*>[ \t]?/gm, '').trim();
					tokens.push({ type: 'blockquote', text });
					src = src.substring(match[0].length);
					continue;
				}

				// List
				const listMatch = src.match(/^( {0,3})([-*+]|\d+\.)\s+[\s\S]+?(?:\n{2,}(?!\s)|\s*$)/);
				if (listMatch && src.match(/^( {0,3})([-*+]|\d+\.)\s+/)) {
					const rawList = listMatch[0];
					const baseIndent = listMatch[1].length;
					const bull = listMatch[2];
					const ordered = /^\d/.test(bull);
					const start = ordered ? parseInt(bull, 10) : 1;

					const itemRegex = new RegExp(`^( {0,3})([-*+]|\\d+\\.)[ \\t]+`, 'gm');
					let itemRegexMatch;
					const itemMatches = [];

					while ((itemRegexMatch = itemRegex.exec(rawList)) !== null) {
						if (itemRegexMatch[1].length <= baseIndent + 1) {
							itemMatches.push(itemRegexMatch);
						}
					}

					if (itemMatches.length === 0) {
						itemMatches.push({ index: 0, 0: listMatch[1] + listMatch[2] + ' ', 1: listMatch[1] });
					}

					const items = [];
					for (let i = 0; i < itemMatches.length; i++) {
						const startObj = itemMatches[i];
						const endIdx = (i + 1 < itemMatches.length) ? itemMatches[i + 1].index : rawList.length;
						let itemRaw = rawList.substring(startObj.index, endIdx);

						// Strip the bullet marker itself
						itemRaw = itemRaw.substring(startObj[0].length);

						let task = false;
						let checked = false;
						if (/^\[[ xX]\][ \t]/.test(itemRaw)) {
							task = true;
							checked = /^\[[xX]\]/.test(itemRaw);
							itemRaw = itemRaw.substring(4);
						}

						const indentToRemove = startObj[0].length;
						const unindented = itemRaw.split('\n').map((line, index) => {
							if (index === 0) return line;
							let spaces = 0;
							while (spaces < indentToRemove && line[spaces] === ' ') {
								spaces++;
							}
							return line.substring(spaces);
						}).join('\n');

						items.push({ text: unindented.trimEnd(), task, checked });
					}

					tokens.push({ type: 'list', ordered, start, items });
					src = src.substring(rawList.length);
					continue;
				}

				// Indented code block
				match = src.match(/^( {4}[^\n]+\n*)+/);
				if (match) {
					const text = match[0].replace(/^ {4}/gm, '').trim();
					tokens.push({ type: 'code', text });
					src = src.substring(match[0].length);
					continue;
				}

				// Paragraph & HTML Blocks intercept
				match = src.match(/^([^\n]+(?:\n(?! {0,3}#{1,6}\s| {0,3}>| {0,3}[-*+]| {0,3}\d+\.|```|~~~| {0,3}<\/?div| {0,3}<\/?details|\n{2,}| {0,3}\|?[^\n]+\|[^\n]*\n {0,3}\|?[ \t\-:|]+\|[ \t\-:|]*(?:\n|$))[^\n]+)*)/);
				if (match) {
					let text = match[1].trim();
					if (/^ {0,3}<\/?(div|details|summary|p|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre)/i.test(text)) {
						tokens.push({ type: 'html', text: text });
					} else {
						tokens.push({ type: 'paragraph', text: text });
					}
					src = src.substring(match[0].length);
					continue;
				}

				// Fallback - consume one char
				if (src) {
					src = src.substring(1);
				}
			}

			return tokens;
		}

		render(token) {
			switch (token.type) {
				case 'code':
					return this.renderer.code(token.text, token.lang);
				case 'blockquote':
					return this.renderer.blockquote(this.inlineParser.parse(token.text));
				case 'heading':
					return this.renderer.heading(this.inlineParser.parse(token.text), token.depth);
				case 'html':
					return this.renderer.html(token.text);
				case 'hr':
					return this.renderer.hr();
				case 'list': {
					let body = '';
					for (const item of token.items) {
						body += this.renderer.listitem(this.parseItem(item.text), item.task, item.checked);
					}
					return this.renderer.list(body, token.ordered, token.start);
				}
				case 'table': {
					let header = '';
					let tbody = '';
					for (let i = 0; i < token.header.length; i++) {
						header += this.renderer.tablecell(this.inlineParser.parse(token.header[i]), { header: true, align: token.align[i] });
					}
					header = this.renderer.tablerow(header);
					for (const row of token.cells) {
						let cells = '';
						for (let i = 0; i < row.length; i++) {
							cells += this.renderer.tablecell(this.inlineParser.parse(row[i] || ''), { header: false, align: token.align[i] });
						}
						tbody += this.renderer.tablerow(cells);
					}
					return this.renderer.table(header, tbody);
				}
				case 'paragraph':
					return this.renderer.paragraph(this.inlineParser.parse(token.text));
				default:
					return '';
			}
		}
	}

	return {
		parse: (src, options) => new Parser(options).parse(src)
	};
})();

/**
 * Syntax highlighting for code blocks
 * Uses a multi-pass placeholder strategy to avoid "md-keyword" artifacts
 * where strings/comments match keyword regexes or keyword HTML output matches string regexes.
 */
function highlightCode(code, language) {
	if (!language) return escapeHtml(code);

	const lang = language.toLowerCase();
	let src = code;

	const placeholders = {
		strings: [],
		comments: []
	};

	// 1. Extract Comments
	if (['javascript', 'typescript', 'java', 'cpp', 'c', 'go', 'rust', 'css'].includes(lang)) {
		src = src.replace(/(\/\*[\s\S]*?\*\/)/g, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
		src = src.replace(/(\/\/.*$)/gm, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
	} else if (['python', 'bash', 'shell', 'sh'].includes(lang)) {
		src = src.replace(/(#.*$)/gm, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
	} else if (lang === 'sql') {
		src = src.replace(/(--.*$)/gm, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
	} else if (lang === 'html') {
		src = src.replace(/(<!--[\s\S]*?-->)/g, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
	}

	// 2. Extract Strings
	src = src.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (match) => {
		const id = `__STR${placeholders.strings.length}__`;
		placeholders.strings.push(match);
		return id;
	});

	// 3. Escape the skeleton
	src = escapeHtml(src);

	// 4. Highlight Keywords
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
	};

	const langKeywords = keywords[lang] || [];
	if (langKeywords.length > 0) {
		const keywordRegex = new RegExp('\\b(' + langKeywords.join('|') + ')\\b', 'g');
		src = src.replace(keywordRegex, '<span class="md-keyword">$1</span>');
	}

	// 5. Highlight Numbers
	src = src.replace(/\b(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, '<span class="md-number">$1</span>');

	// 6. Restore Strings
	placeholders.strings.forEach((str, i) => {
		const id = `__STR${i}__`;
		const escaped = escapeHtml(str);
		src = src.replace(id, `<span class="md-string">${escaped}</span>`);
	});

	// 7. Restore Comments
	placeholders.comments.forEach((com, i) => {
		const id = `__COM${i}__`;
		const escaped = escapeHtml(com);
		src = src.replace(id, `<span class="md-comment">${escaped}</span>`);
	});

	// HTML tag highlighting
	if (lang === 'html') {
		src = src.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="md-keyword">$2</span>');
	}

	return src;
}

function escapeHtml(text) {
	if (!text) return '';
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Pre-process markdown to handle custom extensions:
 * - WikiLinks: [[Page Title]] or [[Page Title|Display Text]]
 * - Highlights: ==text==
 * - Spoilers: ||text||
 * - Discord mentions and timestamps
 */
function preprocessMarkdown(text) {
	if (!text) return '';

	let result = text;

	// WikiLinks
	result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, page, display) => {
		const linkText = display || page;
		const href = '#' + page.toLowerCase().replace(/\s+/g, '-');
		return '<a href="' + href + '" class="md-wikilink">' + linkText + '</a>';
	});

	// Highlights
	result = result.replace(/==([^=]+)==/g, '<mark class="md-highlight">$1</mark>');

	// Spoilers
	result = result.replace(/\|\|([^|]+)\|\|/g, '<span class="md-spoiler" onclick="this.classList.add(\'revealed\')">$1</span>');

	// Discord mentions
	result = result.replace(/<@!?(&?\d+)>/g, '<span class="md-mention">@user</span>');
	result = result.replace(/<#(\d+)>/g, '<span class="md-mention">#channel</span>');

	// Discord timestamps
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
		return '<time class="md-timestamp" datetime="' + date.toISOString() + '">' + (formatMap[formatStr] || formatMap['f']) + '</time>';
	});

	return result;
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

/**
 * Post-process HTML to handle callouts/admonitions.
 *
 * Handles two forms models produce:
 *
 *   1. Obsidian blockquote form (Obsidian spec):
 *        > [!warning] Title
 *        > Body text
 *      Marked parses this as a <blockquote> whose first <p> starts with [!type].
 *
 *   2. Standalone paragraph form (no leading '>'):
 *        [!warning] Deprecated/Legacy Method — body text here
 *      Marked parses this as a plain <p> starting with [!type].
 *      Models frequently emit this form — we now render it identically.
 *
 * Both forms produce the same styled callout card.
 */
function postprocessCallouts(html) {
	const iconMap = {
		'note':      'ℹ️',
		'info':      'ℹ️',
		'tip':       '💡',
		'hint':      '💡',
		'important': '❗',
		'warning':   '⚠️',
		'caution':   '⚠️',
		'danger':    '🔥',
		'error':     '❌',
		'success':   '✅',
		'check':     '✅',
		'done':      '✅',
		'question':  '❓',
		'help':      '❓',
		'faq':       '❓',
		'example':   '📝',
		'quote':     '\u201C',
		'cite':      '\u201C',
	};
 
	const openCallout = (type, title) => {
		const calloutType  = type.toLowerCase();
		const calloutTitle = title.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);
		const icon         = iconMap[calloutType] || 'ℹ️';
		return (
			'<div class="md-callout md-callout-' + calloutType + '">' +
			'<div class="md-callout-header">' +
			'<span class="md-callout-icon">' + icon + '</span>' +
			'<span class="md-callout-title">' + calloutTitle + '</span>' +
			'</div>' +
			'<div class="md-callout-content">'
		);
	};
 
	// 1. Blockquote form — captures body paragraphs that follow the header too
	let result = html.replace(
		/<blockquote class="md-blockquote">\s*<p class="md-paragraph">\[!([\w]+)\]\s*(.*?)<\/p>([\s\S]*?)<\/blockquote>/g,
		(match, type, title, body) => openCallout(type, title) + body + '</div></div>'
	);
 
	// 2. Standalone paragraph form — [!type] Title — body or [!type] body
	result = result.replace(
		/<p class="md-paragraph">\[!([\w]+)\]\s*([\s\S]*?)<\/p>/g,
		(match, type, content) => {
			// Attempt to split "Short Title — longer body text" at an em-dash,
			// en-dash, or plain dash cluster.  Cap title at 60 chars.
			const split = content.match(/^(.{1,60}?)\s*(?:[—–]|-{2,})\s*([\s\S]+)$/);
			let title, body;
			if (split) {
				title = split[1].trim();
				body  = split[2].trim() ? '<p class="md-paragraph">' + split[2].trim() + '</p>' : '';
			} else {
				// No dash separator — use the callout type as title, all text as body
				title = '';
				body  = content.trim() ? '<p class="md-paragraph">' + content.trim() + '</p>' : '';
			}
			return openCallout(type, title) + body + '</div></div>';
		}
	);
 
	return result;
}

/**
 * Main markdown parser function
 */
export function parseMarkdown(text) {
	if (!text) return '';

	const preprocessed = preprocessMarkdown(text);

	const options = {
		gfm: true,
		breaks: true
	};

	let html = markedModule.parse(preprocessed, options);
	html = postprocessCallouts(html);

	return html;
}

export default parseMarkdown;