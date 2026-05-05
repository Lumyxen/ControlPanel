export function isTextPart(part) {
	return part?.type === 'text';
}

export function isReasoningPart(part) {
	return part?.type === 'reasoning';
}

export function hasInlineReasoningParts(parts) {
	return Array.isArray(parts) && parts.some(isReasoningPart);
}

export function getReasoningPartContent(part) {
	if (!isReasoningPart(part)) return '';
	if (part.content != null) return String(part.content);
	if (part.reasoning != null) return String(part.reasoning);
	if (Array.isArray(part.reasoningParts)) {
		return part.reasoningParts
			.filter(isTextPart)
			.map((reasoningPart) => String(reasoningPart.content || ''))
			.join('');
	}
	return '';
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

export function getNodeRawTextContent(node) {
	if (!node) return '';
	if (hasInlineReasoningParts(node.parts)) {
		return node.parts
			.map((part) => {
				if (isTextPart(part)) return String(part.content || '');
				if (!isReasoningPart(part)) return '';
				const reasoning = getReasoningPartContent(part).trim();
				return reasoning ? `<think>\n${reasoning}\n</think>` : '';
			})
			.join('');
	}

	const chunks = [];
	if (node.reasoning && String(node.reasoning).trim()) {
		chunks.push(`<think>\n${String(node.reasoning).trim()}\n</think>`);
	}
	const text = getNodeTextContent(node);
	if (text) chunks.push(text);
	return chunks.join('\n\n');
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
