export function isTextPart(part) {
	return part?.type === 'text';
}

export function getPartsText(parts) {
	if (!Array.isArray(parts)) return '';
	return parts
		.filter(isTextPart)
		.map((part) => String(part.content || ''))
		.join('');
}

export function getNodeTextContent(node) {
	if (!node) return '';
	if (Array.isArray(node.parts)) {
		return getPartsText(node.parts);
	}
	return String(node.content || '');
}

export function buildPartsWithUpdatedText(node, text) {
	const nextText = String(text ?? '');
	if (!Array.isArray(node?.parts)) {
		return [{ type: 'text', content: nextText }];
	}

	let replaced = false;
	const nextParts = node.parts.map((part) => {
		if (!replaced && isTextPart(part)) {
			replaced = true;
			return { ...part, content: nextText };
		}
		return { ...part };
	});

	if (!replaced) {
		nextParts.unshift({ type: 'text', content: nextText });
	}

	return nextParts;
}
