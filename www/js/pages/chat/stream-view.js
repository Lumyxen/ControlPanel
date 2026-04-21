import { parseStreamReasoning } from './payloads.js';
import { buildToolCallElement } from './thread-view.js';
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
	let activeToolCalls = [];
	let tokenLogprobs = [];
	let errorFromStream = null;
	let pendingChunks = [];
	let isProcessingChunks = false;

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
		const { parsedContent, parsedReasoning } = parseStreamReasoning(rawStreamText);
		let displayReasoning = officialReasoningText;
		if (parsedReasoning) {
			displayReasoning += (displayReasoning ? '\n\n' : '') + parsedReasoning.trim();
		}
		return { parsedContent, displayReasoning };
	};

	const emitLiveNode = () => {
		onLiveNodeChange({
			role: 'assistant',
			content: rawStreamText,
			reasoning: officialReasoningText,
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

	const renderReasoning = (content, displayReasoning) => {
		let reasoningEl = content.querySelector('.message-reasoning');
		if (!displayReasoning) {
			reasoningEl?.remove();
			return;
		}

		if (!reasoningEl) {
			reasoningEl = document.createElement('details');
			reasoningEl.className = 'message-reasoning';
			reasoningEl.open = true;
			reasoningEl.innerHTML = '<summary>Thinking...</summary><div class="reasoning-content"></div>';
			content.insertBefore(reasoningEl, content.firstChild);
		}

		const reasoningContent = reasoningEl.querySelector('.reasoning-content');
		if (reasoningContent) reasoningContent.textContent = displayReasoning;
	};

	const renderToolCalls = (content) => {
		content.querySelectorAll('.message-tool-call').forEach((el) => el.remove());
		if (activeToolCalls.length === 0) return;

		const textEl = content.querySelector('.chat-message-text');
		for (const toolCall of activeToolCalls) {
			const toolEl = buildToolCallElement(toolCall);
			toolEl.dataset.toolCallId = toolCall.id;
			textEl ? content.insertBefore(toolEl, textEl) : content.appendChild(toolEl);
		}
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
		const { parsedContent, displayReasoning } = getDisplayState();
		renderReasoning(content, displayReasoning);
		renderText(content, parsedContent);
		renderToolCalls(content);
		afterRender();
	};

	const applyChunk = (chunk) => {
		if (chunk.error) {
			errorFromStream = typeof chunk.error === 'object'
				? (chunk.error.message || JSON.stringify(chunk.error))
				: String(chunk.error);
			return;
		}

		if (chunk.type === 'retract') {
			rawStreamText = '';
			officialReasoningText = '';
			tokenLogprobs = [];
			emitLiveNode();
			renderDom();
			return;
		}

		if ((chunk.type === 'tool_execution' || chunk.type === 'tool_event') && chunk.tool_call) {
			const nextToolCall = {
				...chunk.tool_call,
				input: chunk.tool_call.input ?? chunk.tool_call.arguments ?? null,
			};
			upsertToolCall(nextToolCall);
		}

		if (chunk.choices?.[0]?.delta) {
			const delta = chunk.choices[0].delta;
			if (delta.reasoning) officialReasoningText += delta.reasoning;
			if (delta.content) {
				rawStreamText += delta.content;
				if (delta.logprob != null) {
					tokenLogprobs.push({ text: delta.content, logprob: delta.logprob });
				}
			}
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
			const reasoningEl = typingEl.querySelector('.message-reasoning');
			if (!reasoningEl) return;
			reasoningEl.open = false;
			const summary = reasoningEl.querySelector('summary');
			if (summary) summary.textContent = 'Thinking';
		},
		getState() {
			return {
				rawStreamText,
				officialReasoningText,
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
		buildFinalResult() {
			const { parsedContent, displayReasoning } = getDisplayState();
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
				activeToolCalls: cloneToolCalls(activeToolCalls),
				tokenLogprobs: cloneTokenLogprobs(tokenLogprobs),
				errorFromStream,
			};
		},
	};
}
