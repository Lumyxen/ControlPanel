import { createHashRouter, currentRoute, navigateTo } from '../core/router.js';
import { loadFragment, prefetchFragment } from '../core/fragment-loader.js';
import { initNavGroups, initSidebarToggle, setActive } from './navigation.js';
import { bindQuickNewChat } from './sidebar.js';
import { mountHomePage } from '../pages/home.js';
import { mountPasswordManagerPage } from '../pages/password-manager.js';
import { mountChatPage, prepareChatPageFragment } from '../pages/chat/page.js';
import { renderChatList } from '../pages/chat/sidebar-list.js';
import {
	clearCurrentChatId,
	getChatById,
	getCurrentChatId,
	loadChats,
	setCurrentChatId,
} from '../pages/chat/repository.js';
import { mountSettingsPage } from '../pages/settings/page.js';
import { initTheme } from '../pages/settings/theme-section.js';
import * as SettingsStore from '../services/settings.js';
import { checkAndSuggest } from '../services/backend-suggest.js';
import { logout } from '../services/auth.js';
import { mountIdleLockService } from '../services/idle-lock.js';
import {
	startMonitoring,
	stopMonitoring,
	setConnectionChangeCallback,
	retryConnection,
	startAutoRetry,
	stopAutoRetry,
	RETRY_INTERVAL,
} from '../services/connection.js';

let activeCleanup = null;
let connectionModal = null;
let countdownTimer = null;
let countdownValue = 0;

const RETRY_SECONDS = Math.round(RETRY_INTERVAL / 1000);

function cleanupPage() {
	if (typeof activeCleanup === 'function') activeCleanup();
	activeCleanup = null;
}

function updateCountdownDisplay() {
	const text = connectionModal?.querySelector('#conn-modal-status-text');
	if (!text) return;
	text.textContent = `Retrying automatically in ${countdownValue} second${countdownValue !== 1 ? 's' : ''}...`;
}

function startCountdown() {
	countdownValue = RETRY_SECONDS;
	updateCountdownDisplay();
	if (countdownTimer) clearInterval(countdownTimer);
	countdownTimer = setInterval(() => {
		countdownValue--;
		if (countdownValue <= 0) countdownValue = RETRY_SECONDS;
		updateCountdownDisplay();
	}, 1000);
}

function stopCountdown() {
	if (countdownTimer) clearInterval(countdownTimer);
	countdownTimer = null;
}

function hideConnectionModal() {
	if (!connectionModal) return;
	stopAutoRetry();
	stopCountdown();
	connectionModal.classList.remove('visible');
	setTimeout(() => {
		connectionModal?.remove();
		connectionModal = null;
	}, 300);
}

function showConnectionModal() {
	if (connectionModal) return;
	const overlay = document.createElement('div');
	overlay.className = 'connection-modal-overlay';
	overlay.id = 'connection-modal';
	overlay.innerHTML = `
		<div class="connection-modal">
			<div class="connection-modal-header">
				<div class="connection-modal-icon error"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"/><path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929"/><path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687"/><path d="M17.656 12H22"/><path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45"/><path d="M2 12h10"/><path d="m2 2 20 20"/></svg></div>
				<h3 class="connection-modal-title">Connection Lost</h3>
			</div>
			<p class="connection-modal-message">Lost connection to backend server. The application requires a connection to function properly.</p>
			<div class="connection-modal-actions">
				<button class="connection-modal-button secondary" id="conn-modal-cancel">Cancel</button>
				<button class="connection-modal-button primary" id="conn-modal-retry">Retry Connection</button>
			</div>
			<div class="connection-modal-status">
				<span class="connection-modal-status-dot reconnecting"></span>
				<span id="conn-modal-status-text">Retrying automatically in ${RETRY_SECONDS} seconds...</span>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	connectionModal = overlay;
	startCountdown();
	startAutoRetry((connected) => {
		if (connected) hideConnectionModal();
	});

	overlay.querySelector('#conn-modal-retry')?.addEventListener('click', async () => {
		const connected = await retryConnection();
		if (connected) hideConnectionModal();
		else startCountdown();
	});
	overlay.querySelector('#conn-modal-cancel')?.addEventListener('click', hideConnectionModal);
	requestAnimationFrame(() => overlay.classList.add('visible'));
}

function handleConnectionChange(isConnected) {
	if (isConnected) hideConnectionModal();
	else showConnectionModal();
}

function buildPageContext() {
	return {
		currentRouteGetter: currentRoute,
		setActiveCallback: () => setActive(currentRoute(), getCurrentChatId()),
	};
}

function startNewChat() {
	clearCurrentChatId();
	const target = 'pages/ai-chat.html';
	if (currentRoute() === target) {
		void renderRoute(target);
	} else {
		navigateTo(target);
	}
}

async function renderRoute(route) {
	cleanupPage();
	const root = await loadFragment(route, route.includes('pages/ai-chat.html')
		? { prepareFragment: (fragment) => prepareChatPageFragment(fragment, { route }) }
		: undefined);
	if (!root) return;
	if (route.includes('pages/settings.html')) {
		activeCleanup = mountSettingsPage(root, buildPageContext());
	} else if (route.includes('pages/password-manager.html')) {
		activeCleanup = mountPasswordManagerPage(root, buildPageContext());
	} else if (route.includes('pages/ai-chat.html')) {
		activeCleanup = mountChatPage(root, buildPageContext());
		void checkAndSuggest().catch(() => {});
	} else {
		activeCleanup = mountHomePage(root, buildPageContext());
	}
	setActive(route, getCurrentChatId());
}

export async function mountAppShell() {
	initTheme();
	initNavGroups();
	initSidebarToggle();

	SettingsStore.init().catch(console.warn);
	SettingsStore.startPolling();
	const stopIdleLock = mountIdleLockService();

	setConnectionChangeCallback(handleConnectionChange);
	startMonitoring();

	await loadChats();

	const initial = currentRoute();
	if (initial.includes('ai-chat.html')) {
		const chatIdFromUrl = new URLSearchParams(location.hash.split('?')[1] || '').get('chat');
		if (chatIdFromUrl && !getChatById(chatIdFromUrl)) clearCurrentChatId();
	}

	renderChatList(() => {
		setActive(currentRoute(), getCurrentChatId());
	});
	setActive(initial, getCurrentChatId());

	const router = createHashRouter((route) => {
		void renderRoute(route).catch(console.error);
	});

	const stopQuickNewChat = bindQuickNewChat(startNewChat);

	const handleDocumentClick = (event) => {
		if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA') return;
		const anchor = event.target.closest('a[data-route]');
		if (!anchor || anchor.classList.contains('editing')) return;
		event.preventDefault();
		const href = anchor.getAttribute('href');
		const route = (href?.startsWith('#') ? href.slice(1) : href) || 'pages/home.html';
		if (anchor.hasAttribute('data-new-chat')) clearCurrentChatId();
		if (anchor.dataset.chatId) setCurrentChatId(anchor.dataset.chatId);
		if (`#${route}` !== location.hash) navigateTo(route);
		else void renderRoute(route);
	};

	const handlePointerOver = (event) => {
		const anchor = event.target.closest('a[data-route]');
		if (!anchor) return;
		prefetchFragment((anchor.getAttribute('href')?.replace(/^#\/?/, '')) || 'pages/home.html');
	};

	const logoutBtn = document.getElementById('logoutBtn');
	const handleLogout = () => {
		void logout();
		window.location.replace('./login.html');
	};

	document.addEventListener('click', handleDocumentClick);
	document.addEventListener('pointerover', handlePointerOver, { passive: true });
	logoutBtn?.addEventListener('click', handleLogout);

	router.start();
	setTimeout(() => void checkAndSuggest().catch(() => {}), 3000);

	return () => {
		router.stop();
		stopMonitoring();
		stopIdleLock();
		hideConnectionModal();
		stopQuickNewChat();
		cleanupPage();
		document.removeEventListener('click', handleDocumentClick);
		document.removeEventListener('pointerover', handlePointerOver);
		logoutBtn?.removeEventListener('click', handleLogout);
	};
}
