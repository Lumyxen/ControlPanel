import { computeThreadNodeIds, ensureGraph, getNode } from "./graph.js";

// Store for model metadata fetched from API
// Maps model ID -> model object with context_length, max_tokens, etc.
let modelMetadata = new Map();

/**
 * Store model metadata from API response
 * @param {Array} models - Array of model objects from API
 */
export function setModelMetadata(models) {
	modelMetadata.clear();
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
export function getModelMetadata(modelId) {
	return modelMetadata.get(modelId) || null;
}

/**
 * Get the currently selected model ID from the UI
 * @param {HTMLElement} root - Root element
 * @returns {string|null} Selected model ID or null
 */
export function getSelectedModelId(root) {
	const selected = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
	return selected?.dataset?.value || null;
}

export function estimateTokensForText(text) {
	const s = String(text || "");
	if (!s) return 0;
	return Math.max(1, Math.ceil(s.length / 4));
}

export function getModelContextLimitFromUI(root) {
	const selected = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
	if (!selected) return 8192; // Default fallback if nothing selected
	
	// First try to get context_length from stored model metadata
	const modelId = selected.dataset.value;
	if (modelId && modelMetadata.has(modelId)) {
		const model = modelMetadata.get(modelId);
		const contextLength = parseInt(model.context_length, 10);
		if (!isNaN(contextLength) && contextLength > 0) {
			return contextLength;
		}
	}
	
	// Fallback to data attribute from HTML (hardcoded values)
	const contextLength = parseInt(selected.dataset.contextLength, 10);
	if (!isNaN(contextLength) && contextLength > 0) {
		return contextLength;
	}
	
	// Final default fallback
	return 8192;
}

/**
 * Get max_tokens for a model from stored metadata
 * @param {string} modelId - Model ID
 * @returns {number} max_tokens value or default (8192)
 */
export function getModelMaxTokens(modelId) {
	if (!modelId) return 8192;

	const model = modelMetadata.get(modelId);
	if (model) {
		const maxTokens = parseInt(model.max_tokens, 10);
		if (!isNaN(maxTokens) && maxTokens > 0) {
			return maxTokens;
		}
	}

	return 8192; // Default fallback 
}

export function computeThreadTokenUsage(graph) {
	return computeThreadNodeIds(graph).reduce((total, id) => {
		const node = getNode(graph, id);
		let text = "";
		if (node?.parts && Array.isArray(node.parts)) {
			text = node.parts.filter(p => p.type === "text").map(p => p.content).join("");
		} else if (node?.content) {
			text = node.content;
		}
		return total + estimateTokensForText(text);
	}, 0);
}

export function updateContextUI(root, chat) {
	const el = root?.querySelector?.("#chatContext");
	if (!el) return;
	
	// Always get the model context limit from the selected dropdown item
	const max = getModelContextLimitFromUI(root);
	
	// Calculate used tokens only if there's a chat
	let used = 0;
	if (chat) {
		const graph = ensureGraph(chat);
		used = computeThreadTokenUsage(graph);
	}
	
	el.textContent = `${used}/${max}`;
	el.title = max > 0
		? `Context Window: ${used} tokens used / ${max} total`
		: "Context Window";
}
