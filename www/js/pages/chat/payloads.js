// www/js/chat/generation.js
// Pure helper functions for building conversation payloads sent to the AI backend.
// These functions have no side-effects and do not touch the DOM.

import { getNode } from './graph.js';
import { getNodeTextContent } from './message-parts.js';

// ─── buildNodeTextForHistory ──────────────────────────────────────────────────
// Converts a single graph node into a flat string for the legacy prompt history.

function buildNodeText(node, { includeToolCalls = true } = {}) {
	if (!node) return '';
	let nodeContent = '';

	if (node.parts && Array.isArray(node.parts)) {
		const attachmentInfos = [];

		for (const part of node.parts) {
			if (part.type === 'attachment') {
				const isImage = part.isImage ? ' (image)' : '';
				let info = `[Attachment: ${part.name} (${part.size} bytes)${isImage}]`;

				if (part.data && !part.isImage) {
					try {
						const b64Match = part.data.match(/^data:[^;]+;base64,(.+)$/);
						if (b64Match) {
							const chunk = b64Match[1].slice(0, 13336);
							const binaryString = atob(chunk);
							const bytes = new Uint8Array(binaryString.length);
							for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
							const textContent = new TextDecoder('utf-8').decode(bytes).slice(0, 10000);
							info += `\n[File Content:]\n${textContent}`;
						}
					} catch (e) { console.warn('Could not read file content:', e); }
				}
				attachmentInfos.push(info);
			}
		}

		nodeContent = getNodeTextContent(node);
		if (attachmentInfos.length > 0) nodeContent += '\n' + attachmentInfos.join('\n');
	} else if (node.content) {
		nodeContent = getNodeTextContent(node);
	}

	if (node.reasoning) nodeContent = `<think>\n${node.reasoning}\n</think>\n\n` + nodeContent;

	if (includeToolCalls && node.toolCalls && Array.isArray(node.toolCalls) && node.toolCalls.length > 0) {
		let toolsText = '';
		for (const tc of node.toolCalls) {
			const inputValue = tc.input ?? tc.arguments ?? '';
			const inputStr = typeof inputValue === 'object' ? JSON.stringify(inputValue) : String(inputValue || '');
			const outputStr = typeof tc.output === 'object' ? JSON.stringify(tc.output) : String(tc.output || '');
			toolsText += `\n[Tool Execution: ${tc.title || tc.name}]\nInput: ${inputStr}\nOutput: ${outputStr}\n`;
		}
		nodeContent += toolsText;
	}

	return nodeContent;
}

export function buildNodeTextForHistory(node) {
	return buildNodeText(node, { includeToolCalls: true });
}

function buildAssistantHistoryText(node, settings = null) {
	let textContent = buildNodeTextForHistory(node);
	const includeLogprobs = settings && (
		settings.logprobHistoryHigh || settings.logprobHistoryMedium || settings.logprobHistoryLow
	);

	if (includeLogprobs && node?.tokenLogprobs && node.tokenLogprobs.length > 0) {
		const logprobNote = buildLogprobAnnotation(node.tokenLogprobs, settings);
		if (logprobNote) {
			textContent += '\n\n' + logprobNote;
		}
	}

	return textContent;
}

function buildAssistantApiText(node, settings = null) {
	let textContent = buildNodeText(node, { includeToolCalls: false });
	const includeLogprobs = settings && (
		settings.logprobHistoryHigh || settings.logprobHistoryMedium || settings.logprobHistoryLow
	);

	if (includeLogprobs && node?.tokenLogprobs && node.tokenLogprobs.length > 0) {
		const logprobNote = buildLogprobAnnotation(node.tokenLogprobs, settings);
		if (logprobNote) {
			textContent += '\n\n' + logprobNote;
		}
	}

	return textContent;
}

// ─── buildConversationHistory ────────────────────────────────────────────────
// Converts ordered thread node IDs into the flat prompt history format still
// used by the backend task submission/title generation paths.

export function buildConversationHistory(graph, nodeIds, settings = null) {
	let history = '';

	for (const nodeId of nodeIds) {
		const node = getNode(graph, nodeId);
		if (!node || (node.role !== 'user' && node.role !== 'assistant')) continue;

		const nodeText = node.role === 'assistant'
			? buildAssistantHistoryText(node, settings)
			: buildNodeTextForHistory(node);
		if (!nodeText) continue;

		history += `${node.role === 'user' ? 'User' : 'Assistant'}: ${nodeText}\n\n`;
	}

	return history.trim();
}

function stringifyToolArguments(toolCall) {
	const value = toolCall?.input ?? toolCall?.arguments ?? {};
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return '{}';
	}
}

function deriveToolMessageContent(toolCall) {
	if (toolCall?.modelOutput != null) {
		return String(toolCall.modelOutput);
	}

	const output = toolCall?.output;
	if (typeof output === 'string') {
		return output;
	}
	if (output && typeof output === 'object' && !Array.isArray(output)) {
		if (typeof output.output === 'string') {
			return output.output;
		}
		if (output.output != null) {
			return JSON.stringify(output.output);
		}
		if (typeof output.stdout === 'string' && output.stdout) {
			return output.stdout;
		}
	}
	if (Array.isArray(output)) {
		let text = '';
		for (const item of output) {
			if (item && typeof item === 'object' && item.type === 'text') {
				text += item.text || '';
			}
		}
		if (text) {
			return text;
		}
	}
	if (output == null) {
		return '';
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

function buildAssistantToolTranscript(node) {
	if (!Array.isArray(node?.toolCalls) || node.toolCalls.length === 0) {
		return [];
	}

	const toolCalls = [];
	const toolResults = [];

	for (const toolCall of node.toolCalls) {
		if (!toolCall || typeof toolCall !== 'object') continue;
		const id = String(toolCall.id || '');
		const name = String(toolCall.name || '');
		if (!id || !name) continue;

		toolCalls.push({
			id,
			type: 'function',
			function: {
				name,
				arguments: stringifyToolArguments(toolCall),
			},
		});
		toolResults.push({
			role: 'tool',
			tool_call_id: id,
			content: deriveToolMessageContent(toolCall),
		});
	}

	if (toolCalls.length === 0) {
		return [];
	}

	return [
		{ role: 'assistant', content: null, tool_calls: toolCalls },
		...toolResults,
	];
}

function buildApiMessagesFromNode(node, settings = null) {
	if (!node || (node.role !== 'user' && node.role !== 'assistant')) return [];
	const role = node.role === 'user' ? 'user' : 'assistant';

	if (role === 'assistant') {
		const apiMessages = buildAssistantToolTranscript(node);
		const textContent = buildAssistantApiText(node, settings);
		if (textContent) {
			apiMessages.push({ role, content: textContent });
		}
		return apiMessages;
	}

	if (node.parts && Array.isArray(node.parts)) {
		const textParts = [];
		const contentBlocks = [];
		let hasImages = false;

		for (const part of node.parts) {
			if (part.type === 'text' && part.content) {
				textParts.push(part.content);
			} else if (part.type === 'attachment') {
				if (part.isImage && part.data) {
					hasImages = true;
					contentBlocks.push({ type: 'image_url', image_url: { url: part.data } });
				} else if (!part.isImage && part.data) {
					try {
						const b64Match = part.data.match(/^data:[^;]+;base64,(.+)$/);
						if (b64Match) {
							const chunk = b64Match[1].slice(0, 13336);
							const binary = atob(chunk);
							const bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
							const text = new TextDecoder('utf-8').decode(bytes).slice(0, 10000);
							textParts.push(`\n[File: ${part.name}]\n${text}`);
						}
					} catch (e) { console.warn('[generation] Could not decode file attachment:', e); }
				}
			}
		}

		const combinedText = textParts.join('');
		if (hasImages) {
			if (combinedText) contentBlocks.push({ type: 'text', text: combinedText });
			return [{ role, content: contentBlocks }];
		}
		if (combinedText) {
			return [{ role, content: combinedText }];
		}
		return [];
	}

	if (node.content) {
		return [{ role, content: node.content }];
	}

	return [];
}

export function buildApiMessagesFromNodes(nodes, settings = null) {
	const apiMessages = [];
	for (const node of nodes || []) {
		const messages = buildApiMessagesFromNode(node, settings);
		if (Array.isArray(messages) && messages.length > 0) {
			apiMessages.push(...messages);
		}
	}
	return apiMessages;
}

// ─── buildLogprobAnnotation ──────────────────────────────────────────────────
// Builds a text annotation showing token confidence levels for selected tokens.
// Used to include logprob info in the conversation history for the AI to see.

function buildLogprobAnnotation(tokenLogprobs, settings) {
	// Logprob thresholds (log base 2): -0.32 ≈ 80%, -1.0 ≈ 50%
	const HIGH_THRESHOLD    = -0.32;
	const MEDIUM_THRESHOLD  = -1.0;

	const includeHigh    = settings?.logprobHistoryHigh ?? false;
	const includeMedium  = settings?.logprobHistoryMedium ?? false;
	const includeLow     = settings?.logprobHistoryLow ?? false;

	// If nothing is enabled, skip
	if (!includeHigh && !includeMedium && !includeLow) return null;

	const annotated = [];
	let totalTokens = 0;
	let flaggedTokens = 0;

	for (const { text, logprob } of tokenLogprobs) {
		totalTokens++;
		if (logprob == null || isNaN(logprob)) continue;

		const prob = Math.pow(2, logprob) * 100;
		const pct = Math.round(prob);

		let level = null;
		if (logprob >= HIGH_THRESHOLD)   level = 'HIGH';
		else if (logprob >= MEDIUM_THRESHOLD) level = 'MEDIUM';
		else level = 'LOW';

		if ((level === 'HIGH' && !includeHigh) ||
			(level === 'MEDIUM' && !includeMedium) ||
			(level === 'LOW' && !includeLow)) continue;

		flaggedTokens++;
		annotated.push({ text, level, pct });
	}

	if (annotated.length === 0) return null;

	// Build a structured annotation
	let annotation = `\n<logprob_confidence total_tokens=${totalTokens} flagged=${flaggedTokens}>\n`;
	for (const { text, level, pct } of annotated) {
		// Use angle brackets to avoid markdown conflicts
		const escaped = text.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
		annotation += `[${escaped}](${level}=${pct}%) `;
	}
	annotation += '\n</logprob_confidence>\n';
	return annotation;
}

// ─── buildApiMessages ─────────────────────────────────────────────────────────
// Converts an array of node IDs into structured OpenAI-format messages.
// Returns a multimodal array when any user message contains image attachments.
//
// @param {Object} [settings] - Optional settings object with logprobHistory* flags

export function buildApiMessages(graph, nodeIds, settings = null) {
	return buildApiMessagesFromNodes(
		(nodeIds || []).map((nodeId) => getNode(graph, nodeId)).filter(Boolean),
		settings
	);
}

// ─── parseStreamReasoning ─────────────────────────────────────────────────────
// Extracts content and reasoning from a raw stream text containing <think> blocks.

export function parseStreamReasoning(rawText) {
	let parsedContent  = '';
	let parsedReasoning = '';
	let currentStr = rawText;
	let hasThinkTags = false;
	let isThinkingActive = false;
	let closedThinkBlocks = 0;

	while (true) {
		const startIdx = currentStr.indexOf('<think>');
		if (startIdx === -1) { parsedContent += currentStr; break; }
		hasThinkTags = true;
		parsedContent += currentStr.substring(0, startIdx);
		const endIdx = currentStr.indexOf('</think>', startIdx + 7);
		if (endIdx === -1) {
			parsedReasoning += currentStr.substring(startIdx + 7);
			isThinkingActive = true;
			break;
		}
		parsedReasoning += currentStr.substring(startIdx + 7, endIdx) + '\n\n';
		closedThinkBlocks += 1;
		currentStr = currentStr.substring(endIdx + 8);
	}

	return {
		parsedContent,
		parsedReasoning,
		hasThinkTags,
		isThinkingActive,
		closedThinkBlocks,
	};
}
