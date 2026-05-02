import * as SettingsStore from './settings.js';
import { isUnlocked as isVaultUnlocked, lock as lockVault, subscribe as subscribeVault } from './vault.js';

let timerId = null;
let timeoutMs = 300000;

function clearTimer() {
	if (timerId) {
		window.clearTimeout(timerId);
		timerId = null;
	}
}

function scheduleLock() {
	clearTimer();
	if (!isVaultUnlocked() || timeoutMs <= 0) return;
	timerId = window.setTimeout(() => {
		if (isVaultUnlocked()) {
			lockVault();
		}
	}, timeoutMs);
}

function handleActivity() {
	if (!isVaultUnlocked()) return;
	scheduleLock();
}

export function mountIdleLockService() {
	const updateFromSettings = (settings) => {
		timeoutMs = Math.max(30, Number.parseInt(settings?.vaultIdleTimeoutSeconds ?? 300, 10) || 300) * 1000;
		scheduleLock();
	};

	updateFromSettings(SettingsStore.get());
	const unsubscribeSettings = SettingsStore.subscribe(updateFromSettings);
	const unsubscribeVault = subscribeVault(() => scheduleLock());

	const events = ['pointerdown', 'pointermove', 'keydown', 'touchstart'];
	for (const eventName of events) {
		window.addEventListener(eventName, handleActivity, { passive: true });
	}

	scheduleLock();

	return () => {
		clearTimer();
		unsubscribeSettings();
		unsubscribeVault();
		for (const eventName of events) {
			window.removeEventListener(eventName, handleActivity, { passive: true });
		}
	};
}
