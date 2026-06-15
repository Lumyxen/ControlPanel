// www/js/chat/context.js

// Store for model metadata fetched from API
// Maps model ID -> model object with context_length, max_tokens, etc.
let modelMetadata = new Map();
const DEFAULT_CONTEXT_LIMIT = 65536;

/**
 * Store / merge model metadata from API response
 * (Now merges instead of clearing so LM Studio models are also kept)
 * @param {Array} models - Array of model objects from API
 */
export function setModelMetadata(models) {
	if (Array.isArray(models)) {
		for (const model of models) {
			if (model.id) {
				modelMetadata.set(model.id, model);
			}
		}
	}
}

/**
 * Get a specific model's metadata by ID
 * @param {string} modelId - Model ID
 * @returns {Object|null} Model metadata or null
 */
function getModelMetadata(modelId) {
	return modelMetadata.get(modelId) || null;
}

export function hasKnownModel(modelId) {
	return Boolean(modelId) && modelMetadata.has(modelId);
}

export function getKnownModelContextLength(modelId) {
	return getModelContextLength(getModelMetadata(modelId));
}

function parsePositiveInt(value) {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getModelContextLength(model) {
	if (!model || typeof model !== "object") return null;

	const candidates = [
		model.context_length,
		model.contextLength,
		model.max_context_length,
		model.maxContextLength,
		model.architecture?.context_length,
		model.architecture?.contextLength,
	];

	for (const candidate of candidates) {
		const parsed = parsePositiveInt(candidate);
		if (parsed) return parsed;
	}

	return null;
}

export function estimateTokensForText(text) {
	const s = String(text || "");
	if (!s) return 0;
	return Math.max(1, Math.ceil(s.length / 4));
}

function estimateMessageContentTokens(content) {
	if (!content) return 0;
	if (typeof content === "string") {
		return estimateTokensForText(content);
	}
	if (Array.isArray(content)) {
		return content.reduce((total, part) => {
			if (!part || typeof part !== "object") {
				return total + estimateTokensForText(part);
			}

			if (part.type === "text" || part.type === "input_text") {
				return total + estimateTokensForText(part.text || part.content || "");
			}
			if (part.type === "image_url" || part.type === "input_image") {
				return total + estimateTokensForText("[Image attachment]");
			}

			return total + estimateTokensForText(JSON.stringify(part));
		}, 0);
	}
	if (typeof content === "object") {
		return estimateTokensForText(JSON.stringify(content));
	}
	return estimateTokensForText(content);
}

export function estimatePreparedMessagesTokens(messages, systemPrompt = "") {
	let total = estimateTokensForText(systemPrompt);

	if (!Array.isArray(messages)) return total;

	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		total += estimateTokensForText(message.role || "");
		total += estimateMessageContentTokens(message.content);
		if (message.name) total += estimateTokensForText(message.name);
		if (message.tool_call_id) total += estimateTokensForText(message.tool_call_id);
		if (message.tool_calls) total += estimateTokensForText(JSON.stringify(message.tool_calls));
	}

	return total;
}

/**
 * Extract a flat transcript approximation for node-level estimates.
 * The exact context counter uses structured API messages instead.
 */
function getNodeFullText(node) {
	if (!node) return "";

	let text = "";

	if (node.parts && Array.isArray(node.parts)) {
		for (const part of node.parts) {
			if (part.type === "text" && part.content) {
				text += part.content + "\n";
			} else if (part.type === "attachment") {
				let info = `[Attachment: ${part.name} (${part.size} bytes)`;
				if (part.isImage) info += " (image)";
				
				if (part.data && !part.isImage) {
					try {
						const base64Match = part.data.match(/^data:[^;]+;base64,(.+)$/);
						if (base64Match) {
							const binaryString = atob(base64Match[1]);
							const bytes = new Uint8Array(binaryString.length);
							for (let i = 0; i < binaryString.length; i++) {
								bytes[i] = binaryString.charCodeAt(i);
							}
							const decoder = new TextDecoder('utf-8');
							const textContent = decoder.decode(bytes);
							info += `\n[File Content:]\n${textContent}`;
						}
					} catch (e) {
						console.warn('Could not read file content for token estimation:', e);
					}
				}
				
				text += info + "]\n";
			}
		}
	} else {
		text += String(node.content || "") + "\n";
	}

	if (node.reasoning) {
		text += `<think>\n${node.reasoning}\n</think>\n`;
	}

	if (node.toolCalls && Array.isArray(node.toolCalls)) {
		for (const tc of node.toolCalls) {
			const inputValue = tc.input ?? tc.arguments ?? "";
			const inputStr = typeof inputValue === 'object' ? JSON.stringify(inputValue) : String(inputValue || "");
			const outputStr = typeof tc.output === 'object' ? JSON.stringify(tc.output) : String(tc.output || "");
			text += `\n[Tool Execution: ${tc.title || tc.name}]\nInput: ${inputStr}\nOutput: ${outputStr}\n`;
		}
	}

	return text.trim();
}

export function estimateNodeTokens(node) {
	if (!node) return 0;
	return estimateTokensForText(getNodeFullText(node));
}

export function estimatePartsTokens(parts) {
	if (!parts || !parts.length) return 0;
	return estimateTokensForText(getNodeFullText({ parts }));
}

function getModelPickerItem(root, modelId = "") {
	const normalizedModelId = String(modelId || "");
	const items = root?.querySelectorAll?.('[data-dropdown="model"] .chat-dropdown-item') || [];
	let selected = null;

	for (const item of items) {
		if (item.classList?.contains?.("selected")) {
			selected = item;
		}
		if (normalizedModelId && item.dataset?.value === normalizedModelId) {
			return item;
		}
	}

	return normalizedModelId ? null : selected;
}

export function getModelContextInfo(modelId = "", root = null) {
	const normalizedModelId = String(modelId || "");
	let contextLimit = null;

	if (normalizedModelId && modelMetadata.has(normalizedModelId)) {
		contextLimit = getModelContextLength(getModelMetadata(normalizedModelId));
	}

	if (!contextLimit) {
		contextLimit = parsePositiveInt(getModelPickerItem(root, normalizedModelId)?.dataset?.contextLength);
	}

	if (contextLimit) {
		return {
			contextLimit,
			isKnown: true,
		};
	}

	return {
		contextLimit: DEFAULT_CONTEXT_LIMIT,
		isKnown: false,
	};
}

export function getModelContextInfoFromUI(root) {
	const selected = getModelPickerItem(root);
	if (!selected) {
		return {
			contextLimit: DEFAULT_CONTEXT_LIMIT,
			isKnown: false,
		};
	}

	return getModelContextInfo(selected.dataset?.value || "", root);
}

export function getModelContextLimitFromUI(root) {
	return getModelContextInfoFromUI(root).contextLimit;
}

/**
 * Get max_tokens for a model from stored metadata
 */
export function getModelMaxTokens(modelId) {
	if (!modelId) return 8192;
	const model = getModelMetadata(modelId);
	if (model) {
		const maxTokens = parseInt(model.max_tokens, 10);
		if (!isNaN(maxTokens) && maxTokens > 0) {
			return maxTokens;
		}
	}
	return 8192;
}

function buildContextIssueMessages({
	exactCountUnavailable = false,
	contextLimitKnown = true,
	showUnknownContextWarning = true,
} = {}) {
	const messages = [];
	if (exactCountUnavailable) {
		messages.push('Exact token counting is unavailable. The displayed usage may be stale.');
	}
	if (showUnknownContextWarning && !contextLimitKnown) {
		messages.push("The model's context window is unknown.");
	}
	return messages;
}

export function updateContextUI(root, {
	usedTokens = 0,
	contextLimit = null,
	contextLimitKnown = null,
	exactCountUnavailable = false,
	showUnknownContextWarning = true,
} = {}) {
	const el = root?.querySelector?.("#chatContext");
	if (!el) return;
	const warningEl = root?.querySelector?.("#chatContextWarningIcon");
	const contextInfo = getModelContextInfoFromUI(root);

	const passedMax = Number.isFinite(contextLimit) && contextLimit > 0
		? contextLimit
		: null;
	const hasKnownContextFromUI = contextInfo.isKnown === true;
	const max = hasKnownContextFromUI && contextLimitKnown !== true
		? contextInfo.contextLimit
		: passedMax || contextInfo.contextLimit;
	const isContextLimitKnown = hasKnownContextFromUI || (
		typeof contextLimitKnown === "boolean"
			? contextLimitKnown
			: contextInfo.isKnown
	);
	const used = Number.isFinite(usedTokens) && usedTokens >= 0
		? Math.max(0, usedTokens)
		: 0;
	const hasExactCountIssue = exactCountUnavailable === true;
	const issueMessages = buildContextIssueMessages({
		exactCountUnavailable: hasExactCountIssue,
		contextLimitKnown: isContextLimitKnown,
		showUnknownContextWarning,
	});
	const issueTitle = issueMessages.join("\n");
	const displayMax = isContextLimitKnown && Number.isFinite(max) && max > 0
		? String(max)
		: "?";
	const displayChars = Math.max(
		String(used).length,
		displayMax === "?" ? 5 : displayMax.length,
	) + displayMax.length + 1;

	el.dataset.usedTokens = String(used);
	el.dataset.contextLimitKnown = String(isContextLimitKnown);
	el.dataset.exactCountUnavailable = String(hasExactCountIssue);
	el.style.setProperty("--chat-context-width", `${displayChars}ch`);
	el.textContent = `${used}/${displayMax}`;
	el.title = (isContextLimitKnown && max > 0
		? `Context Window: ${used} tokens used / ${max} total`
		: `Context Window: ${used} tokens used / unknown total`)
		+ (issueTitle ? `\n${issueTitle}` : "");
	el.classList.toggle("issue-text", issueMessages.length > 0);
	el.classList.toggle("issue-box", hasExactCountIssue && !isContextLimitKnown);

	if (warningEl) {
		warningEl.hidden = issueMessages.length === 0;
		if (issueMessages.length > 0) {
			warningEl.title = issueTitle;
			warningEl.setAttribute("aria-label", issueMessages.join(" "));
		} else {
			warningEl.removeAttribute("title");
			warningEl.removeAttribute("aria-label");
		}
	}

	if (max > 0 && isContextLimitKnown) {
		const ratio = used / max;
		if (ratio >= 0.9) {
			el.classList.add("danger");
			el.classList.remove("warning");
		} else if (ratio >= 0.5) {
			el.classList.add("warning");
			el.classList.remove("danger");
		} else {
			el.classList.remove("warning", "danger");
		}
	} else {
		el.classList.remove("warning", "danger");
	}
}
