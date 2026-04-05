// www/js/chat/thread-ui.js
// Renders the conversation thread: builds message elements, action menus,
// reasoning blocks, tool call blocks, and inline attachment previews.

import { computeThreadNodeIds, ensureGraph, getNode } from './graph.js';
import { formatBytes, getFileExtension, getFiletypeIcon, getFiletypeName } from './util.js';
import { parseMarkdown } from './markdown.js';
import { detectAndRenderColours } from './colour-utils.js';
import { preprocessLatexText, extractMath, injectMath } from './latex/index.js';

// ─── HTML escaping ────────────────────────────────────────────────────────────

function escapeHtml(text) {
	if (!text) return '';
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// ─── Action button icons ──────────────────────────────────────────────────────

const stroke = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const icons = {
	edit:          s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>`,
	refresh:       s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
	'chev-left':   s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="m15 18-6-6 6-6"/></svg>`,
	'chev-right':  s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="m9 18 6-6-6-6"/></svg>`,
	check:         s => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M20 6L9 17l-5-5"/></svg>`,
	x:             s => `<svg viewBox="0 0 24 24" fill="none" ${s}><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`,
	branch:        s => `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M13 22H29C33.4183 22 37 25.5817 37 30V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="8.94365" r="5" transform="rotate(-90 13 8.94365)" stroke="currentColor" stroke-width="4"/><path d="M13 14V43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 39L13 44L8 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 39L37 44L32 39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	trash:         s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
	copy:          s => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" ${s}><path d="M8 5.00005C7.01165 5.00082 6.49359 5.01338 6.09202 5.21799C5.71569 5.40973 5.40973 5.71569 5.21799 6.09202C5 6.51984 5 7.07989 5 8.2V17.8C5 18.9201 5 19.4802 5.21799 19.908C5.40973 20.2843 5.71569 20.5903 6.09202 20.782C6.51984 21 7.07989 21 8.2 21H15.8C16.9201 21 17.4802 21 17.908 20.782C18.2843 20.5903 18.5903 20.2843 18.782 19.908C19 19.4802 19 18.9201 19 17.8V8.2C19 7.07989 19 6.51984 18.782 6.09202C18.5903 5.71569 18.2843 5.40973 17.908 5.21799C17.5064 5.01338 16.9884 5.00082 16 5.00005M8 5.00005V7H16V5.00005M8 5.00005V4.70711C8 4.25435 8.17986 3.82014 8.5 3.5C8.82014 3.17986 9.25435 3 9.70711 3H14.2929C14.7456 3 15.1799 3.17986 15.5 3.5C15.8201 3.82014 16 4.25435 16 4.70711V5.00005"/></svg>`,
};

function createActionButton({ action, label, title, iconName, disabled = false }) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'chat-action-btn';
	btn.dataset.action = action;
	btn.setAttribute('aria-label', label);
	btn.title = title || label;
	btn.disabled = Boolean(disabled);
	btn.innerHTML = icons[iconName]?.(stroke) || '';
	return btn;
}

// ─── Sibling navigation state ─────────────────────────────────────────────────

function getSiblingNavState(graph, nodeId) {
	const node = getNode(graph, nodeId);
	if (!node?.parentId) return { parentId: null, siblings: [], index: -1, canBack: false, canForward: false };
	const parent   = getNode(graph, node.parentId);
	const siblings = parent?.children || [];
	const index    = siblings.indexOf(nodeId);
	return { parentId: node.parentId, siblings, index, canBack: index > 0, canForward: index >= 0 && index < siblings.length - 1 };
}

// ─── Inline attachment preview (message display) ──────────────────────────────

function buildInlineAttachment(attachment) {
	const wrap = document.createElement('span');
	wrap.className = 'chat-message-inline-attachment';

	if (attachment.isImage && attachment.data) {
		wrap.classList.add('chat-message-inline-attachment-image');
		wrap.innerHTML = `
			<span class="chat-message-inline-preview"><img src="${attachment.data}" alt="${attachment.name}" /></span>
			<span class="chat-message-inline-info">
				<span class="chat-message-inline-name">${attachment.name}</span>
				<span class="chat-message-inline-size">${formatBytes(attachment.size)}</span>
			</span>`;
	} else {
		wrap.classList.add('chat-message-inline-attachment-file');
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
			</span>`;
	}
	return wrap;
}

// ─── Tool call element ────────────────────────────────────────────────────────

function formatToolName(name) {
	return name.replace(/__/g, ' › ').replace(/_/g, ' ');
}

export function buildToolCallElement(tc) {
	const details = document.createElement('details');
	details.className = 'message-tool-call';

	const summary = document.createElement('summary');
	summary.className = 'tool-call-summary';

	const iconEl = document.createElement('span');
	iconEl.className = 'tool-call-icon';
	iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`;

	const nameEl = document.createElement('span');
	nameEl.className = 'tool-call-name';
	nameEl.textContent = formatToolName(tc.name);

	summary.append(iconEl, nameEl);
	details.appendChild(summary);

	const body = document.createElement('div');
	body.className = 'tool-call-body';
	if (tc.input != null) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Input';
		const code  = document.createElement('pre');  code.className  = 'tool-call-code';
		code.textContent = typeof tc.input === 'object' ? JSON.stringify(tc.input, null, 2) : String(tc.input);
		body.append(label, code);
	}
	if (tc.output != null) {
		const label = document.createElement('div'); label.className = 'tool-call-section-label'; label.textContent = 'Output';
		const code  = document.createElement('pre');  code.className  = 'tool-call-code';
		code.textContent = typeof tc.output === 'object' ? JSON.stringify(tc.output, null, 2) : String(tc.output);
		body.append(label, code);
	}
	details.appendChild(body);
	return details;
}

// ─── Reasoning block ──────────────────────────────────────────────────────────

export function buildReasoningElement(reasoning) {
	if (!reasoning || !reasoning.trim()) return null;
	const details = document.createElement('details');
	details.className = 'message-reasoning';
	details.open = false;
	const summary = document.createElement('summary');
	summary.textContent = 'Thinking';
	const content = document.createElement('div');
	content.className = 'reasoning-content';
	content.textContent = reasoning;
	details.append(summary, content);
	return details;
}

// ─── Content container ────────────────────────────────────────────────────────

export function buildContentContainer(node, isEditing, editingDraft) {
	const container = document.createElement('div');
	container.className = 'chat-message-content';

	if (!isEditing && node.role === 'assistant' && node.reasoning) {
		const el = buildReasoningElement(node.reasoning);
		if (el) container.appendChild(el);
	}

	if (!isEditing && node.role === 'assistant' && Array.isArray(node.toolCalls) && node.toolCalls.length > 0) {
		node.toolCalls.forEach(tc => container.appendChild(buildToolCallElement(tc)));
	}

	if (isEditing) {
		// Using contenteditable avoids Firefox's native ESC interception on <textarea>
		const editEl = document.createElement('div');
		editEl.className = 'chat-edit-input';
		editEl.contentEditable = 'true';
		editEl.setAttribute('role', 'textbox');
		editEl.setAttribute('aria-multiline', 'true');
		editEl.setAttribute('aria-label', 'Edit message');
		editEl.spellcheck = true;
		const textContent = node.parts
			? node.parts.filter(p => p.type === 'text').map(p => p.content).join('')
			: String(node.content || '');
		editEl.innerText = editingDraft ?? textContent;
		container.appendChild(editEl);
	} else if (node.parts && Array.isArray(node.parts)) {
		node.parts.forEach((part) => {
			if (part.type === 'text' && part.content) {
				const preprocessed = preprocessLatexText(part.content);
				const { text, mathBlocks } = extractMath(preprocessed);
				const wrapper = document.createElement('div');
				wrapper.className = 'chat-message-text';
				wrapper.innerHTML = injectMath(detectAndRenderColours(parseMarkdown(text)), mathBlocks);
				container.appendChild(wrapper);
			} else if (part.type === 'attachment') {
				container.appendChild(buildInlineAttachment(part));
			}
		});
	} else {
		// Legacy: plain content string
		const preprocessed = preprocessLatexText(String(node.content || ''));
		const { text, mathBlocks } = extractMath(preprocessed);
		const wrapper = document.createElement('div');
		wrapper.className = 'chat-message-text';
		wrapper.innerHTML = injectMath(detectAndRenderColours(parseMarkdown(text)), mathBlocks);
		container.appendChild(wrapper);
		if (node.attachments?.length > 0) node.attachments.forEach(a => container.appendChild(buildInlineAttachment(a)));
	}

	return container;
}

// ─── Full message element ─────────────────────────────────────────────────────

function buildMessageElement({ node, isEditing, editingDraft, canBranchBack, canBranchForward, canResend }) {
	const div = document.createElement('div');
	div.className = `chat-message ${node.role}`;
	div.setAttribute('role', 'article');
	div.setAttribute('aria-label', node.role === 'user' ? 'You' : 'Assistant');
	div.dataset.nodeId = node.id;

	div.appendChild(buildContentContainer(node, isEditing, editingDraft));

	const menu = document.createElement('div');
	menu.className = 'chat-message-menu';
	menu.setAttribute('role', 'toolbar');
	menu.setAttribute('aria-label', 'Message actions');

	if (isEditing) {
		menu.append(
			createActionButton({ action: 'save',   label: 'Save edit',   title: 'Save',   iconName: 'check' }),
			createActionButton({ action: 'cancel', label: 'Cancel edit', title: 'Cancel', iconName: 'x' })
		);
	} else {
		menu.append(
			createActionButton({ action: 'branch-back',    label: 'Previous thread',                           title: 'Previous thread',                          iconName: 'chev-left',  disabled: !canBranchBack }),
			createActionButton({ action: 'branch-forward', label: 'Next thread',                               title: 'Next thread',                              iconName: 'chev-right', disabled: !canBranchForward }),
			createActionButton({ action: 'thread',         label: 'Create new thread from this message',       title: 'New thread',                               iconName: 'branch' }),
			createActionButton({ action: 'edit',           label: 'Edit message',                              title: 'Edit',                                     iconName: 'edit' }),
			createActionButton({ action: 'resend',         label: 'Regenerate from here',                      title: 'Regenerate',                               iconName: 'refresh',    disabled: !canResend }),
			createActionButton({ action: 'delete',         label: 'Delete message',                            title: 'Delete (shift+click to delete only this)', iconName: 'trash' }),
			createActionButton({ action: 'copy',           label: 'Copy raw message',                          title: 'Copy',                                     iconName: 'copy' })
		);
	}

	div.appendChild(menu);
	return div;
}

// ─── Scroll helper ────────────────────────────────────────────────────────────

function scrollToBottom(messagesEl) {
	const scrollEl = messagesEl.closest('.content') || messagesEl;
	scrollEl.scrollTop = scrollEl.scrollHeight;
}

// ─── Public rendering functions ───────────────────────────────────────────────

export function showTyping(container) {
	const div = document.createElement('div');
	div.className = 'chat-typing';
	div.setAttribute('aria-label', 'Assistant is typing');
	div.innerHTML = '<span></span><span></span><span></span>';
	container.appendChild(div);
	scrollToBottom(container);
	return div;
}

export function renderThread(messagesEl, chat, uiState) {
	if (!messagesEl || !chat) return;
	const graph = ensureGraph(chat);
	messagesEl.querySelectorAll('.chat-message, .chat-typing').forEach(el => el.remove());

	computeThreadNodeIds(graph).forEach((id) => {
		const node = getNode(graph, id);
		if (!node) return;
		const nav = getSiblingNavState(graph, id);
		messagesEl.appendChild(buildMessageElement({
			node,
			isEditing:        uiState?.editingNodeId === node.id,
			editingDraft:     uiState?.editingDraft,
			canBranchBack:    nav.canBack,
			canBranchForward: nav.canForward,
			canResend:        Boolean(node.parentId) && node.role !== 'system',
		}));
	});
	scrollToBottom(messagesEl);
}

/**
 * Swap a single message element between normal and editing state without
 * rebuilding the entire thread. Avoids the Chromium flash during full re-renders.
 * Returns false if the element wasn't found — caller should fall back to renderThread.
 */
export function patchMessageEditState(messagesEl, graph, node, isEditing, editingDraft) {
	const msgEl = messagesEl.querySelector(`[data-node-id="${node.id}"]`);
	if (!msgEl) return false;

	const oldContent = msgEl.querySelector('.chat-message-content');
	const newContent = buildContentContainer(node, isEditing, editingDraft);
	if (oldContent) msgEl.replaceChild(newContent, oldContent);
	else msgEl.insertBefore(newContent, msgEl.querySelector('.chat-message-menu'));

	const nav = getSiblingNavState(graph, node.id);
	const canResend = Boolean(node.parentId) && node.role !== 'system';
	const oldMenu = msgEl.querySelector('.chat-message-menu');
	const newMenu = document.createElement('div');
	newMenu.className = 'chat-message-menu';
	newMenu.setAttribute('role', 'toolbar');
	newMenu.setAttribute('aria-label', 'Message actions');

	if (isEditing) {
		newMenu.append(
			createActionButton({ action: 'save',   label: 'Save edit',   title: 'Save',   iconName: 'check' }),
			createActionButton({ action: 'cancel', label: 'Cancel edit', title: 'Cancel', iconName: 'x' })
		);
	} else {
		newMenu.append(
			createActionButton({ action: 'branch-back',    label: 'Previous thread',                           title: 'Previous thread', iconName: 'chev-left',  disabled: !nav.canBack }),
			createActionButton({ action: 'branch-forward', label: 'Next thread',                               title: 'Next thread',     iconName: 'chev-right', disabled: !nav.canForward }),
			createActionButton({ action: 'thread',         label: 'Create new thread from this message',       title: 'New thread',      iconName: 'branch' }),
			createActionButton({ action: 'edit',           label: 'Edit message',                              title: 'Edit',            iconName: 'edit' }),
			createActionButton({ action: 'resend',         label: 'Regenerate from here',                      title: 'Regenerate',      iconName: 'refresh',    disabled: !canResend }),
			createActionButton({ action: 'delete',         label: 'Delete message',                            title: 'Delete (shift+click to delete only this)', iconName: 'trash' }),
			createActionButton({ action: 'copy',           label: 'Copy raw message',                          title: 'Copy',            iconName: 'copy' })
		);
	}

	if (oldMenu) msgEl.replaceChild(newMenu, oldMenu);
	else msgEl.appendChild(newMenu);
	return true;
}
