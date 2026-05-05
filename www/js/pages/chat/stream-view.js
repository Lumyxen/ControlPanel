import { parseStreamReasoningParts } from './payloads.js';
import { buildReasoningElement, buildToolCallElement, buildToolCallsElement } from './thread-view.js';
import {
	appendReasoningTextPart,
	cloneReasoningParts,
	upsertReasoningToolPart,
} from './reasoning-parts.js';
import { applyTokenHighlighting } from '../../render/token-highlighting.js';
import { renderMessageTextInto } from '../../render/message.js';

function cloneToolCalls(toolCalls) {
	return toolCalls.map((toolCall) => ({ ...toolCall }));
}

function cloneTokenLogprobs(tokenLogprobs) {
	return tokenLogprobs.map((entry) => ({ ...entry }));
}

function cloneMessageParts(parts) {
	if (!Array.isArray(parts)) return [];
	return parts
		.map((part) => {
			if (part?.type === 'text') {
				return { type: 'text', content: String(part.content ?? '') };
			}
			if (part?.type === 'reasoning') {
				const nextPart = { type: 'reasoning', content: String(part.content ?? '') };
				const reasoningParts = cloneReasoningParts(part.reasoningParts);
				if (reasoningParts.length > 0) nextPart.reasoningParts = reasoningParts;
				return nextPart;
			}
			if (part?.type === 'tool_call') {
				return cloneReasoningParts([part])[0] || null;
			}
			return null;
		})
		.filter(Boolean);
}

function hasReasoningPart(parts) {
	return Array.isArray(parts) && parts.some((part) => part?.type === 'reasoning');
}

function appendMessagePart(parts, type, text) {
	if (type === 'tool_call') {
		const toolPart = cloneReasoningParts([{ type: 'tool_call', ...(text || {}) }])[0];
		if (!toolPart) return;
		const toolCallId = String(toolPart.toolCallId ?? toolPart.toolCall?.id ?? '');
		if (toolCallId) {
			const existingPart = parts.find((part) =>
				part?.type === 'tool_call' && String(part.toolCallId ?? part.toolCall?.id ?? '') === toolCallId);
			if (existingPart) {
				existingPart.toolCallId = toolCallId;
				existingPart.toolCall = toolPart.toolCall;
				return;
			}
		}
		parts.push(toolPart);
		return;
	}

	const value = String(text ?? '');
	if (!value) return;
	const lastPart = parts[parts.length - 1];
	if ((type === 'text' || type === 'reasoning') && lastPart?.type === type) {
		lastPart.content += value;
		return;
	}
	parts.push({ type, content: value });
}

function appendTextMessagePart(parts, text) {
	appendMessagePart(parts, 'text', text);
}

function appendReasoningMessagePart(parts, text) {
	appendMessagePart(parts, 'reasoning', text);
}

function getTopReasoningParts(reasoningParts, hasInlineReasoning) {
	const clonedParts = cloneReasoningParts(reasoningParts);
	return hasInlineReasoning ? [] : clonedParts;
}

function getInlineReferencedReasoningParts(inlineParts) {
	const referencedParts = [];
	for (const part of cloneMessageParts(inlineParts)) {
		if (part?.type === 'tool_call') {
			referencedParts.push(part);
			continue;
		}
		if (part?.type !== 'reasoning') continue;
		for (const reasoningPart of cloneReasoningParts(part.reasoningParts)) {
			if (reasoningPart?.type === 'tool_call') referencedParts.push(reasoningPart);
		}
	}
	return referencedParts;
}

function isTerminalToolStatus(status) {
	return ['completed', 'failed', 'denied', 'cancelled'].includes(String(status || '').toLowerCase());
}

const STREAM_RENDER_BATCH_SIZE = 24;
const PRESERVED_RENDER_ATTRIBUTES = new Set([
	'data-render-source',
	'data-streaming-bound',
	'data-token-highlight-signature',
	'data-token-tooltip-bound',
]);

function nextFrame(callback) {
	const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
	return raf(callback);
}

function getElementKey(node) {
	if (!node || node.nodeType !== 1) return '';
	return node.getAttribute('data-tool-call-id') ||
		node.getAttribute('data-stream-key') ||
		'';
}

function canMorphNode(currentNode, nextNode) {
	if (!currentNode || !nextNode || currentNode.nodeType !== nextNode.nodeType) return false;
	if (currentNode.nodeType === 3) return true;
	if (currentNode.nodeType !== 1) return false;
	return currentNode.nodeName === nextNode.nodeName &&
		currentNode.namespaceURI === nextNode.namespaceURI;
}

function syncTextNode(currentNode, nextNode) {
	const currentText = currentNode.nodeValue || '';
	const nextText = nextNode.nodeValue || '';
	if (currentText === nextText) return;
	if (nextText.startsWith(currentText) && typeof currentNode.appendData === 'function') {
		currentNode.appendData(nextText.slice(currentText.length));
		return;
	}
	currentNode.nodeValue = nextText;
}

function shouldPreserveAttribute(element, name) {
	if (PRESERVED_RENDER_ATTRIBUTES.has(name)) return true;
	return element.nodeName === 'DETAILS' && name === 'open';
}

function syncAttributes(target, source) {
	if (!target || !source || target.nodeType !== 1 || source.nodeType !== 1) return;
	for (const attr of [...target.attributes]) {
		if (shouldPreserveAttribute(target, attr.name)) continue;
		if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
	}
	for (const attr of [...source.attributes]) {
		if (shouldPreserveAttribute(target, attr.name)) continue;
		if (target.getAttribute(attr.name) !== attr.value) {
			target.setAttribute(attr.name, attr.value);
		}
	}
}

function findKeyedChild(parent, key, beforeNode) {
	if (!key) return null;
	for (let node = beforeNode; node; node = node.nextSibling) {
		if (getElementKey(node) === key) return node;
	}
	return null;
}

function morphChildren(target, source) {
	let currentChild = target.firstChild;
	let nextChild = source.firstChild;
	while (nextChild) {
		const followingNextChild = nextChild.nextSibling;
		const nextKey = getElementKey(nextChild);
		let childToMorph = currentChild;
		if (nextKey && getElementKey(childToMorph) !== nextKey) {
			childToMorph = findKeyedChild(target, nextKey, currentChild?.nextSibling || null);
		}

		if (childToMorph && canMorphNode(childToMorph, nextChild)) {
			if (childToMorph !== currentChild) {
				target.insertBefore(childToMorph, currentChild);
			}
			morphNode(childToMorph, nextChild);
			currentChild = childToMorph.nextSibling;
		} else {
			const inserted = nextChild.cloneNode(true);
			target.insertBefore(inserted, currentChild || null);
			currentChild = inserted.nextSibling;
		}
		nextChild = followingNextChild;
	}

	while (currentChild) {
		const nextCurrentChild = currentChild.nextSibling;
		currentChild.remove();
		currentChild = nextCurrentChild;
	}
}

function morphNode(target, source) {
	if (!canMorphNode(target, source)) {
		target.replaceWith(source.cloneNode(true));
		return;
	}
	if (target.nodeType === 3) {
		syncTextNode(target, source);
		return;
	}
	if (target.nodeType !== 1) return;
	syncAttributes(target, source);
	morphChildren(target, source);
}

function renderMessageTextStable(target, text) {
	const sourceText = String(text ?? '');
	if (target.dataset.renderSource === sourceText) return false;
	const nextEl = document.createElement(target.tagName.toLowerCase());
	nextEl.className = target.className;
	renderMessageTextInto(nextEl, sourceText);
	morphChildren(target, nextEl);
	target.dataset.renderSource = sourceText;
	delete target.dataset.tokenHighlightSignature;
	return true;
}

function selectionIntersectsElement(element) {
	if (typeof window === 'undefined') return false;
	const selection = window.getSelection?.();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
	for (let index = 0; index < selection.rangeCount; index++) {
		const range = selection.getRangeAt(index);
		if (!element.contains(range.commonAncestorContainer) && range.intersectsNode) {
			try {
				if (!range.intersectsNode(element)) continue;
			} catch {
				continue;
			}
		}
		return true;
	}
	return false;
}

function getTokenHighlightSettingsSignature(settings) {
	return [
		settings?.logprobHighlightHigh ?? false,
		settings?.logprobHighlightMedium ?? false,
		settings?.logprobHighlightLow ?? true,
	].join(':');
}

export function createStreamingMessageController({
	typingEl,
	getSettings,
	onLiveNodeChange = () => {},
	afterRender = () => {},
}) {
	let rawStreamText = '';
	let officialReasoningText = '';
	let streamParts = [];
	let reasoningParts = [];
	let activeToolCalls = [];
	let tokenLogprobs = [];
	let errorFromStream = null;
	let pendingChunks = [];
	let isProcessingChunks = false;
	let reasoningOpen = true;
	let reasoningSummaryText = 'Thinking...';
	let reasoningPhaseActive = false;
	let reasoningPhaseUserToggled = false;
	let reasoningUserToggledDuringGeneration = false;
	let pendingReasoningUserToggle = false;
	let finalTokenHighlightingEnabled = false;
	let pointerSelectingInMessage = false;
	let processingScheduled = false;

	const clearPointerSelectionFlag = () => {
		setTimeout(() => {
			pointerSelectingInMessage = false;
		}, 120);
	};
	typingEl.addEventListener('pointerdown', (event) => {
		const isElementTarget = typeof Element === 'undefined' || event.target instanceof Element;
		if (isElementTarget && event.target && typingEl.contains(event.target)) {
			pointerSelectingInMessage = true;
			const ownerDocument = typingEl.ownerDocument || document;
			ownerDocument.addEventListener('pointerup', clearPointerSelectionFlag, { once: true });
			ownerDocument.addEventListener('pointercancel', clearPointerSelectionFlag, { once: true });
		}
	}, { passive: true });

	const upsertToolCall = (toolCall) => {
		if (!toolCall || typeof toolCall !== 'object') return;
		const id = toolCall.id || '';
		if (!id) {
			activeToolCalls.push({ ...toolCall });
			return;
		}

		const index = activeToolCalls.findIndex((existing) => existing.id === id);
		if (index === -1) {
			activeToolCalls.push({ ...toolCall });
		} else {
			const merged = { ...activeToolCalls[index], ...toolCall };
			if (toolCall.approval == null && isTerminalToolStatus(toolCall.status)) {
				delete merged.approval;
			}
			activeToolCalls[index] = merged;
		}
	};

	const getDisplayState = () => {
		const {
			parsedContent,
			parsedReasoning,
			parts,
			hasThinkTags,
			isThinkingActive,
			closedThinkBlocks,
		} = parseStreamReasoningParts(streamParts);
		const hasInlineReasoning = hasReasoningPart(parts);
		const displayReasoning = parsedReasoning ? parsedReasoning.trim() : officialReasoningText;
		const topReasoning = hasInlineReasoning ? '' : displayReasoning;
		return {
			parsedContent,
			parsedReasoning,
			displayReasoning,
			topReasoning,
			inlineParts: cloneMessageParts(parts),
			hasInlineReasoning,
			hasThinkTags,
			isThinkingActive,
			closedThinkBlocks,
		};
	};

	const emitLiveNode = () => {
		const { parsedContent, displayReasoning, inlineParts, hasInlineReasoning } = getDisplayState();
		const liveNode = {
			role: 'assistant',
			content: parsedContent,
			reasoning: displayReasoning,
			reasoningParts: cloneReasoningParts(reasoningParts),
			toolCalls: cloneToolCalls(activeToolCalls),
		};
		if (hasInlineReasoning) {
			liveNode.parts = inlineParts;
		}
		onLiveNodeChange(liveNode);
	};

	const ensureMessageContent = () => {
		if (!typingEl.querySelector('.chat-message-content')) {
			typingEl.innerHTML = '';
			typingEl.className = 'chat-message assistant';
		}

		let content = typingEl.querySelector('.chat-message-content');
		if (!content) {
			content = document.createElement('div');
			content.className = 'chat-message-content';
			typingEl.appendChild(content);
		}
		return content;
	};

	const bindReasoningElement = (reasoningEl) => {
		if (!reasoningEl || reasoningEl.dataset.streamingBound === 'true') return;
		const summaryEl = reasoningEl.querySelector('summary');
		summaryEl?.addEventListener('click', () => {
			pendingReasoningUserToggle = true;
		});
		summaryEl?.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				pendingReasoningUserToggle = true;
			}
		});
		reasoningEl.addEventListener('toggle', () => {
			reasoningOpen = reasoningEl.open;
			if (pendingReasoningUserToggle) {
				reasoningUserToggledDuringGeneration = true;
				if (reasoningPhaseActive) {
					reasoningPhaseUserToggled = true;
				}
			}
			pendingReasoningUserToggle = false;
		});
		reasoningEl.dataset.streamingBound = 'true';
	};

	const syncReasoningElement = (reasoningEl, nextReasoningEl) => {
		if (!reasoningEl || !nextReasoningEl) return;
		const currentSummaryEl = reasoningEl.querySelector('summary');
		const nextSummaryEl = nextReasoningEl.querySelector('summary');
		if (currentSummaryEl && nextSummaryEl) {
			currentSummaryEl.textContent = nextSummaryEl.textContent;
		}

		if (reasoningEl.open !== reasoningOpen) {
			reasoningEl.open = reasoningOpen;
		}

		const currentContentEl = reasoningEl.querySelector('.reasoning-content');
		const nextContentEl = nextReasoningEl.querySelector('.reasoning-content');
		if (currentContentEl && nextContentEl) {
			morphNode(currentContentEl, nextContentEl);
		} else if (currentContentEl) {
			currentContentEl.remove();
		} else if (nextContentEl) {
			reasoningEl.appendChild(nextContentEl);
		}
	};

	const renderReasoning = (content, displayState) => {
		if (displayState.hasInlineReasoning) {
			content.querySelector(':scope > .message-reasoning')?.remove();
			return;
		}

		const nextReasoningEl = buildReasoningElement({
			reasoning: displayState.topReasoning,
			reasoningParts: getTopReasoningParts(reasoningParts, displayState.hasInlineReasoning),
			toolCalls: activeToolCalls,
			open: reasoningOpen,
			summaryText: reasoningSummaryText,
		});
		const existingReasoningEl = content.querySelector(':scope > .message-reasoning');
		if (!nextReasoningEl) {
			existingReasoningEl?.remove();
			return;
		}
		if (existingReasoningEl) {
			bindReasoningElement(existingReasoningEl);
			syncReasoningElement(existingReasoningEl, nextReasoningEl);
			return;
		}
		bindReasoningElement(nextReasoningEl);
		content.insertBefore(nextReasoningEl, content.firstChild);
	};

	const renderToolCalls = (content, displayState) => {
		const referencedReasoningParts = displayState.hasInlineReasoning
			? getInlineReferencedReasoningParts(displayState.inlineParts)
			: getTopReasoningParts(reasoningParts, false);
		const nextToolCallsEl = buildToolCallsElement({
			reasoning: displayState.topReasoning,
			reasoningParts: referencedReasoningParts,
			toolCalls: activeToolCalls,
		});
		const existingToolCallsEl = content.querySelector(':scope > .message-tool-calls');
		if (!nextToolCallsEl) {
			existingToolCallsEl?.remove();
			return;
		}
		if (existingToolCallsEl) {
			morphNode(existingToolCallsEl, nextToolCallsEl);
			return;
		}

		const textEl = content.querySelector(':scope > .chat-message-text, :scope > .chat-message-inline-flow');
		if (textEl) {
			content.insertBefore(nextToolCallsEl, textEl);
			return;
		}
		content.appendChild(nextToolCallsEl);
	};

	const renderText = (content, parsedContent) => {
		let textEl = content.querySelector(':scope > .chat-message-text');
		if (!parsedContent) {
			textEl?.remove();
			return;
		}

		if (!textEl) {
			textEl = document.createElement('div');
			textEl.className = 'chat-message-text';
			content.appendChild(textEl);
		}

		renderMessageTextStable(textEl, parsedContent);
		if (finalTokenHighlightingEnabled && tokenLogprobs.length > 0) {
			const settings = getSettings();
			const signature = [
				textEl.dataset.renderSource || '',
				tokenLogprobs.length,
				getTokenHighlightSettingsSignature(settings),
			].join('::');
			if (!pointerSelectingInMessage &&
				!selectionIntersectsElement(textEl) &&
				textEl.dataset.tokenHighlightSignature !== signature) {
				applyTokenHighlighting(textEl, tokenLogprobs, settings);
				textEl.dataset.tokenHighlightSignature = signature;
			}
		}
	};

	const renderInlineParts = (content, displayState) => {
		content.querySelector(':scope > .chat-message-text')?.remove();
		let flowEl = content.querySelector(':scope > .chat-message-inline-flow');
		if (!flowEl) {
			flowEl = document.createElement('div');
			flowEl.className = 'chat-message-inline-flow';
			content.appendChild(flowEl);
		}
		const nextFlowEl = document.createElement('div');
		nextFlowEl.className = 'chat-message-inline-flow';

		const lastReasoningIndex = displayState.inlineParts.reduce(
			(lastIndex, part, index) => part.type === 'reasoning' ? index : lastIndex,
			-1,
		);
		for (let index = 0; index < displayState.inlineParts.length; index++) {
			const part = displayState.inlineParts[index];
			if (part.type === 'text' && part.content) {
				const textEl = document.createElement('div');
				textEl.className = 'chat-message-text';
				renderMessageTextInto(textEl, part.content);
				textEl.dataset.renderSource = String(part.content ?? '');
				nextFlowEl.appendChild(textEl);
				continue;
			}
			if (part.type === 'reasoning' && (part.content || cloneReasoningParts(part.reasoningParts).length > 0)) {
				const isActiveReasoning = (displayState.isThinkingActive || reasoningPhaseActive) && index === lastReasoningIndex;
				const reasoningEl = buildReasoningElement({
					reasoning: part.content,
					reasoningParts: part.reasoningParts,
					toolCalls: activeToolCalls,
					open: isActiveReasoning ? reasoningOpen : false,
					summaryText: isActiveReasoning ? reasoningSummaryText : 'Thinking',
				});
				if (reasoningEl) nextFlowEl.appendChild(reasoningEl);
				continue;
			}
			if (part.type === 'tool_call') {
				const toolCallPart = cloneReasoningParts([part])[0];
				const toolCallId = String(toolCallPart?.toolCallId ?? toolCallPart?.toolCall?.id ?? '');
				const toolCall = (toolCallId && activeToolCalls.find((candidate) =>
					String(candidate?.id ?? '') === toolCallId)) || toolCallPart?.toolCall;
				if (toolCall) nextFlowEl.appendChild(buildToolCallElement(toolCall));
			}
		}

		if (nextFlowEl.children.length === 0) {
			flowEl.remove();
			return;
		}
		morphNode(flowEl, nextFlowEl);
	};

	const renderDom = () => {
		const content = ensureMessageContent();
		const displayState = getDisplayState();
		renderReasoning(content, displayState);
		renderToolCalls(content, displayState);
		if (displayState.hasInlineReasoning) {
			renderInlineParts(content, displayState);
		} else {
			content.querySelector(':scope > .chat-message-inline-flow')?.remove();
			renderText(content, displayState.parsedContent);
		}
		afterRender();
	};

	const closeReasoningPhase = () => {
		reasoningPhaseActive = false;
		reasoningSummaryText = 'Thinking';
		if (!reasoningPhaseUserToggled) {
			reasoningOpen = false;
		}
		reasoningPhaseUserToggled = false;
	};

	const startReasoningPhase = () => {
		reasoningPhaseActive = true;
		reasoningPhaseUserToggled = false;
		pendingReasoningUserToggle = false;
		reasoningOpen = true;
		reasoningSummaryText = 'Thinking...';
	};

	const applyChunk = (chunk) => {
		const previousDisplayState = getDisplayState();
		let chunkHasLiveReasoning = false;
		let chunkStartedMainOutput = false;

		if (chunk.error) {
			errorFromStream = typeof chunk.error === 'object'
				? (chunk.error.message || JSON.stringify(chunk.error))
				: String(chunk.error);
			return true;
		}

		if (chunk.type === 'retract') {
			rawStreamText = '';
			officialReasoningText = '';
			streamParts = [];
			reasoningParts = [];
			activeToolCalls = [];
			tokenLogprobs = [];
			reasoningOpen = true;
			reasoningSummaryText = 'Thinking...';
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			reasoningUserToggledDuringGeneration = false;
			pendingReasoningUserToggle = false;
			finalTokenHighlightingEnabled = false;
			return true;
		}

		if ((chunk.type === 'tool_execution' || chunk.type === 'tool_event') && chunk.tool_call) {
			chunkHasLiveReasoning = true;
			const nextToolCall = {
				...chunk.tool_call,
				input: chunk.tool_call.input ?? chunk.tool_call.arguments ?? null,
			};
			upsertToolCall(nextToolCall);
			upsertReasoningToolPart(reasoningParts, nextToolCall);
			appendMessagePart(streamParts, 'tool_call', { toolCallId: nextToolCall.id, toolCall: nextToolCall });
		}

		if (chunk.choices?.[0]?.delta) {
			const delta = chunk.choices[0].delta;
			if (delta.reasoning) {
				chunkHasLiveReasoning = true;
				officialReasoningText += delta.reasoning;
				appendReasoningTextPart(reasoningParts, delta.reasoning);
				appendReasoningMessagePart(streamParts, delta.reasoning);
			}
			if (delta.content) {
				const contentText = String(delta.content);
				if (contentText.toLowerCase().includes('<think>') ||
					contentText.toLowerCase().includes('<thinking>') ||
					contentText.toLowerCase().includes('<reasoning>') ||
					contentText.toLowerCase().includes('<thought>')) {
					chunkHasLiveReasoning = true;
				} else if (reasoningPhaseActive) {
					chunkStartedMainOutput = true;
				}
				rawStreamText += contentText;
				appendTextMessagePart(streamParts, contentText);
				if (delta.logprob != null) {
					tokenLogprobs.push({ text: contentText, logprob: delta.logprob });
				}
			}
		}

		const nextDisplayState = getDisplayState();
		const startedThinkingThisChunk =
			!previousDisplayState.isThinkingActive && nextDisplayState.isThinkingActive;
		const shouldStartReasoningPhase =
			startedThinkingThisChunk ||
			(!nextDisplayState.hasThinkTags && chunkHasLiveReasoning && !reasoningPhaseActive);
		const closedThinkingThisChunk =
			nextDisplayState.closedThinkBlocks > previousDisplayState.closedThinkBlocks;
		const mainOutputStartedThisChunk =
			chunkStartedMainOutput &&
			!nextDisplayState.hasThinkTags &&
			(reasoningPhaseActive || shouldStartReasoningPhase);
		const hasVisibleReasoning =
			Boolean(nextDisplayState.displayReasoning) ||
			reasoningParts.length > 0;
		const visibleOutputStarted =
			!nextDisplayState.isThinkingActive &&
			String(nextDisplayState.parsedContent ?? '').length > 0 &&
			hasVisibleReasoning &&
			reasoningSummaryText === 'Thinking...';
		if (shouldStartReasoningPhase) {
			startReasoningPhase();
		}
		if (closedThinkingThisChunk || mainOutputStartedThisChunk || visibleOutputStarted) {
			closeReasoningPhase();
		}

		return true;
	};

	const processPendingChunks = (flushAll = false) => {
		const batchSize = flushAll ? pendingChunks.length : Math.min(STREAM_RENDER_BATCH_SIZE, pendingChunks.length);
		let shouldRender = false;
		for (let i = 0; i < batchSize; i++) {
			const chunk = pendingChunks.shift();
			if (!chunk) break;
			shouldRender = applyChunk(chunk) || shouldRender;
		}

		if (shouldRender) {
			emitLiveNode();
			renderDom();
		}

		if (pendingChunks.length > 0 && !flushAll) {
			processingScheduled = true;
			nextFrame(() => {
				processingScheduled = false;
				processPendingChunks(false);
			});
		} else {
			isProcessingChunks = false;
		}
	};

	const schedulePendingChunks = () => {
		if (processingScheduled) return;
		processingScheduled = true;
		nextFrame(() => {
			processingScheduled = false;
			processPendingChunks(false);
		});
	};

	return {
		queueChunk(chunk) {
			pendingChunks.push(chunk);
			if (isProcessingChunks) return;
			isProcessingChunks = true;
			schedulePendingChunks();
		},
		flushAllPending() {
			if (pendingChunks.length === 0) return;
			isProcessingChunks = true;
			processPendingChunks(true);
		},
		renderNow() {
			renderDom();
		},
		closeReasoning() {
			reasoningSummaryText = 'Thinking';
			if (!reasoningUserToggledDuringGeneration) {
				reasoningOpen = false;
			}
			finalTokenHighlightingEnabled = true;
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			pendingReasoningUserToggle = false;
			renderDom();
		},
		getState() {
			return {
				rawStreamText,
				officialReasoningText,
				streamParts: cloneMessageParts(streamParts),
				reasoningParts: cloneReasoningParts(reasoningParts),
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
		buildFinalResult() {
			const {
				parsedContent,
				parsedReasoning,
				displayReasoning,
				inlineParts,
				hasInlineReasoning,
			} = getDisplayState();
			let finalContent = parsedContent.trim();
			const finalReasoning = displayReasoning.trim();
			const finalParts = hasInlineReasoning ? cloneMessageParts(inlineParts) : [];
			const finalReasoningParts = cloneReasoningParts(reasoningParts);
			const hasReasoningTextPart = finalReasoningParts.some((part) => part.type === 'text' && part.content);
			if (!hasInlineReasoning && parsedReasoning && finalReasoning && !hasReasoningTextPart) {
				finalReasoningParts.unshift({ type: 'text', content: finalReasoning });
			}
			if (errorFromStream) {
				finalContent += finalContent
					? `\n\n**Error:** ${errorFromStream}`
					: `**Error:** ${errorFromStream}`;
				if (hasInlineReasoning) {
					appendTextMessagePart(finalParts, finalParts.length > 0
						? `\n\n**Error:** ${errorFromStream}`
						: `**Error:** ${errorFromStream}`);
				}
			}
			return {
				finalContent,
				finalReasoning,
				finalReasoningParts,
				finalParts,
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
	};
}
