import {
	isUnlocked,
	releaseAuthGate,
	redirectToLogin,
	syncFromOtherTabs,
	startKeyShareServer,
	validateSession,
} from '../services/auth.js';
import { mountAppShell } from '../shell/app-shell.js';

async function checkAuth() {
	if (!isUnlocked()) {
		const synced = await syncFromOtherTabs();
		if (!synced) {
			redirectToLogin();
			return false;
		}
	}

	const valid = await validateSession();
	if (!valid) {
		redirectToLogin({ broadcast: true });
		return false;
	}

	return true;
}

export async function bootMain() {
	const authOk = await checkAuth();
	if (!authOk) return;
	startKeyShareServer();
	try {
		await mountAppShell();
	} finally {
		releaseAuthGate();
	}
}
