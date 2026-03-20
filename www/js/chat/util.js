// www/js/chat/util.js
// Shared utility functions used across multiple chat modules.

// ─── ID / Formatting ──────────────────────────────────────────────────────────

export function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ─── File Type Icons & Names ──────────────────────────────────────────────────
// Single canonical set used by both inline-attachment.js and thread-ui.js.

export const FILETYPE_ICONS = {
	// Archives
	zip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M12 11v6M9 14h6"/></svg>`,
	tar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h4"/></svg>`,
	gz:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M12 11v6M9 14h6"/></svg>`,
	rar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z"/><path d="M9 9h6M9 13h6"/></svg>`,
	// Code
	js:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>`,
	ts:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/><text x="12" y="14" font-size="6" fill="currentColor" stroke="none">TS</text></svg>`,
	py:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2C6.5 2 6 4 6 6v3h6v1H4c-2 0-4 1.5-4 5s2 5 4 5h2v-3c0-2 1.5-4 4-4h6c2 0 4-2 4-4V6c0-2-2-4-8-4zm-2 2.5a1 1 0 110 2 1 1 0 010-2z"/><path d="M12 22c5.5 0 6-2 6-4v-3h-6v-1h8c2 0 4-1.5 4-5s-2-5-4-5h-2v3c0 2-1.5 4-4 4H8c-2 0-4 2-4 4v3c0 2 2 4 8 4zm2-2.5a1 1 0 110-2 1 1 0 010 2z"/></svg>`,
	java: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 20c-2 0-3-1-3-3 2-2 6-2 8-5 1 2 1 4-1 6-2 2-4 2-4 2z"/><path d="M16 4c0 2-2 4-6 6-2 1-3 3-3 5 0 0 1-2 4-3 4-1 6-4 5-8z"/><path d="M18 12c0 1-1 2-3 3-1 1-2 2-2 3"/></svg>`,
	jar:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="3" width="12" height="18" rx="1"/><path d="M6 7h12M6 11h12M6 15h12"/><circle cx="12" cy="19" r="1"/></svg>`,
	json: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-2"/><path d="M7 8h2M7 12h4M7 16h2"/></svg>`,
	html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l2 16 6 2 6-2 2-16H4z"/><path d="M8 8h8l-1 8-3 1-3-1-.5-4h3"/></svg>`,
	css:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l2 16 6 2 6-2 2-16H4z"/><path d="M8 8h8M8 12h7M9 16l3 1 3-1"/></svg>`,
	// Documents
	pdf:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>`,
	doc:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	docx: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	txt:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`,
	md:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M7 13l2 2 2-2M7 17l2 2 2-2M13 13h4M13 17h4"/></svg>`,
	// Audio / Video
	mp3:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
	wav:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
	mp4:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>`,
	avi:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3V9z"/></svg>`,
	// Images
	png:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	jpg:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	jpeg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	gif:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/><text x="12" y="14" font-size="5" fill="currentColor" stroke="none">GIF</text></svg>`,
	svg:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	webp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
	// Default
	default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
};

export const FILETYPE_NAMES = {
	zip: "ZIP Archive", tar: "TAR Archive", gz: "GZip Archive", rar: "RAR Archive",
	js: "JavaScript", ts: "TypeScript", py: "Python", java: "Java",
	jar: "Java Archive", json: "JSON", html: "HTML", css: "CSS",
	pdf: "PDF Document", doc: "Word Document", docx: "Word Document",
	txt: "Text File", md: "Markdown",
	mp3: "MP3 Audio", wav: "WAV Audio", mp4: "MP4 Video", avi: "AVI Video",
	png: "PNG Image", jpg: "JPEG Image", jpeg: "JPEG Image",
	gif: "GIF Image", svg: "SVG Image", webp: "WebP Image",
};

export function getFileExtension(filename) {
	const match = (filename || "").match(/\.([^.]+)$/);
	return match ? match[1].toLowerCase() : "";
}

export function getFiletypeIcon(filename) {
	return FILETYPE_ICONS[getFileExtension(filename)] || FILETYPE_ICONS.default;
}

export function getFiletypeName(filename) {
	const ext = getFileExtension(filename);
	return FILETYPE_NAMES[ext] || ext.toUpperCase() + " File";
}

export function isImageFile(file) {
	const type = String(file?.type || "");
	if (type.startsWith("image/")) return true;
	return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(getFileExtension(file?.name || ""));
}

export function createXIcon() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>`;
}
