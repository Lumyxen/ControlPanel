import { initConnectionUI } from "./connection-ui.js";
import { initTheme, initSettingsPage } from "./theme.js";
import * as SettingsStore from "./settings-store.js";
import { checkAndSuggest } from "./backend-suggest.js";
import {
	clearCurrentChatId,
	getChatById,
	getCurrentChatId,
	initChatPage,
	loadChats,
	loadCurrentChat,
	renderChatList,
	saveChats,
	setCurrentChatId,
} from "./chat/index.js";
import {
	currentRoute,
	load,
	prefetch,
	setActive,
	initNavGroups,
	initSidebarToggle,
} from "./router.js";

// Initialize connection monitoring early
initConnectionUI();

// Bootstrap the settings store: fetch once then poll for external changes
SettingsStore.init().catch(console.warn);
SettingsStore.startPolling();

function initPage(url, root) {
	if (url.includes("pages/settings.html")) {
		initSettingsPage(root);
	}
	if (url.includes("pages/ai-chat.html")) {
		initChatPage(root, currentRoute, () => setActive(currentRoute(), getCurrentChatId()));
	}
}

function refreshActiveState() {
	setActive(currentRoute(), getCurrentChatId());
}

function refreshChatUIIfOpen() {
	if (currentRoute().includes("ai-chat.html")) {
		loadCurrentChat(() => refreshActiveState());
	} else {
		renderChatList(() => {});
		refreshActiveState();
	}
}

async function reloadRoute(url) {
	await load(url, (u, root) => {
		refreshActiveState();
		initPage(u, root);
	});
}

function startNewChat() {
	clearCurrentChatId();
	saveChats();
	const target = "pages/ai-chat.html";
	if (currentRoute() === target) {
		reloadRoute(target).catch(console.error);
	} else {
		location.hash = target;
	}
}

document.addEventListener("click", (e) => {
	if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

	const a = e.target.closest("a[data-route]");
	if (!a) return;
	if (a.classList.contains("editing")) return;

	e.preventDefault();
	const href = a.getAttribute("href");
	const url = (href?.startsWith("#") ? href.slice(1) : href) || "pages/home.html";
	if (a.hasAttribute("data-new-chat")) {
		clearCurrentChatId();
		saveChats();
	}
	if (a.dataset.chatId) {
		setCurrentChatId(a.dataset.chatId);
		saveChats();
	}
	if ("#" + url !== location.hash) {
		location.hash = url;
	} else if (url.includes("ai-chat.html")) {
		reloadRoute(url).catch(console.error);
	}
});

document.addEventListener("pointerover", (e) => {
	const a = e.target.closest("a[data-route]");
	if (!a) return;
	const url = (a.getAttribute("href")?.replace(/^#\/?/, "")) || "pages/home.html";
	prefetch(url);
}, { passive: true });

window.addEventListener("hashchange", () => {
	reloadRoute(currentRoute()).catch(console.error);
});

initTheme();
initNavGroups();
initSidebarToggle();

const quickNewChatBtn = document.getElementById("quickNewChat");
if (quickNewChatBtn) {
	quickNewChatBtn.addEventListener("click", (e) => {
		e.preventDefault();
		startNewChat();
	});
}

// Async startup
(async () => {
	await loadChats();

	const initial = currentRoute();

	if (initial.includes("ai-chat.html")) {
		const urlParams = new URLSearchParams(location.hash.split("?")[1] || "");
		const chatIdFromUrl = urlParams.get("chat");
		if (chatIdFromUrl && !getChatById(chatIdFromUrl)) {
			clearCurrentChatId();
			saveChats();
		}
	}

	renderChatList(() => refreshChatUIIfOpen());
	refreshActiveState();

	try {
		await reloadRoute(initial);
	} catch (err) {
		console.error(err);
	}

	// Check for GPU backend suggestion a short while after startup so it
	// doesn't compete with page load and feels non-intrusive.
	setTimeout(() => checkAndSuggest().catch(() => {}), 3000);
})();