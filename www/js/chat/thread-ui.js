import { computeThreadNodeIds, ensureGraph, getNode } from "./graph.js";
import { formatBytes } from "./util.js";
import { parseMarkdown } from "./markdown.js";
import { preprocessLatexText, extractMath, injectMath } from "./latex.js";

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

// Filetype icons for message display
const FILETYPE_ICONS = {
	zip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/></svg>`,
	js: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>`,
	py: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C6.5 2 6 4 6 6v3h6v1H4c-2 0-4 1.5-4 5s2 5 4 5h2v-3c0-2 1.5-4 4-4h6c2 0 4-2 4-4V6c0-2-2-4-8-4z"/></svg>`,
	java: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 20c-2 0-3-1-3-3 2-2 6-2 8-5 1 2 1 4-1 6-2 2-4 2-4 2z"/></svg>`,
	jar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="3" width="12" height="18" rx="1"/><path d="M6 7h12M6 11h12M6 15h12"/></svg>`,
	json: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-2"/></svg>`,
	pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
	doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	txt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
	md: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M7 13l2 2 2-2M7 17l2 2 2-2M13 13h4M13 17h4"/></svg>`,
	mp3: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
	mp4: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>`,
	png: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
};

const FILETYPE_NAMES = {
	zip: "ZIP Archive", js: "JavaScript", ts: "TypeScript", py: "Python",
	java: "Java", jar: "Java Archive", json: "JSON", pdf: "PDF Document",
	doc: "Word Document", txt: "Text File", md: "Markdown",
	mp3: "MP3 Audio", mp4: "MP4 Video", png: "PNG Image", jpg: "JPEG Image",
};

function getFileExtension(filename) {
	const match = filename.match(/\.([^.]+)$/);
	return match ? match[1].toLowerCase() : "";
}

function getFiletypeIcon(filename) {
	const ext = getFileExtension(filename);
	return FILETYPE_ICONS[ext] || FILETYPE_ICONS.default;
}

function getFiletypeName(filename) {
	const ext = getFileExtension(filename);
	return FILETYPE_NAMES[ext] || ext.toUpperCase() + " File";
}

const icons = {
	edit: (s) => `<svg viewBox="0 -0.5 21 21" version="1.1" xmlns="http://www.w3.org/2000/svg" ${s}><g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><g fill="currentColor"><path d="M3.15,14 C2.5704,14 2.1,13.552 2.1,13 L2.1,7 C2.1,6.448 2.5704,6 3.15,6 C3.7296,6 4.2,5.552 4.2,5 C4.2,4.448 3.7296,4 3.15,4 L2.1,4 C0.93975,4 0,4.895 0,6 L0,14 C0,15.105 0.93975,16 2.1,16 L3.15,16 C3.7296,16 4.2,15.552 4.2,15 C4.2,14.448 3.7296,14 3.15,14 M18.9,4 L11.55,4 C10.9704,4 10.5,4.448 10.5,5 C10.5,5.552 10.9704,6 11.55,6 L17.85,6 C18.4296,6 18.9,6.448 18.9,7 L18.9,13 C18.9,13.552 18.4296,14 17.85,14 L11.55,14 C10.9704,14 10.5,14.448 10.5,15 C10.5,15.552 10.9704,16 11.55,16 L18.9,16 C20.06025,16 21,15.105 21,14 L21,6 C21,4.895 20.06025,4 18.9,4 M10.5,19 C10.5,19.552 10.0296,20 9.45,20 L5.25,20 C4.6704,20 4.2,19.552 4.2,19 C4.2,18.448 4.6704,18 5.25,18 L6.3,18 L6.3,2 L5.25,2 C4.6704,2 4.2,1.552 4.2,1 C4.2,0.448 4.6704,0 5.25,0 L9.45,0 C10.0296,0 10.5,0.448 10.5,1 C10.5,1.552 10.0296,2 9.45,2 L8.4,2 L8.4,18 L9.45,18 C10.0296,18 10.5,18.448 10.5,19"/></g></g></svg>`,
	refresh: (s) => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0115-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 01-15 6.7L3 16" /></svg>`,
	"chev-left": (s) => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M15 18l-6-6 6-6"/></svg>`,
	"chev-right": (s) => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M9 18l6-6-6-6"/></svg>`,
	check: (s) => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M20 6L9 17l-5-5"/></svg>`,
	x: (s) => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`,
	branch: (s) => `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M13 22H29C33.4183 22 37 25.5817 37 30V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="8.94365" r="5" transform="rotate(-90 13 8.94365)" stroke="currentColor" stroke-width="4"/><path d="M13 14V43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 39L13 44L8 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 39L37 44L32 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	trash: (s) => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M4 6H20L18.4199 20.2209C18.3074 21.2337 17.4512 22 16.4321 22H7.56786C6.54876 22 5.69264 21.2337 5.5801 20.2209L4 6Z"/><path d="M7.34491 3.14716C7.67506 2.44685 8.37973 2 9.15396 2H14.846C15.6203 2 16.3249 2.44685 16.6551 3.14716L18 6H6L7.34491 3.14716Z"/><path d="M2 6H22"/><path d="M10 11V16"/><path d="M14 11V16"/></svg>`,
	copy: (s) => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M8 5.00005C7.01165 5.00082 6.49359 5.01338 6.09202 5.21799C5.71569 5.40973 5.40973 5.71569 5.21799 6.09202C5 6.51984 5 7.07989 5 8.2V17.8C5 18.9201 5 19.4802 5.21799 19.908C5.40973 20.2843 5.71569 20.5903 6.09202 20.782C6.51984 21 7.07989 21 8.2 21H15.8C16.9201 21 17.4802 21 17.908 20.782C18.2843 20.5903 18.5903 20.2843 18.782 19.908C19 19.4802 19 18.9201 19 17.8V8.2C19 7.07989 19 6.51984 18.782 6.09202C18.5903 5.71569 18.2843 5.40973 17.908 5.21799C17.5064 5.01338 16.9884 5.00082 16 5.00005M8 5.00005V7H16V5.00005M8 5.00005V4.70711C8 4.25435 8.17986 3.82014 8.5 3.5C8.82014 3.17986 9.25435 3 9.70711 3H14.2929C14.7456 3 15.1799 3.17986 15.5 3.5C15.8201 3.82014 16 4.25435 16 4.70711V5.00005" /></svg>`,
};

const stroke = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function createActionButton({ action, label, title, iconName, disabled = false }) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "chat-action-btn";
	btn.dataset.action = action;
	btn.setAttribute("aria-label", label);
	btn.title = title || label;
	btn.disabled = Boolean(disabled);
	btn.innerHTML = icons[iconName]?.(stroke) || "";
	return btn;
}

function getSiblingNavState(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) {
		return { parentId: null, siblings:[], index: -1, canBack: false, canForward: false };
	}
	const parent = getNode(graph, node.parentId);
	const siblings = parent?.children ||[];
	const index = siblings.indexOf(nodeId);
	return {
		parentId: node.parentId,
		siblings,
		index,
		canBack: index > 0,
		canForward: index >= 0 && index < siblings.length - 1,
	};
}

/**
 * Build inline attachment element for message display
 */
function buildInlineAttachment(attachment) {
	const wrap = document.createElement("span");
	wrap.className = "chat-message-inline-attachment";

	if (attachment.isImage && attachment.data) {
		wrap.classList.add("chat-message-inline-attachment-image");
		wrap.innerHTML = `
			<span class="chat-message-inline-preview">
				<img src="${attachment.data}" alt="${attachment.name}" />
			</span>
			<span class="chat-message-inline-info">
				<span class="chat-message-inline-name">${attachment.name}</span>
				<span class="chat-message-inline-size">${formatBytes(attachment.size)}</span>
			</span>
		`;
	} else {
		wrap.classList.add("chat-message-inline-attachment-file");
		const ext = getFileExtension(attachment.name);
		wrap.innerHTML = `
			<span class="chat-message-inline-icon">
				${getFiletypeIcon(attachment.name)}
				<span class="chat-message-inline-type">${ext.toUpperCase()}</span>
			</span>
			<span class="chat-message-inline-info">
				<span class="chat-message-inline-name">${attachment.name}</span>
				<span class="chat-message-inline-type-name">${getFiletypeName(attachment.name)}</span>
				<span class="chat-message-inline-size">${formatBytes(attachment.size)}</span>
			</span>
		`;
	}

	return wrap;
}

/**
 * Format a tool name for display: "server__tool_name" → "server › tool name"
 */
function formatToolName(name) {
	return name.replace(/__/g, ' › ').replace(/_/g, ' ');
}

/**
 * Build a collapsible tool call element showing input and output
 */
export function buildToolCallElement(tc) {
	const details = document.createElement("details");
	details.className = "message-tool-call";

	const summary = document.createElement("summary");
	summary.className = "tool-call-summary";

	const iconEl = document.createElement("span");
	iconEl.className = "tool-call-icon";
	iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.6316 7.63137C15.2356 7.23535 15.0376 7.03735 14.9634 6.80902C14.8981 6.60817 14.8981 6.39183 14.9634 6.19098C15.0376 5.96265 15.2356 5.76465 15.6316 5.36863L18.47 2.53026C17.7168 2.18962 16.8806 2 16.0002 2C12.6865 2 10.0002 4.68629 10.0002 8C10.0002 8.49104 10.0592 8.9683 10.1705 9.42509C10.2896 9.91424 10.3492 10.1588 10.3387 10.3133C10.3276 10.4751 10.3035 10.5612 10.2289 10.7051C10.1576 10.8426 10.0211 10.9791 9.74804 11.2522L3.50023 17.5C2.6718 18.3284 2.6718 19.6716 3.50023 20.5C4.32865 21.3284 5.6718 21.3284 6.50023 20.5L12.748 14.2522C13.0211 13.9791 13.1576 13.8426 13.2951 13.7714C13.4391 13.6968 13.5251 13.6727 13.6869 13.6616C13.8414 13.651 14.086 13.7106 14.5751 13.8297C15.0319 13.941 15.5092 14 16.0002 14C19.3139 14 22.0002 11.3137 22.0002 8C22.0002 7.11959 21.8106 6.28347 21.47 5.53026L18.6316 8.36863C18.2356 8.76465 18.0376 8.96265 17.8092 9.03684C17.6084 9.1021 17.3921 9.1021 17.1912 9.03684C16.9629 8.96265 16.7649 8.76465 16.3689 8.36863L15.6316 7.63137Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

	const nameEl = document.createElement("span");
	nameEl.className = "tool-call-name";
	nameEl.textContent = formatToolName(tc.name);

	summary.appendChild(iconEl);
	summary.appendChild(nameEl);
	details.appendChild(summary);

	const body = document.createElement("div");
	body.className = "tool-call-body";

	if (tc.input !== undefined && tc.input !== null) {
		const inputLabel = document.createElement("div");
		inputLabel.className = "tool-call-section-label";
		inputLabel.textContent = "Input";
		body.appendChild(inputLabel);

		const inputCode = document.createElement("pre");
		inputCode.className = "tool-call-code";
		inputCode.textContent = typeof tc.input === "object"
			? JSON.stringify(tc.input, null, 2)
			: String(tc.input);
		body.appendChild(inputCode);
	}

	if (tc.output !== undefined && tc.output !== null) {
		const outputLabel = document.createElement("div");
		outputLabel.className = "tool-call-section-label";
		outputLabel.textContent = "Output";
		body.appendChild(outputLabel);

		const outputCode = document.createElement("pre");
		outputCode.className = "tool-call-code";
		outputCode.textContent = typeof tc.output === "object"
			? JSON.stringify(tc.output, null, 2)
			: String(tc.output);
		body.appendChild(outputCode);
	}

	details.appendChild(body);
	return details;
}

export function buildReasoningElement(reasoning) {
	if (!reasoning || !reasoning.trim()) return null;

	const details = document.createElement("details");
	details.className = "message-reasoning";
	details.open = false; // FIX: explicitly closed for completed messages

	const summary = document.createElement("summary");
	summary.textContent = "Thinking"; // FIX: "Thinking..." → "Thinking" to distinguish completed state from active streaming

	const content = document.createElement("div");
	content.className = "reasoning-content";
	content.textContent = reasoning;
	
	details.appendChild(summary);
	details.appendChild(content);
	return details;
}

/**
 * Build content container with parts rendered in order
 */
function buildContentContainer(node, isEditing, editingDraft) {
	const container = document.createElement("div");
	container.className = "chat-message-content";

	// Add reasoning section for assistant messages (when not editing)
	if (!isEditing && node.role === "assistant" && node.reasoning) {
		const reasoningEl = buildReasoningElement(node.reasoning);
		if (reasoningEl) {
			container.appendChild(reasoningEl);
		}
	}

	// Add tool calls section for assistant messages (when not editing)
	if (!isEditing && node.role === "assistant" && Array.isArray(node.toolCalls) && node.toolCalls.length > 0) {
		node.toolCalls.forEach((tc) => {
			container.appendChild(buildToolCallElement(tc));
		});
	}

	if (isEditing) {
		// Use a contenteditable div instead of <textarea>.
		// Firefox intercepts ESC on a focused <textarea> at the native level and
		// never dispatches the keydown event to JS at all, making it impossible to
		// cancel an edit on the first keypress. contenteditable elements have no
		// such native ESC interception, so keydown fires normally in all browsers.
		const editEl = document.createElement("div");
		editEl.className = "chat-edit-input";
		editEl.contentEditable = "true";
		editEl.setAttribute("role", "textbox");
		editEl.setAttribute("aria-multiline", "true");
		editEl.setAttribute("aria-label", "Edit message");
		editEl.spellcheck = true;
		// For editing, combine text parts
		const textContent = node.parts
			? node.parts.filter(p => p.type === "text").map(p => p.content).join("")
			: String(node.content || "");
		// innerText assignment respects \n as a line break and sets plain text only
		editEl.innerText = editingDraft ?? textContent;
		container.appendChild(editEl);
	} else if (node.parts && Array.isArray(node.parts)) {
		// Render parts in order
		node.parts.forEach((part) => {
			if (part.type === "text" && part.content) {
				// Prevent math parsing errors with code shielding and preprocess raw UI tags
				const preprocessed = preprocessLatexText(part.content);
				const { text, mathBlocks } = extractMath(preprocessed);
				const mdHtml = parseMarkdown(text);
				const finalHtml = injectMath(mdHtml, mathBlocks);

				const wrapper = document.createElement("div");
				wrapper.className = "chat-message-text";
				wrapper.innerHTML = finalHtml;
				container.appendChild(wrapper);
			} else if (part.type === "attachment") {
				container.appendChild(buildInlineAttachment(part));
			}
		});
	} else {
		// Legacy format: just content string
		const preprocessed = preprocessLatexText(String(node.content || ""));
		const { text, mathBlocks } = extractMath(preprocessed);
		const mdHtml = parseMarkdown(text);
		const finalHtml = injectMath(mdHtml, mathBlocks);

		const wrapper = document.createElement("div");
		wrapper.className = "chat-message-text";
		wrapper.innerHTML = finalHtml;
		container.appendChild(wrapper);
		
		// Legacy attachments (rendered after content)
		if (node.attachments && node.attachments.length > 0) {
			node.attachments.forEach((attachment) => {
				container.appendChild(buildInlineAttachment(attachment));
			});
		}
	}

	return container;
}

function buildMessageElement({ node, isEditing, editingDraft, canBranchBack, canBranchForward, canResend }) {
	const div = document.createElement("div");
	div.className = `chat-message ${node.role}`;
	div.setAttribute("role", "article");
	div.setAttribute("aria-label", node.role === "user" ? "You" : "Assistant");
	div.dataset.nodeId = node.id;

	const contentContainer = buildContentContainer(node, isEditing, editingDraft);
	div.appendChild(contentContainer);

	const menu = document.createElement("div");
	menu.className = "chat-message-menu";
	menu.setAttribute("role", "toolbar");
	menu.setAttribute("aria-label", "Message actions");

	if (isEditing) {
		menu.append(
			createActionButton({ action: "save", label: "Save edit", title: "Save", iconName: "check" }),
			createActionButton({ action: "cancel", label: "Cancel edit", title: "Cancel", iconName: "x" })
		);
	} else {
		menu.append(
			createActionButton({ action: "branch-back", label: "Previous thread", title: "Previous thread", iconName: "chev-left", disabled: !canBranchBack }),
			createActionButton({ action: "branch-forward", label: "Next thread", title: "Next thread", iconName: "chev-right", disabled: !canBranchForward }),
			createActionButton({ action: "thread", label: "Create new thread from this message", title: "New thread", iconName: "branch" }),
			createActionButton({ action: "edit", label: "Edit message", title: "Edit", iconName: "edit" }),
			createActionButton({ action: "resend", label: "Regenerate from here", title: "Regenerate", iconName: "refresh", disabled: !canResend }),
			createActionButton({ action: "delete", label: "Delete message", title: "Delete (shift+click to delete only this message)", iconName: "trash" }),
			createActionButton({ action: "copy", label: "Copy raw message", title: "Copy", iconName: "copy" })
		);
	}

	div.appendChild(menu);
	return div;
}

/**
 * Scroll the page to the bottom. Targets the .content scroll container so the
 * scrollbar appears at the right edge of the viewport rather than inside the
 * chat column.
 * @param {Element} messagesEl  The #chatMessages element
 */
function scrollToBottom(messagesEl) {
	const scrollEl = messagesEl.closest('.content') || messagesEl;
	scrollEl.scrollTop = scrollEl.scrollHeight;
}

export function showTyping(container) {
	const div = document.createElement("div");
	div.className = "chat-typing";
	div.setAttribute("aria-label", "Assistant is typing");
	div.innerHTML = "<span></span><span></span><span></span>";
	container.appendChild(div);
	scrollToBottom(container);
	return div;
}

export function renderThread(messagesEl, chat, uiState) {
	if (!messagesEl || !chat) return;
	const graph = ensureGraph(chat);
	messagesEl.querySelectorAll(".chat-message, .chat-typing").forEach((el) => el.remove());

	const ids = computeThreadNodeIds(graph);
	ids.forEach((id) => {
		const node = getNode(graph, id);
		if (!node) return;
		const nav = getSiblingNavState(graph, id);
		const el = buildMessageElement({
			node,
			isEditing: uiState?.editingNodeId === node.id,
			editingDraft: uiState?.editingDraft,
			canBranchBack: nav.canBack,
			canBranchForward: nav.canForward,
			canResend: Boolean(node.parentId) && node.role !== "system",
		});
		messagesEl.appendChild(el);
	});

	scrollToBottom(messagesEl);
}

/**
 * Update a single message element between normal and editing state WITHOUT
 * rebuilding the rest of the thread.  This avoids Chromium painting the
 * intermediate empty-thread state that causes surrounding messages to shift.
 *
 * @param {Element} messagesEl  The #chatMessages container
 * @param {object}  graph       The chat graph
 * @param {object}  node        The node being toggled
 * @param {boolean} isEditing   Whether we're entering (true) or leaving (false) edit mode
 * @param {string}  editingDraft  Current draft text (only used when isEditing=true)
 * @returns {boolean} false if the element wasn't found (caller should fall back to renderThread)
 */
export function patchMessageEditState(messagesEl, graph, node, isEditing, editingDraft) {
	const msgEl = messagesEl.querySelector(`[data-node-id="${node.id}"]`);
	if (!msgEl) return false;

	// Swap content container
	const oldContent = msgEl.querySelector('.chat-message-content');
	const newContent = buildContentContainer(node, isEditing, editingDraft);
	if (oldContent) msgEl.replaceChild(newContent, oldContent);
	else msgEl.insertBefore(newContent, msgEl.querySelector('.chat-message-menu'));

	// Swap menu
	const nav = getSiblingNavState(graph, node.id);
	const canResend = Boolean(node.parentId) && node.role !== "system";
	const oldMenu = msgEl.querySelector('.chat-message-menu');
	const newMenu = document.createElement('div');
	newMenu.className = 'chat-message-menu';
	newMenu.setAttribute('role', 'toolbar');
	newMenu.setAttribute('aria-label', 'Message actions');
	if (isEditing) {
		newMenu.append(
			createActionButton({ action: 'save', label: 'Save edit', title: 'Save', iconName: 'check' }),
			createActionButton({ action: 'cancel', label: 'Cancel edit', title: 'Cancel', iconName: 'x' })
		);
	} else {
		newMenu.append(
			createActionButton({ action: 'branch-back', label: 'Previous thread', title: 'Previous thread', iconName: 'chev-left', disabled: !nav.canBack }),
			createActionButton({ action: 'branch-forward', label: 'Next thread', title: 'Next thread', iconName: 'chev-right', disabled: !nav.canForward }),
			createActionButton({ action: 'thread', label: 'Create new thread from this message', title: 'New thread', iconName: 'branch' }),
			createActionButton({ action: 'edit', label: 'Edit message', title: 'Edit', iconName: 'edit' }),
			createActionButton({ action: 'resend', label: 'Regenerate from here', title: 'Regenerate', iconName: 'refresh', disabled: !canResend }),
			createActionButton({ action: 'delete', label: 'Delete message', title: 'Delete (shift+click to delete only this message)', iconName: 'trash' }),
			createActionButton({ action: 'copy', label: 'Copy raw message', title: 'Copy', iconName: 'copy' })
		);
	}
	if (oldMenu) msgEl.replaceChild(newMenu, oldMenu);
	else msgEl.appendChild(newMenu);

	return true;
}