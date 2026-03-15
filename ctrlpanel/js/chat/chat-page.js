import {
	branchFromNode,
	computeThreadNodeIds,
	createSiblingCopy,
	deleteSubtree,
	ensureGraph,
	getNode,
	nodeHasGeneratedResponse,
	recomputeLeafId,
	setSelectedChildId,
	spliceDeleteNode,
} from "./graph.js";
import {
	addChildMessageToChat,
	addMessageToChat,
	createNewChat,
	getChatById,
	getChatModel,
	getCurrentChatId,
	getLastSelectedModel,
	saveChats,
	setChatModel,
	setCurrentChatId,
	setLastSelectedModel,
} from "./store.js";
import { renderChatList } from "./sidebar.js";
import { updateContextUI, setModelMetadata, getModelMaxTokens, getModelContextLimitFromUI, estimateNodeTokens, estimatePartsTokens } from "./context.js";
import { getModels } from "../api.js";
import { renderThread, showTyping, buildToolCallElement, patchMessageEditState } from "./thread-ui.js";
import { InlineAttachmentManager } from "./inline-attachment.js";
import { parseMarkdown } from "./markdown.js";
import { preprocessLatexText, extractMath, injectMath } from "./latex.js";
import { streamChatMessage, stopChatMessage } from "../api.js";
import * as SettingsStore from "../settings-store.js";

const TOOLS_KEY = "ctrlpanel:toolsEnabled";

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
	if (!text) return "";
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}
let chatPageAbort = null;

function initDropdowns(root, signal) {
	root.querySelectorAll(".chat-dropdown").forEach((dropdown) => {
		const toggle = dropdown.querySelector(".chat-dropdown-toggle");
		const menu = dropdown.querySelector(".chat-dropdown-menu");
		const isMulti = dropdown.hasAttribute("data-multi");

		toggle?.addEventListener("click", (e) => {
			e.preventDefault();
			const isOpen = dropdown.classList.contains("open");
			root.querySelectorAll(".chat-dropdown.open").forEach((d) => {
				if (d !== dropdown) {
					d.classList.remove("open");
					d.querySelector(".chat-dropdown-toggle")?.setAttribute("aria-expanded", "false");
				}
			});
			dropdown.classList.toggle("open", !isOpen);
			toggle.setAttribute("aria-expanded", String(!isOpen));
		}, { signal });

		if (!isMulti) {
			const items = dropdown.querySelectorAll(".chat-dropdown-item");
			const label = dropdown.querySelector(".chat-dropdown-label");
			items.forEach((item) => {
				item.addEventListener("click", () => {
					items.forEach((i) => {
						i.classList.remove("selected");
						i.setAttribute("aria-selected", "false");
					});
					item.classList.add("selected");
					item.setAttribute("aria-selected", "true");
					if (label) label.textContent = item.textContent;
					dropdown.classList.remove("open");
					toggle?.setAttribute("aria-expanded", "false");
				}, { signal });
			});
		} else {
			menu?.addEventListener("click", (e) => e.stopPropagation(), { signal });
		}
	});

	document.addEventListener("click", (e) => {
		if (!e.target.closest(".chat-dropdown")) {
			root.querySelectorAll(".chat-dropdown.open").forEach((d) => {
				d.classList.remove("open");
				d.querySelector(".chat-dropdown-toggle")?.setAttribute("aria-expanded", "false");
			});
		}
	}, { signal });
}

function initTools(root, signal) {
	const toolsDropdown = root.querySelector('[data-dropdown="tools"]');
	if (!toolsDropdown) return;
	const checkboxes = [...toolsDropdown.querySelectorAll('input[type="checkbox"][name="tool"]')];
	const enabled = new Set(JSON.parse(localStorage.getItem(TOOLS_KEY) || "[]"));
	checkboxes.forEach((cb) => cb.checked = enabled.has(cb.value));

	const update = () => {
		const enabledValues = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
		toolsDropdown.classList.toggle("has-enabled-tools", enabledValues.length > 0);
		localStorage.setItem(TOOLS_KEY, JSON.stringify(enabledValues));
	};
	checkboxes.forEach((cb) => cb.addEventListener("change", update, { signal }));
	update();
}

function initUpload(root, inputEl, attachmentManager, signal) {
	const uploadBtn = root.querySelector("#chatUploadBtn");
	const uploadInput = root.querySelector("#chatUploadInput");
	const uploadLabel = root.querySelector("#chatUploadLabel");
	if (!uploadBtn || !uploadInput) return;

	const updateCount = () => {
		const count = attachmentManager.getAttachments().length;
		if (count > 0) uploadBtn.dataset.count = String(count);
		else delete uploadBtn.dataset.count;
		uploadLabel && (uploadLabel.textContent = "Upload");
	};

	uploadBtn.addEventListener("click", () => uploadInput.click(), { signal });
	
	uploadInput.addEventListener("change", async () => {
		const selected = Array.from(uploadInput.files ||[]);
		uploadInput.value = "";
		
		for (const file of selected) {
			await attachmentManager.addFile(file);
		}
		
		updateCount();
	}, { signal });

	attachmentManager.options.onAttachmentAdded = updateCount;
	attachmentManager.options.onAttachmentRemoved = updateCount;

	updateCount();
}

function initAutoResize(element, signal) {
	const updatePlaceholder = () => {
		const text = element.textContent || "";
		const hasAttachments = element.querySelector(".inline-attachment");
		const isEmpty = text.trim().length === 0 && !hasAttachments;
		element.dataset.empty = isEmpty ? "true" : "false";
	};
	
	const handleInput = () => {
		updatePlaceholder();
	};
	
	element.addEventListener("input", handleInput, { signal });
	
	element.addEventListener("paste", () => {
		setTimeout(handleInput, 0);
	}, { signal });
	
	requestAnimationFrame(() => {
		updatePlaceholder();
	});
	
	return () => {
		updatePlaceholder();
	};
}

async function loadAndPopulateModels(root, signal) {
	try {
		const response = await getModels();
		const models = response?.data ||[];
		
		setModelMetadata(models);
		
		const modelDropdown = root.querySelector('[data-dropdown="model"]');
		const menu = modelDropdown?.querySelector('.chat-dropdown-menu');
		if (!menu) return;
		
		menu.innerHTML = '';
		
		for (const model of models) {
			if (!model.id) continue;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'chat-dropdown-item';
			btn.setAttribute('role', 'option');
			btn.setAttribute('aria-selected', 'false');
			btn.dataset.value = model.id;
			if (model.context_length) btn.dataset.contextLength = String(model.context_length);

			const displayName = model.id.replace('lmstudio::', '').split('/').pop().replace(/-/g, ' ');
			btn.innerHTML = `<span class="chat-dropdown-item-label">${displayName}</span><span class="chat-dropdown-item-badge">Local</span>`;

			btn.addEventListener('click', () => {
				menu.querySelectorAll('.chat-dropdown-item').forEach(i => {
					i.classList.remove('selected');
					i.setAttribute('aria-selected', 'false');
				});
				btn.classList.add('selected');
				btn.setAttribute('aria-selected', 'true');
				const label = modelDropdown.querySelector('.chat-dropdown-label');
				if (label) label.textContent = displayName;
				modelDropdown.classList.remove('open');
				modelDropdown.querySelector('.chat-dropdown-toggle')?.setAttribute('aria-expanded', 'false');

				const chatId = getCurrentChatId();
				if (chatId) setChatModel(chatId, model.id);
				setLastSelectedModel(model.id);
				
				if (root._updateLiveContext) {
					root._updateLiveContext();
				} else {
					const chat = getChatById(chatId);
					updateContextUI(root, chat);
				}
			});

			menu.appendChild(btn);
		}
		
		selectModelForCurrentChat(root);

		if (root._updateLiveContext) {
			root._updateLiveContext();
		} else {
			const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
			updateContextUI(root, chat);
		}

	} catch (err) {
		console.error('Failed to load models:', err);
		if (root._updateLiveContext) {
			root._updateLiveContext();
		} else {
			const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
			updateContextUI(root, chat);
		}
	}
}

function applyModel(root, modelId) {
	if (!modelId) return false;
	const modelDropdown = root.querySelector('[data-dropdown="model"]');
	if (!modelDropdown) return false;

	const items = modelDropdown.querySelectorAll('.chat-dropdown-item');
	const label = modelDropdown.querySelector('.chat-dropdown-label');
	let matched = false;

	items.forEach((item) => {
		const isMatch = item.dataset.value === modelId;
		item.classList.toggle("selected", isMatch);
		item.setAttribute("aria-selected", String(isMatch));
		if (isMatch) {
			matched = true;
			if (label) {
				const displayName = modelId.replace('lmstudio::', '').split('/').pop().replace(/-/g, ' ');
				label.textContent = displayName;
			}
		}
	});

	if (!matched) {
		console.debug('[ChatPage] model not found in dropdown:', modelId);
	}
	return matched;
}

function selectModelForCurrentChat(root) {
	const chatId = getCurrentChatId();

	// 1. Chat-specific model
	const chatModel = chatId ? getChatModel(chatId) : null;
	if (chatModel) {
		if (applyModel(root, chatModel)) return;
		const settings = SettingsStore.get();
		if (settings?.defaultModel) applyModel(root, settings.defaultModel);
		return;
	}

	// 2. Last model the user explicitly chose
	const lastModel = getLastSelectedModel();
	if (lastModel) {
		if (applyModel(root, lastModel)) return;
	}

	// 3. Settings default
	const settings = SettingsStore.get();
	if (settings?.defaultModel) {
		applyModel(root, settings.defaultModel);
	}
}

function ensureChatExists(setActiveCallback) {
	if (!getCurrentChatId() || !getChatById(getCurrentChatId())) {
		createNewChat();
		renderChatList();
		setActiveCallback && setActiveCallback();
	}
}

export function loadCurrentChat(setActiveCallback) {
	const messages = document.getElementById("chatMessages");
	const empty = document.getElementById("chatEmpty");
	if (!messages) return;

	const currentChatId = getCurrentChatId();
	const chat = currentChatId ? getChatById(currentChatId) : null;
	const graph = chat ? ensureGraph(chat) : null;
	const hasMessages = Boolean(graph && computeThreadNodeIds(graph).length > 0);

	if (empty) empty.hidden = hasMessages;
	if (chat) renderThread(messages, chat, { editingNodeId: null, editingDraft: "" });
	else messages.querySelectorAll(".chat-message, .chat-typing").forEach((el) => el.remove());

	renderChatList();
	setActiveCallback && setActiveCallback();
}

export async function initChatPage(root, currentRouteGetter, setActiveCallback) {
	if (!root) return;
	chatPageAbort?.abort();
	const controller = new AbortController();
	chatPageAbort = controller;
	const { signal } = controller;

	const form = root.querySelector("#chatForm");
	const input = root.querySelector("#chatInput");
	const messages = root.querySelector("#chatMessages");
	const empty = root.querySelector("#chatEmpty");
	if (!form || !input || !messages) return;

	const attachmentManager = new InlineAttachmentManager(input);

	const uiState = {
		editingNodeId: null,
		editingDraft: "",
		typingEl: null,
		typingTimeout: null,
		editingSaveMode: null,
		streamAbort: null,
		flushResponse: null,
		isGenerating: false,
		liveGeneratingNode: null,
		activeStreamId: null,
	};

	const updateLiveContext = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		let extraTokens = 0;

		const parts = attachmentManager.extractParts();
		if (parts && parts.length > 0) {
			extraTokens += estimatePartsTokens(parts);
		}

		if (uiState.isGenerating && uiState.liveGeneratingNode) {
			extraTokens += estimateNodeTokens(uiState.liveGeneratingNode);
		}

		if (uiState.editingNodeId && chat) {
			const node = getNode(ensureGraph(chat), uiState.editingNodeId);
			if (node) {
				extraTokens -= estimateNodeTokens(node);

				let draftParts =[];
				if (node.parts) {
					let textAdded = false;
					for (const part of node.parts) {
						if (part.type === "text" && !textAdded) {
							draftParts.push({ type: "text", content: uiState.editingDraft });
							textAdded = true;
						} else if (part.type !== "text") {
							draftParts.push(part);
						}
					}
					if (!textAdded) draftParts.unshift({ type: "text", content: uiState.editingDraft });
				} else {
					draftParts =[{ type: "text", content: uiState.editingDraft }];
				}
				extraTokens += estimatePartsTokens(draftParts);
			}
		}

		updateContextUI(root, chat, Math.max(0, extraTokens));
	};
	root._updateLiveContext = updateLiveContext;

	await loadAndPopulateModels(root, signal);

	initDropdowns(root, signal);
	initTools(root, signal);
	initUpload(root, input, attachmentManager, signal);
	const resizeInput = initAutoResize(input, signal);

	input.addEventListener("input", () => {
		updateLiveContext();
	}, { signal });

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (uiState.isGenerating) return;
			
			if (e.shiftKey) {
				form.dataset.sendNoReply = "1";
			}
			form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
		}
	}, { signal });

	const urlParams = new URLSearchParams(location.hash.split("?")[1] || "");
	const chatIdFromUrl = urlParams.get("chat");
	if (chatIdFromUrl && getChatById(chatIdFromUrl)) {
		setCurrentChatId(chatIdFromUrl);
		saveChats();
	}

	// Primary ESC handler: runs in capture phase so it fires before any element-level
	// handlers. With contenteditable (instead of <textarea>) this works in all browsers —
	// Firefox no longer intercepts ESC natively, so keydown reaches JS normally.
	document.addEventListener("keydown", (e) => {
		if ((e.key === "Escape" || e.key === "Esc") && uiState.editingNodeId) {
			e.preventDefault();
			uiState.editingNodeId = null;
			uiState.editingDraft = "";
			uiState.editingSaveMode = null;
			rerender();
		}
	}, { capture: true, signal });

	// Safety net: if somehow keydown was missed (edge case browser behaviour),
	// keyup will still cancel the edit since editingNodeId will still be set.
	// On normal paths the keydown handler above already cleared editingNodeId,
	// making this a no-op.
	document.addEventListener("keyup", (e) => {
		if ((e.key === "Escape" || e.key === "Esc") && uiState.editingNodeId) {
			uiState.editingNodeId = null;
			uiState.editingDraft = "";
			uiState.editingSaveMode = null;
			rerender();
		}
	}, { signal });

	const setGeneratingState = (isGenerating) => {
		uiState.isGenerating = isGenerating;
		if (!isGenerating) {
			uiState.liveGeneratingNode = null;
		}
		const sendBtn = form.querySelector('.chat-send-btn');
		if (sendBtn) {
			if (isGenerating) {
				sendBtn.classList.add('generating');
				sendBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="1" width="14" height="14" fill="currentColor"/></svg>`;
				sendBtn.title = "Stop generating";
				sendBtn.setAttribute("aria-label", "Stop generating");
			} else {
				sendBtn.classList.remove('generating');
				sendBtn.innerHTML = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M44.9,23.2l-38-18L6,5A2,2,0,0,0,4,7l6,18L4,43a2,2,0,0,0,2,2l.9-.2,38-18A2,2,0,0,0,44.9,23.2ZM9.5,39.1l4-12.1H24a2,2,0,0,0,0-4H13.5l-4-12.1L39.3,25Z" fill="currentColor"/></svg>`;
				sendBtn.title = "Send (Ctrl+Enter) • Send without reply (Ctrl+Shift+Enter)";
				sendBtn.setAttribute("aria-label", "Send message");
			}
		}
	};

	// FIX: Close the live thinking box in typingEl before stopTyping tears it down.
	// This prevents the open <details> from persisting across the brief gap between
	// stopTyping() removing the element and rerender() inserting the rebuilt (closed) one.
	// User can still open/close the box freely during active generation — this only
	// fires at stream completion, not during streaming.
	const closeTypingReasoning = () => {
		if (uiState.typingEl) {
			const liveReasoning = uiState.typingEl.querySelector('.message-reasoning');
			if (liveReasoning) liveReasoning.open = false;
		}
	};

	const stopTyping = () => {
		if (uiState.activeStreamId) {
			stopChatMessage(uiState.activeStreamId).catch(() => {});
			uiState.activeStreamId = null;
		}
		if (uiState.flushResponse) {
			uiState.flushResponse();
			uiState.flushResponse = null;
		}
		if (uiState.streamAbort) {
			uiState.streamAbort.abort();
			uiState.streamAbort = null;
		}
		if (uiState.typingTimeout) {
			clearTimeout(uiState.typingTimeout);
			uiState.typingTimeout = null;
		}
		if (uiState.typingEl) {
			uiState.typingEl.remove();
			uiState.typingEl = null;
		}
		setGeneratingState(false);
	};

	signal.addEventListener("abort", () => {
		if (uiState.activeStreamId) {
			stopChatMessage(uiState.activeStreamId).catch(() => {});
			uiState.activeStreamId = null;
		}
		if (uiState.flushResponse) {
			uiState.flushResponse();
			uiState.flushResponse = null;
		}
		if (uiState.streamAbort) {
			uiState.streamAbort.abort();
		}
	});

	const startReply = async (parentUserNodeId) => {
		stopTyping();
		uiState.typingEl = showTyping(messages);
		setGeneratingState(true);
		
		const activeChatId = getCurrentChatId();
		
		uiState.streamAbort = new AbortController();
		const currentSignal = uiState.streamAbort.signal;
		uiState.activeStreamId = "stream_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
		
		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value || "";

		if (activeChatId && model) setChatModel(activeChatId, model);

		let maxTokens = getModelMaxTokens(model);
		const contextLimit = getModelContextLimitFromUI(root);
		
		const chat = getChatById(activeChatId);
		if (!chat) {
			stopTyping();
			return;
		}
		
		const graph = ensureGraph(chat);
		const threadIds = computeThreadNodeIds(graph);
		
		const buildNodeTextForHistory = (node) => {
			if (!node) return "";
			let nodeContent = "";
			
			if (node.parts && Array.isArray(node.parts)) {
				const textParts =[];
				const attachmentInfos =[];
				
				for (const part of node.parts) {
					if (part.type === "text" && part.content) {
						textParts.push(part.content);
					} else if (part.type === "attachment") {
						const isImage = part.isImage ? " (image)" : "";
						let attachmentInfo = `[Attachment: ${part.name} (${part.size} bytes)${isImage}]`;
						
						if (part.data && !part.isImage) {
							try {
								const base64Match = part.data.match(/^data:[^;]+;base64,(.+)$/);
								if (base64Match) {
									const chunk = base64Match[1].slice(0, 13336);
									const binaryString = atob(chunk);
									const bytes = new Uint8Array(binaryString.length);
									for (let i = 0; i < binaryString.length; i++) {
										bytes[i] = binaryString.charCodeAt(i);
									}
									const decoder = new TextDecoder('utf-8');
									const textContent = decoder.decode(bytes).slice(0, 10000);
									attachmentInfo += `\n[File Content:]\n${textContent}`;
								}
							} catch (e) {
								console.warn('Could not read file content:', e);
							}
						}
						attachmentInfos.push(attachmentInfo);
					}
				}
				
				nodeContent = textParts.join("");
				if (attachmentInfos.length > 0) {
					nodeContent += "\n" + attachmentInfos.join("\n");
				}
			} else if (node.content) {
				nodeContent = node.content;
			}
			
			if (node.reasoning) {
				nodeContent = `<think>\n${node.reasoning}\n</think>\n\n` + nodeContent;
			}
			
			if (node.toolCalls && Array.isArray(node.toolCalls) && node.toolCalls.length > 0) {
				let toolsText = "";
				for (const tc of node.toolCalls) {
					const inputStr = typeof tc.input === 'object' ? JSON.stringify(tc.input) : String(tc.input || "");
					toolsText += `\n[Tool Execution: ${tc.name}]\nInput: ${inputStr}\nOutput: ${tc.output || ""}\n`;
				}
				nodeContent += toolsText;
			}
			
			return nodeContent;
		};

		const buildApiMessages = (nodeIds) => {
			const apiMessages =[];

			for (const nodeId of nodeIds) {
				const node = getNode(graph, nodeId);
				if (!node) continue;

				const role = node.role === "user" ? "user" : "assistant";

				if (role === "assistant") {
					const textContent = buildNodeTextForHistory(node);
					if (textContent) {
						apiMessages.push({ role, content: textContent });
					}
					continue;
				}

				if (node.parts && Array.isArray(node.parts)) {
					const textParts = [];
					const contentBlocks =[];
					let hasImages = false;

					for (const part of node.parts) {
						if (part.type === "text" && part.content) {
							textParts.push(part.content);
						} else if (part.type === "attachment") {
							if (part.isImage && part.data) {
								hasImages = true;
								contentBlocks.push({
									type: "image_url",
									image_url: { url: part.data },
								});
							} else if (!part.isImage && part.data) {
								try {
									const b64Match = part.data.match(/^data:[^;]+;base64,(.+)$/);
									if (b64Match) {
										const chunk = b64Match[1].slice(0, 13336);
										const binary = atob(chunk);
										const bytes = new Uint8Array(binary.length);
										for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
										const text = new TextDecoder("utf-8").decode(bytes).slice(0, 10000);
										textParts.push(`\n[File: ${part.name}]\n${text}`);
									}
								} catch (e) {
									console.warn("[ChatPage] Could not decode file attachment:", e);
								}
							}
						}
					}

					const combinedText = textParts.join("");

					if (hasImages) {
						// PUSH the text so it appears AFTER the images
						if (combinedText) {
							contentBlocks.push({ type: "text", text: combinedText });
						}
						apiMessages.push({ role, content: contentBlocks });
					} else if (combinedText) {
						apiMessages.push({ role, content: combinedText });
					}
				} else if (node.content) {
					apiMessages.push({ role, content: node.content });
				}
			}

			return apiMessages;
		};

		let conversationHistory = "";
		for (const nodeId of threadIds) {
			const node = getNode(graph, nodeId);
			if (node) {
				const nodeContent = buildNodeTextForHistory(node);
				if (nodeContent) {
					const role = node.role === "user" ? "User" : "Assistant";
					conversationHistory += `${role}: ${nodeContent}\n\n`;
				}
			}
		}
		
		if (!conversationHistory.trim() && parentUserNodeId) {
			const parentNode = getNode(graph, parentUserNodeId);
			if (parentNode) {
				const parentContent = buildNodeTextForHistory(parentNode);
				if (parentContent) {
					conversationHistory = parentContent;
				}
			}
		}
		
		if (!conversationHistory.trim()) {
			conversationHistory = "Hello";
		}

		let apiMessages = buildApiMessages(threadIds);
		if (apiMessages.length === 0 && parentUserNodeId) {
			apiMessages = buildApiMessages([parentUserNodeId]);
		}

		const hasVisionContent = apiMessages.some(m => Array.isArray(m.content));
		const visionMessages = hasVisionContent ? apiMessages : null;

		const estimatedPromptTokens = Math.ceil(conversationHistory.length / 3) + 200;

		if (estimatedPromptTokens + maxTokens > contextLimit) {
			maxTokens = Math.max(256, contextLimit - estimatedPromptTokens);
		}
		
		let rawStreamText = "";
		let officialReasoningText = "";
		let activeToolCalls =[];
		let errorFromStream = null;
		let isSaved = false;

		const currentSettings = SettingsStore.get() ?? {};
		let systemPrompt = currentSettings.systemPrompt ?? "";
		const temperature = (typeof currentSettings.temperature === "number")
			? currentSettings.temperature
			: null;

		if (systemPrompt) {
			const modelLabel = modelSelect?.querySelector(".chat-dropdown-item-label")?.textContent?.trim()
				|| modelSelect?.textContent?.trim()
				|| model;
			systemPrompt = systemPrompt.replaceAll("{model}", modelLabel);

			const TOOL_LABELS = {
				"web-search": "Web Search",
				"code-exec":  "Code Execution",
				"file-read":  "File Reading",
			};
			const enabledToolValues = JSON.parse(localStorage.getItem(TOOLS_KEY) || "[]");
			const toolNames = enabledToolValues.map(v => TOOL_LABELS[v] ?? v);
			const toolsString = toolNames.length > 0 ? toolNames.join(", ") : "none";
			systemPrompt = systemPrompt.replaceAll("{tools}", toolsString);
		}

		if (hasVisionContent) {
			const visionHint = "[System Override: You have native multimodal vision capabilities. The user has attached an image. Analyze the visual data directly. Do not claim you are a text-only reasoning engine or that you cannot see images.]";
			systemPrompt = systemPrompt ? (systemPrompt + "\n\n" + visionHint) : visionHint;
		}

		uiState.flushResponse = () => {
			if (isSaved) return;
			isSaved = true;
			
			let parsedContent = "";
			let parsedReasoning = "";
			let currentStr = rawStreamText;

			while (true) {
				let startIdx = currentStr.indexOf("<think>");
				if (startIdx === -1) {
					parsedContent += currentStr;
					break;
				}
				
				parsedContent += currentStr.substring(0, startIdx);
				let endIdx = currentStr.indexOf("</think>", startIdx + 7);
                
				if (endIdx === -1) {
					parsedReasoning += currentStr.substring(startIdx + 7);
					break;
				} else {
					parsedReasoning += currentStr.substring(startIdx + 7, endIdx) + "\n\n";
					currentStr = currentStr.substring(endIdx + 8);
				}
			}

			let displayReasoning = officialReasoningText;
			if (parsedReasoning) {
				displayReasoning += (displayReasoning ? "\n\n" : "") + parsedReasoning.trim();
			}

			let finalContent = parsedContent.trim();
			let finalReasoning = displayReasoning.trim();

			if (errorFromStream) {
				finalContent += finalContent ? `\n\n**Error:** ${errorFromStream}` : `**Error:** ${errorFromStream}`;
			}

			if (finalContent || finalReasoning || activeToolCalls.length > 0) {
				const node = addChildMessageToChat(activeChatId, parentUserNodeId, "assistant", finalContent);
				if (node) {
					if (finalReasoning) node.reasoning = finalReasoning;
					if (activeToolCalls.length > 0) node.toolCalls = activeToolCalls;
					saveChats();
				}
			} else if (errorFromStream) {
				addChildMessageToChat(activeChatId, parentUserNodeId, "assistant", `**Error:** ${errorFromStream}`);
			}

			uiState.liveGeneratingNode = null;
		};
		
		try {
			await streamChatMessage(
				model,
				conversationHistory,
				maxTokens,
				(chunk) => {
					if (currentSignal.aborted) return;

					if (chunk.error) {
						const errorMsg = typeof chunk.error === 'object'
							? (chunk.error.message || JSON.stringify(chunk.error))
							: String(chunk.error);
						console.debug("[ChatPage] Error in stream chunk:", errorMsg);
						errorFromStream = errorMsg;
						return;
					}

					if (chunk.type === "tool_execution" && chunk.tool_call) {
						activeToolCalls.push({
							id: chunk.tool_call.id,
							name: chunk.tool_call.name,
							input: chunk.tool_call.arguments,
							output: chunk.tool_call.output
						});
					}

					if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
						const delta = chunk.choices[0].delta;
						
						if (delta.reasoning) {
							officialReasoningText += delta.reasoning;
						}
						if (delta.content) {
							rawStreamText += delta.content;
						}
					}

					uiState.liveGeneratingNode = {
						role: "assistant",
						content: rawStreamText,
						reasoning: officialReasoningText,
						toolCalls: activeToolCalls
					};
					updateLiveContext();
						
					if (uiState.typingEl) {
						let parsedContent = "";
						let parsedReasoning = "";
						let currentStr = rawStreamText;

						while (true) {
							let startIdx = currentStr.indexOf("<think>");
							if (startIdx === -1) {
								parsedContent += currentStr;
								break;
							}
							
							parsedContent += currentStr.substring(0, startIdx);
							let endIdx = currentStr.indexOf("</think>", startIdx + 7);
							
							if (endIdx === -1) {
								parsedReasoning += currentStr.substring(startIdx + 7);
								break;
							} else {
								parsedReasoning += currentStr.substring(startIdx + 7, endIdx) + "\n\n";
								currentStr = currentStr.substring(endIdx + 8);
							}
						}

						let displayReasoning = officialReasoningText;
						if (parsedReasoning) {
							displayReasoning += (displayReasoning ? "\n\n" : "") + parsedReasoning.trim();
						}

						if (!uiState.typingEl.querySelector(".chat-message-content")) {
							uiState.typingEl.innerHTML = '';
							uiState.typingEl.className = "chat-message assistant";
						}
						
						let msgContent = uiState.typingEl.querySelector(".chat-message-content");
						if (!msgContent) {
							msgContent = document.createElement("div");
							msgContent.className = "chat-message-content";
							uiState.typingEl.appendChild(msgContent);
						}

						if (displayReasoning) {
							let reasoningEl = msgContent.querySelector('.message-reasoning');
							if (!reasoningEl) {
								reasoningEl = document.createElement('details');
								reasoningEl.className = 'message-reasoning';
								reasoningEl.open = true;
								reasoningEl.innerHTML = '<summary>Thinking...</summary><div class="reasoning-content"></div>';
								msgContent.insertBefore(reasoningEl, msgContent.firstChild);
							}
							const reasoningContent = reasoningEl.querySelector('.reasoning-content');
							if (reasoningContent) reasoningContent.textContent = displayReasoning;
						}

						const existingToolCallEls = msgContent.querySelectorAll('.message-tool-call');
						if (activeToolCalls.length > existingToolCallEls.length) {
							for (let i = existingToolCallEls.length; i < activeToolCalls.length; i++) {
								const tcEl = buildToolCallElement(activeToolCalls[i]);
								const textWrapper = msgContent.querySelector('.chat-message-text');
								textWrapper
									? msgContent.insertBefore(tcEl, textWrapper)
									: msgContent.appendChild(tcEl);
							}
						}

						if (parsedContent) {
							let textWrapper = msgContent.querySelector('.chat-message-text');
							if (!textWrapper) {
								textWrapper = document.createElement('div');
								textWrapper.className = 'chat-message-text';
								msgContent.appendChild(textWrapper);
							}
							const preprocessed = preprocessLatexText(parsedContent);
							const { text, mathBlocks } = extractMath(preprocessed);
							const finalHtml = injectMath(parseMarkdown(text), mathBlocks);
							textWrapper.innerHTML = finalHtml;
						} else {
							msgContent.querySelector('.chat-message-text')?.remove();
						}
						
						if (messages) {
							const scrollEl = messages.closest('.content') || messages;
							scrollEl.scrollTop = scrollEl.scrollHeight;
						}
					}
				},
				currentSignal,
				systemPrompt,
				temperature,
				contextLimit,
				uiState.activeStreamId,
				visionMessages,
			);
			
			if (errorFromStream) {
				throw new Error(errorFromStream);
			}

			if (!rawStreamText && !officialReasoningText && activeToolCalls.length === 0) {
				throw new Error("Empty response from AI");
			}

			// FIX: Close the live thinking box before teardown so the open state doesn't
			// persist across the microtask gap between stopTyping() and rerender().
			closeTypingReasoning();
			stopTyping();
			rerender();
			setActiveCallback && setActiveCallback();
			
		} catch (err) {
			console.error("[ChatPage] Stream error:", err);
			// FIX: Same close-before-teardown on the error path.
			closeTypingReasoning();
			stopTyping();
			
			if (!isSaved) {
				const errorText = err?.message || String(err);
				if (errorText && errorText !== "Empty response from AI") {
					addChildMessageToChat(activeChatId, parentUserNodeId, "assistant", `**Error:** ${errorText}`);
					saveChats();
				}
			}
			
			rerender();
			setActiveCallback && setActiveCallback();
		}
	};

	const rerender = () => {
		const currentChatId = getCurrentChatId();
		const chat = currentChatId ? getChatById(currentChatId) : null;
		const graph = chat ? ensureGraph(chat) : null;
		const hasMessages = Boolean(graph && computeThreadNodeIds(graph).length > 0);

		if (empty) empty.hidden = hasMessages || uiState.isGenerating;
		if (chat) renderThread(messages, chat, uiState);
		else messages.querySelectorAll(".chat-message, .chat-typing").forEach((el) => el.remove());

		if (uiState.editingNodeId) {
			const editEl = messages.querySelector(".chat-edit-input");
			if (editEl) {
				editEl.focus();
				// Place cursor at end of content
				const range = document.createRange();
				const sel = window.getSelection();
				range.selectNodeContents(editEl);
				range.collapse(false); // false = collapse to end
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		}

		updateLiveContext();
	};

	messages.addEventListener("click", (e) => {
		const btn = e.target.closest(".chat-action-btn");
		if (!btn) return;

		const action = btn.dataset.action;
		const msgEl = btn.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (!nodeId) return;

		const currentChatId = getCurrentChatId();
		const chat = currentChatId ? getChatById(currentChatId) : null;
		if (!chat) return;
		const graph = ensureGraph(chat);
		const node = getNode(graph, nodeId);
		if (!node) return;

		const handlers = {
			thread: () => {
				stopTyping();
				const branched = branchFromNode(graph, nodeId);
				if (branched) {
					recomputeLeafId(graph);
					chat.updatedAt = Date.now();
					saveChats();
					uiState.editingNodeId = null;
					uiState.editingDraft = "";
					uiState.editingSaveMode = null;
					rerender();
					renderChatList();
					setActiveCallback && setActiveCallback();
				}
			},
			edit: () => {
				stopTyping();
				uiState.editingNodeId = nodeId;

				let textToEdit = "";
				if (node.parts) {
					textToEdit = node.parts.filter(p => p.type === "text").map(p => p.content).join("");
				} else {
					textToEdit = String(node.content || "");
				}

				uiState.editingDraft = textToEdit;
				uiState.editingSaveMode = null;

				// Patch only this message in-place — avoids tearing down and
				// rebuilding the whole thread, which causes Chromium to paint an
				// intermediate empty-container state that squishes other messages.
				const patched = patchMessageEditState(messages, graph, node, true, textToEdit);
				if (!patched) { rerender(); return; }

				// Focus + place cursor at end
				const editEl = messages.querySelector('.chat-edit-input');
				if (editEl) {
					editEl.focus({ preventScroll: true });
					const range = document.createRange();
					const sel = window.getSelection();
					range.selectNodeContents(editEl);
					range.collapse(false);
					sel?.removeAllRanges();
					sel?.addRange(range);
				}
				updateLiveContext();
			},
			cancel: () => {
				const cancelNodeId = uiState.editingNodeId;
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				const cancelNode = cancelNodeId ? getNode(graph, cancelNodeId) : null;
				const patched = cancelNode
					? patchMessageEditState(messages, graph, cancelNode, false, null)
					: false;
				if (!patched) rerender();
				else updateLiveContext();
			},
			save: () => {
				const editEl = msgEl.querySelector(".chat-edit-input");
				const next = editEl ? (editEl.innerText ?? "").trimEnd() : uiState.editingDraft;
				
				const oldText = node.parts 
					? node.parts.filter(p => p.type === "text").map(p => p.content).join("")
					: String(node.content || "");
				
				if (String(next) === oldText) {
					uiState.editingNodeId = null;
					uiState.editingDraft = "";
					uiState.editingSaveMode = null;
					rerender();
					return;
				}

				stopTyping();

				const saveMode = uiState.editingSaveMode ?? "reset";

				if (saveMode === "preserve") {
					if (node.parts) {
						let textSet = false;
						node.parts = node.parts.map(p => {
							if (p.type === "text" && !textSet) {
								textSet = true;
								return { ...p, content: next };
							}
							return p;
						});
						if (!textSet) node.parts.unshift({ type: "text", content: next });
					} else {
						node.content = next;
					}
					node.editedAt = Date.now();
					chat.updatedAt = Date.now();
					saveChats();
					uiState.editingNodeId = null;
					uiState.editingDraft = "";
					uiState.editingSaveMode = null;
					rerender();
					setActiveCallback && setActiveCallback();
				} else {
					const sibling = createSiblingCopy(graph, nodeId);
					if (!sibling) return;

					if (sibling.parts) {
						let textSet = false;
						sibling.parts = sibling.parts.map(p => {
							if (p.type === "text" && !textSet) {
								textSet = true;
								return { ...p, content: next };
							}
							return p;
						});
						if (!textSet) sibling.parts.unshift({ type: "text", content: next });
					} else {
						sibling.content = next;
					}
					sibling.editedAt = Date.now();

					recomputeLeafId(graph);
					chat.updatedAt = Date.now();
					saveChats();
					uiState.editingNodeId = null;
					uiState.editingDraft = "";
					uiState.editingSaveMode = null;

					rerender();
					setActiveCallback && setActiveCallback();

					if (empty) empty.hidden = true;
					startReply(sibling.id);
				}
			},
			back: () => {
				setSelectedChildId(graph, node.parentId, nodeId, -1);
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				setActiveCallback && setActiveCallback();
			},
			forward: () => {
				setSelectedChildId(graph, node.parentId, nodeId, +1);
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				setActiveCallback && setActiveCallback();
			},
			resend: () => {
				stopTyping();
				
				let userNodeId = node.role === "user" ? node.id : node.parentId;
				let userNode = getNode(graph, userNodeId);
				if (!userNode) return;

				const childrenToDelete = [...(userNode.children || [])];
				childrenToDelete.forEach((childId) => deleteSubtree(graph, childId));

				delete graph.selections[userNodeId];

				if (userNode.parentId) {
					setSelectedChildId(graph, userNode.parentId, userNodeId);
				}

				recomputeLeafId(graph);
				
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				
				rerender();
				setActiveCallback && setActiveCallback();
				
				if (empty) empty.hidden = true;
				startReply(userNodeId);
			},
			copy: async () => {
				let textToCopy = node.parts 
					? node.parts.filter(p => p.type === "text").map(p => p.content).join("")
					: String(node.content || "");
				
				try {
					await navigator.clipboard.writeText(textToCopy);
					const oldHTML = btn.innerHTML;
					btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
					setTimeout(() => {
						if (btn) btn.innerHTML = oldHTML;
					}, 2000);
				} catch (err) {
					console.error("Failed to copy text: ", err);
				}
			},
			delete: () => {
				stopTyping();
				if (e.shiftKey) {
					spliceDeleteNode(graph, nodeId);
				} else {
					deleteSubtree(graph, nodeId);
				}
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				renderChatList();
				setActiveCallback && setActiveCallback();
			},
		};

		handlers[action]?.();
	}, { signal });

	messages.addEventListener("keydown", (e) => {
		const editEl = e.target.closest(".chat-edit-input");
		if (!editEl) return;
		const msgEl = editEl.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (!nodeId) return;

		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			// Ctrl/Cmd+Enter: save the edit
			e.preventDefault();
			uiState.editingSaveMode = e.shiftKey ? "preserve" : "reset";
			msgEl.querySelector('button[data-action="save"]')?.click();
		} else if (e.key === "Enter") {
			// Plain Enter: insert a literal newline character.
			// If we allow the default, browsers insert a <div> or <br> element
			// which corrupts the plain-text content we read back via innerText.
			e.preventDefault();
			// execCommand('insertText') is the most cross-browser reliable way to
			// insert text at the caret, handling selection replacement automatically.
			// It is deprecated in spec but supported in every current browser and
			// triggers the 'input' event so our draft-sync handler fires normally.
			document.execCommand("insertText", false, "\n");
		} else if (e.key === "Escape" || e.key === "Esc") {
			// Belt-and-suspenders: fires on Chrome/Safari where keydown works fine
			// (the document capture handler above handles it first, making editingNodeId
			// null so this becomes a no-op). On Firefox the keyup handler is primary.
			e.preventDefault();
			const escNodeId = uiState.editingNodeId;
			uiState.editingNodeId = null;
			uiState.editingDraft = "";
			uiState.editingSaveMode = null;
			const escNode = escNodeId ? getNode(graph, escNodeId) : null;
			const patched = escNode
				? patchMessageEditState(messages, graph, escNode, false, null)
				: false;
			if (!patched) rerender();
		}
	}, { signal });

	messages.addEventListener("input", (e) => {
		const editEl = e.target.closest(".chat-edit-input");
		if (!editEl) return;
		const msgEl = editEl.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (nodeId && uiState.editingNodeId === nodeId) {
			// innerText reflects what the user sees, including \n for line breaks.
			// A lone <br> inserted by some browsers into an empty contenteditable
			// reads as "\n" via innerText — we strip a single trailing newline here
			// so the draft doesn't accumulate phantom whitespace.
			uiState.editingDraft = (editEl.innerText ?? "").replace(/\n$/, "");
			updateLiveContext();
		}
	}, { signal });

	document.addEventListener("copy", (e) => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) return;

		const range = selection.getRangeAt(0);
		if (!messages.contains(range.commonAncestorContainer)) return;

		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		const graph = chat ? ensureGraph(chat) : null;

		const nodeRawText = (node) => {
			if (!node) return "";
			if (node.parts && Array.isArray(node.parts)) {
				return node.parts.filter(p => p.type === "text").map(p => p.content).join("");
			}
			return String(node.content || "");
		};

		const allMsgEls = [...messages.querySelectorAll(".chat-message[data-node-id]")];
		const selectedMsgEls = allMsgEls.filter(el => range.intersectsNode(el));

		let plainPayload = "";

		if (graph && selectedMsgEls.length > 0) {
			const parts =[];
			for (const msgEl of selectedMsgEls) {
				const node = getNode(graph, msgEl.dataset.nodeId);
				const raw = nodeRawText(node);
				if (raw) parts.push(raw);
			}
			plainPayload = parts.join("\n\n");
		}

		if (!plainPayload) plainPayload = selection.toString();

		const container = document.createElement("div");
		container.appendChild(range.cloneContents());

		container
			.querySelectorAll(".chat-message-menu, .md-code-header, .chat-typing, .chat-message-inline-attachment, .latex-preamble")
			.forEach(el => el.remove());

		container.querySelectorAll(".message-tool-call").forEach(el => {
			const summary = el.querySelector("summary");
			el.replaceWith(document.createTextNode(summary ? summary.textContent.trim() : ""));
		});

		container.querySelectorAll(".katex-display").forEach(el => {
			const src = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
			if (src) el.replaceWith(document.createTextNode(`$$${src}$$`));
		});
		container.querySelectorAll(".katex").forEach(el => {
			const src = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
			if (src) el.replaceWith(document.createTextNode(`$${src}$`));
		});

		const htmlPayload = `<!DOCTYPE html><html><body>${container.innerHTML}</body></html>`;

		e.preventDefault();
		if (!e.clipboardData) return;
		e.clipboardData.setData("text/plain", plainPayload);
		try {
			e.clipboardData.setData("text/html", htmlPayload);
		} catch {
		}
	}, { signal });

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		if (uiState.isGenerating) {
			stopTyping();
			rerender();
			setActiveCallback && setActiveCallback();
			return;
		}
		
		const parts = attachmentManager.extractParts();
		if (!parts || parts.length === 0) return;

		ensureChatExists(setActiveCallback);
		if (empty) empty.hidden = true;

		stopTyping();
		uiState.editingNodeId = null;
		uiState.editingDraft = "";
		uiState.editingSaveMode = null;

		const userNode = addMessageToChat(getCurrentChatId(), "user", "", null, parts);
		
		attachmentManager.clear();
		const uploadBtn = root.querySelector("#chatUploadBtn");
		if (uploadBtn) delete uploadBtn.dataset.count;
		if (resizeInput) resizeInput();
		
		rerender();
		renderChatList();
		setActiveCallback && setActiveCallback();

		const sendNoReply = form.dataset.sendNoReply === "1";
		delete form.dataset.sendNoReply;
		if (!sendNoReply && userNode?.id) {
			startReply(userNode.id);
		}
	}, { signal });

	rerender();
	input.focus();
}