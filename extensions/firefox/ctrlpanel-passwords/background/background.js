(function () {
	'use strict';

	const api = globalThis.browser;
	const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:8080';
	const STORAGE_KEYS = {
		deviceId: 'ctrlpanelDeviceId',
		pinRecord: 'ctrlpanelPinRecord',
		serverOrigin: 'ctrlpanelServerOrigin',
	};
	const UNLOCK_TTL_MS = 10 * 60 * 1000;

	let unlockedState = null;

	function now() {
		return Date.now();
	}

	function randomId(prefix) {
		return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2)}`;
	}

	function cleanServerOrigin(value) {
		const trimmed = String(value || '').trim().replace(/\/+$/, '');
		return trimmed || DEFAULT_SERVER_ORIGIN;
	}

	async function getSettings() {
		const values = await api.storage.local.get({
			[STORAGE_KEYS.serverOrigin]: DEFAULT_SERVER_ORIGIN,
		});
		return {
			serverOrigin: cleanServerOrigin(values[STORAGE_KEYS.serverOrigin]),
		};
	}

	async function setSettings(patch) {
		const next = {};
		if (Object.prototype.hasOwnProperty.call(patch, 'serverOrigin')) {
			next[STORAGE_KEYS.serverOrigin] = cleanServerOrigin(patch.serverOrigin);
		}
		await api.storage.local.set(next);
		return getSettings();
	}

	async function apiUrl(path) {
		const settings = await getSettings();
		return `${settings.serverOrigin}/api/extension${path}`;
	}

	async function requestJson(path, options = {}) {
		const headers = {
			'X-CtrlPanel-Extension': 'firefox',
			...(options.headers || {}),
		};
		let body = options.body;
		if (body && typeof body !== 'string') {
			headers['Content-Type'] = headers['Content-Type'] || 'application/json';
			body = JSON.stringify(body);
		}
		const response = await fetch(await apiUrl(path), {
			...options,
			headers,
			body,
			cache: 'no-store',
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = new Error(data?.error || `HTTP ${response.status}`);
			error.status = response.status;
			error.details = data;
			throw error;
		}
		return data;
	}

	async function getDeviceId() {
		const values = await api.storage.local.get(STORAGE_KEYS.deviceId);
		if (values[STORAGE_KEYS.deviceId]) return values[STORAGE_KEYS.deviceId];
		const deviceId = randomId('firefox');
		await api.storage.local.set({ [STORAGE_KEYS.deviceId]: deviceId });
		return deviceId;
	}

	async function getPinRecord() {
		const values = await api.storage.local.get(STORAGE_KEYS.pinRecord);
		return values[STORAGE_KEYS.pinRecord] || null;
	}

	async function setPinRecord(record) {
		await api.storage.local.set({ [STORAGE_KEYS.pinRecord]: record });
	}

	async function clearPinRecord() {
		await api.storage.local.remove(STORAGE_KEYS.pinRecord);
	}

	function clearUnlockedState() {
		unlockedState = null;
	}

	function isUnlocked() {
		return Boolean(unlockedState?.vault?.items) && unlockedState.expiresAt > now();
	}

	function requireUnlocked() {
		if (!isUnlocked()) {
			clearUnlockedState();
			throw new Error('Vault is locked');
		}
		unlockedState.expiresAt = now() + UNLOCK_TTL_MS;
		return unlockedState;
	}

	async function requestVaultStatus() {
		return requestJson('/vault/status', {
			headers: {
				'X-Vault-Device-Id': await getDeviceId(),
			},
		});
	}

	async function unlockWithMaster(password, options = {}) {
		const status = await requestVaultStatus();
		if (!status.setup || !status.kdf) {
			throw new Error('CtrlPanel vault is not configured');
		}

		const material = await CtrlPanelVaultCrypto.deriveVaultMaterial(password, status.kdf);
		const challenge = await requestJson('/vault/unlock/challenge', {
			method: 'POST',
			body: { mode: 'master' },
		});
		const proof = await CtrlPanelVaultCrypto.createMasterProof(material.vaultAuthKey, challenge.challenge);
		const data = await requestJson('/vault/unlock/master', {
			method: 'POST',
			body: {
				challenge: challenge.challenge,
				proof,
			},
		});
		const vault = await CtrlPanelVaultCrypto.decryptVaultData(data.vault, material.vaultEncKey);
		unlockedState = {
			vault,
			vaultEncKey: material.vaultEncKey,
			vaultAuthKey: material.vaultAuthKey,
			revision: data.revision,
			accessToken: data.vaultAccessToken,
			unlockedAt: now(),
			expiresAt: now() + UNLOCK_TTL_MS,
			method: 'master',
		};

		if (options.savePin && options.pin) {
			await setupPinAfterMasterUnlock(String(options.pin));
		}

		return getVaultSummary();
	}

	async function setupPinAfterMasterUnlock(pin) {
		if (!pin) {
			throw new Error('PIN is required');
		}
		const state = requireUnlocked();
		if (!state.accessToken) {
			throw new Error('Fresh master unlock token is missing');
		}
		const deviceId = await getDeviceId();
		const pinAuthKdf = CtrlPanelVaultCrypto.createPinAuthKdf();
		const pinAuthVerifier = await CtrlPanelVaultCrypto.derivePinAuthKey(pin, pinAuthKdf);
		const data = await requestJson('/vault/pin/setup', {
			method: 'POST',
			headers: {
				'X-Vault-Access-Token': state.accessToken,
			},
			body: {
				deviceId,
				pinAuthKdf,
				pinAuthVerifier,
			},
		});
		const localRecord = await CtrlPanelVaultCrypto.createPinLocalRecord({
			deviceId,
			pin,
			pepper: data.pepper,
			vaultEncKey: state.vaultEncKey,
			vaultAuthKey: state.vaultAuthKey,
		});
		await setPinRecord(localRecord);
	}

	async function unlockWithPin(pin) {
		const status = await requestVaultStatus();
		const localRecord = await getPinRecord();
		if (!status.pin?.configured || !localRecord) {
			throw new Error('PIN unlock is not configured for this Firefox profile');
		}
		const deviceId = await getDeviceId();
		const pinAuthKey = await CtrlPanelVaultCrypto.derivePinAuthKey(pin, status.pin.kdf);
		const challenge = await requestJson('/vault/unlock/challenge', {
			method: 'POST',
			body: { mode: 'pin', deviceId },
		});
		const proof = await CtrlPanelVaultCrypto.createPinProof(pinAuthKey, challenge.challenge);
		let data;
		try {
			data = await requestJson('/vault/unlock/pin', {
				method: 'POST',
				body: {
					deviceId,
					challenge: challenge.challenge,
					proof,
				},
			});
		} catch (error) {
			if (error.details?.pinDisabled) {
				await clearPinRecord();
			}
			throw error;
		}
		const keys = await CtrlPanelVaultCrypto.unwrapPinLocalRecord(localRecord, pin, data.pepper);
		const vault = await CtrlPanelVaultCrypto.decryptVaultData(data.vault, keys.vaultEncKey);
		unlockedState = {
			vault,
			vaultEncKey: keys.vaultEncKey,
			vaultAuthKey: keys.vaultAuthKey,
			revision: data.revision,
			accessToken: data.vaultAccessToken,
			unlockedAt: now(),
			expiresAt: now() + UNLOCK_TTL_MS,
			method: 'pin',
		};
		return getVaultSummary();
	}

	function getVaultSummary() {
		return {
			unlocked: isUnlocked(),
			unlockMethod: unlockedState?.method || '',
			expiresAt: unlockedState?.expiresAt || 0,
		};
	}

	function parseUrl(value) {
		try {
			return new URL(value);
		} catch {
			return null;
		}
	}

	function normalizeHost(hostname) {
		return String(hostname || '').toLowerCase().replace(/^www\./, '');
	}

	function credentialMatchesUrl(credential, pageUrl) {
		const page = parseUrl(pageUrl);
		if (!page) return false;
		const saved = parseUrl(credential.url || '');
		if (!saved) return false;

		const pageHost = normalizeHost(page.hostname);
		const savedHost = normalizeHost(saved.hostname);
		const hostMatches =
			pageHost === savedHost ||
			pageHost.endsWith(`.${savedHost}`) ||
			savedHost.endsWith(`.${pageHost}`);
		if (!hostMatches) return false;

		const savedPath = saved.pathname || '/';
		return savedPath === '/' || page.pathname.startsWith(savedPath);
	}

	function publicCredential(credential, pageUrl) {
		const saved = parseUrl(credential.url || '');
		const page = parseUrl(pageUrl);
		return {
			id: credential.id,
			title: credential.title || credential.username || saved?.hostname || page?.hostname || 'Saved login',
			username: credential.username || '',
			url: credential.url || '',
			host: saved?.hostname || '',
			hasPassword: Boolean(credential.password),
		};
	}

	function matchingCredentials(pageUrl) {
		const state = requireUnlocked();
		const items = Array.isArray(state.vault.items) ? state.vault.items : [];
		return items
			.filter((item) => item && item.id && (item.username || item.password) && credentialMatchesUrl(item, pageUrl))
			.sort((a, b) => String(a.title || a.username || '').localeCompare(String(b.title || b.username || '')))
			.slice(0, 12);
	}

	async function listLogins(pageUrl) {
		if (!isUnlocked()) {
			clearUnlockedState();
			const pinRecord = await getPinRecord();
			return {
				locked: true,
				pinAvailable: Boolean(pinRecord),
				logins: [],
			};
		}
		return {
			locked: false,
			pinAvailable: Boolean(await getPinRecord()),
			logins: matchingCredentials(pageUrl).map((credential) => publicCredential(credential, pageUrl)),
		};
	}

	async function getLoginSecret(id, pageUrl) {
		const credential = matchingCredentials(pageUrl).find((item) => item.id === id);
		if (!credential) {
			throw new Error('Login is no longer available for this page');
		}
		return {
			id: credential.id,
			username: credential.username || '',
			password: credential.password || '',
		};
	}

	async function handleMessage(message) {
		switch (message?.type) {
			case 'getSettings':
				return { ok: true, settings: await getSettings(), summary: getVaultSummary() };
			case 'setSettings':
				return { ok: true, settings: await setSettings(message.settings || {}) };
			case 'getLogins':
				return { ok: true, ...(await listLogins(String(message.url || ''))) };
			case 'unlockMaster':
				await unlockWithMaster(String(message.password || ''), {
					savePin: Boolean(message.savePin),
					pin: message.pin,
				});
				return { ok: true, ...(await listLogins(String(message.url || ''))) };
			case 'unlockPin':
				await unlockWithPin(String(message.pin || ''));
				return { ok: true, ...(await listLogins(String(message.url || ''))) };
			case 'getLoginSecret':
				return { ok: true, login: await getLoginSecret(String(message.id || ''), String(message.url || '')) };
			case 'lock':
				clearUnlockedState();
				return { ok: true, summary: getVaultSummary() };
			default:
				return { ok: false, error: 'Unknown CtrlPanel message' };
		}
	}

	api.runtime.onMessage.addListener((message) => (
		handleMessage(message).catch((error) => ({
			ok: false,
			error: error?.message || 'CtrlPanel extension error',
			status: error?.status || 0,
		}))
	));

	api.browserAction.onClicked.addListener(() => {
		api.runtime.openOptionsPage();
	});
}());
