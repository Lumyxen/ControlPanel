export function $(selector, root = document) {
	return root.querySelector(selector);
}

export function $$(selector, root = document) {
	return Array.from(root.querySelectorAll(selector));
}

export function createElement(tagName, options = {}) {
	const element = document.createElement(tagName);
	if (options.className) element.className = options.className;
	if (options.text != null) element.textContent = String(options.text);
	if (options.html != null) element.innerHTML = String(options.html);
	if (options.attributes) {
		Object.entries(options.attributes).forEach(([name, value]) => {
			if (value != null) element.setAttribute(name, String(value));
		});
	}
	return element;
}
