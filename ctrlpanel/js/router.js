const OUTLET = '[data-fragment="main"]';
const DEFAULT_ROUTE = "pages/home.html";
const cache = new Map();

let outlet = document.querySelector(OUTLET);
let navAbort = null;

export const normalise = (hash) => hash.replace(/^#\/?/, "");
export const currentRoute = () => normalise(location.hash) || DEFAULT_ROUTE;

function getChatIdFromRoute(route) {
	try {
		return new URLSearchParams(route.split("?")[1] || "").get("chat");
	} catch {
		return null;
	}
}

export function setActive(url, currentChatId) {
	const isChat = url.includes("ai-chat.html");
	const urlChatId = isChat ? getChatIdFromRoute(url) : null;
	const effectiveChatId = urlChatId || currentChatId || null;

	document.querySelectorAll("a[data-route]").forEach((a) => {
		const href = a.getAttribute("href") || "";
		const isChatLink = href.includes("ai-chat.html");

		if (isChatLink && isChat) {
			const linkChatId = a.dataset.chatId || null;
			const isNewChatLink = a.hasAttribute("data-new-chat");

			if (linkChatId) {
				a.classList.toggle("active", linkChatId === effectiveChatId);
			} else if (isNewChatLink) {
				a.classList.toggle("active", !effectiveChatId);
			} else {
				a.classList.remove("active");
			}
			return;
		}
		a.classList.toggle("active", href === "#" + url.split("?")[0]);
	});

	const navGroup = document.querySelector('[data-nav-group="ai-chat"]');
	if (navGroup) navGroup.classList.toggle("has-active", isChat);
}

async function fetchText(url, signal) {
	const baseUrl = url.split("?")[0];
	if (cache.has(baseUrl)) return cache.get(baseUrl);
	const res = await fetch(baseUrl, { signal, credentials: "same-origin" });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${baseUrl}`);
	const text = await res.text();
	cache.set(baseUrl, text);
	return text;
}

function parseFragment(html, url) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html.trim();
	const node = tpl.content.querySelector(OUTLET) || tpl.content.firstElementChild;
	if (!node) throw new Error(`No fragment in ${url}`);
	if (!node.matches(OUTLET)) node.setAttribute("data-fragment", "main");
	node.classList.add("content");
	return node;
}

export async function load(url, initPageCallback) {
	navAbort?.abort();
	const controller = new AbortController();
	navAbort = controller;
	const source = await fetchText(url, controller.signal);
	if (controller.signal.aborted) return;
	const frag = parseFragment(source, url);
	outlet.replaceWith(frag);
	outlet = document.querySelector(OUTLET);
	if (initPageCallback) initPageCallback(url, outlet);
}

export function prefetch(url) {
	const baseUrl = url.split("?")[0];
	if (!cache.has(baseUrl)) fetchText(baseUrl).catch(() => {});
}

export function initNavGroups() {
	document.querySelectorAll(".nav-group-toggle").forEach((toggle) => {
		toggle.addEventListener("click", () => {
			const group = toggle.closest(".nav-group");
			const expanded = toggle.getAttribute("aria-expanded") === "true";
			toggle.setAttribute("aria-expanded", String(!expanded));
			group.classList.toggle("collapsed", expanded);
		});
	});
}

export function initSidebarToggle() {
	const toggleBtn = document.getElementById("sidebarToggle");
	if (!toggleBtn) return;
	toggleBtn.addEventListener("click", () => {
		const collapsed = document.body.classList.toggle("sidebar-collapsed");
		toggleBtn.setAttribute("aria-expanded", String(!collapsed));
	});
	toggleBtn.setAttribute("aria-expanded", String(!document.body.classList.contains("sidebar-collapsed")));
}