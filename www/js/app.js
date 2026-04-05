// www/js/app.js
// Entry point and router.
// initSettingsPage is now imported from settings/page.js (not theme.js).

// ── Auth guard ────────────────────────────────────────────────────────────────
//
// The inline script in index.html hides the page (visibility:hidden) and does
// a synchronous sessionStorage check.  Here we do the full async check that
// includes asking peer tabs for the key via BroadcastChannel.
//
// Flow:
//   1. Already have key in sessionStorage → proceed immediately.
//   2. No key, but another tab responds within 300 ms → key stored, proceed.
//   3. No key, no peer → redirect to login.html.

import { isUnlocked, syncFromOtherTabs, startKeyShareServer, logout } from './auth.js';

if (!isUnlocked()) {
    const synced = await syncFromOtherTabs();
    if (!synced) {
        document.documentElement.style.visibility = '';
        window.location.replace('./login.html');
        throw new Error('Not authenticated — redirecting.');
    }
}

// Key is confirmed present. Start the share server so this tab can respond
// to future key-request messages from newly opened tabs.
startKeyShareServer();

// Reveal the page (was hidden by the inline script to prevent content flash).
document.documentElement.style.visibility = '';

// ── Normal app boot ───────────────────────────────────────────────────────────

import { initConnectionUI } from './connection-ui.js';
import { initTheme } from './theme.js';
import { initSettingsPage } from './settings/page.js';
import { initSpaceMissionsPage } from './space-missions/index.js';
import * as SettingsStore from './settings-store.js';
import { checkAndSuggest } from './backend-suggest.js';
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
} from './chat/index.js';
import {
	currentRoute,
	load,
	prefetch,
	setActive,
	initNavGroups,
	initSidebarToggle,
} from './router.js';

initConnectionUI();

SettingsStore.init().catch(console.warn);
SettingsStore.startPolling();

function initPage(url, root) {
	if (url.includes('pages/settings.html')) initSettingsPage(root);
	if (url.includes('pages/ai-chat.html')) {
		initChatPage(root, currentRoute, () => setActive(currentRoute(), getCurrentChatId()));
		checkAndSuggest().catch(() => {});
	}
	if (url.includes('pages/space-missions.html')) initSpaceMissionsPage(root);
}

function refreshActiveState() {
	setActive(currentRoute(), getCurrentChatId());
}

function refreshChatUIIfOpen() {
	if (currentRoute().includes('ai-chat.html')) {
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
	const target = 'pages/ai-chat.html';
	if (currentRoute() === target) {
		reloadRoute(target).catch(console.error);
	} else {
		location.hash = target;
	}
}

document.addEventListener('click', (e) => {
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
	const a = e.target.closest('a[data-route]');
	if (!a) return;
	if (a.classList.contains('editing')) return;
	e.preventDefault();
	const href = a.getAttribute('href');
	const url = (href?.startsWith('#') ? href.slice(1) : href) || 'pages/home.html';
	if (a.hasAttribute('data-new-chat')) { clearCurrentChatId(); saveChats(); }
	if (a.dataset.chatId) { setCurrentChatId(a.dataset.chatId); saveChats(); }
	if ('#' + url !== location.hash) {
		location.hash = url;
	} else if (url.includes('ai-chat.html')) {
		reloadRoute(url).catch(console.error);
	}
});

document.addEventListener('pointerover', (e) => {
	const a = e.target.closest('a[data-route]');
	if (!a) return;
	prefetch((a.getAttribute('href')?.replace(/^#\/?/, '')) || 'pages/home.html');
}, { passive: true });

window.addEventListener('hashchange', () => {
	reloadRoute(currentRoute()).catch(console.error);
});

initTheme();
initNavGroups();
initSidebarToggle();

const quickNewChatBtn = document.getElementById('quickNewChat');
if (quickNewChatBtn) {
	quickNewChatBtn.addEventListener('click', (e) => {
		e.preventDefault();
		startNewChat();
	});
}

// ── Lock button ───────────────────────────────────────────────────────────────
// Clears the session key in all tabs via BroadcastChannel, then redirects here.

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
	logoutBtn.addEventListener('click', () => {
		logout();                              // broadcasts key-revoke to all tabs
		window.location.replace('./login.html');
	});
}

// ── Initial load ──────────────────────────────────────────────────────────────

(async () => {
	await loadChats();

	const initial = currentRoute();
	if (initial.includes('ai-chat.html')) {
		const urlParams = new URLSearchParams(location.hash.split('?')[1] || '');
		const chatIdFromUrl = urlParams.get('chat');
		if (chatIdFromUrl && !getChatById(chatIdFromUrl)) { clearCurrentChatId(); saveChats(); }
	}

	renderChatList(() => refreshChatUIIfOpen());
	refreshActiveState();

	try {
		await reloadRoute(initial);
	} catch (err) {
		console.error(err);
	}

	setTimeout(() => checkAndSuggest().catch(() => {}), 3000);
})();
