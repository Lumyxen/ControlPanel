// www/js/chat/generation.js
// Pure helper functions for building conversation payloads sent to the AI backend.
// These functions have no side-effects and do not touch the DOM.

import { getNode } from './graph.js';

// ─── buildNodeTextForHistory ──────────────────────────────────────────────────
// Converts a single graph node into a flat string for the legacy prompt history.

export function buildNodeTextForHistory(node) {
	if (!node) return '';
	let nodeContent = '';

	if (node.parts && Array.isArray(node.parts)) {
		const textParts = [];
		const attachmentInfos = [];

		for (const part of node.parts) {
			if (part.type === 'text' && part.content) {
				textParts.push(part.content);
			} else if (part.type === 'attachment') {
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

		nodeContent = textParts.join('');
		if (attachmentInfos.length > 0) nodeContent += '\n' + attachmentInfos.join('\n');
	} else if (node.content) {
		nodeContent = node.content;
	}

	if (node.reasoning) nodeContent = `<think>\n${node.reasoning}\n</think>\n\n` + nodeContent;

	// Fix: was `Array.isArray(node.toolCalls && node.toolCalls.length > 0)` which always returned false
	if (node.toolCalls && Array.isArray(node.toolCalls) && node.toolCalls.length > 0) {
		let toolsText = '';
		for (const tc of node.toolCalls) {
			const inputStr = typeof tc.input === 'object' ? JSON.stringify(tc.input) : String(tc.input || '');
			toolsText += `\n[Tool Execution: ${tc.name}]\nInput: ${inputStr}\nOutput: ${tc.output || ''}\n`;
		}
		nodeContent += toolsText;
	}

	return nodeContent;
}

// ─── buildApiMessages ─────────────────────────────────────────────────────────
// Converts an array of node IDs into structured OpenAI-format messages.
// Returns a multimodal array when any user message contains image attachments.

export function buildApiMessages(graph, nodeIds) {
	const apiMessages = [];

	for (const nodeId of nodeIds) {
		const node = getNode(graph, nodeId);
		if (!node) continue;
		const role = node.role === 'user' ? 'user' : 'assistant';

		if (role === 'assistant') {
			const textContent = buildNodeTextForHistory(node);
			if (textContent) apiMessages.push({ role, content: textContent });
			continue;
		}

		// User messages: may contain image attachments → multimodal content blocks
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
				apiMessages.push({ role, content: contentBlocks });
			} else if (combinedText) {
				apiMessages.push({ role, content: combinedText });
			}
		} else if (node.content) {
			apiMessages.push({ role, content: node.content });
		}
	}

	return apiMessages;
}

// ─── parseStreamReasoning ─────────────────────────────────────────────────────
// Extracts content and reasoning from a raw stream text containing <think> blocks.

export function parseStreamReasoning(rawText) {
	let parsedContent  = '';
	let parsedReasoning = '';
	let currentStr = rawText;

	while (true) {
		const startIdx = currentStr.indexOf('<think>');
		if (startIdx === -1) { parsedContent += currentStr; break; }
		parsedContent += currentStr.substring(0, startIdx);
		const endIdx = currentStr.indexOf('</think>', startIdx + 7);
		if (endIdx === -1) { parsedReasoning += currentStr.substring(startIdx + 7); break; }
		parsedReasoning += currentStr.substring(startIdx + 7, endIdx) + '\n\n';
		currentStr = currentStr.substring(endIdx + 8);
	}

	return { parsedContent, parsedReasoning };
}
