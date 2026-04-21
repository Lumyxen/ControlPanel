import { parseMarkdown } from './markdown.js';
import { detectAndRenderColours } from './colours.js';

export function renderMessageTextHtml(text) {
	return detectAndRenderColours(parseMarkdown(String(text ?? '')));
}

export function renderMessageTextInto(target, text) {
	if (!target) return null;
	target.innerHTML = renderMessageTextHtml(text);
	return target;
}
