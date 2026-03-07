/**
 * InlineAttachmentManager - Handles inline file attachments in contenteditable
 * 
 * Features:
 * - Insert attachment chips at cursor position
 * - Track attachment data associated with each chip
 * - Handle backspace/delete to remove chips
 * - Alt+Up/Down to move content
 * - Extract content as parts array
 */

import { generateId } from "./util.js";
import { formatBytes } from "./util.js";

// Filetype icons as SVG strings
const FILETYPE_ICONS = {
	// Archives
	zip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M12 11v6M9 14h6"/></svg>`,
	tar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h4"/></svg>`,
	gz: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M12 11v6M9 14h6"/></svg>`,
	rar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M9 9h6M9 13h6"/></svg>`,
	
	// Code
	js: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>`,
	ts: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/><text x="12" y="14" font-size="6" fill="currentColor" stroke="none">TS</text></svg>`,
	py: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C6.5 2 6 4 6 6v3h6v1H4c-2 0-4 1.5-4 5s2 5 4 5h2v-3c0-2 1.5-4 4-4h6c2 0 4-2 4-4V6c0-2-2-4-8-4zm-2 2.5a1 1 0 110 2 1 1 0 010-2z"/><path d="M12 22c5.5 0 6-2 6-4v-3h-6v-1h8c2 0 4-1.5 4-5s-2-5-4-5h-2v3c0 2-1.5 4-4 4H8c-2 0-4 2-4 4v3c0 2 2 4 8 4zm2-2.5a1 1 0 110-2 1 1 0 010 2z"/></svg>`,
	java: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 20c-2 0-3-1-3-3 2-2 6-2 8-5 1 2 1 4-1 6-2 2-4 2-4 2z"/><path d="M16 4c0 2-2 4-6 6-2 1-3 3-3 5 0 0 1-2 4-3 4-1 6-4 5-8z"/><path d="M18 12c0 1-1 2-3 3-1 1-2 2-2 3"/></svg>`,
	jar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="3" width="12" height="18" rx="1"/><path d="M6 7h12M6 11h12M6 15h12"/><circle cx="12" cy="19" r="1"/></svg>`,
	json: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-2"/><path d="M7 8h2M7 12h4M7 16h2"/></svg>`,
	html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l2 16 6 2 6-2 2-16H4z"/><path d="M8 8h8l-1 8-3 1-3-1-.5-4h3"/></svg>`,
	css: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l2 16 6 2 6-2 2-16H4z"/><path d="M8 8h8M8 12h7M9 16l3 1 3-1"/></svg>`,
	
	// Documents
	pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>`,
	doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	docx: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	txt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	md: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M7 13l2 2 2-2M7 17l2 2 2-2M13 13h4M13 17h4"/></svg>`,
	
	// Media
	mp3: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
	wav: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
	mp4: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>`,
	avi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>`,
	
	// Images (fallback for non-preview)
	png: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	jpg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	jpeg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	gif: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/><text x="12" y="14" font-size="5" fill="currentColor" stroke="none">GIF</text></svg>`,
	svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	webp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	
	// Default
	default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
};

// Filetype display names
const FILETYPE_NAMES = {
	zip: "ZIP Archive",
	tar: "TAR Archive",
	gz: "GZip Archive",
	rar: "RAR Archive",
	js: "JavaScript",
	ts: "TypeScript",
	py: "Python",
	java: "Java",
	jar: "Java Archive",
	json: "JSON",
	html: "HTML",
	css: "CSS",
	pdf: "PDF Document",
	doc: "Word Document",
	docx: "Word Document",
	txt: "Text File",
	md: "Markdown",
	mp3: "MP3 Audio",
	wav: "WAV Audio",
	mp4: "MP4 Video",
	avi: "AVI Video",
	png: "PNG Image",
	jpg: "JPEG Image",
	jpeg: "JPEG Image",
	gif: "GIF Image",
	svg: "SVG Image",
	webp: "WebP Image",
};

/**
 * Get file extension from filename
 */
function getFileExtension(filename) {
	const match = filename.match(/\.([^.]+)$/);
	return match ? match[1].toLowerCase() : "";
}

/**
 * Check if file is an image
 */
export function isImageFile(file) {
	const type = String(file?.type || "");
	if (type.startsWith("image/")) return true;
	const ext = getFileExtension(file?.name || "");
	return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

/**
 * Get filetype icon SVG
 */
function getFiletypeIcon(filename) {
	const ext = getFileExtension(filename);
	return FILETYPE_ICONS[ext] || FILETYPE_ICONS.default;
}

/**
 * Get filetype display name
 */
function getFiletypeName(filename) {
	const ext = getFileExtension(filename);
	return FILETYPE_NAMES[ext] || ext.toUpperCase() + " File";
}

/**
 * Create X icon for remove button
 */
function createXIcon() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`;
}

/**
 * Normalize the DOM by merging adjacent text nodes and removing empty ones
 * This is crucial for consistent cursor behavior
 */
function normalizeContentEditable(el) {
	// First, merge adjacent text nodes
	el.normalize();
	
	// Then clean up any problematic text nodes
	const childNodes = Array.from(el.childNodes);
	for (const node of childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			// Remove empty text nodes (but keep one if it's the only content)
			// Also preserve text nodes that are just whitespace if they're between elements
			if (!node.textContent) {
				if (el.childNodes.length > 1) {
					node.remove();
				}
			}
		}
	}
	
	// Remove consecutive BR elements (keep only one)
	const nodes = Array.from(el.childNodes);
	let lastWasBR = false;
	for (const node of nodes) {
		if (node.tagName === "BR") {
			if (lastWasBR) {
				node.remove();
			} else {
				lastWasBR = true;
			}
		} else if (node.nodeType !== Node.TEXT_NODE || node.textContent.trim()) {
			lastWasBR = false;
		}
	}
}

/**
 * Get the current cursor position in a robust way
 */
function getCursorPosition(el) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	
	const range = selection.getRangeAt(0);
	if (!el.contains(range.commonAncestorContainer)) return null;
	
	return { selection, range };
}

/**
 * Set cursor position after an element
 */
function setCursorAfter(element) {
	const selection = window.getSelection();
	if (!selection) return;
	
	const range = document.createRange();
	range.setStartAfter(element);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/**
 * Set cursor position before an element
 */
function setCursorBefore(element) {
	const selection = window.getSelection();
	if (!selection) return;
	
	const range = document.createRange();
	range.setStartBefore(element);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/**
 * InlineAttachmentManager class
 */
export class InlineAttachmentManager {
	constructor(contentEditableEl, options = {}) {
		this.el = contentEditableEl;
		this.options = {
			maxImagePreviewWidth: 400,
			maxImagePreviewHeight: 300,
			onAttachmentAdded: null,
			onAttachmentRemoved: null,
			...options,
		};
		this.attachments = new Map(); // id -> attachment data
		this.isProcessing = false; // Flag to prevent recursive handling
		this.setupEventListeners();
	}

	/**
	 * Setup event listeners for contenteditable
	 */
	setupEventListeners() {
		// Handle backspace/delete for attachment removal
		this.el.addEventListener("keydown", (e) => this.handleKeyDown(e));
		
		// Handle click on remove buttons
		this.el.addEventListener("click", (e) => this.handleClick(e));
		
		// Handle paste
		this.el.addEventListener("paste", (e) => this.handlePaste(e));
		
		// Handle input events to normalize DOM
		this.el.addEventListener("input", () => {
			// Debounce normalization
			if (this._normalizeTimeout) {
				clearTimeout(this._normalizeTimeout);
			}
			this._normalizeTimeout = setTimeout(() => {
				// Only normalize if we're not in the middle of an operation
				if (!this.isProcessing) {
					this.normalizeDOM();
				}
			}, 50);
		});
		
		// Clean up on blur
		this.el.addEventListener("blur", () => {
			this.normalizeDOM();
		});
		
		// Handle focus - ensure cursor is in a valid position
		this.el.addEventListener("focus", () => {
			// Ensure there's at least a text node to type in
			if (!this.el.firstChild) {
				const textNode = document.createTextNode("");
				this.el.appendChild(textNode);
			}
		});
	}

	/**
	 * Normalize the DOM structure
	 */
	normalizeDOM() {
		normalizeContentEditable(this.el);
	}

	/**
	 * Handle keydown events
	 */
	handleKeyDown(e) {
		// Prevent recursive handling
		if (this.isProcessing) return;
		
		// Alt+Up/Down for moving content
		if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			e.preventDefault();
			this.moveContent(e.key === "ArrowUp" ? -1 : 1);
			return;
		}
		
		// Backspace/Delete handling for attachments
		if (e.key === "Backspace" || e.key === "Delete") {
			const cursorPos = getCursorPosition(this.el);
			if (!cursorPos) return;
			
			const { selection, range } = cursorPos;
			
			// Check if there's a selection range (not collapsed)
			if (!range.collapsed) {
				// Check if the selection contains any chips
				const chipsInRange = this.getChipsInRange(range);
				if (chipsInRange.length > 0) {
					e.preventDefault();
					this.isProcessing = true;
					try {
						// Remove all chips in the selection
						for (const chip of chipsInRange) {
							this.removeAttachmentChip(chip);
						}
						// Let the browser handle the remaining text deletion
						range.deleteContents();
						this.normalizeDOM();
					} finally {
						this.isProcessing = false;
					}
					return;
				}
				// Let the browser handle normal selection deletion
				return;
			}
			
			// Collapsed range - check if we're adjacent to a chip
			const chip = this.getAdjacentChip(range, e.key === "Backspace" ? "before" : "after");
			
			if (chip) {
				e.preventDefault();
				this.isProcessing = true;
				try {
					// Remove the chip
					this.removeAttachmentChip(chip);
					this.normalizeDOM();
				} finally {
					this.isProcessing = false;
				}
				return;
			}
			
			// Deselect any selected chips if we're typing elsewhere
			this.el.querySelectorAll(".inline-attachment.selected").forEach((c) => {
				c.classList.remove("selected");
			});
		}
		
		// Arrow key handling for chip selection
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			const cursorPos = getCursorPosition(this.el);
			if (!cursorPos) return;
			
			const { range } = cursorPos;
			if (!range.collapsed) return;
			
			// Check if we're about to navigate into a chip
			const chip = this.getAdjacentChip(range, e.key === "ArrowLeft" ? "before" : "after");
			if (chip) {
				// Deselect any previously selected chips
				this.el.querySelectorAll(".inline-attachment.selected").forEach((c) => {
					c.classList.remove("selected");
				});
				
				// If navigating to an image chip and there's no text node after, create one
				if (e.key === "ArrowRight" && chip.classList.contains("inline-attachment-image")) {
					const nextSibling = chip.nextSibling;
					if (!nextSibling || (nextSibling.nodeType === Node.TEXT_NODE && !nextSibling.textContent.trim()) || nextSibling.tagName === 'BR') {
						const textNode = document.createTextNode(" ");
						this.el.insertBefore(textNode, nextSibling || null);
					}
				}
			}
		}
	}

	/**
	 * Get all chips within a range
	 */
	getChipsInRange(range) {
		const chips = [];
		const walker = document.createTreeWalker(
			range.commonAncestorContainer,
			NodeFilter.SHOW_ELEMENT,
			null
		);
		
		let node = walker.currentNode;
		while (node) {
			if (node.nodeType === Node.ELEMENT_NODE && 
				node.classList?.contains("inline-attachment") &&
				range.intersectsNode(node)) {
				chips.push(node);
			}
			node = walker.nextNode();
		}
		
		return chips;
	}

	/**
	 * Get adjacent attachment chip - improved version
	 */
	getAdjacentChip(range, direction) {
		if (!range.collapsed) return null;
		
		const container = range.startContainer;
		const offset = range.startOffset;
		
		// Helper to check if a node is a chip
		const isChip = (node) => 
			node?.nodeType === Node.ELEMENT_NODE && 
			node.classList?.contains("inline-attachment");
		
		// Helper to check if a node is just a BR element
		const isBR = (node) => node?.nodeType === Node.ELEMENT_NODE && node.tagName === "BR";
		
		// Helper to check if a text node is empty or just whitespace
		const isEmptyText = (node) => 
			node?.nodeType === Node.TEXT_NODE && !node.textContent.trim();
		
		if (direction === "before") {
			// We're looking for a chip that's IMMEDIATELY before the cursor
			// The cursor must be at the START of a text node (position 0)
			// and the previous sibling must be a chip (possibly with BR in between)
			
			if (container.nodeType === Node.TEXT_NODE) {
				// Only consider if cursor is at position 0
				if (offset !== 0) return null;
				
				// Check previous sibling
				let prev = container.previousSibling;
				
				// Skip BR elements and empty text nodes
				while (prev && (isBR(prev) || isEmptyText(prev))) {
					prev = prev.previousSibling;
				}
				
				// If previous sibling is a chip, return it
				if (isChip(prev)) return prev;
				
				// If we're in a nested structure, check parent's previous sibling
				if (container.parentElement !== this.el) {
					let parentPrev = container.parentElement.previousSibling;
					while (parentPrev && (isBR(parentPrev) || isEmptyText(parentPrev))) {
						parentPrev = parentPrev.previousSibling;
					}
					if (isChip(parentPrev)) return parentPrev;
				}
			} else if (container === this.el) {
				// Cursor is directly in the contenteditable
				// Check the element at offset-1
				const children = Array.from(this.el.childNodes);
				if (offset > 0) {
					let prev = children[offset - 1];
					// Skip BR and empty text
					while (prev && (isBR(prev) || isEmptyText(prev))) {
						const prevIndex = children.indexOf(prev) - 1;
						prev = prevIndex >= 0 ? children[prevIndex] : null;
					}
					if (isChip(prev)) return prev;
				}
			}
		} else {
			// Direction: after
			// We're looking for a chip that's IMMEDIATELY after the cursor
			// The cursor must be at the END of a text node
			// and the next sibling must be a chip (possibly with BR in between)
			
			if (container.nodeType === Node.TEXT_NODE) {
				// Only consider if cursor is at the end
				if (offset !== container.textContent.length) return null;
				
				// Check next sibling
				let next = container.nextSibling;
				
				// Skip BR elements and empty text nodes
				while (next && (isBR(next) || isEmptyText(next))) {
					next = next.nextSibling;
				}
				
				// If next sibling is a chip, return it
				if (isChip(next)) return next;
				
				// If we're in a nested structure, check parent's next sibling
				if (container.parentElement !== this.el) {
					let parentNext = container.parentElement.nextSibling;
					while (parentNext && (isBR(parentNext) || isEmptyText(parentNext))) {
						parentNext = parentNext.nextSibling;
					}
					if (isChip(parentNext)) return parentNext;
				}
			} else if (container === this.el) {
				// Cursor is directly in the contenteditable
				// Check the element at offset
				const children = Array.from(this.el.childNodes);
				if (offset < children.length) {
					let next = children[offset];
					// Skip BR and empty text
					while (next && (isBR(next) || isEmptyText(next))) {
						const nextIndex = children.indexOf(next) + 1;
						next = nextIndex < children.length ? children[nextIndex] : null;
					}
					if (isChip(next)) return next;
				}
			}
		}
		
		return null;
	}

	/**
	 * Handle click events
	 */
	handleClick(e) {
		const removeBtn = e.target.closest(".inline-attachment-remove");
		if (removeBtn) {
			e.preventDefault();
			e.stopPropagation();
			const chip = removeBtn.closest(".inline-attachment");
			if (chip) {
				this.isProcessing = true;
				try {
					this.removeAttachmentChip(chip);
				} finally {
					this.isProcessing = false;
				}
			}
			return;
		}
		
		// Deselect chips when clicking elsewhere
		if (!e.target.closest(".inline-attachment")) {
			this.el.querySelectorAll(".inline-attachment.selected").forEach((c) => {
				c.classList.remove("selected");
			});
		}
	}

	/**
	 * Handle paste events
	 */
	handlePaste(e) {
		const items = e.clipboardData?.items;
		if (!items) return;
		
		for (const item of items) {
			if (item.kind === "file") {
				e.preventDefault();
				const file = item.getAsFile();
				if (file) this.addFile(file);
				return; // Only handle the first file
			}
		}
	}

	/**
	 * Move selected content up or down
	 */
	moveContent(direction) {
		const selection = window.getSelection();
		if (!selection.rangeCount) return;
		
		const range = selection.getRangeAt(0);
		
		// Get the element or text node to move
		let nodeToMove = null;
		let isChip = false;
		
		if (range.startContainer === range.endContainer && range.startOffset !== range.endOffset) {
			// There's a selection
			if (range.startContainer.nodeType === Node.TEXT_NODE) {
				nodeToMove = range.extractContents();
			}
		} else {
			// Check if a chip is selected
			const selectedChip = this.el.querySelector(".inline-attachment.selected");
			if (selectedChip) {
				nodeToMove = selectedChip;
				isChip = true;
			}
		}
		
		if (!nodeToMove) return;
		
		// Find the adjacent node
		const allNodes = Array.from(this.el.childNodes);
		const currentIndex = isChip ? allNodes.indexOf(nodeToMove) : -1;
		
		if (currentIndex === -1) return;
		
		const targetIndex = currentIndex + direction;
		if (targetIndex < 0 || targetIndex >= allNodes.length) return;
		
		// Move the node
		const targetNode = allNodes[targetIndex];
		if (direction < 0) {
			this.el.insertBefore(nodeToMove, targetNode);
		} else {
			this.el.insertBefore(nodeToMove, targetNode.nextSibling);
		}
		
		// Restore selection
		if (!isChip) {
			const newRange = document.createRange();
			newRange.selectNodeContents(nodeToMove);
			selection.removeAllRanges();
			selection.addRange(newRange);
		}
	}

	/**
	 * Add a file as an inline attachment at cursor position
	 */
	async addFile(file) {
		const id = generateId();
		const isImage = isImageFile(file);
		
		const attachment = {
			id,
			name: file.name,
			size: file.size,
			type: file.type || "application/octet-stream",
			isImage,
			data: null,
		};
		
		// Read file as data URL
		attachment.data = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
		
		// Store attachment data
		this.attachments.set(id, attachment);
		
		// Create and insert chip element
		const chip = this.createChipElement(attachment);
		this.insertAtCursor(chip);
		
		// Update empty state
		this.updateEmptyState();
		
		// Trigger input event to notify parent components (like auto-resize)
		this.el.dispatchEvent(new Event("input", { bubbles: true }));
		
		// Callback
		this.options.onAttachmentAdded?.(attachment);
		
		return attachment;
	}

	/**
	 * Create chip element for attachment
	 */
	createChipElement(attachment) {
		const chip = document.createElement("span");
		chip.className = "inline-attachment";
		chip.setAttribute("contenteditable", "false");
		chip.dataset.attachmentId = attachment.id;
		
		if (attachment.isImage) {
			chip.classList.add("inline-attachment-image");
			chip.innerHTML = `
				<span class="inline-attachment-preview">
					<img src="${attachment.data}" alt="${attachment.name}" />
				</span>
				<span class="inline-attachment-info">
					<span class="inline-attachment-name">${attachment.name}</span>
					<span class="inline-attachment-size">${formatBytes(attachment.size)}</span>
					<button type="button" class="inline-attachment-remove" aria-label="Remove attachment">
						${createXIcon()}
					</button>
				</span>
			`;
			
			// Trigger resize when image loads
			const img = chip.querySelector("img");
			if (img) {
				img.addEventListener("load", () => {
					this.el.dispatchEvent(new Event("input", { bubbles: true }));
				});
			}
		} else {
			chip.classList.add("inline-attachment-file");
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
					<button type="button" class="inline-attachment-remove" aria-label="Remove attachment">
						${createXIcon()}
					</button>
				</span>
			`;
		}
		
		return chip;
	}

	/**
	 * Insert element at cursor position - improved version
	 */
	insertAtCursor(element) {
		this.isProcessing = true;
		
		try {
			const selection = window.getSelection();
			
			// Helper to check if there's text content before cursor
			const hasTextBefore = (range) => {
				const container = range.startContainer;
				if (container.nodeType === Node.TEXT_NODE) {
					const textBefore = container.textContent.slice(0, range.startOffset).trim();
					if (textBefore) return true;
				}
				// Check previous siblings
				let sibling = container.previousSibling;
				while (sibling) {
					if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) return true;
					if (sibling.nodeType === Node.ELEMENT_NODE) {
						if (sibling.classList?.contains("inline-attachment")) return true;
						if (sibling.textContent?.trim()) return true;
					}
					sibling = sibling.previousSibling;
				}
				return false;
			};
			
			// Helper to check if there's text content after cursor
			const hasTextAfter = (range) => {
				const container = range.startContainer;
				if (container.nodeType === Node.TEXT_NODE) {
					const textAfter = container.textContent.slice(range.startOffset).trim();
					if (textAfter) return true;
				}
				// Check next siblings
				let sibling = container.nextSibling;
				while (sibling) {
					if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim()) return true;
					if (sibling.nodeType === Node.ELEMENT_NODE) {
						if (sibling.classList?.contains("inline-attachment")) return true;
						if (sibling.textContent?.trim()) return true;
					}
					sibling = sibling.nextSibling;
				}
				return false;
			};
			
			if (!selection || !selection.rangeCount) {
				// No selection, append to end with line break if needed
				if (this.el.firstChild && this.el.textContent?.trim()) {
					this.el.appendChild(document.createElement("br"));
				}
				this.el.appendChild(element);
				this.ensureTrailingSpace();
				return;
			}
			
			const range = selection.getRangeAt(0);
			
			// Check if range is within our contenteditable
			if (!this.el.contains(range.commonAncestorContainer)) {
				if (this.el.firstChild && this.el.textContent?.trim()) {
					this.el.appendChild(document.createElement("br"));
				}
				this.el.appendChild(element);
				this.ensureTrailingSpace();
				return;
			}
			
			// Delete any selected content
			range.deleteContents();
			
			// Check if we need a line break before the attachment
			if (hasTextBefore(range)) {
				const br = document.createElement("br");
				range.insertNode(br);
				range.setStartAfter(br);
				range.collapse(true);
			}
			
			// Insert the element
			range.insertNode(element);
			range.setStartAfter(element);
			range.collapse(true);
			
			// Check if we need a line break after the attachment
			if (hasTextAfter({ startContainer: range.startContainer, startOffset: range.startOffset })) {
				const br = document.createElement("br");
				range.insertNode(br);
				range.setStartAfter(br);
				range.collapse(true);
			}
			
			// Position cursor after the element
			setCursorAfter(element);
			
			// Ensure there's a space for typing
			this.ensureTrailingSpace();
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * Ensure there's a trailing space after the cursor for easier typing
	 */
	ensureTrailingSpace() {
		const selection = window.getSelection();
		if (!selection || !selection.rangeCount) return;
		
		const range = selection.getRangeAt(0);
		const container = range.startContainer;
		
		// Check if we need to add a space
		if (container.nodeType === Node.TEXT_NODE) {
			// We're in a text node, check if there's content after cursor
			const textAfterCursor = container.textContent.slice(range.startOffset);
			if (textAfterCursor.length === 0) {
				// We're at the end of the text node, check if there's a next sibling
				if (!container.nextSibling || container.nextSibling.tagName !== 'BR') {
					// Add a space at the end for typing
					container.textContent += " ";
					// Position cursor before the space
					range.setStart(container, range.startOffset);
					range.collapse(true);
					selection.removeAllRanges();
					selection.addRange(range);
				}
			}
		} else {
			// We're in an element, check if we need a text node
			const nextSibling = range.startContainer.childNodes[range.startOffset];
			if (!nextSibling || (nextSibling.nodeType !== Node.TEXT_NODE && nextSibling.tagName !== 'BR')) {
				// Add a text node with a space
				const textNode = document.createTextNode(" ");
				range.insertNode(textNode);
				range.setStart(textNode, 0);
				range.collapse(true);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		}
	}

	/**
	 * Remove an attachment chip - improved version
	 */
	removeAttachmentChip(chip) {
		const id = chip.dataset.attachmentId;
		const attachment = this.attachments.get(id);
		
		// Save cursor position relative to chip
		const selection = window.getSelection();
		let restoreCursor = false;
		let cursorBefore = false;
		
		if (selection && selection.rangeCount) {
			const range = selection.getRangeAt(0);
			if (this.el.contains(range.commonAncestorContainer)) {
				// Check if cursor is before or after the chip
				const chipRect = chip.getBoundingClientRect();
				const rangeRect = range.getBoundingClientRect();
				if (rangeRect.width === 0 && rangeRect.height === 0) {
					// Collapsed range, use position comparison
					const rangePos = range.startContainer.compareDocumentPosition(chip);
					cursorBefore = (rangePos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
					restoreCursor = true;
				}
			}
		}
		
		// Find adjacent nodes before removal
		const prevSibling = chip.previousSibling;
		const nextSibling = chip.nextSibling;
		
		// Remove from DOM
		chip.remove();
		
		// Remove from tracking
		this.attachments.delete(id);
		
		// Clean up empty text nodes and normalize
		this.normalizeDOM();
		
		// Update empty state
		this.updateEmptyState();
		
		// Restore cursor position
		if (restoreCursor) {
			try {
				// Try to position cursor where the chip was
				if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
					setCursorAfter(prevSibling);
				} else if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
					setCursorBefore(nextSibling);
				} else {
					// Just focus the element
					this.el.focus();
				}
			} catch (e) {
				// If cursor restoration fails, just focus
				this.el.focus();
			}
		}
		
		// Trigger input event to notify parent components (like auto-resize)
		this.el.dispatchEvent(new Event("input", { bubbles: true }));
		
		// Callback
		this.options.onAttachmentRemoved?.(attachment);
	}

	/**
	 * Extract content as parts array
	 */
	extractParts() {
		// Don't normalize here - it could interfere with cursor position
		// Just read the DOM as-is
		
		const parts = [];
		
		for (const child of this.el.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				// Get text content
				const text = child.textContent;
				if (text) {
					// Merge with previous text part if exists
					const lastPart = parts[parts.length - 1];
					if (lastPart?.type === "text") {
						lastPart.content += text;
					} else {
						parts.push({ type: "text", content: text });
					}
				}
			} else if (child.tagName === "BR") {
				// Handle line breaks - add newline to previous text part or create new one
				const lastPart = parts[parts.length - 1];
				if (lastPart?.type === "text") {
					lastPart.content += "\n";
				} else {
					parts.push({ type: "text", content: "\n" });
				}
			} else if (child.nodeType === Node.ELEMENT_NODE && child.classList?.contains("inline-attachment")) {
				const id = child.dataset.attachmentId;
				const attachment = this.attachments.get(id);
				if (attachment) {
					parts.push({
						type: "attachment",
						id: attachment.id,
						name: attachment.name,
						size: attachment.size,
						mimeType: attachment.type,
						isImage: attachment.isImage,
						data: attachment.data,
					});
				}
			}
		}
		
		// Trim trailing whitespace from the last text part
		const lastPart = parts[parts.length - 1];
		if (lastPart?.type === "text") {
			lastPart.content = lastPart.content.trimEnd();
			if (!lastPart.content) {
				parts.pop();
			}
		}
		
		return parts;
	}

	/**
	 * Clear all content
	 */
	clear() {
		this.attachments.clear();
		this.el.innerHTML = "";
		// Update placeholder state
		this.el.dataset.empty = "true";
	}

	/**
	 * Check if there's any content
	 */
	hasContent() {
		// Check for attachments
		if (this.attachments.size > 0) return true;
		
		// Check for text content (excluding whitespace)
		const text = this.el.textContent || "";
		return text.trim().length > 0;
	}

	/**
	 * Update the empty state indicator
	 */
	updateEmptyState() {
		const hasContent = this.hasContent();
		this.el.dataset.empty = hasContent ? "false" : "true";
	}

	/**
	 * Focus the input
	 */
	focus() {
		this.el.focus();
		
		// Ensure there's a text node to type in
		if (!this.el.firstChild) {
			const textNode = document.createTextNode("");
			this.el.appendChild(textNode);
		}
		
		// Move cursor to end
		const selection = window.getSelection();
		if (!selection) return;
		
		const range = document.createRange();
		
		// Move to end of content
		if (this.el.lastChild && this.el.lastChild.nodeType === Node.TEXT_NODE) {
			range.setStart(this.el.lastChild, this.el.lastChild.textContent.length);
			range.collapse(true);
		} else {
			range.selectNodeContents(this.el);
			range.collapse(false);
		}
		
		selection.removeAllRanges();
		selection.addRange(range);
	}

	/**
	 * Get all attachments
	 */
	getAttachments() {
		return Array.from(this.attachments.values());
	}
}

export default InlineAttachmentManager;
