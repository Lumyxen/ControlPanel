/**
 * Comprehensive markdown parser using marked.js architecture
 * Supports:
 * - GitHub Flavored Markdown (GFM): Tables, strikethrough, task lists, autolinks
 * - Basic Markdown: Headers, lists, links, images, bold/italic, code blocks, blockquotes, horizontal rules
 * - Obsidian-style: WikiLinks [[...]], highlights ==text==, callouts/admonitions
 * - Discord-style: Spoilers ||text||, mentions, timestamps
 * - Syntax highlighting for code blocks
 */

const markedModule = (function () {
	'use strict';

	const defaults = {
		gfm: true,
		breaks: false,
		langPrefix: 'language-'
	};

	function escapeHtml(html) {
		if (!html) return '';
		return html
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
			const lang = (infostring || '').match(/\S*/)[0];
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

		tokenize(src) {
			const tokens =[];

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

				// Table (GFM)
				match = src.match(/^ {0,3}\|?(.+)\|.*\n {0,3}\|?[\s\S]*\|[\s\S]*(?:\n|$)/);
				if (match && src.match(/^ {0,3}\|?.*\|\n {0,3}\|?[\-:]+/)) {
					const tableMatch = src.match(/^ {0,3}\|?(.+)\|\n {0,3}\|?([\s\S]*?)\|(?:\n([\s\S]*?))?(?:\n{2,}|\s*$)/);
					if (tableMatch) {
						const header = tableMatch[1].split('|').map(s => s.trim()).filter(Boolean);
						const alignRow = tableMatch[2].split('|').map(s => s.trim()).filter(Boolean);
						const align = alignRow.map(s => {
							if (/^:-+:$/.test(s)) return 'center';
							if (/^:-+/.test(s)) return 'left';
							if (/^-+:$/.test(s)) return 'right';
							return null;
						});
						const rows = tableMatch[3] ? tableMatch[3].trim().split('\n') :[];
						const cells = rows.map(row => row.replace(/^ {0,3}\|?|\|$/g, '').split('|').map(s => s.trim()));
						tokens.push({ type: 'table', header, align, cells });
						src = src.substring(tableMatch[0].length);
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
				if (listMatch) {
					const indent = listMatch[1].length;
					const marker = listMatch[2];
					const ordered = /^\d+\./.test(marker);
					const start = ordered ? parseInt(marker) : 1;
					const listContent = listMatch[0];
					const items =[];
					const itemRegex = new RegExp(`^ {0,3}${ordered ? '\\d+\\.' : '[-*+]'}\\s+(.*)$`, 'gm');
					let itemMatch;
					while ((itemMatch = itemRegex.exec(listContent)) !== null) {
						const text = itemMatch[1].trim();
						const task = /^\[[ xX]\]/.test(text);
						const checked = /^\[[xX]\]/.test(text);
						items.push({ text: task ? text.substring(4) : text, task, checked });
					}
					tokens.push({ type: 'list', ordered, start, items });
					src = src.substring(listMatch[0].length);
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
				// Regex carefully splits whenever it sees <div, </div, <details, etc. to prevent invalid <p> wrapper nesting.
				match = src.match(/^([^\n]+(?:\n(?! {0,3}#{1,6}\s| {0,3}>| {0,3}[-*+]| {0,3}\d+\.|```|~~~| {0,3}<\/?div| {0,3}<\/?details|\n{2,})[^\n]+)*)/);
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
				case 'list':
					let body = '';
					for (const item of token.items) {
						body += this.renderer.listitem(this.inlineParser.parse(item.text), item.task, item.checked);
					}
					return this.renderer.list(body, token.ordered, token.start);
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
		comments:[]
	};

	// 1. Extract Comments (Hide them first so keywords inside comments are ignored)
	if (['javascript', 'typescript', 'java', 'cpp', 'c', 'go', 'rust', 'css'].includes(lang)) {
		// Block comments
		src = src.replace(/(\/\*[\s\S]*?\*\/)/g, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
		// Line comments
		src = src.replace(/(\/\/.*$)/gm, (match) => {
			const id = `__COM${placeholders.comments.length}__`;
			placeholders.comments.push(match);
			return id;
		});
	} else if (['python', 'bash', 'shell'].includes(lang)) {
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

	// 2. Extract Strings (Hide them so keywords inside aren't highlighted, and string regex doesn't match keyword HTML tags)
	// General string regex for "..." and '...' and `...`
	src = src.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (match) => {
		const id = `__STR${placeholders.strings.length}__`;
		placeholders.strings.push(match);
		return id;
	});

	// 3. Escape the skeleton (the code without strings/comments)
	// This prevents HTML tags generated later from being escaped, while escaping code operators like < and >.
	src = escapeHtml(src);

	// 4. Highlight Keywords
	const keywords = {
		javascript:['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'default'],
		typescript:['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace', 'module', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'default', 'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'null', 'undefined', 'object', 'symbol', 'bigint', 'as', 'satisfies', 'infer', 'keyof', 'readonly', 'abstract', 'private', 'protected', 'public', 'static', 'get', 'set', 'declare'],
		python:['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'lambda', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'pass', 'break', 'continue', 'del', 'assert', 'global', 'nonlocal', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await', 'match', 'case'],
		java:['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'extends', 'implements', 'return', 'void', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'true', 'false', 'null', 'import', 'package', 'instanceof', 'synchronized', 'volatile', 'transient', 'native', 'strictfp', 'const', 'goto'],
		cpp:['int', 'float', 'double', 'char', 'void', 'bool', 'auto', 'const', 'static', 'volatile', 'extern', 'inline', 'virtual', 'explicit', 'mutable', 'constexpr', 'consteval', 'constinit', 'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue', 'return', 'goto', 'try', 'catch', 'throw', 'class', 'struct', 'union', 'enum', 'typedef', 'typename', 'template', 'namespace', 'using', 'public', 'private', 'protected', 'friend', 'operator', 'new', 'delete', 'sizeof', 'typeid', 'decltype', 'nullptr', 'true', 'false', 'this', 'override', 'final', 'noexcept', 'concept', 'requires', 'co_await', 'co_return', 'co_yield'],
		c:['int', 'float', 'double', 'char', 'void', 'short', 'long', 'signed', 'unsigned', 'const', 'static', 'volatile', 'extern', 'auto', 'register', 'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do', 'break', 'continue', 'return', 'goto', 'struct', 'union', 'enum', 'typedef', 'sizeof', 'inline', 'restrict'],
		go:['package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'fallthrough', 'return', 'goto', 'defer', 'go', 'select', 'make', 'new', 'len', 'cap', 'append', 'copy', 'close', 'delete', 'panic', 'recover', 'nil', 'true', 'false', 'iota'],
		rust:['fn', 'let', 'mut', 'const', 'static', 'type', 'struct', 'enum', 'trait', 'impl', 'pub', 'use', 'mod', 'crate', 'super', 'self', 'if', 'else', 'match', 'while', 'loop', 'for', 'in', 'break', 'continue', 'return', 'async', 'await', 'move', 'ref', 'where', 'unsafe', 'extern', 'as', 'dyn', 'yield', 'macro', 'union', 'typeof'],
		json:['true', 'false', 'null'],
		html:['DOCTYPE', 'html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style', 'div', 'span', 'p', 'a', 'img', 'br', 'hr', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'nav', 'header', 'footer', 'main', 'section', 'article', 'aside'],
		css:['import', 'media', 'keyframes', 'font-face', 'supports', 'charset', 'important', 'color', 'background', 'border', 'margin', 'padding', 'width', 'height', 'display', 'position', 'top', 'left', 'right', 'bottom', 'float', 'clear', 'font', 'text', 'align', 'content', 'overflow', 'visibility', 'opacity', 'transform', 'transition', 'animation', 'flex', 'grid', 'min', 'max', 'calc', 'var'],
		sql:['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'VIEW', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'CAST', 'CONVERT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'VALUES', 'INTO', 'SET'],
		bash:['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done', 'in', 'function', 'return', 'break', 'continue', 'shift', 'exit', 'export', 'local', 'readonly', 'unset', 'declare', 'typeset', 'source', 'alias', 'unalias', 'trap', 'wait', 'exec', 'eval', 'echo', 'printf', 'read', 'test', 'true', 'false', 'cd', 'pwd', 'ls', 'cat', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'head', 'tail', 'chmod', 'chown', 'mkdir', 'rm', 'cp', 'mv', 'tar', 'gzip', 'gunzip', 'find', 'xargs', 'curl', 'wget', 'ssh', 'scp', 'sudo', 'su', 'ps', 'kill', 'top', 'df', 'du', 'free', 'uptime', 'date', 'time', 'sleep', 'jobs', 'fg', 'bg', 'disown', 'nohup', 'env', 'set', 'shopt', 'getopts', 'command', 'builtin', 'type', 'hash', 'ulimit', 'umask', 'caller', 'logout', 'exit']
	};

	const langKeywords = keywords[lang] ||[];
	if (langKeywords.length > 0) {
		const keywordRegex = new RegExp('\\b(' + langKeywords.join('|') + ')\\b', 'g');
		src = src.replace(keywordRegex, '<span class="md-keyword">$1</span>');
	}

	// 5. Highlight Numbers
	src = src.replace(/\b(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, '<span class="md-number">$1</span>');

	// 6. Restore Strings (escape content + wrap)
	placeholders.strings.forEach((str, i) => {
		const id = `__STR${i}__`;
		const escaped = escapeHtml(str);
		src = src.replace(id, `<span class="md-string">${escaped}</span>`);
	});

	// 7. Restore Comments (escape content + wrap)
	placeholders.comments.forEach((com, i) => {
		const id = `__COM${i}__`;
		const escaped = escapeHtml(com);
		src = src.replace(id, `<span class="md-comment">${escaped}</span>`);
	});

	// HTML tags (special case: minimal highlighting for tag names if lang is html)
	// Since we escaped everything in step 3, we look for &lt;tagname
	if (lang === 'html') {
		// Only highlight the tag name, e.g., &lt;div
		src = src.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="md-keyword">$2</span>');
	}

	return src;
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

/**
 * Pre-process markdown to handle custom extensions
 * - WikiLinks: [[Page Title]] or [[Page Title|Display Text]]
 * - Highlights: ==text==
 * - Spoilers: ||text||
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
	result = result.replace(/\|\|([^|]+)\|\|/g, '<span class="md-spoiler" onclick="this.classList.add(' + "'" + 'revealed' + "'" + ')">$1</span>');

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
 * Post-process HTML to handle callouts/admonitions
 */
function postprocessCallouts(html) {
	return html.replace(/<blockquote class="md-blockquote">\s*<p class="md-paragraph">\[!([\w]+)\]\s*(.*?)<\/p>/g, (match, type, title) => {
		const calloutType = type.toLowerCase();
		const calloutTitle = title.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

		const iconMap = {
			'note': 'ℹ️',
			'info': 'ℹ️',
			'tip': '💡',
			'hint': '💡',
			'important': '❗',
			'warning': '⚠️',
			'caution': '⚠️',
			'danger': '🔥',
			'error': '❌',
			'success': '✅',
			'check': '✅',
			'done': '✅',
			'question': '❓',
			'help': '❓',
			'faq': '❓',
			'example': '📝',
			'quote': '"',
			'cite': '"'
		};

		const icon = iconMap[calloutType] || 'ℹ️';
		return '<div class="md-callout md-callout-' + calloutType + '"><div class="md-callout-header"><span class="md-callout-icon">' + icon + '</span><span class="md-callout-title">' + calloutTitle + '</span></div><div class="md-callout-content">';
	}).replace(/<\/blockquote>/g, (match, offset, string) => {
		const precedingText = string.substring(0, offset);
		if (precedingText.includes('md-callout')) {
			return '</div></div>';
		}
		return match;
	});
}

/**
 * Main markdown parser function
 */
export function parseMarkdown(text) {
	if (!text) return '';

	const preprocessed = preprocessMarkdown(text);

	const options = {
		gfm: true,
		breaks: false
	};

	let html = markedModule.parse(preprocessed, options);
	html = postprocessCallouts(html);

	return html;
}

export default parseMarkdown;