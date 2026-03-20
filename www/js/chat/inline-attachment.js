// www/js/chat/inline-attachment.js
// Manages inline file attachment chips inside the contenteditable input.

import { generateId, formatBytes, getFiletypeIcon, getFiletypeName, getFileExtension, isImageFile, createXIcon } from './util.js';

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function getCursorPosition(el) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	if (!el.contains(range.commonAncestorContainer)) return null;
	return { selection, range };
}

function setCursorAfter(element) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.setStartAfter(element);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

function setCursorBefore(element) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.setStartBefore(element);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

// ─── InlineAttachmentManager ──────────────────────────────────────────────────

export class InlineAttachmentManager {
	constructor(contentEditableEl, options = {}) {
		this.el = contentEditableEl;
		this.options = {
			maxImagePreviewWidth:  400,
			maxImagePreviewHeight: 300,
			onAttachmentAdded:   null,
			onAttachmentRemoved: null,
			...options,
		};
		this.attachments = new Map();
		this.isProcessing = false;
		this.setupEventListeners();
	}

	setupEventListeners() {
		this.el.addEventListener('keydown', e => this.handleKeyDown(e));
		this.el.addEventListener('click',   e => this.handleClick(e));
		this.el.addEventListener('paste',   e => this.handlePaste(e));
		this.el.addEventListener('input',   () => this.updateEmptyState());
		this.el.addEventListener('focus',   () => {
			if (!this.el.firstChild) this.el.appendChild(document.createTextNode(''));
		});
	}

	handleKeyDown(e) {
		if (this.isProcessing) return;

		if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			e.preventDefault();
			this.moveContent(e.key === 'ArrowUp' ? -1 : 1);
			return;
		}

		if (e.key === 'Backspace' || e.key === 'Delete') {
			const cursorPos = getCursorPosition(this.el);
			if (!cursorPos) return;
			const { range } = cursorPos;

			if (!range.collapsed) {
				const chipsInRange = this.getChipsInRange(range);
				if (chipsInRange.length > 0) {
					e.preventDefault();
					this.isProcessing = true;
					try {
						for (const chip of chipsInRange) this.removeAttachmentChip(chip);
						range.deleteContents();
					} finally { this.isProcessing = false; }
					return;
				}
				return;
			}

			const chip = this.getAdjacentChip(range, e.key === 'Backspace' ? 'before' : 'after');
			if (chip) {
				e.preventDefault();
				this.isProcessing = true;
				try { this.removeAttachmentChip(chip); }
				finally { this.isProcessing = false; }
				return;
			}
			this.el.querySelectorAll('.inline-attachment.selected').forEach(c => c.classList.remove('selected'));
		}

		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const cursorPos = getCursorPosition(this.el);
			if (!cursorPos) return;
			const { range } = cursorPos;
			if (!range.collapsed) return;
			const chip = this.getAdjacentChip(range, e.key === 'ArrowLeft' ? 'before' : 'after');
			if (chip) {
				this.el.querySelectorAll('.inline-attachment.selected').forEach(c => c.classList.remove('selected'));
				if (e.key === 'ArrowRight' && chip.classList.contains('inline-attachment-image')) {
					const nextSibling = chip.nextSibling;
					if (!nextSibling || (nextSibling.nodeType === Node.TEXT_NODE && !nextSibling.textContent.trim()) || nextSibling.tagName === 'BR') {
						this.el.insertBefore(document.createTextNode(' '), nextSibling || null);
					}
				}
			}
		}
	}

	getChipsInRange(range) {
		const chips = [];
		const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT, null);
		let node = walker.currentNode;
		while (node) {
			if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('inline-attachment') && range.intersectsNode(node)) {
				chips.push(node);
			}
			node = walker.nextNode();
		}
		return chips;
	}

	getAdjacentChip(range, direction) {
		if (!range.collapsed) return null;
		const container = range.startContainer;
		const offset    = range.startOffset;
		const isChip      = n => n?.nodeType === Node.ELEMENT_NODE && n.classList?.contains('inline-attachment');
		const isEmptyText = n => n?.nodeType === Node.TEXT_NODE && n.textContent === '';

		if (direction === 'before') {
			if (container.nodeType === Node.TEXT_NODE) {
				if (offset !== 0) return null;
				let prev = container.previousSibling;
				while (prev && isEmptyText(prev)) prev = prev.previousSibling;
				if (isChip(prev)) return prev;
				if (container.parentElement !== this.el) {
					let parentPrev = container.parentElement.previousSibling;
					while (parentPrev && isEmptyText(parentPrev)) parentPrev = parentPrev.previousSibling;
					if (isChip(parentPrev)) return parentPrev;
				}
			} else if (container === this.el) {
				const children = Array.from(this.el.childNodes);
				if (offset > 0) {
					let prev = children[offset - 1];
					while (prev && isEmptyText(prev)) {
						const prevIndex = children.indexOf(prev) - 1;
						prev = prevIndex >= 0 ? children[prevIndex] : null;
					}
					if (isChip(prev)) return prev;
				}
			} else {
				const children = Array.from(container.childNodes);
				if (offset > 0) {
					let prev = children[offset - 1];
					while (prev && isEmptyText(prev)) {
						const prevIndex = children.indexOf(prev) - 1;
						prev = prevIndex >= 0 ? children[prevIndex] : null;
					}
					if (isChip(prev)) return prev;
				} else if (offset === 0) {
					let parentPrev = container.previousSibling;
					while (parentPrev && isEmptyText(parentPrev)) parentPrev = parentPrev.previousSibling;
					if (isChip(parentPrev)) return parentPrev;
				}
			}
		} else {
			if (container.nodeType === Node.TEXT_NODE) {
				if (offset !== container.textContent.length) return null;
				let next = container.nextSibling;
				while (next && isEmptyText(next)) next = next.nextSibling;
				if (isChip(next)) return next;
				if (container.parentElement !== this.el) {
					let parentNext = container.parentElement.nextSibling;
					while (parentNext && isEmptyText(parentNext)) parentNext = parentNext.nextSibling;
					if (isChip(parentNext)) return parentNext;
				}
			} else if (container === this.el) {
				const children = Array.from(this.el.childNodes);
				if (offset < children.length) {
					let next = children[offset];
					while (next && isEmptyText(next)) {
						const nextIndex = children.indexOf(next) + 1;
						next = nextIndex < children.length ? children[nextIndex] : null;
					}
					if (isChip(next)) return next;
				}
			} else {
				const children = Array.from(container.childNodes);
				if (offset < children.length) {
					let next = children[offset];
					while (next && isEmptyText(next)) {
						const nextIndex = children.indexOf(next) + 1;
						next = nextIndex < children.length ? children[nextIndex] : null;
					}
					if (isChip(next)) return next;
				} else {
					let parentNext = container.nextSibling;
					while (parentNext && isEmptyText(parentNext)) parentNext = parentNext.nextSibling;
					if (isChip(parentNext)) return parentNext;
				}
			}
		}
		return null;
	}

	handleClick(e) {
		const removeBtn = e.target.closest('.inline-attachment-remove');
		if (removeBtn) {
			e.preventDefault();
			e.stopPropagation();
			const chip = removeBtn.closest('.inline-attachment');
			if (chip) {
				this.isProcessing = true;
				try { this.removeAttachmentChip(chip); }
				finally { this.isProcessing = false; }
			}
			return;
		}
		if (!e.target.closest('.inline-attachment')) {
			this.el.querySelectorAll('.inline-attachment.selected').forEach(c => c.classList.remove('selected'));
		}
	}

	handlePaste(e) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.kind === 'file') {
				e.preventDefault();
				const file = item.getAsFile();
				if (file) this.addFile(file);
				return;
			}
		}
		const text = e.clipboardData.getData('text/plain');
		if (text) {
			e.preventDefault();
			const selection = window.getSelection();
			if (!selection || !selection.rangeCount) return;
			const range = selection.getRangeAt(0);
			range.deleteContents();
			const lines = text.split(/\r\n|\r|\n/);
			const frag  = document.createDocumentFragment();
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]) frag.appendChild(document.createTextNode(lines[i].replace(/ /g, '\u00A0')));
				if (i < lines.length - 1) frag.appendChild(document.createElement('br'));
			}
			frag.appendChild(document.createTextNode(''));
			const lastChild = frag.lastChild;
			range.insertNode(frag);
			if (lastChild) {
				range.setStartAfter(lastChild);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			this.updateEmptyState();
			this.el.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}

	moveContent(direction) {
		const selectedChip = this.el.querySelector('.inline-attachment.selected');
		if (!selectedChip) return;
		const allNodes    = Array.from(this.el.childNodes);
		const currentIndex = allNodes.indexOf(selectedChip);
		if (currentIndex === -1) return;
		const targetIndex = currentIndex + direction;
		if (targetIndex < 0 || targetIndex >= allNodes.length) return;
		const targetNode = allNodes[targetIndex];
		if (direction < 0) this.el.insertBefore(selectedChip, targetNode);
		else               this.el.insertBefore(selectedChip, targetNode.nextSibling);
	}

	async addFile(file) {
		const id       = generateId();
		const imageFile = isImageFile(file);
		const attachment = { id, name: file.name, size: file.size, type: file.type || 'application/octet-stream', isImage: imageFile, data: null };
		attachment.data = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload  = () => resolve(reader.result);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
		this.attachments.set(id, attachment);
		const chip = this.createChipElement(attachment);
		this.insertAtCursor(chip);
		this.updateEmptyState();
		this.el.dispatchEvent(new Event('input', { bubbles: true }));
		this.options.onAttachmentAdded?.(attachment);
		return attachment;
	}

	createChipElement(attachment) {
		const chip = document.createElement('span');
		chip.className = 'inline-attachment';
		chip.setAttribute('contenteditable', 'false');
		chip.dataset.attachmentId = attachment.id;

		if (attachment.isImage) {
			chip.classList.add('inline-attachment-image');
			chip.innerHTML = `
				<span class="inline-attachment-preview"><img src="${attachment.data}" alt="${attachment.name}" /></span>
				<span class="inline-attachment-info">
					<span class="inline-attachment-name">${attachment.name}</span>
					<span class="inline-attachment-size">${formatBytes(attachment.size)}</span>
					<button type="button" class="inline-attachment-remove" aria-label="Remove attachment">${createXIcon()}</button>
				</span>
			`;
			const img = chip.querySelector('img');
			if (img) img.addEventListener('load', () => this.el.dispatchEvent(new Event('input', { bubbles: true })));
		} else {
			chip.classList.add('inline-attachment-file');
			const ext = getFileExtension(attachment.name);
			chip.innerHTML = `
				<span class="inline-attachment-icon">
					${getFiletypeIcon(attachment.name)}
					<span class="inline-attachment-type">${ext.toUpperCase()}</span>
				</span>
				<span class="inline-attachment-info">
					<span class="inline-attachment-name">${attachment.name}</span>
					<span class="inline-attachment-type-name">${getFiletypeName(attachment.name)}</span>
					<span class="inline-attachment-size">${formatBytes(attachment.size)}</span>
					<button type="button" class="inline-attachment-remove" aria-label="Remove attachment">${createXIcon()}</button>
				</span>
			`;
		}
		return chip;
	}

	insertAtCursor(element) {
		this.isProcessing = true;
		try {
			const selection = window.getSelection();
			const hasTextBefore = (range) => {
				const container = range.startContainer;
				if (container.nodeType === Node.TEXT_NODE && container.textContent.slice(0, range.startOffset).trim()) return true;
				let sibling = container.previousSibling;
				while (sibling) {
					if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) return true;
					if (sibling.nodeType === Node.ELEMENT_NODE && (sibling.classList?.contains('inline-attachment') || sibling.textContent?.trim())) return true;
					sibling = sibling.previousSibling;
				}
				return false;
			};
			const hasTextAfter = (range) => {
				const container = range.startContainer;
				if (container.nodeType === Node.TEXT_NODE && container.textContent.slice(range.startOffset).trim()) return true;
				let sibling = container.nextSibling;
				while (sibling) {
					if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) return true;
					if (sibling.nodeType === Node.ELEMENT_NODE && (sibling.classList?.contains('inline-attachment') || sibling.textContent?.trim())) return true;
					sibling = sibling.nextSibling;
				}
				return false;
			};

			if (!selection || !selection.rangeCount) {
				if (this.el.firstChild && this.el.textContent?.trim()) this.el.appendChild(document.createElement('br'));
				this.el.appendChild(element);
				this.ensureTrailingSpace();
				return;
			}
			const range = selection.getRangeAt(0);
			if (!this.el.contains(range.commonAncestorContainer)) {
				if (this.el.firstChild && this.el.textContent?.trim()) this.el.appendChild(document.createElement('br'));
				this.el.appendChild(element);
				this.ensureTrailingSpace();
				return;
			}
			range.deleteContents();
			if (hasTextBefore(range)) {
				const br = document.createElement('br');
				range.insertNode(br);
				range.setStartAfter(br);
				range.collapse(true);
			}
			range.insertNode(element);
			range.setStartAfter(element);
			range.collapse(true);
			if (hasTextAfter({ startContainer: range.startContainer, startOffset: range.startOffset })) {
				const br = document.createElement('br');
				range.insertNode(br);
				range.setStartAfter(br);
				range.collapse(true);
			}
			setCursorAfter(element);
			this.ensureTrailingSpace();
		} finally {
			this.isProcessing = false;
		}
	}

	ensureTrailingSpace() {
		const selection = window.getSelection();
		if (!selection || !selection.rangeCount) return;
		const range = selection.getRangeAt(0);
		const container = range.startContainer;
		if (container.nodeType === Node.TEXT_NODE) {
			if (container.textContent.slice(range.startOffset).length === 0 &&
				(!container.nextSibling || container.nextSibling.tagName !== 'BR')) {
				container.textContent += ' ';
				range.setStart(container, range.startOffset);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		} else {
			const nextSibling = range.startContainer.childNodes[range.startOffset];
			if (!nextSibling || (nextSibling.nodeType !== Node.TEXT_NODE && nextSibling.tagName !== 'BR')) {
				const textNode = document.createTextNode(' ');
				range.insertNode(textNode);
				range.setStart(textNode, 0);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		}
	}

	removeAttachmentChip(chip) {
		const id         = chip.dataset.attachmentId;
		const attachment = this.attachments.get(id);
		const prevSibling = chip.previousSibling;
		const nextSibling = chip.nextSibling;
		chip.remove();
		this.attachments.delete(id);
		this.updateEmptyState();
		try {
			if (prevSibling?.nodeType === Node.TEXT_NODE) setCursorAfter(prevSibling);
			else if (nextSibling?.nodeType === Node.TEXT_NODE) setCursorBefore(nextSibling);
			else this.el.focus();
		} catch { this.el.focus(); }
		this.el.dispatchEvent(new Event('input', { bubbles: true }));
		this.options.onAttachmentRemoved?.(attachment);
	}

	extractParts() {
		const parts = [];

		const addNewlineIfNeeded = () => {
			if (!parts.length) return;
			const last = parts[parts.length - 1];
			if (last?.type === 'text' && !last.content.endsWith('\n')) last.content += '\n';
			else if (last?.type !== 'text') parts.push({ type: 'text', content: '\n' });
		};

		const processNode = (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const text = (node.textContent || '').replace(/\u00A0/g, ' ');
				if (!text) return;
				const lastPart = parts[parts.length - 1];
				if (lastPart?.type === 'text') lastPart.content += text;
				else parts.push({ type: 'text', content: text });

			} else if (node.tagName === 'BR') {
				let isPlaceholder = true;
				let next = node.nextSibling;
				while (next) {
					if (next.nodeType === Node.TEXT_NODE && next.textContent.length > 0) { isPlaceholder = false; break; }
					if (next.nodeType === Node.ELEMENT_NODE && next.tagName !== 'BR' && !next.classList?.contains('inline-attachment')) { isPlaceholder = false; break; }
					if (next.classList?.contains('inline-attachment') || next.tagName === 'BR') { isPlaceholder = false; break; }
					next = next.nextSibling;
				}
				if (isPlaceholder) return;
				const lastPart = parts[parts.length - 1];
				if (lastPart?.type === 'text') lastPart.content += '\n';
				else parts.push({ type: 'text', content: '\n' });

			} else if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'DIV' || node.tagName === 'P')) {
				addNewlineIfNeeded();
				for (const child of node.childNodes) processNode(child);

			} else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('inline-attachment')) {
				const attachment = this.attachments.get(node.dataset.attachmentId);
				if (attachment) {
					parts.push({
						type: 'attachment', id: attachment.id, name: attachment.name,
						size: attachment.size, mimeType: attachment.type,
						isImage: attachment.isImage, data: attachment.data,
					});
				}
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				for (const child of node.childNodes) processNode(child);
			}
		};

		for (const child of this.el.childNodes) processNode(child);

		const lastPart = parts[parts.length - 1];
		if (lastPart?.type === 'text') {
			lastPart.content = lastPart.content.trimEnd();
			if (!lastPart.content) parts.pop();
		}
		return parts;
	}

	clear() {
		this.attachments.clear();
		this.el.innerHTML = '';
		this.el.dataset.empty = 'true';
	}

	hasContent() {
		return this.attachments.size > 0 || (this.el.textContent || '').trim().length > 0;
	}

	updateEmptyState() {
		this.el.dataset.empty = this.hasContent() ? 'false' : 'true';
	}

	focus() {
		this.el.focus();
		if (!this.el.firstChild) this.el.appendChild(document.createTextNode(''));
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		if (this.el.lastChild?.nodeType === Node.TEXT_NODE) {
			range.setStart(this.el.lastChild, this.el.lastChild.textContent.length);
			range.collapse(true);
		} else {
			range.selectNodeContents(this.el);
			range.collapse(false);
		}
		selection.removeAllRanges();
		selection.addRange(range);
	}

	getAttachments() {
		return Array.from(this.attachments.values());
	}
}

export default InlineAttachmentManager;
