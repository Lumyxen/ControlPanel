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
	getChatById, getCurrentChatId, saveChats, setChatModel, setCurrentChatId,
} from './store.js';
import { renderChatList } from './sidebar.js';
import { updateContextUI, getModelMaxTokens, getModelContextLimitFromUI, estimateNodeTokens, estimatePartsTokens } from './context.js';
import { renderThread, showTyping, buildToolCallElement, patchMessageEditState } from './thread-ui.js';
import { InlineAttachmentManager } from './inline-attachment.js';
import { parseMarkdown } from './markdown.js';
import { preprocessLatexText, extractMath, injectMath } from './latex/index.js';
import { StreamProcessor } from '../latex/live/stream-processor.js';
import { TokenTracker } from '../latex/live/token-tracker.js';
import { PendingManager } from '../latex/live/pending-manager.js';
import { renderKatex } from '../latex/renderers/katex-renderer.js';
import { renderToHTML } from '../latex/renderers/html-renderer.js';
import { tokenize } from '../latex/core/tokenizer.js';
import { parse } from '../latex/core/parser.js';
import { HTMLRenderer } from '../latex/renderers/html-renderer.js';
import { streamChatMessage, stopChatMessage } from '../api.js';
import * as SettingsStore from '../settings-store.js';
import { initDropdowns, initTools, initUpload, initAutoResize, loadAndPopulateModels, TOOLS_KEY } from './toolbar.js';
import { buildNodeTextForHistory, buildApiMessages, parseStreamReasoning } from './generation.js';

let chatPageAbort = null;

// Convert rendered HTML back to markdown for partial selections
function htmlToMarkdown(el) {
	let text = '';
	const walk = (node) => {
		if (node.nodeType === 3) { text += node.textContent; return; }
		if (node.nodeType !== 1) return;
		const tag = node.tagName.toLowerCase();
		if (tag === 'br') { text += '\n'; return; }
		if (tag === 'p') { text += '\n'; [...node.childNodes].forEach(walk); text += '\n'; return; }
		if (tag === 'div') {
			// Only add newlines for structural divs, not wrapper divs
			const cls = node.className || '';
			if (cls.includes('chat-message-text') || cls.includes('chat-message-content')) {
				[...node.childNodes].forEach(walk);
				return;
			}
			text += '\n';
			[...node.childNodes].forEach(walk);
			text += '\n';
			return;
		}
		if (tag === 'strong' || tag === 'b') { text += '**'; [...node.childNodes].forEach(walk); text += '**'; return; }
		if (tag === 'em' || tag === 'i') { text += '*'; [...node.childNodes].forEach(walk); text += '*'; return; }
		if (tag === 'code') {
			// Check if inside a pre block — skip, pre handles it
			if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') return;
			text += '`'; [...node.childNodes].forEach(walk); text += '`'; return;
		}
		if (tag === 'pre') {
			const code = node.querySelector('code');
			if (code) { text += '```\n' + code.textContent + '\n```'; }
			else { text += '```\n' + node.textContent + '\n```'; }
			return;
		}
		if (tag === 'a') { const href = node.getAttribute('href'); const inner = [...node.childNodes].map(n => n.textContent).join(''); text += href ? `[${inner}](${href})` : inner; return; }
		if (tag === 'li') { text += '- '; [...node.childNodes].forEach(walk); text += '\n'; return; }
		if (tag === 'h1') { text += '# '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'h2') { text += '## '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'h3') { text += '### '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'h4') { text += '#### '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'h5') { text += '##### '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'h6') { text += '###### '; [...node.childNodes].forEach(walk); text += '\n\n'; return; }
		if (tag === 'ul') { [...node.childNodes].forEach(walk); text += '\n'; return; }
		if (tag === 'ol') { let i = 0; [...node.childNodes].forEach(c => { if (c.nodeType === 1 && c.tagName.toLowerCase() === 'li') { i++; text += i + '. '; walk(c); text += '\n'; } else { walk(c); } }); text += '\n'; return; }
		if (tag === 'hr') { text += '\n---\n\n'; return; }
		if (tag === 'del' || tag === 's') { text += '~~'; [...node.childNodes].forEach(walk); text += '~~'; return; }
		if (tag === 'img') { const alt = node.getAttribute('alt') || ''; const src = node.getAttribute('src') || ''; text += alt ? `![${alt}](${src})` : src; return; }
		if (tag === 'table') { [...node.childNodes].forEach(walk); text += '\n'; return; }
		if (tag === 'thead') { [...node.childNodes].forEach(walk); return; }
		if (tag === 'tbody') { [...node.childNodes].forEach(walk); return; }
		if (tag === 'tr') { [...node.childNodes].forEach(walk); return; }
		if (tag === 'th') { text += '| **'; [...node.childNodes].forEach(walk); text += '** '; return; }
		if (tag === 'td') { text += '| '; [...node.childNodes].forEach(walk); text += ' '; return; }
		if (tag === 'blockquote') { text += '> '; [...node.childNodes].forEach(walk); text += '\n'; return; }
		[...node.childNodes].forEach(walk);
	};
	[...el.childNodes].forEach(walk);
	return text.replace(/\n{3,}/g, '\n\n').trim();
}

function ensureChatExists(setActiveCallback) {
	if (!getCurrentChatId() || !getChatById(getCurrentChatId())) {
		createNewChat(); renderChatList(); setActiveCallback?.();
	}
}

export function loadCurrentChat(setActiveCallback) {
	const messages = document.getElementById('chatMessages');
	const empty    = document.getElementById('chatEmpty');
	if (!messages) return;
	const currentChatId = getCurrentChatId();
	const chat  = currentChatId ? getChatById(currentChatId) : null;
	const graph = chat ? ensureGraph(chat) : null;
	const hasMessages = Boolean(graph && computeThreadNodeIds(graph).length > 0);
	if (empty) empty.hidden = hasMessages;
	if (chat) renderThread(messages, chat, { editingNodeId: null, editingDraft: '' });
	else messages.querySelectorAll('.chat-message, .chat-typing').forEach(el => el.remove());
	renderChatList();
	setActiveCallback?.();
}

export async function initChatPage(root, currentRouteGetter, setActiveCallback) {
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

	const attachmentManager = new InlineAttachmentManager(input);

	const uiState = {
		editingNodeId: null, editingDraft: '', editingSaveMode: null,
		typingEl: null, typingTimeout: null, streamAbort: null,
		flushResponse: null, isGenerating: false,
		liveGeneratingNode: null, activeStreamId: null,
	};

	const updateLiveContext = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		let extra = 0;
		const parts = attachmentManager.extractParts();
		if (parts?.length > 0) extra += estimatePartsTokens(parts);
		if (uiState.isGenerating && uiState.liveGeneratingNode) extra += estimateNodeTokens(uiState.liveGeneratingNode);
		if (uiState.editingNodeId && chat) {
			const node = getNode(ensureGraph(chat), uiState.editingNodeId);
			if (node) {
				extra -= estimateNodeTokens(node);
				let draftParts = [];
				if (node.parts) {
					let set = false;
					for (const p of node.parts) {
						if (p.type === 'text' && !set) { draftParts.push({ type: 'text', content: uiState.editingDraft }); set = true; }
						else if (p.type !== 'text') draftParts.push(p);
					}
					if (!set) draftParts.unshift({ type: 'text', content: uiState.editingDraft });
				} else { draftParts = [{ type: 'text', content: uiState.editingDraft }]; }
				extra += estimatePartsTokens(draftParts);
			}
		}
		updateContextUI(root, chat, Math.max(0, extra));
	};
	root._updateLiveContext = updateLiveContext;

	await loadAndPopulateModels(root, signal);
	initDropdowns(root, signal);
	initTools(root, signal);
	initUpload(root, input, attachmentManager, signal);
	const resizeInput = initAutoResize(input, signal);
	input.addEventListener('input', updateLiveContext, { signal });
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (uiState.isGenerating) return;
			if (e.shiftKey) form.dataset.sendNoReply = '1';
			form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
		}
	}, { signal });

	const urlParams = new URLSearchParams(location.hash.split('?')[1] || '');
	const chatIdFromUrl = urlParams.get('chat');
	if (chatIdFromUrl && getChatById(chatIdFromUrl)) { setCurrentChatId(chatIdFromUrl); saveChats(); }

	const rerender = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat) { messages.querySelectorAll('.chat-message, .chat-typing').forEach(el => el.remove()); return; }
		renderThread(messages, chat, { editingNodeId: uiState.editingNodeId, editingDraft: uiState.editingDraft });
		if (empty) empty.hidden = computeThreadNodeIds(ensureGraph(chat)).length > 0;
	};

	const setGeneratingState = (gen) => {
		uiState.isGenerating = gen;
		if (!gen) uiState.liveGeneratingNode = null;
		const btn = form.querySelector('.chat-send-btn');
		if (!btn) return;
		if (gen) {
			btn.classList.add('generating');
			btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="14" height="14" fill="currentColor"/></svg>`;
			btn.title = 'Stop generating'; btn.setAttribute('aria-label', 'Stop generating');
		} else {
			btn.classList.remove('generating');
			btn.innerHTML = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M44.9,23.2l-38-18L6,5A2,2,0,0,0,4,7l6,18L4,43a2,2,0,0,0,2,2l.9-.2,38-18A2,2,0,0,0,44.9,23.2ZM9.5,39.1l4-12.1H24a2,2,0,0,0,0-4H13.5l-4-12.1L39.3,25Z" fill="currentColor"/></svg>`;
			btn.title = 'Send'; btn.setAttribute('aria-label', 'Send message');
		}
	};

	const closeTypingReasoning = () => {
		if (uiState.typingEl) { const lr = uiState.typingEl.querySelector('.message-reasoning'); if (lr) lr.open = false; }
	};

	const stopTyping = () => {
		if (uiState.activeStreamId) { stopChatMessage(uiState.activeStreamId).catch(()=>{}); uiState.activeStreamId = null; }
		if (uiState.flushResponse)  { uiState.flushResponse(); uiState.flushResponse = null; }
		if (uiState.streamAbort)    { uiState.streamAbort.abort(); uiState.streamAbort = null; }
		if (uiState.typingTimeout)  { clearTimeout(uiState.typingTimeout); uiState.typingTimeout = null; }
		if (uiState.typingEl)       { uiState.typingEl.remove(); uiState.typingEl = null; }
		setGeneratingState(false);
	};

	signal.addEventListener('abort', () => {
		if (uiState.activeStreamId) { stopChatMessage(uiState.activeStreamId).catch(()=>{}); uiState.activeStreamId = null; }
		if (uiState.flushResponse)  { uiState.flushResponse(); uiState.flushResponse = null; }
		if (uiState.streamAbort)    uiState.streamAbort.abort();
	});

	const startReply = async (parentUserNodeId) => {
		stopTyping();
		uiState.typingEl = showTyping(messages);
		setGeneratingState(true);

		const activeChatId    = getCurrentChatId();
		uiState.streamAbort   = new AbortController();
		const currentSignal   = uiState.streamAbort.signal;
		uiState.activeStreamId = 'stream_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value || '';
		if (activeChatId && model) setChatModel(activeChatId, model);

		let maxTokens      = getModelMaxTokens(model);
		const contextLimit = getModelContextLimitFromUI(root);
		const chat  = getChatById(activeChatId);
		if (!chat) { stopTyping(); return; }
		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);

		let conversationHistory = '';
		for (const nid of threadIds) {
			const n = getNode(graph, nid);
			if (n) {
				const nc = buildNodeTextForHistory(n);
				if (nc) conversationHistory += `${n.role === 'user' ? 'User' : 'Assistant'}: ${nc}\n\n`;
			}
		}
		if (!conversationHistory.trim() && parentUserNodeId) {
			const pn = getNode(graph, parentUserNodeId);
			if (pn) conversationHistory = buildNodeTextForHistory(pn) || 'Hello';
		}
		if (!conversationHistory.trim()) conversationHistory = 'Hello';

		let apiMessages = buildApiMessages(graph, threadIds);
		if (apiMessages.length === 0 && parentUserNodeId) apiMessages = buildApiMessages(graph, [parentUserNodeId]);
		const hasVision = apiMessages.some(m => Array.isArray(m.content));
		const visionMessages = hasVision ? apiMessages : null;

		const estimatedPromptTokens = Math.ceil(conversationHistory.length / 3) + 200;
		if (estimatedPromptTokens + maxTokens > contextLimit) maxTokens = Math.max(256, contextLimit - estimatedPromptTokens);

		let rawStreamText = '', officialReasoningText = '', activeToolCalls = [], errorFromStream = null, isSaved = false;

		const latexStreamProcessor = new StreamProcessor({
			debounceMs: 200,
			tokenThreshold: 0,
			onUpdate: (source, changedBlocks) => {
				const tw = mc?.querySelector('.chat-message-text');
				if (!tw || !source) return;
				const pre = preprocessLatexText(source);
				const { text, mathBlocks } = extractMath(pre);
				tw.innerHTML = injectMath(parseMarkdown(text), mathBlocks);
			},
		});

		let systemPrompt = chat?.systemPrompt || '';
		let temperature = chat?.temperature ?? 1.0;

		if (hasVision) {
			const hint = '[System Override: You have native multimodal vision capabilities. The user has attached an image. Analyze the visual data directly.]';
			systemPrompt = systemPrompt ? systemPrompt + '\n\n' + hint : hint;
		}

		uiState.flushResponse = () => {
			if (isSaved) return;
			isSaved = true;
			const { parsedContent, parsedReasoning } = parseStreamReasoning(rawStreamText);
			let displayReasoning = officialReasoningText;
			if (parsedReasoning) displayReasoning += (displayReasoning ? '\n\n' : '') + parsedReasoning.trim();
			let finalContent  = parsedContent.trim();
			let finalReasoning = displayReasoning.trim();
			if (errorFromStream) finalContent += finalContent ? `\n\n**Error:** ${errorFromStream}` : `**Error:** ${errorFromStream}`;
			if (finalContent || finalReasoning || activeToolCalls.length > 0) {
				const node = addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', finalContent);
				if (node) {
					if (finalReasoning)             node.reasoning  = finalReasoning;
					if (activeToolCalls.length > 0) node.toolCalls  = activeToolCalls;
					saveChats();
				}
			} else if (errorFromStream) {
				addChildMessageToChat(activeChatId, parentUserNodeId, 'assistant', `**Error:** ${errorFromStream}`);
			}
			uiState.liveGeneratingNode = null;
		};

		try {
			await streamChatMessage(model, conversationHistory, maxTokens,
				(chunk) => {
					if (currentSignal.aborted) return;
					if (chunk.error) {
						errorFromStream = typeof chunk.error === 'object' ? (chunk.error.message || JSON.stringify(chunk.error)) : String(chunk.error);
						return;
					}
					if (chunk.type === 'retract') {
						// Backend detected a tool call after streaming — clear the
						// buffered text so we don't duplicate it in the final output.
						// Tool call events will follow immediately after.
						rawStreamText = '';
						officialReasoningText = '';
						if (uiState.typingEl) {
							uiState.typingEl.querySelector('.chat-message-text')?.remove();
							uiState.typingEl.querySelector('.message-reasoning')?.remove();
						}
						return;
					}
					if (chunk.type === 'tool_execution' && chunk.tool_call) {
						activeToolCalls.push({ id: chunk.tool_call.id, name: chunk.tool_call.name, input: chunk.tool_call.arguments, output: chunk.tool_call.output });
					}
					if (chunk.type === 'retract') {
						// Backend detected a tool call after streaming — clear the
						// buffered text so we don't duplicate it in the final output.
						// Tool call events will follow immediately after.
						rawStreamText = '';
						officialReasoningText = '';
						if (uiState.typingEl) {
							uiState.typingEl.querySelector('.chat-message-text')?.remove();
							uiState.typingEl.querySelector('.message-reasoning')?.remove();
						}
						return;
					}
					if (chunk.type === 'tool_execution' && chunk.tool_call) {
						activeToolCalls.push({ id: chunk.tool_call.id, name: chunk.tool_call.name, input: chunk.tool_call.arguments, output: chunk.tool_call.output });
					}
					if (chunk.choices?.[0]?.delta) {
						const delta = chunk.choices[0].delta;
						if (delta.reasoning) officialReasoningText += delta.reasoning;
						if (delta.content)   rawStreamText         += delta.content;
					}
					uiState.liveGeneratingNode = { role: 'assistant', content: rawStreamText, reasoning: officialReasoningText, toolCalls: activeToolCalls };
					updateLiveContext();

					if (!uiState.typingEl) return;
					const { parsedContent, parsedReasoning } = parseStreamReasoning(rawStreamText);
					let displayReasoning = officialReasoningText;
					if (parsedReasoning) displayReasoning += (displayReasoning ? '\n\n' : '') + parsedReasoning.trim();

					if (!uiState.typingEl.querySelector('.chat-message-content')) {
						uiState.typingEl.innerHTML = '';
						uiState.typingEl.className = 'chat-message assistant';
					}
					let mc = uiState.typingEl.querySelector('.chat-message-content');
					if (!mc) { mc = document.createElement('div'); mc.className = 'chat-message-content'; uiState.typingEl.appendChild(mc); }

					if (displayReasoning) {
						let re = mc.querySelector('.message-reasoning');
						if (!re) {
							re = document.createElement('details'); re.className = 'message-reasoning'; re.open = true;
							re.innerHTML = '<summary>Thinking...</summary><div class="reasoning-content"></div>';
							mc.insertBefore(re, mc.firstChild);
						}
						const rc = re.querySelector('.reasoning-content');
						if (rc) rc.textContent = displayReasoning;
					}

					latexStreamProcessor.scheduleUpdate(rawStreamText);

					// Update or add tool call elements
					const existingTCs = mc.querySelectorAll('.message-tool-call');
					for (let i = 0; i < activeToolCalls.length; i++) {
						const tc = activeToolCalls[i];
						let tcEl = null;

						// Find existing element by ID
						for (const el of existingTCs) {
							if (el.dataset.toolCallId === tc.id) {
								tcEl = el;
								break;
							}
						}

						if (!tcEl) {
							tcEl = document.createElement('div');
							tcEl.className = 'message-tool-call';
							tcEl.dataset.toolCallId = tc.id;
							const tw = mc.querySelector('.chat-message-text');
							tw ? mc.insertBefore(tcEl, tw) : mc.appendChild(tcEl);
						} else {
							// Update existing tool call element with output
							const body = tcEl.querySelector('.tool-call-body');
							if (body && tc.output) {
								const outputSection = body.querySelector('.tool-call-section-label:last-of-type');
								if (outputSection) {
									const outputCode = outputSection.nextElementSibling;
									if (outputCode && outputCode.classList.contains('tool-call-code')) {
										outputCode.textContent = tc.output;
									}
								}
							}
						}
					}

					if (parsedContent) {
						let tw = mc.querySelector('.chat-message-text');
						if (!tw) { tw = document.createElement('div'); tw.className = 'chat-message-text'; mc.appendChild(tw); }
						const pre = preprocessLatexText(parsedContent);
						const { text, mathBlocks } = extractMath(pre);
						tw.innerHTML = injectMath(parseMarkdown(text), mathBlocks);
					} else {
						mc.querySelector('.chat-message-text')?.remove();
					}
					const se = messages.closest('.content') || messages;
					se.scrollTop = se.scrollHeight;
				},
				currentSignal, systemPrompt, temperature, contextLimit, uiState.activeStreamId, visionMessages,
			);

			if (errorFromStream) throw new Error(errorFromStream);
			if (!rawStreamText && !officialReasoningText && activeToolCalls.length === 0) throw new Error('Empty response from AI');

			closeTypingReasoning(); stopTyping(); rerender(); renderChatList(); setActiveCallback?.();
		} catch (err) {
			if (err.name === 'AbortError') {
				uiState.flushResponse?.(); uiState.flushResponse = null;
				stopTyping(); rerender(); renderChatList(); setActiveCallback?.();
				return;
			}
			console.error('[ChatPage] Stream error:', err);
			uiState.flushResponse?.(); uiState.flushResponse = null;
			stopTyping(); rerender(); renderChatList(); setActiveCallback?.();
		}
	};

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
				uiState.editingDraft  = node.parts ? node.parts.filter(p=>p.type==='text').map(p=>p.content).join('') : String(node.content||'');
				uiState.editingSaveMode = null;
				const patched = patchMessageEditState(messages, graph, node, true, uiState.editingDraft);
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
				const patched = escNode ? patchMessageEditState(messages, graph, escNode, false, null) : false;
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
					let set = false;
					sibling.parts = sibling.parts.map(p => {
						if (p.type==='text' && !set) { set=true; return {...p, content: next}; }
						return p;
					});
					if (!set) sibling.parts.unshift({ type:'text', content: next });
				} else { sibling.content = next; }
				sibling.editedAt = Date.now();
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				resetEdit();
				rerender();
				setActiveCallback?.();
				if (saveMode !== 'preserve') {
					if (empty) empty.hidden = true;
					startReply(sibling.id);
				}
			},
			thread: () => {
				const newNode = branchFromNode(graph, nodeId, { preserveSelectedTail: true });
				if (!newNode) return;
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				rerender(); setActiveCallback?.();
			},
			back: () => {
				setSelectedChildId(graph, node.parentId, nodeId, -1);
				recomputeLeafId(graph); chat.updatedAt = Date.now(); saveChats();
				resetEdit(); rerender(); setActiveCallback?.();
			},
			forward: () => {
				setSelectedChildId(graph, node.parentId, nodeId, +1);
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
				startReply(userNodeId);
			},
			copy: async () => {
				const chunks = [];
				if (node.reasoning && node.reasoning.trim()) {
					chunks.push(`<think>\n${node.reasoning.trim()}\n</think>`);
				}
				const txt = node.parts ? node.parts.filter(p=>p.type==='text').map(p=>p.content).join('') : String(node.content||'');
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
			const patched = escNode ? patchMessageEditState(messages, g2, escNode, false, null) : false;
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
			return node.parts ? node.parts.filter(p=>p.type==='text').map(p=>p.content).join('') : String(node.content||'');
		};

		const msgEls = [...messages.querySelectorAll('.chat-message[data-node-id]')];
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
			const parts = [];
			for (const m of selMsgEls) {
				const node = graph ? getNode(graph, m.dataset.nodeId) : null;
				if (!node) continue;
				const chunks = [];
				if (node.reasoning && node.reasoning.trim()) {
					chunks.push(`<think>\n${node.reasoning.trim()}\n</think>`);
				}
				const txt = node.parts ? node.parts.filter(p=>p.type==='text').map(p=>p.content).join('') : String(node.content||'');
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
		htmlContainer.querySelectorAll('.chat-message-menu, .md-code-header, .chat-typing, .chat-message-inline-attachment, .latex-preamble').forEach(el => el.remove());
		htmlContainer.querySelectorAll('.message-tool-call').forEach(el => { const s = el.querySelector('summary'); el.replaceWith(document.createTextNode(s ? s.textContent.trim() : '')); });
		htmlContainer.querySelectorAll('.katex-display').forEach(el => { const src = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim(); if (src) el.replaceWith(document.createTextNode(`$$${src}$$`)); });
		htmlContainer.querySelectorAll('.katex').forEach(el => { const src = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim(); if (src) el.replaceWith(document.createTextNode(`$${src}$`)); });
		const htmlPayload = `<!DOCTYPE html><html><body>${htmlContainer.innerHTML}</body></html>`;
		e.preventDefault();
		if (!e.clipboardData) return;
		e.clipboardData.setData('text/plain', plain);
		try { e.clipboardData.setData('text/html', htmlPayload); } catch {}
	}, { signal });

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		if (uiState.isGenerating) { stopTyping(); rerender(); setActiveCallback?.(); return; }
		const parts = attachmentManager.extractParts();
		if (!parts || parts.length === 0) return;
		ensureChatExists(setActiveCallback);
		if (empty) empty.hidden = true;
		stopTyping();
		uiState.editingNodeId = null; uiState.editingDraft = ''; uiState.editingSaveMode = null;
		const userNode = addMessageToChat(getCurrentChatId(), 'user', '', null, parts);
		attachmentManager.clear();
		const uploadBtn = root.querySelector('#chatUploadBtn');
		if (uploadBtn) delete uploadBtn.dataset.count;
		if (resizeInput) resizeInput();
		rerender(); renderChatList(); setActiveCallback?.();
		const sendNoReply = form.dataset.sendNoReply === '1';
		delete form.dataset.sendNoReply;
		if (!sendNoReply && userNode?.id) startReply(userNode.id);
	}, { signal });

	rerender();
	input.focus();
}
