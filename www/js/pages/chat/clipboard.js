export function htmlToMarkdown(root) {
	let text = '';

	const append = (value) => {
		text += String(value ?? '');
	};

	const trimLineEnd = () => {
		text = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]+$/g, '');
	};

	const ensureNewline = () => {
		trimLineEnd();
		if (text && !text.endsWith('\n')) text += '\n';
	};

	const isStructuralContainer = (node) => {
		const cls = node.className || '';
		return cls.includes('chat-message-text') ||
			cls.includes('chat-message-content') ||
			cls.includes('reasoning-text') ||
			cls.includes('reasoning-content');
	};

	const isFormatterWhitespace = (node) => {
		if (node.nodeType !== Node.TEXT_NODE || !/^[\t\n\r ]*$/.test(node.textContent || '')) {
			return false;
		}

		const parent = node.parentElement;
		const parentTag = parent?.tagName?.toLowerCase?.() || '';
		if (parentTag === 'p' || parentTag === 'pre' || parentTag === 'code') return false;

		return Boolean(parent?.className?.includes?.('md-')) ||
			(parent ? isStructuralContainer(parent) : false);
	};

	const walkChildren = (node, context = {}) => {
		[...node.childNodes].forEach((child) => walk(child, context));
	};

	const walk = (node, context = {}) => {
		if (node.nodeType === Node.TEXT_NODE) {
			if (isFormatterWhitespace(node)) return;
			append(node.textContent);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const tag = node.tagName.toLowerCase();
		if (tag === 'br') {
			append('\n');
			return;
		}
		if (tag === 'p') {
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'div') {
			if (isStructuralContainer(node)) {
				walkChildren(node, context);
				return;
			}
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'strong' || tag === 'b') {
			append('**');
			walkChildren(node, context);
			append('**');
			return;
		}
		if (tag === 'em' || tag === 'i') {
			append('*');
			walkChildren(node, context);
			append('*');
			return;
		}
		if (tag === 'code') {
			if (node.parentElement?.tagName.toLowerCase() === 'pre') return;
			append('`');
			walkChildren(node, context);
			append('`');
			return;
		}
		if (tag === 'pre') {
			const code = node.querySelector('code');
			ensureNewline();
			append(`\`\`\`\n${code ? code.textContent : node.textContent}\n\`\`\``);
			ensureNewline();
			return;
		}
		if (tag === 'a') {
			const href = node.getAttribute('href');
			const inner = [...node.childNodes].map((child) => child.textContent).join('');
			append(href ? `[${inner}](${href})` : inner);
			return;
		}
		if (tag === 'li') {
			const marker = context.list === 'ol'
				? `${context.index || 1}. `
				: '- ';
			append(marker);
			walkChildren(node, { ...context, inListItem: true });
			ensureNewline();
			return;
		}
		if (tag === 'h1') {
			append('# ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'h2') {
			append('## ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'h3') {
			append('### ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'h4') {
			append('#### ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'h5') {
			append('##### ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'h6') {
			append('###### ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}
		if (tag === 'ul') {
			walkChildren(node, { ...context, list: 'ul' });
			ensureNewline();
			return;
		}
		if (tag === 'ol') {
			let index = Number.parseInt(node.getAttribute('start') || '1', 10);
			if (!Number.isFinite(index)) index = 1;
			[...node.childNodes].forEach((child) => {
				if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
					walk(child, { ...context, list: 'ol', index });
					index += 1;
				} else {
					walk(child, context);
				}
			});
			ensureNewline();
			return;
		}
		if (tag === 'hr') {
			ensureNewline();
			append('---');
			ensureNewline();
			return;
		}
		if (tag === 'del' || tag === 's') {
			append('~~');
			walkChildren(node, context);
			append('~~');
			return;
		}
		if (tag === 'img') {
			const alt = node.getAttribute('alt') || '';
			const src = node.getAttribute('src') || '';
			append(alt ? `![${alt}](${src})` : src);
			return;
		}
		if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr') {
			walkChildren(node, context);
			if (tag === 'table') ensureNewline();
			return;
		}
		if (tag === 'th') {
			append('| **');
			walkChildren(node, context);
			append('** ');
			return;
		}
		if (tag === 'td') {
			append('| ');
			walkChildren(node, context);
			append(' ');
			return;
		}
		if (tag === 'blockquote') {
			append('> ');
			walkChildren(node, context);
			ensureNewline();
			return;
		}

		walkChildren(node, context);
	};

	walkChildren(root);
	return text.replace(/\n{3,}/g, '\n\n').trim();
}
