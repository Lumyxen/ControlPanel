function clonePlainObject(value) {
	if (!value || typeof value !== 'object') return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return { ...value };
	}
}

export function cloneReasoningParts(reasoningParts) {
	if (!Array.isArray(reasoningParts)) return [];
	const cloned = [];
	for (const part of reasoningParts) {
		if (!part || typeof part !== 'object') continue;
		if (part.type === 'text') {
			cloned.push({
				type: 'text',
				content: String(part.content ?? ''),
			});
			continue;
		}
		if (part.type === 'tool_call') {
			const nextPart = { type: 'tool_call' };
			if (part.toolCallId) nextPart.toolCallId = String(part.toolCallId);
			if (part.toolCall && typeof part.toolCall === 'object') {
				nextPart.toolCall = clonePlainObject(part.toolCall);
			}
			cloned.push(nextPart);
		}
	}
	return cloned;
}

export function appendReasoningTextPart(reasoningParts, text) {
	if (!Array.isArray(reasoningParts)) return reasoningParts;
	const value = String(text ?? '');
	if (!value) return reasoningParts;
	const lastPart = reasoningParts[reasoningParts.length - 1];
	if (lastPart?.type === 'text') {
		lastPart.content = String(lastPart.content ?? '') + value;
		return reasoningParts;
	}
	reasoningParts.push({ type: 'text', content: value });
	return reasoningParts;
}

export function upsertReasoningToolPart(reasoningParts, toolCall) {
	if (!Array.isArray(reasoningParts) || !toolCall || typeof toolCall !== 'object') {
		return reasoningParts;
	}

	const clonedToolCall = clonePlainObject(toolCall);
	if (!clonedToolCall) return reasoningParts;

	const toolCallId = String(clonedToolCall.id ?? '');
	if (toolCallId) {
		const existingPart = reasoningParts.find((part) =>
			part?.type === 'tool_call' && String(part.toolCallId ?? '') === toolCallId);
		if (existingPart) {
			existingPart.toolCallId = toolCallId;
			existingPart.toolCall = clonedToolCall;
			return reasoningParts;
		}
		reasoningParts.push({ type: 'tool_call', toolCallId, toolCall: clonedToolCall });
		return reasoningParts;
	}

	reasoningParts.push({ type: 'tool_call', toolCall: clonedToolCall });
	return reasoningParts;
}

export function getResolvedReasoningParts({ reasoning = '', reasoningParts = null, toolCalls = null } = {}) {
	const storedParts = cloneReasoningParts(reasoningParts);
	const toolCallMap = new Map();
	if (Array.isArray(toolCalls)) {
		for (const toolCall of toolCalls) {
			if (!toolCall || typeof toolCall !== 'object' || !toolCall.id) continue;
			toolCallMap.set(String(toolCall.id), clonePlainObject(toolCall));
		}
	}

	if (storedParts.length > 0) {
		const resolved = [];
		for (const part of storedParts) {
			if (part.type === 'text') {
				if (part.content) resolved.push(part);
				continue;
			}

			if (part.type !== 'tool_call') continue;
			const toolCallId = String(part.toolCallId ?? '');
			const resolvedToolCall = (toolCallId && toolCallMap.get(toolCallId)) || part.toolCall;
			if (!resolvedToolCall) continue;
			resolved.push({
				type: 'tool_call',
				toolCallId: toolCallId || String(resolvedToolCall.id ?? ''),
				toolCall: clonePlainObject(resolvedToolCall),
			});
		}
		return resolved;
	}

	const fallback = [];
	if (String(reasoning ?? '').trim()) {
		fallback.push({ type: 'text', content: String(reasoning) });
	}
	if (Array.isArray(toolCalls)) {
		for (const toolCall of toolCalls) {
			const clonedToolCall = clonePlainObject(toolCall);
			if (!clonedToolCall) continue;
			fallback.push({
				type: 'tool_call',
				toolCallId: String(clonedToolCall.id ?? ''),
				toolCall: clonedToolCall,
			});
		}
	}
	return fallback;
}
