import { initConnectionUI } from "./connection-ui.js";
import { initTheme, initSettingsPage } from "./theme.js";
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

// Initialize connection monitoring and demo mode early
initConnectionUI();

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
	// Ignore clicks on input/textarea elements (e.g., rename input fields)
	if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

	const a = e.target.closest("a[data-route]");
	if (!a) return;

	// Ignore clicks on anchors that are in editing mode
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
loadChats();
renderChatList(() => refreshChatUIIfOpen());
initNavGroups();
initSidebarToggle();

const quickNewChatBtn = document.getElementById("quickNewChat");
if (quickNewChatBtn) {
	quickNewChatBtn.addEventListener("click", (e) => {
		e.preventDefault();
		startNewChat();
	});
}

(async () => {
	const initial = currentRoute();
	if (initial.includes("ai-chat.html")) {
		const urlParams = new URLSearchParams(location.hash.split("?")[1] || "");
		const chatIdFromUrl = urlParams.get("chat");
		if (chatIdFromUrl && !getChatById(chatIdFromUrl)) {
			clearCurrentChatId();
			saveChats();
		}
	}
	refreshActiveState();
	try {
		await reloadRoute(initial);
	} catch (err) {
		console.error(err);
	}
})();
