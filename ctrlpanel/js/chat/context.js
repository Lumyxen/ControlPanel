// ctrlpanel/js/chat/context.js
import { computeThreadNodeIds, ensureGraph, getNode } from "./graph.js";

// Store for model metadata fetched from API
// Maps model ID -> model object with context_length, max_tokens, etc.
let modelMetadata = new Map();

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

export function estimateTokensForText(text) {
	const s = String(text || "");
	if (!s) return 0;
	return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * Extract full text that contributes to context (text + attachment descriptions + reasoning + tools)
 * Matches exactly what is sent to the model in chat-page.js
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
			const inputStr = typeof tc.input === 'object' ? JSON.stringify(tc.input) : String(tc.input || "");
			text += `\n[Tool Execution: ${tc.name}]\nInput: ${inputStr}\nOutput: ${tc.output || ""}\n`;
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

export function getModelContextLimitFromUI(root) {
	const selected = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
	if (!selected) return 65536;

	const modelId = selected.dataset.value;

	let limit = 65536; // Fallback

	// Prefer metadata (now includes LM Studio models and normalizes fallback keys dynamically)
	if (modelId && modelMetadata.has(modelId)) {
		const model = getModelMetadata(modelId);
		const contextLength = parseInt(model.context_length, 10);
		if (!isNaN(contextLength) && contextLength > 0) {
			limit = contextLength;
		}
	} else {
		// Fallback to data attribute (still works)
		const contextLength = parseInt(selected.dataset.contextLength, 10);
		if (!isNaN(contextLength) && contextLength > 0) {
			limit = contextLength;
		}
	}

	// Apply minimum and maximum of 64k
	return Math.min(Math.max(limit, 65536), 65536);
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

function computeThreadTokenUsage(graph) {
	return computeThreadNodeIds(graph).reduce((total, id) => {
		const node = getNode(graph, id);
		const text = getNodeFullText(node);
		return total + estimateTokensForText(text);
	}, 0);
}

export function updateContextUI(root, chat, extraTokens = 0) {
	const el = root?.querySelector?.("#chatContext");
	if (!el) return;

	const max = getModelContextLimitFromUI(root);

	let used = extraTokens;
	if (chat) {
		const graph = ensureGraph(chat);
		used += computeThreadTokenUsage(graph);
	}

	el.textContent = `${Math.max(0, used)}/${max}`;
	el.title = max > 0
		? `Context Window: ${Math.max(0, used)} tokens used / ${max} total`
		: "Context Window";

	if (max > 0) {
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