// www/js/chat/chat-page.js
// Top-level initialiser for the AI chat page.
// Wires together the toolbar, generation loop, message action handlers,
// and the copy/clipboard override — but delegates all the heavy lifting.

import {
	branchFromNode, computeThreadNodeIds, createSiblingCopy,
	deleteSubtree, ensureGraph, getNode, recomputeLeafId,
	setSelectedChildId, spliceDeleteNode,
} from './graph.js';
import {
	addChildMessageToChat, addMessageToChat, createNewChat,
	ensureChatLoaded, getChatById, getCurrentChatId, getChatToolScope, isChatLoaded,
	loadChats, saveChats, setChatModel, setCurrentChatId,
} from './repository.js';
import { renderChatList } from './sidebar-list.js';
import { updateContextUI, getModelMaxTokens, getModelContextLimitFromUI, estimateNodeTokens, estimatePartsTokens, estimateTokensForText } from './context.js';
import { renderThread, showTyping, patchMessageEditState, getSiblingNavState, createActionButton } from './thread-view.js';
import { InlineAttachmentManager } from './attachments.js';
import {
	submitGenerationTask,
	streamTask,
	getTaskByChat,
	cancelTask,
	generateAiTitle,
	approveToolApproval,
	denyToolApproval,
} from '../../core/http.js';
import * as SettingsStore from '../../services/settings.js';
import { initDropdowns, initTools, loadAndPopulateModels } from './model-picker.js';
import { initUpload, initAutoResize } from './composer.js';
import { buildNodeTextForHistory, buildApiMessages, buildConversationHistory } from './payloads.js';
import { buildPartsWithUpdatedText, getNodeTextContent } from './message-parts.js';
import { createStreamingMessageController } from './stream-view.js';
import { htmlToMarkdown } from './clipboard.js';
import { createChatSessionState } from './session.js';

let chatPageAbort = null;

// ── AI Title Generation (reusable) ────────────────────────────────────────────
async function triggerAiTitleGeneration(root, chatId, onStateChange, preferredModel = '') {
	const chat = getChatById(chatId);
	if (!chat || chat.title !== "New Chat") return;
	const graph = ensureGraph(chat);
	const threadIds = computeThreadNodeIds(graph);

	// Only on first message (exactly 1 user message)
	const userCount = threadIds.reduce((count, nodeId) => {
		const node = getNode(graph, nodeId);
		return count + (node?.role === 'user' ? 1 : 0);
	}, 0);
	if (userCount !== 1) return;

	const settings = await SettingsStore.init();
	if (settings?.aiTitleEnabled === false) return;

	const modelSelect = root?.querySelector?.('[data-dropdown="model"] .chat-dropdown-item.selected');
	const currentModel = preferredModel || chat.model || modelSelect?.dataset?.value || '';
	const titleModel = settings?.aiTitleModel || currentModel;
	if (!titleModel) return;

	const conversationText = buildConversationHistory(graph, threadIds);
	if (!conversationText.trim()) return;

	if (onStateChange) onStateChange(true);
	try {
		const data = await generateAiTitle({
			message: conversationText,
			model: titleModel,
			title_system_prompt: settings?.aiTitleSystemPrompt || '',
		});

		if (!data?.title) return;

		await loadChats();
		const refreshedChat = getChatById(chatId);
		if (!refreshedChat || refreshedChat.title !== "New Chat") return;

		const { renameChat } = await import('./repository.js');
		renameChat(chatId, data.title);
		renderChatList();
	} catch (err) {
		console.error('[ChatPage] AI title generation failed:', err);
	} finally {
		if (onStateChange) onStateChange(false);
	}
}

function ensureChatExists(setActiveCallback) {
	if (!getCurrentChatId() || !getChatById(getCurrentChatId())) {
		createNewChat(); renderChatList(); setActiveCallback?.();
	}
}

export function loadCurrentChat(setActiveCallback) {
	(async () => {
		const messages = document.getElementById('chatMessages');
		const empty = document.getElementById('chatEmpty');
		if (!messages) return;
		await SettingsStore.init();
		const activeChatId = getCurrentChatId();
		const chat = activeChatId ? await ensureChatLoaded(activeChatId) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const hasMessages = Boolean(graph && computeThreadNodeIds(graph).length > 0);
		if (empty) empty.hidden = hasMessages;
		if (chat) renderThread(messages, chat, { editingNodeId: null, editingDraft: '' }, SettingsStore.get());
		else messages.querySelectorAll('.chat-message, .chat-typing').forEach((el) => el.remove());
		document.querySelector('.chat-page')?._syncToolPackPicker?.();
		renderChatList();
		setActiveCallback?.();
	})().catch((err) => {
		console.error('[ChatPage] Failed to load current chat:', err);
	});
}

async function initChatPage(root, currentRouteGetter, setActiveCallback) {
	if (!root) return;
	chatPageAbort?.abort();
	const controller = new AbortController();
	chatPageAbort = controller;
	const { signal } = controller;

	const form     = root.querySelector('#chatForm');
	const input    = root.querySelector('#chatInput');
	const messages = root.querySelector('#chatMessages');
	const empty    = root.querySelector('#chatEmpty');
	if (!form || !input || !messages) return;
	await SettingsStore.init();

	const attachmentManager = new InlineAttachmentManager(input);

	const uiState = createChatSessionState();

	const contentEl = messages.closest('.content') || messages;
	const scrollToBottomBtn = root.querySelector('#scrollToBottomBtn');

	let lastScrollTop = contentEl.scrollTop;
	const checkScroll = () => {
		if (!scrollToBottomBtn) return;
		const currentScrollTop = contentEl.scrollTop;
		const scrollBottom = contentEl.scrollHeight - currentScrollTop - contentEl.clientHeight;
		
		if (scrollBottom <= 10) {
			uiState.isScrolledUp = false;
		} else if (currentScrollTop < lastScrollTop) {
			uiState.isScrolledUp = true;
		}
		
		lastScrollTop = currentScrollTop;
		
		if (uiState.isScrolledUp) {
			scrollToBottomBtn.classList.add('visible');
		} else {
			scrollToBottomBtn.classList.remove('visible');
		}
	};

	contentEl.addEventListener('scroll', checkScroll, { signal });
	window.addEventListener('resize', () => {
		if (!uiState.isScrolledUp) {
			contentEl.scrollTop = contentEl.scrollHeight;
		}
		checkScroll();
	}, { signal });

	if (scrollToBottomBtn) {
		scrollToBottomBtn.addEventListener('click', () => {
			contentEl.scrollTo({
				top: contentEl.scrollHeight,
				behavior: 'smooth'
			});
		}, { signal });
	}

	const updateLiveContext = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		let extra = 0;
		const parts = attachmentManager.extractParts();
		if (parts?.length > 0) extra += estimatePartsTokens(parts);
		// Account for system prompt from global settings
		const settings = SettingsStore.get();
		if (settings?.systemPrompt) {
			extra += estimateTokensForText(settings.systemPrompt);
		}
		if (uiState.isGenerating && uiState.liveGeneratingNode) extra += estimateNodeTokens(uiState.liveGeneratingNode);
		if (uiState.editingNodeId && chat) {
			const node = getNode(ensureGraph(chat), uiState.editingNodeId);
			if (node) {
				extra -= estimateNodeTokens(node);
				const draftParts = buildPartsWithUpdatedText(node, uiState.editingDraft);
				extra += estimatePartsTokens(draftParts);
			}
		}
		updateContextUI(root, chat, Math.max(0, extra));
	};
	root._updateLiveContext = updateLiveContext;

	loadAndPopulateModels(root, signal).catch((err) => {
		console.error('Failed to populate models:', err);
	});
	initDropdowns(root, signal);
	initTools(root, signal);
	initUpload(root, input, attachmentManager, signal);
	const resizeInput = initAutoResize(input, signal);
	input.addEventListener('input', updateLiveContext, { signal });
	// Show initial context UI (includes system prompt tokens)
	updateLiveContext();
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			// Block during generation — no canceling
			if (uiState.isGenerating) return;
			// Debounce: prevent rapid-fire duplicate submissions
			if (uiState.isSubmitting) return;
			if (e.shiftKey) form.dataset.sendNoReply = '1';
			form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
		}
	}, { signal });

	const urlParams = new URLSearchParams(location.hash.split('?')[1] || '');
	const chatIdFromUrl = urlParams.get('chat');
	if (chatIdFromUrl && getChatById(chatIdFromUrl)) { setCurrentChatId(chatIdFromUrl); }
	if (getCurrentChatId()) {
		try {
			await ensureChatLoaded(getCurrentChatId());
		} catch (err) {
			console.error('[ChatPage] Failed to load chat:', err);
		}
	}

	const rerender = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat || !isChatLoaded(chat)) {
			messages.querySelectorAll('.chat-message, .chat-typing').forEach(el => el.remove());
			if (empty) empty.hidden = false;
			root._syncToolPackPicker?.();
			updateLiveContext();
			return;
		}
		renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
		if (empty) empty.hidden = computeThreadNodeIds(ensureGraph(chat)).length > 0;
		root._syncToolPackPicker?.();
		updateLiveContext();
	};

	const unsubscribeSettings = SettingsStore.subscribe(() => {
		if (signal.aborted) return;
		if (uiState.isGenerating || uiState.isSubmitting) return;
		rerender();
	});
	signal.addEventListener('abort', unsubscribeSettings, { once: true });

	const setGeneratingState = (gen) => {
		uiState.isGenerating = gen;
		if (!gen) uiState.liveGeneratingNode = null;
		const btn = form.querySelector('.chat-send-btn');
		if (!btn) return;
		if (gen) {
			btn.classList.add('generating');
			btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-icon lucide-square" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>`;
			btn.title = 'Stop generating'; btn.setAttribute('aria-label', 'Stop generating');
		} else {
			btn.classList.remove('generating');
			btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-send-horizontal-icon lucide-send-horizontal" aria-hidden="true"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/></svg>`;
			btn.title = 'Send'; btn.setAttribute('aria-label', 'Send message');
		}
	};

	const createTaskId = () => {
		const uuid = globalThis.crypto?.randomUUID?.();
		if (uuid) return `task_${uuid}`;
		return `task_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
	};

	const createStreamController = (typingEl) => createStreamingMessageController({
		typingEl,
		getSettings: () => SettingsStore.get(),
		onLiveNodeChange: (node) => {
			uiState.liveGeneratingNode = node;
			updateLiveContext();
		},
		afterRender: () => {
			if (!uiState.isScrolledUp) contentEl.scrollTop = contentEl.scrollHeight;
			else checkScroll();
		},
	});

	const getAbortReason = (signalLike) => {
		if (!signalLike) return '';
		if (typeof signalLike.ctrlpanelReason === 'string' && signalLike.ctrlpanelReason) return signalLike.ctrlpanelReason;
		if (typeof signalLike.reason === 'string' && signalLike.reason) return signalLike.reason;
		return '';
	};

	const abortStreamController = (controllerToAbort, reason) => {
		if (!controllerToAbort?.signal || controllerToAbort.signal.aborted) return;
		controllerToAbort.signal.ctrlpanelReason = reason;
		controllerToAbort.abort(reason);
	};

	const detachFromRunningTask = () => {
		uiState.flushResponse = null;
		if (uiState.typingTimeout) {
			clearTimeout(uiState.typingTimeout);
			uiState.typingTimeout = null;
		}
		abortStreamController(uiState.streamAbort, 'detach');
		uiState.streamAbort = null;
		uiState.activeTaskId = null;
		uiState.liveGeneratingNode = null;
		uiState.typingEl = null;
		setGeneratingState(false);
	};

	const requestTaskCancellation = async ({ unload = false, abortStream = true, discardPartial = true } = {}) => {
		const taskId = uiState.activeTaskId;
		if (discardPartial) {
			uiState.flushResponse = null;
		}
		if (abortStream) abortStreamController(uiState.streamAbort, 'cancel-requested');
		if (!taskId) return false;
		try {
			await cancelTask(taskId, { unload });
			return true;
		} catch (err) {
			if (!unload) {
				console.error('[ChatPage] Failed to cancel task:', err);
			}
			return false;
		}
	};

	const stopTyping = (preserveElement = false) => {
		if (uiState.flushResponse)  { uiState.flushResponse(); uiState.flushResponse = null; }
		if (uiState.streamAbort)    { uiState.streamAbort.abort(); uiState.streamAbort = null; }
		if (uiState.typingTimeout)  { clearTimeout(uiState.typingTimeout); uiState.typingTimeout = null; }
		if (uiState.typingEl) {
			if (!preserveElement) {
				uiState.typingEl.remove();
				uiState.typingEl = null;
			}
			// When preserveElement is true, keep uiState.typingEl so finalizeGeneratedMessage can use it
		}
		setGeneratingState(false);
	};

	/**
	 * Smoothly finalize the preserved typing element into a proper message.
	 * Finds the newly generated node in the graph and patches the element
	 * with the correct node ID and menu, avoiding a full re-render flicker.
	 */
	const finalizeGeneratedMessage = () => {
		const preservedEl = uiState.typingEl;
		if (!preservedEl) return null;

		const chatId = getCurrentChatId();
		const chat = getChatById(chatId);
		if (!chat) return null;

		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);
		// The generated node is the last assistant node in the thread
		let generatedNode = null;
		for (let i = threadIds.length - 1; i >= 0; i--) {
			const node = getNode(graph, threadIds[i]);
			if (node && node.role === 'assistant') {
				generatedNode = node;
				break;
			}
		}
		if (!generatedNode) return null;

		// Patch the element with proper attributes
		preservedEl.dataset.nodeId = generatedNode.id;

		// Add the message menu
		const nav = getSiblingNavState(graph, generatedNode.id);
		const canResend = Boolean(generatedNode.parentId) && generatedNode.role !== 'system';
		const menu = document.createElement('div');
		menu.className = 'chat-message-menu';
		menu.setAttribute('role', 'toolbar');
		menu.setAttribute('aria-label', 'Message actions');
		menu.append(
			createActionButton({ action: 'branch-back',    label: 'Previous thread',                           title: 'Previous thread',                          iconName: 'chev-left',  disabled: !nav.canBack }),
			createActionButton({ action: 'branch-forward', label: 'Next thread',                               title: 'Next thread',                              iconName: 'chev-right', disabled: !nav.canForward }),
			createActionButton({ action: 'thread',         label: 'Create new thread from this message',       title: 'New thread',                               iconName: 'branch' }),
			createActionButton({ action: 'edit',           label: 'Edit message',                              title: 'Edit',                                     iconName: 'edit' }),
			createActionButton({ action: 'resend',         label: 'Regenerate from here',                      title: 'Regenerate',                               iconName: 'refresh',    disabled: !canResend }),
			createActionButton({ action: 'delete',         label: 'Delete message',                            title: 'Delete (shift+click to delete only this)', iconName: 'trash' }),
			createActionButton({ action: 'copy',           label: 'Copy raw message',                          title: 'Copy',                                     iconName: 'copy' })
		);
		preservedEl.appendChild(menu);

		// Clear the reference so stopTyping doesn't try to remove it
		uiState.typingEl = null;
		return preservedEl;
	};

	signal.addEventListener('abort', detachFromRunningTask);

	const startReply = async (replyChatId, parentUserNodeId) => {
		stopTyping();
		uiState.typingEl = showTyping(messages);
		checkScroll();
		setGeneratingState(true);

		const activeChatId    = replyChatId;
		uiState.streamAbort   = new AbortController();
		const currentSignal   = uiState.streamAbort.signal;
		let taskId            = createTaskId();
		uiState.activeTaskId  = taskId;

		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value || '';
		if (activeChatId && model) setChatModel(activeChatId, model);

		let maxTokens      = getModelMaxTokens(model);
		const contextLimit = getModelContextLimitFromUI(root);
		const chat  = getChatById(activeChatId);
		if (!chat) { stopTyping(); return; }
		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);

		const settings = SettingsStore.get();
		let conversationHistory = buildConversationHistory(graph, threadIds, settings);
		if (!conversationHistory.trim() && parentUserNodeId) {
			const pn = getNode(graph, parentUserNodeId);
			if (pn) conversationHistory = buildNodeTextForHistory(pn) || 'Hello';
		}
		if (!conversationHistory.trim()) conversationHistory = 'Hello';

		let apiMessages = buildApiMessages(graph, threadIds, settings);
		if (apiMessages.length === 0 && parentUserNodeId) apiMessages = buildApiMessages(graph, [parentUserNodeId], settings);
		const hasVision = apiMessages.some(m => Array.isArray(m.content));
		const visionMessages = hasVision ? apiMessages : null;

		const estimatedPromptTokens = Math.ceil(conversationHistory.length / 3) + 200;
		if (estimatedPromptTokens + maxTokens > contextLimit) maxTokens = Math.max(256, contextLimit - estimatedPromptTokens);

		const streamController = createStreamController(uiState.typingEl);
		let isSaved = false;

		let systemPrompt = SettingsStore.get()?.systemPrompt || '';
		let temperature = SettingsStore.get()?.temperature ?? 1.0;

		if (hasVision) {
			const hint = '[System Override: You have native multimodal vision capabilities. The user has attached an image. Analyze the visual data directly.]';
			systemPrompt = systemPrompt ? systemPrompt + '\n\n' + hint : hint;
		}

		uiState.flushResponse = () => {
			if (isSaved) return;
			isSaved = true;
			const {
				finalContent,
				finalReasoning,
				finalReasoningParts,
				activeToolCalls,
				tokenLogprobs,
				errorFromStream,
			} = streamController.buildFinalResult();
			if (finalContent || finalReasoning || activeToolCalls.length > 0) {
				const node = addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', finalContent);
				if (node) {
					if (finalReasoning)             node.reasoning  = finalReasoning;
					if (finalReasoningParts.length > 0) node.reasoningParts = finalReasoningParts;
					if (activeToolCalls.length > 0) node.toolCalls  = activeToolCalls;
					if (tokenLogprobs.length > 0) {
						node.tokenLogprobs = tokenLogprobs;
					}
					// Don't saveChats() — the backend saves independently via
					// appendAssistantMessage. We only update the local graph for
					// immediate display; on next reload, loadChats() gets the truth.
				}
			} else if (errorFromStream) {
				addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', `**Error:** ${errorFromStream}`);
			}
			uiState.liveGeneratingNode = null;
			uiState.activeTaskId = null;
		};
		const chunkHandler = (chunk) => {
			if (currentSignal.aborted) return;
			streamController.queueChunk(chunk);
		};

		// ── Submit the generation task to the backend ─────────────────────────
		const toolScope = getChatToolScope(activeChatId);
		const hasExplicitToolPacks = Array.isArray(toolScope?.enabledPackIds) && toolScope.enabledPackIds.length > 0;
		const taskPayload = {
			task_id: taskId,
			model, prompt: conversationHistory, max_tokens: maxTokens,
			system_prompt: systemPrompt, temperature, context_window: contextLimit,
			logprobs: !hasExplicitToolPacks,
			chat_id: activeChatId,
			parent_user_node_id: parentUserNodeId || '',
			tool_scope: toolScope,
		};
		if (visionMessages) taskPayload.messages = visionMessages;

		try {
			const submitResult = await submitGenerationTask(taskPayload, { signal: currentSignal });
			if (submitResult?.task_id) {
				taskId = submitResult.task_id;
			}
			uiState.activeTaskId = taskId;

			if (currentSignal.aborted) {
				const abortReason = getAbortReason(currentSignal);
				if (abortReason !== 'detach' && abortReason !== 'cancel-requested') {
					await cancelTask(taskId).catch(() => {});
				}
				throw new DOMException('Aborted', 'AbortError');
			}

			// ── Stream chunks from the task ─────────────────────────────────
			await streamTask(taskId, 0, chunkHandler, currentSignal, () => {
				streamController.flushAllPending();
				streamController.closeReasoning();
				setGeneratingState(false);
			});

			const streamState = streamController.getState();
			const {
				rawStreamText,
				officialReasoningText,
				activeToolCalls,
				errorFromStream,
			} = streamState;
			if (errorFromStream) throw new Error(errorFromStream);
			if (!rawStreamText && !officialReasoningText && activeToolCalls.length === 0) {
				stopTyping();
				setGeneratingState(false);
				rerender();
				renderChatList();
				setActiveCallback?.();
				return;
			}

			streamController.renderNow();
			streamController.closeReasoning();
			stopTyping(true);
			// Reload from backend (source of truth) instead of using stale local state
			await loadChats();
			await ensureChatLoaded(activeChatId, { force: true });
			// Smoothly finalize the preserved element with proper node ID and menu
			const finalized = finalizeGeneratedMessage();
			if (!finalized) {
				// Fallback to full re-render if we couldn't finalize
				rerender();
			}
			renderChatList();
			setActiveCallback?.();
		} catch (err) {
			if (err.name === 'AbortError') {
				uiState.flushResponse = null;
				if (getAbortReason(currentSignal) === 'detach') {
					return;
				}
				stopTyping();
				rerender();
				renderChatList();
				setActiveCallback?.();
				return;
			}
			console.error('[ChatPage] Stream error:', err);
			uiState.flushResponse = null;
			stopTyping();
			if (activeChatId && parentUserNodeId) {
				const errorText = err?.message ? `**Error:** ${err.message}` : '**Error:** Generation failed';
				addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', errorText);
			}
			rerender();
			renderChatList();
			setActiveCallback?.();
		} finally {
			if (uiState.activeTaskId === taskId) uiState.activeTaskId = null;
			if (uiState.streamAbort?.signal === currentSignal) uiState.streamAbort = null;
		}
	};

	// ── Reconnect: check backend for any running/completed task on this chat ──
	const reconnectCheck = async () => {
		const chatId = getCurrentChatId();
		if (!chatId) return;

		const shouldSkipReconnect = () => {
			if (signal.aborted) return true;
			if (getCurrentChatId() !== chatId) return true;
			// This page is already starting or streaming a task locally, so do not
			// attach a second EventSource to the same chat generation.
			if (uiState.isSubmitting || uiState.isGenerating) return true;
			if (uiState.activeTaskId || uiState.streamAbort) return true;
			return false;
		};

		if (shouldSkipReconnect()) return;

		try {
			const task = await getTaskByChat(chatId);
			if (shouldSkipReconnect()) return;
			if (!task || task.error) return;

			if (task.status === 'completed') {
				// Backend already saved the result — just reload chats
				await loadChats();
				const chat = await ensureChatLoaded(chatId, { force: true });
				if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
				renderChatList();
				setActiveCallback?.();
				return;
			}

			if (task.status === 'running' || task.status === 'pending') {
				const reconnectAbort = new AbortController();
				uiState.activeTaskId = task.id;
				uiState.streamAbort = reconnectAbort;
				const currentSignal = reconnectAbort.signal;

				// Don't render existing messages — just show the typing indicator.
				// The streamTask will replay ALL chunks from the backend, rebuilding
				// the full content. On completion, reload from the backend (the source
				// of truth) instead of saving frontend state to it.
				const typingEl = showTyping(messages);
				uiState.typingEl = typingEl;
				// No flushResponse — backend already saved the result independently.
				// Do NOT call saveChats() — it would overwrite the backend truth.
				const streamController = createStreamController(typingEl);
				const chunkHandler = (chunk) => {
					if (currentSignal.aborted) return;
					streamController.queueChunk(chunk);
				};

				setGeneratingState(true);
				checkScroll();

				try {
					await streamTask(task.id, 0, chunkHandler, currentSignal, () => {
						streamController.flushAllPending();
						streamController.closeReasoning();
						setGeneratingState(false);
					});

					const { errorFromStream } = streamController.getState();
					if (errorFromStream) throw new Error(errorFromStream);
					// Reload from backend (source of truth) — don't save frontend state
					await loadChats();
					const chat = await ensureChatLoaded(chatId, { force: true });
					if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
					renderChatList();
					setActiveCallback?.();
				} catch (e) {
					if (e.name === 'AbortError' && getAbortReason(currentSignal) === 'detach') {
						return;
					}
					if (e.name !== 'AbortError') console.error('[ChatPage] Reconnect stream error:', e);
					await loadChats();
					const chat = await ensureChatLoaded(chatId, { force: true });
					if (chat) renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft }, SettingsStore.get());
					renderChatList();
					setActiveCallback?.();
				} finally {
					if (uiState.activeTaskId === task.id) uiState.activeTaskId = null;
					if (uiState.streamAbort === reconnectAbort) uiState.streamAbort = null;
				}
			}
		} catch (e) {
			// ignore
		}
	};

	// Delay reconnect to let the page fully settle and avoid EventSource interruption during navigation
	requestAnimationFrame(() => {
		requestAnimationFrame(reconnectCheck);
	});

	document.addEventListener('keydown', (e) => {
		if ((e.key === 'Escape' || e.key === 'Esc') && uiState.editingNodeId) {
			e.preventDefault();
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null;
			rerender();
		}
	}, { capture: true, signal });

	document.addEventListener('keyup', (e) => {
		if ((e.key === 'Escape' || e.key === 'Esc') && uiState.editingNodeId) {
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null;
			rerender();
		}
	}, { signal });

	messages.addEventListener('click', (e) => {
		const approvalBtn = e.target.closest('[data-approval-action][data-approval-id]');
		if (approvalBtn) {
			const action = approvalBtn.dataset.approvalAction;
			const approvalId = approvalBtn.dataset.approvalId;
			if (!approvalId) return;
			approvalBtn.disabled = true;
			const siblingButtons = approvalBtn.parentElement?.querySelectorAll('[data-approval-action]');
			siblingButtons?.forEach((btn) => { btn.disabled = true; });
			(action === 'approve' ? approveToolApproval(approvalId) : denyToolApproval(approvalId))
				.catch((err) => {
					console.error('[ChatPage] Tool approval action failed:', err);
					siblingButtons?.forEach((btn) => { btn.disabled = false; });
				});
			return;
		}

		const codeCopyBtn = e.target.closest('.md-code-copy');
		if (codeCopyBtn) {
			const wrapper = codeCopyBtn.closest('.md-code-wrapper');
			if (wrapper) {
				const codeBlock = wrapper.querySelector('.md-code-block code');
				if (codeBlock) {
					const text = codeBlock.textContent;
					navigator.clipboard.writeText(text).then(() => {
						const old = codeCopyBtn.innerHTML;
						codeCopyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>`;
						setTimeout(() => { codeCopyBtn.innerHTML = old; }, 2000);
					}).catch(err => console.error('Failed to copy code:', err));
				}
			}
			return;
		}

		const codeHeader = e.target.closest('.md-code-header');
		if (codeHeader) {
			const wrapper = codeHeader.closest('.md-code-wrapper');
			if (wrapper) {
				wrapper.classList.toggle('collapsed');
			}
			return;
		}

		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		const action  = btn.dataset.action;
		const msgEl   = btn.closest('.chat-message[data-node-id]');
		const nodeId  = msgEl?.dataset?.nodeId;
		if (!nodeId) return;
		const chat  = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat) return;
		const graph = ensureGraph(chat);
		const node  = getNode(graph, nodeId);
		if (!node) return;

		const resetEdit = () => { uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null; };

		const handlers = {
			edit: () => {
				uiState.editingNodeId = nodeId;
				uiState.editingDraft  = getNodeTextContent(node);
				uiState.editingSaveMode = null;
				const patched = patchMessageEditState(messages, graph, node, true, uiState.editingDraft, SettingsStore.get());
				if (!patched) rerender();
				updateLiveContext();
				setTimeout(() => {
					const el = messages.querySelector(`[data-node-id="${nodeId}"] .chat-edit-input`);
					if (el) { el.focus(); const s=window.getSelection(),r=document.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
				}, 0);
			},
			cancel: () => {
				const escNode = uiState.editingNodeId ? getNode(graph, uiState.editingNodeId) : null;
				resetEdit();
				const patched = escNode ? patchMessageEditState(messages, graph, escNode, false, null, SettingsStore.get()) : false;
				if (!patched) rerender();
			},
			save: () => {
				if (!uiState.editingNodeId) return;
				const editEl = msgEl.querySelector('.chat-edit-input');
				const next   = (editEl?.innerText ?? '').replace(/\n$/, '');
				const saveMode = uiState.editingSaveMode;

				const sibling = createSiblingCopy(graph, nodeId, { content: next, timestamp: Date.now() });
				if (!sibling) return;
				if (sibling.parts) {
					sibling.parts = buildPartsWithUpdatedText(sibling, next);
				} else { sibling.content = next; }
				sibling.editedAt = Date.now();
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				resetEdit();
				rerender();
				setActiveCallback?.();
				// Only auto-regenerate when editing a user message (to get a new AI response).
				// Editing an assistant message should just update the text, not trigger a new generation.
				if (saveMode !== 'preserve' && sibling.role === 'user') {
					if (empty) empty.hidden = true;
					startReply(chat.id, sibling.id);
				}
				checkScroll();
			},
			thread: () => {
				const newNode = branchFromNode(graph, nodeId, { preserveSelectedTail: true });
				if (!newNode) return;
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				rerender(); setActiveCallback?.();
				checkScroll();
			},
			'branch-back': () => {
				const siblings = getNode(graph, node.parentId)?.children || [];
				const idx = siblings.indexOf(nodeId);
				if (idx <= 0) return;
				setSelectedChildId(graph, node.parentId, siblings[idx - 1]);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
			},
			'branch-forward': () => {
				const siblings = getNode(graph, node.parentId)?.children || [];
				const idx = siblings.indexOf(nodeId);
				if (idx < 0 || idx >= siblings.length - 1) return;
				setSelectedChildId(graph, node.parentId, siblings[idx + 1]);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
			},
			resend: () => {
				stopTyping();
				const userNodeId = node.role==='user' ? node.id : node.parentId;
				const userNode   = getNode(graph, userNodeId);
				if (!userNode) return;
				[...(userNode.children||[])].forEach(cid => deleteSubtree(graph, cid));
				delete graph.selections[userNodeId];
				if (userNode.parentId) setSelectedChildId(graph, userNode.parentId, userNodeId);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
				if (empty) empty.hidden = true;
				startReply(chat.id, userNodeId);
				checkScroll();
			},
			copy: async () => {
				const chunks =[];
				if (node.reasoning && node.reasoning.trim()) {
					chunks.push(`<think>\n${node.reasoning.trim()}\n</think>`);
				}
				const txt = getNodeTextContent(node);
				if (txt) chunks.push(txt);
				try {
					await navigator.clipboard.writeText(chunks.join('\n\n'));
					const old = btn.innerHTML;
					btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
					setTimeout(()=>{ if(btn) btn.innerHTML=old; }, 2000);
				} catch(err) { console.error('Failed to copy:', err); }
			},
			delete: () => {
				stopTyping();
				if (e.shiftKey) spliceDeleteNode(graph, nodeId); else deleteSubtree(graph, nodeId);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); renderChatList(); setActiveCallback?.();
			},
		};
		handlers[action]?.();
	}, { signal });

	messages.addEventListener('keydown', (e) => {
		const editEl = e.target.closest('.chat-edit-input');
		if (!editEl) return;
		const msgEl  = editEl.closest('.chat-message');
		const nodeId = msgEl?.dataset.nodeId;
		if (!nodeId) return;
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			uiState.editingSaveMode = e.shiftKey ? 'preserve' : 'reset';
			msgEl.querySelector('button[data-action="save"]')?.click();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			document.execCommand('insertText', false, '\n');
		} else if (e.key === 'Escape' || e.key === 'Esc') {
			e.preventDefault();
			const escNodeId = uiState.editingNodeId;
			uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null;
			const chat2 = getChatById(getCurrentChatId());
			const g2    = chat2 ? ensureGraph(chat2) : null;
			const escNode = (escNodeId && g2) ? getNode(g2, escNodeId) : null;
			const patched = escNode ? patchMessageEditState(messages, g2, escNode, false, null, SettingsStore.get()) : false;
			if (!patched) rerender();
		}
	}, { signal });

	messages.addEventListener('input', (e) => {
		const editEl = e.target.closest('.chat-edit-input');
		if (!editEl) return;
		const nodeId = editEl.closest('.chat-message')?.dataset?.nodeId;
		if (nodeId && uiState.editingNodeId === nodeId) {
			uiState.editingDraft = (editEl.innerText ?? '').replace(/\n$/, '');
			updateLiveContext();
		}
	}, { signal });

	document.addEventListener('copy', (e) => {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return;
		const range = sel.getRangeAt(0);
		if (!messages.contains(range.commonAncestorContainer)) return;

		const chat  = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const nodeRawText = (node) => {
			if (!node) return '';
			return getNodeTextContent(node);
		};

		const msgEls =[...messages.querySelectorAll('.chat-message[data-node-id]')];
		const selMsgEls = msgEls.filter(el => range.intersectsNode(el));
		if (selMsgEls.length === 0) return;

		// Determine if selection covers entire message content (not just part of it)
		const isFullMessageSelection = selMsgEls.every(msgEl => {
			const content = msgEl.querySelector('.chat-message-content');
			if (!content) return false;
			const contentRange = document.createRange();
			contentRange.selectNodeContents(content);
			return range.compareBoundaryPoints(Range.START_TO_START, contentRange) <= 0 &&
			       range.compareBoundaryPoints(Range.END_TO_END, contentRange) >= 0;
		});

		let plain = '';

		if (isFullMessageSelection) {
			// Full message(s) selected — use raw stored content including reasoning
			const parts =[];
			for (const m of selMsgEls) {
				const node = graph ? getNode(graph, m.dataset.nodeId) : null;
				if (!node) continue;
				const chunks =[];
				if (node.reasoning && node.reasoning.trim()) {
					chunks.push(`<think>\n${node.reasoning.trim()}\n</think>`);
				}
				const txt = getNodeTextContent(node);
				if (txt) chunks.push(txt);
				if (chunks.length) parts.push(chunks.join('\n\n'));
			}
			plain = parts.join('\n\n');
		}

		if (!plain) {
			// Partial selection — convert rendered HTML back to markdown
			const selectedRange = range.cloneRange();
			const fragment = selectedRange.cloneContents();
			const tempDiv = document.createElement('div');
			tempDiv.appendChild(fragment);
			plain = htmlToMarkdown(tempDiv);
		}

		const htmlContainer = document.createElement('div');
		htmlContainer.appendChild(range.cloneContents());
		htmlContainer.querySelectorAll('.chat-message-menu, .md-code-header, .chat-typing, .chat-message-inline-attachment').forEach(el => el.remove());
		htmlContainer.querySelectorAll('.message-tool-call').forEach(el => { const s = el.querySelector('summary'); el.replaceWith(document.createTextNode(s ? s.textContent.trim() : '')); });
		const htmlPayload = `<!DOCTYPE html><html><body>${htmlContainer.innerHTML}</body></html>`;
		e.preventDefault();
		if (!e.clipboardData) return;
		e.clipboardData.setData('text/plain', plain);
		try { e.clipboardData.setData('text/html', htmlPayload); } catch {}
	}, { signal });

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		if (uiState.isGenerating) {
			await requestTaskCancellation({ abortStream: false, discardPartial: false });
			return;
		}

		const parts = attachmentManager.extractParts();
		if (!parts || parts.length === 0) return;
		// Debounce: prevent rapid-fire duplicate submissions
		if (uiState.isSubmitting) return;
		uiState.isSubmitting = true;
		ensureChatExists(setActiveCallback);
		if (empty) empty.hidden = true;
		stopTyping();
		uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null;

		// Check if this is the first message (for AI title generation after chat completes)
		const submittedChatId = getCurrentChatId();
		const currentChat = getChatById(submittedChatId);
		const isFirstMessage = currentChat && currentChat.graph && currentChat.graph.nodes &&
			Object.values(currentChat.graph.nodes).filter(n => n.role === 'user').length === 0;
		const submittedModel = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected')?.dataset?.value || currentChat?.model || '';

		// Add user message immediately (shows in UI)
		const userNode = await addMessageToChat(submittedChatId, 'user', '', null, parts);
		attachmentManager.clear();
		const uploadBtn = root.querySelector('#chatUploadBtn');
		if (uploadBtn) delete uploadBtn.dataset.count;
		if (resizeInput) resizeInput();
		rerender(); renderChatList(); setActiveCallback?.();

		const sendNoReply = form.dataset.sendNoReply === '1';
		delete form.dataset.sendNoReply;
		if (!sendNoReply && userNode?.id) {
			startReply(submittedChatId, userNode.id).finally(() => {
				// Release the submit debounce guard once the reply completes
				uiState.isSubmitting = false;
				// Fire AI title generation after first message completes
				if (isFirstMessage) {
					triggerAiTitleGeneration(root, submittedChatId, null, submittedModel);
				}
			});
		} else {
			// No reply to generate — release the guard immediately
			uiState.isSubmitting = false;
		}
		checkScroll();
	}, { signal });

	rerender();
	input.focus();
}

export function mountChatPage(root, context = {}) {
	initChatPage(root, context.currentRouteGetter || (() => ''), context.setActiveCallback);
	return () => {
		chatPageAbort?.abort();
	};
}
