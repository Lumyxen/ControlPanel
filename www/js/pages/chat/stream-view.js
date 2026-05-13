import { parseStreamReasoningParts } from './payloads.js';
import { buildReasoningElement, buildRevisionTraceElement, buildToolCallElement, buildToolCallsElement } from './thread-view.js';
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

function cloneRevisionTrace(trace) {
	if (!trace || typeof trace !== 'object') return null;
	try {
		return JSON.parse(JSON.stringify(trace));
	} catch {
		return { ...trace };
	}
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

function hasVisibleOutput(displayState) {
	return String(displayState?.parsedContent ?? '').length > 0;
}

export function shouldAutoOpenReasoningPhase({
	previousDisplayState = null,
	nextDisplayState = null,
	chunkHasLiveReasoning = false,
	reasoningPhaseActive = false,
	visibleOutputHasStarted = false,
} = {}) {
	const visibleOutputAlreadyStarted =
		visibleOutputHasStarted || hasVisibleOutput(previousDisplayState);
	if (visibleOutputAlreadyStarted) return false;

	const startedThinkingThisChunk =
		!previousDisplayState?.isThinkingActive && Boolean(nextDisplayState?.isThinkingActive);
	return startedThinkingThisChunk ||
		(!nextDisplayState?.hasThinkTags && chunkHasLiveReasoning && !reasoningPhaseActive);
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
	let revisionTrace = null;
	let errorFromStream = null;
	let pendingChunks = [];
	let isProcessingChunks = false;
	let reasoningOpen = true;
	let reasoningSummaryText = 'Thinking...';
	let reasoningPhaseActive = false;
	let reasoningPhaseUserToggled = false;
	let pendingReasoningUserToggle = false;
	let visibleOutputHasStarted = false;
	let finalTokenHighlightingEnabled = false;
	let pointerSelectingInMessage = false;
	let processingScheduled = false;
	let revisionTimerId = null;
	let revisionTimerEnabled = true;

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

	const isDraftEditorToolCall = (toolCall) => {
		if (!toolCall || typeof toolCall !== 'object') return false;
		const packId = String(toolCall.packId || '');
		const canonicalId = String(toolCall.canonicalId || '');
		const name = String(toolCall.name || '');
		return packId === 'draft_editor' ||
			canonicalId.startsWith('draft_editor/') ||
			name.startsWith('draft_editor__');
	};

	const stopRevisionTimer = () => {
		if (revisionTimerId) {
			clearInterval(revisionTimerId);
			revisionTimerId = null;
		}
	};

	const ensureRevisionTrace = (startedAt = Date.now()) => {
		if (!revisionTrace || typeof revisionTrace !== 'object') {
			const started = Number(startedAt);
			revisionTrace = {
				mode: 'live_revision',
				startedAt: Number.isFinite(started) && started > 0 ? started : Date.now(),
				events: [],
				issues: [],
				stage: 'draft',
			};
		}
		if (!Array.isArray(revisionTrace.events)) revisionTrace.events = [];
		if (!Array.isArray(revisionTrace.issues)) revisionTrace.issues = [];
		return revisionTrace;
	};

	const upsertRevisionIssue = (issue) => {
		if (!issue || typeof issue !== 'object') return;
		const trace = ensureRevisionTrace();
		const issueId = String(issue.id || '');
		if (issueId) {
			const existing = trace.issues.findIndex((candidate) => String(candidate?.id || '') === issueId);
			if (existing !== -1) {
				trace.issues[existing] = { ...issue };
				return;
			}
		}
		trace.issues.push({ ...issue });
	};

	const applyDraftEditorOutput = (toolCall) => {
		const output = toolCall?.output;
		if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
		const operation = String(output.operation || '');
		if (!operation || operation === 'draft_error') return false;

		const timestamp = Number(output.timestamp || Date.now());
		const trace = ensureRevisionTrace(timestamp);
		if (typeof output.mode === 'string' && output.mode) {
			trace.mode = output.mode;
		}
		trace.updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
		trace.stage = String(output.stage || 'draft');
		trace.committed = Boolean(output.final);
		if (typeof output.content === 'string') {
			trace.currentDraft = output.content;
			if (output.final) trace.finalContent = output.content;
		}
		if (typeof output.change_summary === 'string') {
			trace.changeSummary = output.change_summary;
		} else if (output.final && typeof output.summary === 'string') {
			trace.changeSummary = output.summary;
		}
		if (output.issue && typeof output.issue === 'object') {
			upsertRevisionIssue(output.issue);
		} else if (Array.isArray(output.issues)) {
			output.issues.forEach(upsertRevisionIssue);
		}

		const event = {
			operation,
			stage: String(output.stage || 'draft'),
			timestamp: trace.updatedAt,
		};
		if (output.event_id) event.id = String(output.event_id);
		if (typeof output.summary === 'string') event.summary = output.summary;
		if (typeof output.change_summary === 'string') event.changeSummary = output.change_summary;
		if (Array.isArray(output.patch)) event.patch = cloneRevisionTrace(output.patch);
		if (output.issue?.id) event.issueId = String(output.issue.id);
		if (event.id) {
			const existingIndex = trace.events.findIndex((candidate) => String(candidate?.id || '') === event.id);
			if (existingIndex !== -1) {
				trace.events[existingIndex] = event;
				return true;
			}
		}
		trace.events.push(event);
		return true;
	};

	const applyRevisionModelOutput = (event) => {
		if (!event || typeof event !== 'object') return false;
		const phaseId = String(event.phase_id || event.phaseId || event.id || '');
		if (!phaseId) return false;

		const timestamp = Number(event.timestamp || Date.now());
		const trace = ensureRevisionTrace(timestamp);
		if (typeof event.mode === 'string' && event.mode) {
			trace.mode = event.mode;
		}
		if (!Array.isArray(trace.modelOutputs)) trace.modelOutputs = [];

		let phase = trace.modelOutputs.find((candidate) => String(candidate?.id || '') === phaseId);
		if (!phase) {
			phase = {
				id: phaseId,
				stage: String(event.stage || 'draft'),
				label: String(event.label || 'Model output'),
				status: String(event.status || 'streaming'),
				content: '',
				reasoning: '',
				startedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
			};
			trace.modelOutputs.push(phase);
		}
		if (!Array.isArray(phase.toolCalls)) phase.toolCalls = [];

		if (event.stage) {
			phase.stage = String(event.stage);
			trace.stage = phase.stage;
		}
		if (event.label) phase.label = String(event.label);
		if (event.status) {
			phase.status = String(event.status);
			if (phase.status === 'completed') {
				phase.completedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
			}
		}
		if (typeof event.delta === 'string') {
			phase.content = String(phase.content || '') + event.delta;
		}
		if (typeof event.reasoning_delta === 'string') {
			phase.reasoning = String(phase.reasoning || '') + event.reasoning_delta;
		}
		if (event.tool_call && typeof event.tool_call === 'object') {
			const nextToolCall = {
				...event.tool_call,
				input: event.tool_call.input ?? event.tool_call.arguments ?? null,
			};
			const toolCallId = String(nextToolCall.id || '');
			const index = toolCallId
				? phase.toolCalls.findIndex((candidate) => String(candidate?.id || '') === toolCallId)
				: -1;
			if (index === -1) {
				phase.toolCalls.push(nextToolCall);
			} else {
				phase.toolCalls[index] = { ...phase.toolCalls[index], ...nextToolCall };
			}
		}
		phase.updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
		trace.updatedAt = phase.updatedAt;
		return true;
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
		if (revisionTrace) {
			liveNode.revisionTrace = cloneRevisionTrace(revisionTrace);
		}
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
		const isCurrentReasoningElement = () => reasoningEl.dataset.streamCurrentReasoning === 'true';
		const summaryEl = reasoningEl.querySelector('summary');
		summaryEl?.addEventListener('click', () => {
			if (isCurrentReasoningElement()) pendingReasoningUserToggle = true;
		});
		summaryEl?.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				if (isCurrentReasoningElement()) pendingReasoningUserToggle = true;
			}
		});
		reasoningEl.addEventListener('toggle', () => {
			if (!isCurrentReasoningElement()) {
				pendingReasoningUserToggle = false;
				return;
			}
			reasoningOpen = reasoningEl.open;
			if (pendingReasoningUserToggle) {
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
		reasoningEl.dataset.streamCurrentReasoning = 'true';
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
		if (nextReasoningEl) {
			nextReasoningEl.dataset.streamCurrentReasoning = 'true';
		}
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
		const revisionEl = content.querySelector(':scope > .message-revision-trace');
		content.insertBefore(nextReasoningEl, revisionEl?.nextSibling || content.firstChild);
	};

	const renderRevisionTrace = (content) => {
		const existing = content.querySelector(':scope > .message-revision-trace');
		const nextRevisionEl = buildRevisionTraceElement(revisionTrace, { live: true });
		if (!nextRevisionEl) {
			existing?.remove();
			return;
		}
		if (existing) {
			morphNode(existing, nextRevisionEl);
			return;
		}
		content.insertBefore(nextRevisionEl, content.firstChild);
	};

	const syncRevisionTimer = () => {
		if (!revisionTimerEnabled || !revisionTrace || revisionTrace.committed) {
			stopRevisionTimer();
			return;
		}
		if (revisionTimerId) return;
		revisionTimerId = setInterval(() => {
			if (!revisionTimerEnabled || !revisionTrace || revisionTrace.committed) {
				stopRevisionTimer();
				return;
			}
			const content = typingEl.querySelector('.chat-message-content');
			if (!content) return;
			renderRevisionTrace(content);
			afterRender();
		}, 1000);
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
				const isCurrentReasoning = index === lastReasoningIndex;
				const isActiveReasoning = (displayState.isThinkingActive || reasoningPhaseActive) && isCurrentReasoning;
				const reasoningEl = buildReasoningElement({
					reasoning: part.content,
					reasoningParts: part.reasoningParts,
					toolCalls: activeToolCalls,
					open: isCurrentReasoning ? reasoningOpen : false,
					summaryText: isActiveReasoning ? reasoningSummaryText : 'Thinking',
				});
				if (reasoningEl) {
					if (isCurrentReasoning) reasoningEl.dataset.streamCurrentReasoning = 'true';
					nextFlowEl.appendChild(reasoningEl);
				}
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
		const currentReasoningEl = flowEl.querySelector(':scope > .message-reasoning[data-stream-current-reasoning="true"]');
		if (currentReasoningEl) {
			bindReasoningElement(currentReasoningEl);
			if (currentReasoningEl.open !== reasoningOpen) {
				currentReasoningEl.open = reasoningOpen;
			}
		}
	};

	const renderDom = () => {
		const content = ensureMessageContent();
		const displayState = getDisplayState();
		renderRevisionTrace(content);
		renderReasoning(content, displayState);
		renderToolCalls(content, displayState);
		if (displayState.hasInlineReasoning) {
			renderInlineParts(content, displayState);
		} else {
			content.querySelector(':scope > .chat-message-inline-flow')?.remove();
			const committedRevisionContent = revisionTrace?.committed && revisionTrace?.finalContent
				? String(revisionTrace.finalContent)
				: '';
			renderText(content, displayState.parsedContent || committedRevisionContent);
		}
		syncRevisionTimer();
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
			revisionTrace = null;
			stopRevisionTimer();
			revisionTimerEnabled = true;
			reasoningOpen = true;
			reasoningSummaryText = 'Thinking...';
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			pendingReasoningUserToggle = false;
			visibleOutputHasStarted = false;
			finalTokenHighlightingEnabled = false;
			return true;
		}

		if (chunk.type === 'revision_model_output') {
			return applyRevisionModelOutput(chunk);
		}

		if ((chunk.type === 'tool_execution' || chunk.type === 'tool_event') && chunk.tool_call) {
			if (isDraftEditorToolCall(chunk.tool_call)) {
				return applyDraftEditorOutput(chunk.tool_call);
			}
			if (revisionTrace?.mode === 'live_revision') {
				return true;
			}
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
		const shouldStartReasoningPhase = shouldAutoOpenReasoningPhase({
			previousDisplayState,
			nextDisplayState,
			chunkHasLiveReasoning,
			reasoningPhaseActive,
			visibleOutputHasStarted,
		});
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
		if (hasVisibleOutput(nextDisplayState)) {
			visibleOutputHasStarted = true;
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
			revisionTimerEnabled = false;
			stopRevisionTimer();
			// Open state is settled when the reasoning phase ends, not when generation ends.
			finalTokenHighlightingEnabled = true;
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			pendingReasoningUserToggle = false;
			renderDom();
		},
		dispose() {
			revisionTimerEnabled = false;
			stopRevisionTimer();
		},
		getState() {
			return {
				rawStreamText,
				officialReasoningText,
				streamParts: cloneMessageParts(streamParts),
				reasoningParts: cloneReasoningParts(reasoningParts),
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				revisionTrace: cloneRevisionTrace(revisionTrace),
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
			const finalRevisionTrace = cloneRevisionTrace(revisionTrace);
			if (!finalContent && finalRevisionTrace?.finalContent) {
				finalContent = String(finalRevisionTrace.finalContent).trim();
			}
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
				finalRevisionTrace,
				errorFromStream,
			};
		},
	};
}
