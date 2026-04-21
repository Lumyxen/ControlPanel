const OUTLET = '[data-fragment="main"]';
const cache = new Map();

let navAbort = null;

function getOutlet() {
	if (typeof document === 'undefined') return null;
	return document.querySelector(OUTLET);
}

async function fetchFragmentSource(url, signal) {
	const baseUrl = url.split('?')[0];
	if (cache.has(baseUrl)) return cache.get(baseUrl);
	const response = await fetch(baseUrl, { signal, credentials: 'same-origin' });
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${baseUrl}`);
	const text = await response.text();
	cache.set(baseUrl, text);
	return text;
}

export function parseFragment(html, url) {
	const template = document.createElement('template');
	template.innerHTML = html.trim();
	const node = template.content.querySelector(OUTLET) || template.content.firstElementChild;
	if (!node) throw new Error(`No fragment in ${url}`);
	if (!node.matches(OUTLET)) node.setAttribute('data-fragment', 'main');
	node.classList.add('content');
	return node;
}

export async function loadFragment(url) {
	navAbort?.abort();
	const controller = new AbortController();
	navAbort = controller;
	const source = await fetchFragmentSource(url, controller.signal);
	if (controller.signal.aborted) return null;
	const fragment = parseFragment(source, url);
	const outlet = getOutlet();
	if (!outlet) throw new Error('Fragment outlet not found');
	outlet.replaceWith(fragment);
	return getOutlet();
}

export function prefetchFragment(url) {
	const baseUrl = url.split('?')[0];
	if (!cache.has(baseUrl)) fetchFragmentSource(baseUrl).catch(() => {});
}
