export function htmlToMarkdown(root) {
	let text = '';

	const walk = (node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			text += node.textContent;
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const tag = node.tagName.toLowerCase();
		if (tag === 'br') {
			text += '\n';
			return;
		}
		if (tag === 'p') {
			text += '\n';
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}
		if (tag === 'div') {
			const cls = node.className || '';
			if (cls.includes('chat-message-text') || cls.includes('chat-message-content')) {
				[...node.childNodes].forEach(walk);
				return;
			}
			text += '\n';
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}
		if (tag === 'strong' || tag === 'b') {
			text += '**';
			[...node.childNodes].forEach(walk);
			text += '**';
			return;
		}
		if (tag === 'em' || tag === 'i') {
			text += '*';
			[...node.childNodes].forEach(walk);
			text += '*';
			return;
		}
		if (tag === 'code') {
			if (node.parentElement?.tagName.toLowerCase() === 'pre') return;
			text += '`';
			[...node.childNodes].forEach(walk);
			text += '`';
			return;
		}
		if (tag === 'pre') {
			const code = node.querySelector('code');
			text += `\`\`\`\n${code ? code.textContent : node.textContent}\n\`\`\``;
			return;
		}
		if (tag === 'a') {
			const href = node.getAttribute('href');
			const inner = [...node.childNodes].map((child) => child.textContent).join('');
			text += href ? `[${inner}](${href})` : inner;
			return;
		}
		if (tag === 'li') {
			text += '- ';
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}
		if (tag === 'h1') {
			text += '# ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'h2') {
			text += '## ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'h3') {
			text += '### ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'h4') {
			text += '#### ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'h5') {
			text += '##### ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'h6') {
			text += '###### ';
			[...node.childNodes].forEach(walk);
			text += '\n\n';
			return;
		}
		if (tag === 'ul') {
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}
		if (tag === 'ol') {
			let index = 0;
			[...node.childNodes].forEach((child) => {
				if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
					index += 1;
					text += `${index}. `;
					walk(child);
					text += '\n';
				} else {
					walk(child);
				}
			});
			text += '\n';
			return;
		}
		if (tag === 'hr') {
			text += '\n---\n\n';
			return;
		}
		if (tag === 'del' || tag === 's') {
			text += '~~';
			[...node.childNodes].forEach(walk);
			text += '~~';
			return;
		}
		if (tag === 'img') {
			const alt = node.getAttribute('alt') || '';
			const src = node.getAttribute('src') || '';
			text += alt ? `![${alt}](${src})` : src;
			return;
		}
		if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr') {
			[...node.childNodes].forEach(walk);
			if (tag === 'table') text += '\n';
			return;
		}
		if (tag === 'th') {
			text += '| **';
			[...node.childNodes].forEach(walk);
			text += '** ';
			return;
		}
		if (tag === 'td') {
			text += '| ';
			[...node.childNodes].forEach(walk);
			text += ' ';
			return;
		}
		if (tag === 'blockquote') {
			text += '> ';
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}

		[...node.childNodes].forEach(walk);
	};

	[...root.childNodes].forEach(walk);
	return text.replace(/\n{3,}/g, '\n\n').trim();
}
