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
import { updateContextUI, setModelMetadata, getModelMaxTokens, getModelContextLimitFromUI } from "./context.js";
import { getModels, getLmStudioModels } from "../api.js";
import { formatBytes } from "./util.js";
import { renderThread, showTyping, buildToolCallElement } from "./thread-ui.js";
import { InlineAttachmentManager } from "./inline-attachment.js";
import { parseMarkdown } from "./markdown.js";
import { preprocessLatexText, extractMath, injectMath } from "./latex.js";
import { streamChatMessage } from "../api.js";
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
	const checkboxes =[...toolsDropdown.querySelectorAll('input[type="checkbox"][name="tool"]')];
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

function isImageFile(file) {
	const type = String(file?.type || "");
	if (type.startsWith("image/")) return true;
	return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(file?.name || ""));
}

function makeXIcon() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`;
}

function renderAttachments(root, pending) {
	const wrap = root.querySelector("#chatAttachments");
	if (!wrap) return;
	if (!pending.length) {
		wrap.hidden = true;
		wrap.innerHTML = "";
		return;
	}
	wrap.hidden = false;
	const list = document.createElement("div");
	list.className = "chat-attachments-list";

	pending.forEach((item) => {
		const row = document.createElement("div");
		row.className = "chat-attachment";
		row.dataset.attachmentId = item.id;

		const thumb = document.createElement("div");
		thumb.className = "chat-attachment-thumb";
		thumb.setAttribute("aria-hidden", "true");
		if (item.isImage && item.previewUrl) {
			const img = document.createElement("img");
			img.src = item.previewUrl;
			img.alt = "";
			thumb.appendChild(img);
		} else {
			thumb.textContent = "FILE";
		}

		const meta = document.createElement("div");
		meta.className = "chat-attachment-meta";
		const name = document.createElement("div");
		name.className = "chat-attachment-name";
		name.textContent = item.file.name;
		const size = document.createElement("div");
		size.className = "chat-attachment-size";
		size.textContent = formatBytes(item.file.size);
		meta.append(name, size);

		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "chat-attachment-remove";
		remove.setAttribute("aria-label", `Remove ${item.file.name}`);
		remove.title = "Remove";
		remove.dataset.action = "remove-attachment";
		remove.dataset.attachmentId = item.id;
		remove.innerHTML = makeXIcon();

		row.append(thumb, meta, remove);
		list.appendChild(row);
	});

	wrap.innerHTML = "";
	wrap.appendChild(list);
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
	const resize = () => {
		element.style.height = "auto";
		const newHeight = Math.min(element.scrollHeight, 300);
		element.style.height = newHeight + "px";
	};
	
	const updatePlaceholder = () => {
		const text = element.textContent || "";
		const hasAttachments = element.querySelector(".inline-attachment");
		const isEmpty = text.trim().length === 0 && !hasAttachments;
		element.dataset.empty = isEmpty ? "true" : "false";
	};
	
	const handleInput = () => {
		resize();
		updatePlaceholder();
	};
	
	element.addEventListener("input", handleInput, { signal });
	
	element.addEventListener("paste", () => {
		setTimeout(handleInput, 0);
	}, { signal });
	
	requestAnimationFrame(() => {
		resize();
		updatePlaceholder();
	});
	
	window.addEventListener("resize", resize, { signal });
	
	return () => {
		resize();
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
		
		// Update context lengths on existing (static HTML) items
		const modelMap = new Map();
		for (const model of models) {
			if (model.id) modelMap.set(model.id, model);
		}
		const existingItems = menu.querySelectorAll('.chat-dropdown-item');
		for (const item of existingItems) {
			const modelId = item.dataset.value;
			if (modelId && modelMap.has(modelId)) {
				const model = modelMap.get(modelId);
				if (model.context_length) item.dataset.contextLength = model.context_length;
			}
		}
		
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		updateContextUI(root, chat);

		// ── LM Studio models (fire-and-forget, don't block OR models) ──────────
		loadLmStudioModels(root, signal).catch(() => {});
		
	} catch (err) {
		console.error('Failed to load models:', err);
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		updateContextUI(root, chat);
	}
}

async function loadLmStudioModels(root, signal) {
	const modelDropdown = root.querySelector('[data-dropdown="model"]');
	const menu = modelDropdown?.querySelector('.chat-dropdown-menu');
	if (!menu) return;

	// Remove any existing LM Studio section
	menu.querySelectorAll('.chat-dropdown-separator[data-source="lmstudio"], .chat-dropdown-item[data-source="lmstudio"]')
		.forEach(el => el.remove());

	let lmData;
	try {
		const res = await getLmStudioModels();
		lmData = res?.data;
	} catch { return; }

	if (!lmData || lmData.length === 0) return;

	// Divider
	const sep = document.createElement('div');
	sep.className = 'chat-dropdown-separator';
	sep.setAttribute('data-source', 'lmstudio');
	sep.setAttribute('role', 'separator');
	sep.setAttribute('aria-hidden', 'true');
	sep.innerHTML = '<span>LM Studio</span>';
	menu.appendChild(sep);

	for (const model of lmData) {
		if (!model.id) continue;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'chat-dropdown-item';
		btn.setAttribute('role', 'option');
		btn.setAttribute('aria-selected', 'false');
		btn.setAttribute('data-source', 'lmstudio');
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
			const chat = getChatById(chatId);
			updateContextUI(root, chat);
		});

		menu.appendChild(btn);
	}

	// === NEW: add LM Studio models to metadata map (so context window works reliably) ===
	setModelMetadata(lmData);

	// Determine which model should be active:
	//   1. The current chat's saved model (if it's an LM Studio model)
	//   2. The last manually-selected model (if it's LM Studio and no chat model is set)
	const chatId = getCurrentChatId();
	const chatModel = chatId ? getChatModel(chatId) : null;
	const lastModel = getLastSelectedModel();
	const targetModel = chatModel?.startsWith('lmstudio::')
		? chatModel
		: (!chatModel && lastModel?.startsWith('lmstudio::'))
			? lastModel
			: null;

	if (targetModel) {
		const match = menu.querySelector(`.chat-dropdown-item[data-value="${CSS.escape(targetModel)}"]`);
		if (match) {
			menu.querySelectorAll('.chat-dropdown-item').forEach(i => {
				i.classList.remove('selected');
				i.setAttribute('aria-selected', 'false');
			});
			match.classList.add('selected');
			match.setAttribute('aria-selected', 'true');
			const label = modelDropdown.querySelector('.chat-dropdown-label');
			const displayName = targetModel.replace('lmstudio::', '').split('/').pop().replace(/-/g, ' ');
			if (label) label.textContent = displayName;
		}
	}

	// Always refresh the context-window display now that metadata is populated
	// and the correct model is selected.
	const chat = chatId ? getChatById(chatId) : null;
	updateContextUI(root, chat);
}

/**
 * Apply a specific model ID to the model dropdown.
 * Returns true if the model was found and selected; false otherwise.
 * @param {Element} root
 * @param {string}  modelId
 * @returns {boolean}
 */
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
			if (label) label.textContent = item.textContent.trim();
		}
	});

	if (!matched) {
		console.debug('[ChatPage] model not found in dropdown:', modelId);
	}
	return matched;
}

/**
 * Choose and apply the right model for the currently active chat:
 *   1. The chat's own saved model — if found in the dropdown, use it.
 *      If saved but unavailable, fall straight to the settings default (skip lastModel).
 *   2. The last model the user explicitly picked (localStorage) — only when no chat model is set.
 *   3. The settings default model.
 *
 * Auto-selection via this function does NOT update lastSelectedModel.
 * @param {Element} root
 */
/**
 * For LM Studio models that haven't loaded into the DOM yet, immediately
 * stamp the human-readable name onto the dropdown label so the user never
 * sees the stale HTML-default model name while waiting for the async fetch.
 * loadLmStudioModels() will create the real item and mark it selected later.
 */
function primeDropdownLabelForLmStudio(root, modelId) {
	const modelDropdown = root.querySelector('[data-dropdown="model"]');
	if (!modelDropdown) return;
	const label = modelDropdown.querySelector('.chat-dropdown-label');
	if (!label) return;
	// Deselect every existing item so nothing conflicts
	modelDropdown.querySelectorAll('.chat-dropdown-item').forEach(i => {
		i.classList.remove('selected');
		i.setAttribute('aria-selected', 'false');
	});
	// Show the model name right away — strip the prefix and path
	const displayName = modelId.replace('lmstudio::', '').split('/').pop().replace(/-/g, ' ');
	label.textContent = displayName;
}

function selectModelForCurrentChat(root) {
	const chatId = getCurrentChatId();

	// 1. Chat-specific model
	const chatModel = chatId ? getChatModel(chatId) : null;
	if (chatModel) {
		// Found in dropdown → use it
		if (applyModel(root, chatModel)) return;
		// LM Studio models load asynchronously — the item isn't in the DOM yet.
		// Prime the label immediately so the user sees the right name straight
		// away, then loadLmStudioModels() will do the proper selection.
		if (chatModel.startsWith('lmstudio::')) {
			primeDropdownLabelForLmStudio(root, chatModel);
			return;
		}
		// Saved but no longer available → fall back to settings default, not lastModel
		const settings = SettingsStore.get();
		if (settings?.defaultModel) applyModel(root, settings.defaultModel);
		return;
	}

	// 2. Last model the user explicitly chose (no chat-specific preference set).
	const lastModel = getLastSelectedModel();
	if (lastModel) {
		// LM Studio: prime the label now; loadLmStudioModels() will finish the job.
		if (lastModel.startsWith('lmstudio::')) {
			primeDropdownLabelForLmStudio(root, lastModel);
			return;
		}
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

	// Apply the right model immediately — loadAndPopulateModels only adds
	// context-length metadata, it doesn't create or select items, so this
	// works against the HTML-rendered items with no network round-trip.
	selectModelForCurrentChat(root);

	await loadAndPopulateModels(root, signal);

	initDropdowns(root, signal);
	initTools(root, signal);
	initUpload(root, input, attachmentManager, signal);
	const resizeInput = initAutoResize(input, signal);

	const urlParams = new URLSearchParams(location.hash.split("?")[1] || "");
	const chatIdFromUrl = urlParams.get("chat");
	if (chatIdFromUrl && getChatById(chatIdFromUrl)) {
		setCurrentChatId(chatIdFromUrl);
		saveChats();
	}

	const uiState = {
		editingNodeId: null,
		editingDraft: "",
		typingEl: null,
		typingTimeout: null,
		editingSaveMode: null,
		streamAbort: null,
		flushResponse: null,
		isGenerating: false,
	};

	// Capture-phase document listener so ESC cancels editing regardless of
	// which element currently has focus (e.g. user clicked outside the textarea).
	document.addEventListener("keydown", (e) => {
		if ((e.key === "Escape" || e.key === "Esc") && uiState.editingNodeId) {
			e.preventDefault();
			e.stopPropagation();
			uiState.editingNodeId = null;
			uiState.editingDraft = "";
			uiState.editingSaveMode = null;
			rerender();
		}
	}, { signal, capture: true });

	const setGeneratingState = (isGenerating) => {
		uiState.isGenerating = isGenerating;
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

	const stopTyping = () => {
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
		
		const modelSelect = root.querySelector('[data-dropdown="model"] .chat-dropdown-item.selected');
		const model = modelSelect?.dataset?.value || "arcee-ai/trinity-large-preview:free";

		// Persist the model actually used for this reply — this is the authoritative
		// save point and handles the case where the user picked a model before the
		// chat object existed (new chat flow).
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
		
		let conversationHistory = "";
		for (const nodeId of threadIds) {
			const node = getNode(graph, nodeId);
			if (node) {
				let nodeContent = "";
				
				if (node.parts && Array.isArray(node.parts)) {
					const textParts = [];
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
				
				if (nodeContent) {
					const role = node.role === "user" ? "User" : "Assistant";
					conversationHistory += `${role}: ${nodeContent}\n\n`;
				}
			}
		}
		
		if (!conversationHistory.trim() && parentUserNodeId) {
			const parentNode = getNode(graph, parentUserNodeId);
			if (parentNode) {
				let parentContent = "";
				
				if (parentNode.parts && Array.isArray(parentNode.parts)) {
					const textParts =[];
					const attachmentInfos =[];
					
					for (const part of parentNode.parts) {
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
					
					parentContent = textParts.join("");
					if (attachmentInfos.length > 0) {
						parentContent += "\n" + attachmentInfos.join("\n");
					}
				} else if (parentNode.content) {
					parentContent = parentNode.content;
				}
				
				if (parentContent) {
					conversationHistory = parentContent;
				}
			}
		}
		
		if (!conversationHistory.trim()) {
			conversationHistory = "Hello";
		}

		// Calculate safe token bounds to completely prevent ContextLengthExceeded errors
		const estimatedPromptTokens = Math.ceil(conversationHistory.length / 3) + 200;

		// Shrink the requested max tokens if it mathematically pushes us out of the context window
		if (estimatedPromptTokens + maxTokens > contextLimit) {
			maxTokens = Math.max(256, contextLimit - estimatedPromptTokens);
		}
		
		let rawStreamText = "";
		let officialReasoningText = "";
		let activeToolCalls =[];
		let errorFromStream = null;
		let isSaved = false;

		// Resolve system prompt and temperature from the settings store (synchronous – no extra
		// network round-trip; the store keeps itself fresh via background polling).
		const currentSettings = SettingsStore.get() ?? {};
		let systemPrompt = currentSettings.systemPrompt ?? "";
		const temperature = (typeof currentSettings.temperature === "number")
			? currentSettings.temperature
			: null;

		// Expand placeholders in the system prompt.
		if (systemPrompt) {
			// {model} → human-readable model name shown in the dropdown label,
			// falling back to the raw model ID if the label isn't available.
			const modelLabel = modelSelect?.querySelector(".chat-dropdown-item-label")?.textContent?.trim()
				|| modelSelect?.textContent?.trim()
				|| model;
			systemPrompt = systemPrompt.replaceAll("{model}", modelLabel);

			// {tools} → comma-separated list of enabled tool names, or "none".
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

					// Custom event sent by backend when a tool finishes executing
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
						
						msgContent.innerHTML = '';
						
						if (displayReasoning) {
							const openAttr = parsedContent ? '' : 'open';
							const reasoningHtml = `<details class="message-reasoning" ${openAttr}><summary>Thinking...</summary><div class="reasoning-content">${escapeHtml(displayReasoning)}</div></details>`;
							msgContent.insertAdjacentHTML('beforeend', reasoningHtml);
						}

						if (activeToolCalls.length > 0) {
							activeToolCalls.forEach(tc => {
								msgContent.appendChild(buildToolCallElement(tc));
							});
						}

						if (parsedContent) {
							const preprocessed = preprocessLatexText(parsedContent);
							const { text, mathBlocks } = extractMath(preprocessed);
							const finalHtml = injectMath(parseMarkdown(text), mathBlocks);
							const wrapper = document.createElement("div");
							wrapper.className = "chat-message-text";
							wrapper.innerHTML = finalHtml;
							msgContent.appendChild(wrapper);
						}
						
						if (messages) messages.scrollTop = messages.scrollHeight;
					}
				},
				currentSignal,
				systemPrompt,
				temperature,
				contextLimit,
			);
			
			if (errorFromStream) {
				throw new Error(errorFromStream);
			}

			if (!rawStreamText && !officialReasoningText && activeToolCalls.length === 0) {
				throw new Error("Empty response from AI");
			}
			
			stopTyping();
			rerender();
			setActiveCallback && setActiveCallback();
			
		} catch (err) {
			if (currentSignal.aborted || err.name === 'AbortError') {
				if (uiState.flushResponse) {
					uiState.flushResponse();
					uiState.flushResponse = null;
				}
				return;
			}
			
			console.error("[ChatPage] AI request failed:", err);
			errorFromStream = err.message || String(err) || "Unknown error";
			stopTyping();
			rerender();
			setActiveCallback && setActiveCallback();
		}
	};

	const rerender = () => {
		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		if (!chat) return;
		renderThread(messages, chat, uiState);
		updateContextUI(root, chat);

		// Bug 3 fix: keep the empty-state banner in sync after any rerender (e.g. after delete)
		const g = ensureGraph(chat);
		const hasMessages = computeThreadNodeIds(g).length > 0;
		if (empty) empty.hidden = hasMessages;

		if (uiState.editingNodeId) {
			requestAnimationFrame(() => {
				const el = messages.querySelector(`.chat-message[data-node-id="${uiState.editingNodeId}"] .chat-edit-input`);
				if (el) {
					el.focus();
					// Bug 2 fix: auto-size the edit textarea to its content on first render
					el.style.height = "auto";
					el.style.height = el.scrollHeight + "px";
				}
			});
		}
	};

	loadCurrentChat(() => setActiveCallback && setActiveCallback());

	input.addEventListener("keydown", (e) => {
		if (e.isComposing) return;
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (uiState.isGenerating) return;
			form.dataset.sendNoReply = e.shiftKey ? "1" : "";
			form.requestSubmit();
		}
	}, { signal });

	messages.addEventListener("click", (e) => {
		// Code block copy action
		const codeCopyBtn = e.target.closest('.md-code-copy');
		if (codeCopyBtn) {
			e.preventDefault();
			e.stopPropagation();
			const wrapper = codeCopyBtn.closest('.md-code-wrapper');
			const codeEl = wrapper?.querySelector('code');
			if (codeEl) {
				navigator.clipboard.writeText(codeEl.textContent).then(() => {
					const oldHtml = codeCopyBtn.innerHTML;
					codeCopyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>`;
					codeCopyBtn.style.color = "var(--accent)";
					setTimeout(() => {
						codeCopyBtn.innerHTML = oldHtml;
						codeCopyBtn.style.color = "";
					}, 2000);
				}).catch(err => {
					console.error("Failed to copy code", err);
				});
			}
			return;
		}

		// Code block collapse action (entire header)
		const codeHeader = e.target.closest('.md-code-header');
		if (codeHeader) {
			e.preventDefault();
			e.stopPropagation();
			const wrapper = codeHeader.closest('.md-code-wrapper');
			if (wrapper) {
				wrapper.classList.toggle('collapsed');
			}
			return;
		}

		const btn = e.target.closest("button[data-action]");
		if (!btn) return;
		const action = btn.dataset.action;
		const msgEl = btn.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (!action || !nodeId) return;

		const chatId = getCurrentChatId();
		const chat = chatId ? getChatById(chatId) : null;
		if (!chat) return;
		const graph = ensureGraph(chat);
		const node = getNode(graph, nodeId);
		if (!node) return;

		const handlers = {
			thread: () => {
				stopTyping();
				branchFromNode(graph, nodeId, { preserveSelectedTail: false });
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				renderChatList();
				setActiveCallback && setActiveCallback();
			},
			delete: () => {
				stopTyping();
				if (e.shiftKey) {
					spliceDeleteNode(graph, nodeId);
				} else {
					deleteSubtree(graph, nodeId);
					recomputeLeafId(graph);
				}
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				// Bug 3 fix: if the deletion left the thread empty, spin up a fresh chat so
				// the user immediately has a clean thread to work in.
				if (computeThreadNodeIds(graph).length === 0) {
					createNewChat();
				}
				rerender();
				renderChatList();
				setActiveCallback && setActiveCallback();
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
				rerender();
			},
			cancel: () => {
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
			},
			save: () => {
				const textarea = msgEl.querySelector(".chat-edit-input");
				const next = textarea ? textarea.value.trimEnd() : uiState.editingDraft;
				
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
				let effectiveNode = node;

				const getUpdatedParts = () => {
					if (node.parts) {
						const newParts =[];
						let textAdded = false;
						for (const part of node.parts) {
							if (part.type === "text") {
								if (!textAdded) {
									newParts.push({ type: "text", content: next });
									textAdded = true;
								}
							} else {
								newParts.push(JSON.parse(JSON.stringify(part)));
							}
						}
						if (!textAdded) {
							newParts.unshift({ type: "text", content: next });
						}
						return newParts;
					}
					return null;
				};

				if (node.role === "assistant") {
					const preserve = uiState.editingSaveMode === "preserve";
					const branched = branchFromNode(graph, nodeId, { preserveSelectedTail: preserve });
					if (branched) {
						branched.content = String(next);
						const updatedParts = getUpdatedParts();
						if (updatedParts) branched.parts = updatedParts;
						branched.editedAt = Date.now();
						effectiveNode = branched;
						if (!preserve) {
							effectiveNode.children =[];
							delete graph.selections[effectiveNode.id];
							recomputeLeafId(graph);
						} else {
							recomputeLeafId(graph);
						}
					}
				} else {
					const hadResponse = nodeHasGeneratedResponse(graph, nodeId);
					if (hadResponse) {
						const updatedParts = getUpdatedParts();
						const sibling = createSiblingCopy(graph, nodeId, { 
							content: next, 
							timestamp: Date.now(),
							parts: updatedParts
						});
						if (sibling) effectiveNode = sibling;
					} else {
						node.content = String(next);
						const updatedParts = getUpdatedParts();
						if (updatedParts) node.parts = updatedParts;
						node.editedAt = Date.now();
						recomputeLeafId(graph);
					}
				}

				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				renderChatList();
				setActiveCallback && setActiveCallback();

				if (effectiveNode.role === "user") {
					if (empty) empty.hidden = true;
					startReply(effectiveNode.id);
				}
			},
			"branch-back": () => {
				const nodeNow = getNode(graph, nodeId);
				if (!nodeNow?.parentId) return;
				const parent = getNode(graph, nodeNow.parentId);
				const siblings = parent?.children ||[];
				const idx = siblings.indexOf(nodeId);
				if (idx <= 0) return;
				stopTyping();
				setSelectedChildId(graph, nodeNow.parentId, siblings[idx - 1]);
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				setActiveCallback && setActiveCallback();
			},
			"branch-forward": () => {
				const nodeNow = getNode(graph, nodeId);
				if (!nodeNow?.parentId) return;
				const parent = getNode(graph, nodeNow.parentId);
				const siblings = parent?.children ||[];
				const idx = siblings.indexOf(nodeId);
				if (idx === -1 || idx >= siblings.length - 1) return;
				stopTyping();
				setSelectedChildId(graph, nodeNow.parentId, siblings[idx + 1]);
				recomputeLeafId(graph);
				chat.updatedAt = Date.now();
				saveChats();
				uiState.editingNodeId = null;
				uiState.editingDraft = "";
				uiState.editingSaveMode = null;
				rerender();
				setActiveCallback && setActiveCallback();
			},
			/*** FIXED REGENERATE HANDLER ***/
			resend: () => {
				stopTyping();
				
				let userNodeId = node.role === "user" ? node.id : node.parentId;
				let userNode = getNode(graph, userNodeId);
				if (!userNode) return;

				// === FIX: permanently delete the old AI response (the one being regenerated) ===
				// This eliminates the "hidden sibling" that was causing the old message to re-appear
				// after deleting the newly generated response.
				const currentResponseId = graph.selections?.[userNodeId];
				if (currentResponseId) {
					spliceDeleteNode(graph, currentResponseId);
				}

				// Clean selection on the user node (ready for the new response)
				delete graph.selections[userNodeId];

				// Make sure the user node is selected in its parent (so the thread shows correctly)
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
		};

		handlers[action]?.();
	}, { signal });

	messages.addEventListener("keydown", (e) => {
		const textarea = e.target.closest(".chat-edit-input");
		if (!textarea) return;
		const msgEl = textarea.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (!nodeId) return;

		// ESC is handled by the document-level capture listener above so it
		// works whether or not the textarea currently has focus.

		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			uiState.editingSaveMode = e.shiftKey ? "preserve" : "reset";
			msgEl.querySelector('button[data-action="save"]')?.click();
		}
	}, { signal });

	messages.addEventListener("input", (e) => {
		const textarea = e.target.closest(".chat-edit-input");
		if (!textarea) return;
		// Bug 2 fix: grow/shrink the textarea as lines are added or removed
		textarea.style.height = "auto";
		textarea.style.height = textarea.scrollHeight + "px";
		const msgEl = textarea.closest(".chat-message");
		const nodeId = msgEl?.dataset.nodeId;
		if (nodeId && uiState.editingNodeId === nodeId) {
			uiState.editingDraft = textarea.value;
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

	// When the user explicitly picks a model from the dropdown:
	// – save it on the current chat so it restores on next visit
	// – remember it as the last explicitly-chosen model (used for new / unknown chats)
	root.addEventListener("click", (e) => {
		const item = e.target.closest('[data-dropdown="model"] .chat-dropdown-item');
		if (!item) return;

		const chat = getCurrentChatId() ? getChatById(getCurrentChatId()) : null;
		updateContextUI(root, chat);

		const selectedModel = item.dataset?.value;
		if (selectedModel) {
			setLastSelectedModel(selectedModel);
			const chatId = getCurrentChatId();
			if (chatId) setChatModel(chatId, selectedModel);
		}
	}, { signal });

	updateContextUI(root, getCurrentChatId() ? getChatById(getCurrentChatId()) : null);
	input.focus();
}