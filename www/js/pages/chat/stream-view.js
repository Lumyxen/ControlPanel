import { parseStreamReasoning } from './payloads.js';
import { buildReasoningElement } from './thread-view.js';
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

export function createStreamingMessageController({
	typingEl,
	getSettings,
	onLiveNodeChange = () => {},
	afterRender = () => {},
}) {
	let rawStreamText = '';
	let officialReasoningText = '';
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
			activeToolCalls[index] = { ...activeToolCalls[index], ...toolCall };
		}
	};

	const getDisplayState = () => {
		const {
			parsedContent,
			parsedReasoning,
			hasThinkTags,
			isThinkingActive,
			closedThinkBlocks,
		} = parseStreamReasoning(rawStreamText);
		let displayReasoning = officialReasoningText;
		if (parsedReasoning) {
			displayReasoning += (displayReasoning ? '\n\n' : '') + parsedReasoning.trim();
		}
		return {
			parsedContent,
			parsedReasoning,
			displayReasoning,
			hasThinkTags,
			isThinkingActive,
			closedThinkBlocks,
		};
	};

	const emitLiveNode = () => {
		onLiveNodeChange({
			role: 'assistant',
			content: rawStreamText,
			reasoning: officialReasoningText,
			reasoningParts: cloneReasoningParts(reasoningParts),
			toolCalls: cloneToolCalls(activeToolCalls),
		});
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
			currentContentEl.replaceWith(nextContentEl);
		} else if (currentContentEl) {
			currentContentEl.remove();
		} else if (nextContentEl) {
			reasoningEl.appendChild(nextContentEl);
		}
	};

	const renderReasoning = (content, displayState) => {
		const { displayReasoning, parsedReasoning } = displayState;
		const nextReasoningEl = buildReasoningElement({
			reasoning: displayReasoning,
			reasoningParts: parsedReasoning ? null : reasoningParts,
			toolCalls: activeToolCalls,
			open: reasoningOpen,
			summaryText: reasoningSummaryText,
		});
		const existingReasoningEl = content.querySelector('.message-reasoning');
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

	const renderText = (content, parsedContent) => {
		let textEl = content.querySelector('.chat-message-text');
		if (!parsedContent) {
			textEl?.remove();
			return;
		}

		if (!textEl) {
			textEl = document.createElement('div');
			textEl.className = 'chat-message-text';
			content.appendChild(textEl);
		}

		renderMessageTextInto(textEl, parsedContent);
		if (tokenLogprobs.length > 0) {
			applyTokenHighlighting(textEl, tokenLogprobs, getSettings());
		}
	};

	const renderDom = () => {
		const content = ensureMessageContent();
		const displayState = getDisplayState();
		renderReasoning(content, displayState);
		const { parsedContent } = displayState;
		renderText(content, parsedContent);
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
			return;
		}

		if (chunk.type === 'retract') {
			rawStreamText = '';
			officialReasoningText = '';
			reasoningParts = [];
			tokenLogprobs = [];
			reasoningOpen = true;
			reasoningSummaryText = 'Thinking...';
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			reasoningUserToggledDuringGeneration = false;
			pendingReasoningUserToggle = false;
			emitLiveNode();
			renderDom();
			return;
		}

		if ((chunk.type === 'tool_execution' || chunk.type === 'tool_event') && chunk.tool_call) {
			chunkHasLiveReasoning = true;
			const nextToolCall = {
				...chunk.tool_call,
				input: chunk.tool_call.input ?? chunk.tool_call.arguments ?? null,
			};
			upsertToolCall(nextToolCall);
			upsertReasoningToolPart(reasoningParts, nextToolCall);
		}

		if (chunk.choices?.[0]?.delta) {
			const delta = chunk.choices[0].delta;
			if (delta.reasoning) {
				chunkHasLiveReasoning = true;
				officialReasoningText += delta.reasoning;
				appendReasoningTextPart(reasoningParts, delta.reasoning);
			}
			if (delta.content) {
				const contentText = String(delta.content);
				if (contentText.includes('<think>')) {
					chunkHasLiveReasoning = true;
				} else if (reasoningPhaseActive) {
					chunkStartedMainOutput = true;
				}
				rawStreamText += contentText;
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
			reasoningParts.length > 0 ||
			activeToolCalls.length > 0;
		const visibleOutputStarted =
			String(nextDisplayState.parsedContent ?? '').length > 0 &&
			hasVisibleReasoning &&
			reasoningSummaryText === 'Thinking...';
		if (shouldStartReasoningPhase) {
			startReasoningPhase();
		}
		if (closedThinkingThisChunk || mainOutputStartedThisChunk || visibleOutputStarted) {
			closeReasoningPhase();
		}

		emitLiveNode();
		renderDom();
	};

	const processPendingChunks = (flushAll = false) => {
		const batchSize = flushAll ? pendingChunks.length : Math.min(5, pendingChunks.length);
		for (let i = 0; i < batchSize; i++) {
			const chunk = pendingChunks.shift();
			if (!chunk) break;
			applyChunk(chunk);
		}

		if (pendingChunks.length > 0 && !flushAll) {
			requestAnimationFrame(() => processPendingChunks(false));
		} else {
			isProcessingChunks = false;
		}
	};

	return {
		queueChunk(chunk) {
			pendingChunks.push(chunk);
			if (isProcessingChunks) return;
			isProcessingChunks = true;
			processPendingChunks(false);
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
			reasoningPhaseActive = false;
			reasoningPhaseUserToggled = false;
			pendingReasoningUserToggle = false;
			renderDom();
		},
		getState() {
			return {
				rawStreamText,
				officialReasoningText,
				reasoningParts: cloneReasoningParts(reasoningParts),
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
		buildFinalResult() {
			const { parsedContent, parsedReasoning, displayReasoning } = getDisplayState();
			let finalContent = parsedContent.trim();
			const finalReasoning = displayReasoning.trim();
			if (errorFromStream) {
				finalContent += finalContent
					? `\n\n**Error:** ${errorFromStream}`
					: `**Error:** ${errorFromStream}`;
			}
			return {
				finalContent,
				finalReasoning,
				finalReasoningParts: parsedReasoning ? [] : cloneReasoningParts(reasoningParts),
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
	};
}
