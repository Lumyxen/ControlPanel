import { apiUrl } from '../core/http.js';
import {
	createMasterProof,
	createPinAuthKdf,
	createPinLocalRecord,
	createPinProof,
	decryptVaultData,
	derivePinAuthKey,
	deriveVaultMaterial,
	encryptVaultData,
	unwrapPinLocalRecord,
} from './vault-crypto.js';

const DEVICE_ID_KEY = 'ctrlpanel:vaultDeviceId';
const VAULT_CHANNEL = 'ctrlpanel:vault';
const ACCESS_TOKEN_HEADER = 'X-Vault-Access-Token';
const DEVICE_ID_HEADER = 'X-Vault-Device-Id';
const TAB_ID = globalThis.crypto?.randomUUID?.() || `vault-tab-${Math.random().toString(16).slice(2)}`;

const listeners = new Set();

let channel = null;
let channelStarted = false;
let status = {
	setup: false,
	revision: 0,
	kdf: null,
	pin: { configured: false },
	deviceId: getDeviceId(),
};
let state = {
	vault: null,
	vaultEncKey: '',
	vaultAuthKey: '',
	revision: 0,
	accessToken: '',
	unlockMethod: '',
	createdAt: null,
	updatedAt: null,
};
let pendingShareResolver = null;

function getPinStorageKey(deviceId = getDeviceId()) {
	return `ctrlpanel:vaultPin:${deviceId}`;
}

function getChannel() {
	if (!channel) channel = new BroadcastChannel(VAULT_CHANNEL);
	return channel;
}

function readJsonLocal(key) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function writeJsonLocal(key, value) {
	localStorage.setItem(key, JSON.stringify(value));
}

function clearLocalPinRecord(deviceId = getDeviceId()) {
	localStorage.removeItem(getPinStorageKey(deviceId));
}

function getLocalPinRecord(deviceId = getDeviceId()) {
	return readJsonLocal(getPinStorageKey(deviceId));
}

function getSnapshot() {
	return {
		...status,
		unlocked: Boolean(state.vault && state.vaultEncKey && state.vaultAuthKey),
		vault: state.vault,
		revision: state.vault ? state.revision : status.revision,
		unlockMethod: state.unlockMethod,
		hasLocalPinRecord: Boolean(getLocalPinRecord()),
		hasPinUnlock: Boolean(status.pin?.configured && getLocalPinRecord()),
	};
}

function notify() {
	const snapshot = getSnapshot();
	for (const listener of listeners) {
		try {
			listener(snapshot);
		} catch (error) {
			console.error('[vault] listener error', error);
		}
	}
}

function applyUnlockedState({ vault, vaultEncKey, vaultAuthKey, revision, accessToken, unlockMethod, createdAt, updatedAt }) {
	state = {
		vault,
		vaultEncKey,
		vaultAuthKey,
		revision,
		accessToken: accessToken || state.accessToken,
		unlockMethod,
		createdAt: createdAt ?? state.createdAt,
		updatedAt: updatedAt ?? state.updatedAt,
	};
	status = {
		...status,
		setup: true,
		revision,
	};
	notify();
}

function clearVaultState() {
	state = {
		vault: null,
		vaultEncKey: '',
		vaultAuthKey: '',
		revision: 0,
		accessToken: '',
		unlockMethod: '',
		createdAt: null,
		updatedAt: null,
	};
}

function postChannelMessage(message) {
	try {
		getChannel().postMessage({ tabId: TAB_ID, ...message });
	} catch {}
}

function handleChannelMessage(event) {
	const message = event.data;
	if (!message || message.tabId === TAB_ID) return;

	if (message.type === 'unlock-request') {
		if (!state.vault) return;
		postChannelMessage({
			type: 'unlock-share',
			targetTabId: message.tabId,
			payload: {
				vault: state.vault,
				vaultEncKey: state.vaultEncKey,
				vaultAuthKey: state.vaultAuthKey,
				revision: state.revision,
				accessToken: state.accessToken,
				unlockMethod: state.unlockMethod,
				createdAt: state.createdAt,
				updatedAt: state.updatedAt,
			},
		});
		return;
	}

	if (message.type === 'unlock-share' && message.targetTabId === TAB_ID && pendingShareResolver) {
		applyUnlockedState(message.payload);
		const resolver = pendingShareResolver;
		pendingShareResolver = null;
		resolver(true);
		return;
	}

	if (message.type === 'vault-lock') {
		lock({ broadcast: false });
		return;
	}

	if (message.type === 'vault-updated' && state.vault) {
		applyUnlockedState({
			...message.payload,
			vaultEncKey: state.vaultEncKey,
			vaultAuthKey: state.vaultAuthKey,
			accessToken: state.accessToken,
			unlockMethod: state.unlockMethod,
		});
	}
}

function startChannelLayer() {
	if (channelStarted) return;
	channelStarted = true;
	getChannel().onmessage = handleChannelMessage;
	window.addEventListener('pagehide', () => {
		postChannelMessage({ type: 'tab-closing' });
	});
	window.addEventListener('beforeunload', () => {
		postChannelMessage({ type: 'tab-closing' });
	});
	postChannelMessage({ type: 'tab-presence' });
}

function defaultVaultDocument() {
	return {
		version: 1,
		items: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

async function parseJsonResponse(response) {
	return response.json().catch(() => ({}));
}

async function requestJson(path, options = {}) {
	const response = await fetch(apiUrl(path), options);
	const data = await parseJsonResponse(response);
	if (!response.ok) {
		const error = new Error(data?.error || `HTTP ${response.status}`);
		error.status = response.status;
		error.details = data;
		throw error;
	}
	return data;
}

async function requestVaultChallenge(mode, deviceId = '') {
	return requestJson('/vault/unlock/challenge', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mode, deviceId }),
	});
}

async function refreshVaultAccessTokenFromMemory() {
	if (!state.vaultAuthKey) throw new Error('Vault auth key is not loaded');
	const challenge = await requestVaultChallenge('master');
	const proof = await createMasterProof(state.vaultAuthKey, challenge.challenge);
	const data = await requestJson('/vault/reauth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ challenge: challenge.challenge, proof }),
	});
	state.accessToken = data.vaultAccessToken;
	state.unlockMethod = 'master';
	notify();
	return data.vaultAccessToken;
}

async function ensureVaultAccessToken() {
	if (state.accessToken) return state.accessToken;
	return refreshVaultAccessTokenFromMemory();
}

async function unlockWithDerivedMaterial(vaultMaterial) {
	const challenge = await requestVaultChallenge('master');
	const proof = await createMasterProof(vaultMaterial.vaultAuthKey, challenge.challenge);
	const data = await requestJson('/vault/unlock/master', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ challenge: challenge.challenge, proof }),
	});
	const vault = await decryptVaultData(data.vault, vaultMaterial.vaultEncKey);
	applyUnlockedState({
		vault,
		vaultEncKey: vaultMaterial.vaultEncKey,
		vaultAuthKey: vaultMaterial.vaultAuthKey,
		revision: data.revision,
		accessToken: data.vaultAccessToken,
		unlockMethod: 'master',
		createdAt: data.vault.createdAt,
		updatedAt: data.vault.updatedAt,
	});
	postChannelMessage({
		type: 'vault-updated',
		payload: {
			vault,
			revision: data.revision,
			createdAt: data.vault.createdAt,
			updatedAt: data.vault.updatedAt,
		},
	});
	return getSnapshot();
}

export function getDeviceId() {
	let deviceId = localStorage.getItem(DEVICE_ID_KEY);
	if (!deviceId) {
		deviceId = globalThis.crypto?.randomUUID?.() || `device-${Math.random().toString(16).slice(2)}`;
		localStorage.setItem(DEVICE_ID_KEY, deviceId);
	}
	return deviceId;
}

export function subscribe(listener) {
	listeners.add(listener);
	listener(getSnapshot());
	return () => listeners.delete(listener);
}

export function isUnlocked() {
	return Boolean(state.vault);
}

export function getSnapshotState() {
	return getSnapshot();
}

export async function refreshStatus() {
	status = await requestJson('/vault/status', {
		headers: { [DEVICE_ID_HEADER]: getDeviceId() },
	});
	notify();
	return getSnapshot();
}

export async function requestUnlockShare(timeoutMs = 400) {
	if (state.vault) return true;
	startChannelLayer();
	postChannelMessage({ type: 'unlock-request' });
	return new Promise((resolve) => {
		pendingShareResolver = resolve;
		window.setTimeout(() => {
			if (pendingShareResolver === resolve) {
				pendingShareResolver = null;
				resolve(false);
			}
		}, timeoutMs);
	});
}

export async function init(options = {}) {
	startChannelLayer();
	await refreshStatus();
	if (options.allowAutoShare && !state.vault && status.setup) {
		await requestUnlockShare();
	}
	return getSnapshot();
}

export async function setupVault(masterPassword, replaceExisting = false) {
	await refreshStatus();
	const shouldReplaceExisting = replaceExisting || status.setup;
	const vaultMaterial = await deriveVaultMaterial(masterPassword);
	const initialVault = defaultVaultDocument();
	const initialBlob = await encryptVaultData(initialVault, vaultMaterial.vaultEncKey, 1, {
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	await requestJson('/vault/setup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			replaceExisting: shouldReplaceExisting,
			kdf: vaultMaterial.kdf,
			vaultAuthKey: vaultMaterial.vaultAuthKey,
			vault: initialBlob,
		}),
	});
	await refreshStatus();
	return unlockWithDerivedMaterial(vaultMaterial);
}

export async function unlockWithMasterPassword(masterPassword) {
	await refreshStatus();
	if (!status.setup || !status.kdf) {
		throw new Error('Vault is not configured');
	}
	const vaultMaterial = await deriveVaultMaterial(masterPassword, status.kdf);
	return unlockWithDerivedMaterial(vaultMaterial);
}

export async function reauthWithMasterPassword(masterPassword) {
	await refreshStatus();
	if (!status.kdf) {
		throw new Error('Vault is not configured');
	}
	const vaultMaterial = await deriveVaultMaterial(masterPassword, status.kdf);
	const challenge = await requestVaultChallenge('master');
	const proof = await createMasterProof(vaultMaterial.vaultAuthKey, challenge.challenge);
	const data = await requestJson('/vault/reauth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ challenge: challenge.challenge, proof }),
	});
	if (state.vaultAuthKey && state.vaultAuthKey === vaultMaterial.vaultAuthKey) {
		state.accessToken = data.vaultAccessToken;
		state.unlockMethod = 'master';
		notify();
	}
	return data.vaultAccessToken;
}

export async function unlockWithPin(pin) {
	await refreshStatus();
	if (!status.pin?.configured) {
		throw new Error('PIN unlock is not configured for this device');
	}
	const localRecord = getLocalPinRecord();
	if (!localRecord) {
		throw new Error('Local PIN record is missing. Use the master password to set up PIN unlock again.');
	}

	const pinAuthKey = await derivePinAuthKey(pin, status.pin.kdf);
	const challenge = await requestVaultChallenge('pin', getDeviceId());
	const proof = await createPinProof(pinAuthKey, challenge.challenge);

	let data;
	try {
		data = await requestJson('/vault/unlock/pin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				deviceId: getDeviceId(),
				challenge: challenge.challenge,
				proof,
			}),
		});
	} catch (error) {
		if (error.details?.pinDisabled) {
			clearLocalPinRecord();
			await refreshStatus();
		}
		throw error;
	}

	const keys = await unwrapPinLocalRecord(localRecord, pin, data.pepper);
	const vault = await decryptVaultData(data.vault, keys.vaultEncKey);
	applyUnlockedState({
		vault,
		vaultEncKey: keys.vaultEncKey,
		vaultAuthKey: keys.vaultAuthKey,
		revision: data.revision,
		accessToken: data.vaultAccessToken,
		unlockMethod: 'pin',
		createdAt: data.vault.createdAt,
		updatedAt: data.vault.updatedAt,
	});
	postChannelMessage({
		type: 'vault-updated',
		payload: {
			vault,
			revision: data.revision,
			createdAt: data.vault.createdAt,
			updatedAt: data.vault.updatedAt,
		},
	});
	return getSnapshot();
}

export function lock(options = {}) {
	clearVaultState();
	if (options.broadcast !== false) {
		postChannelMessage({ type: 'vault-lock' });
	}
	notify();
}

export async function saveVault(vaultDocument) {
	if (!state.vault || !state.vaultEncKey) {
		throw new Error('Vault is locked');
	}

	const currentRevision = state.revision;
	const nextRevision = currentRevision + 1;
	const now = Date.now();
	const nextDocument = {
		...vaultDocument,
		updatedAt: now,
	};
	const blob = await encryptVaultData(nextDocument, state.vaultEncKey, nextRevision, {
		createdAt: state.createdAt ?? now,
		updatedAt: now,
	});

	try {
		await requestJson('/vault', {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				[ACCESS_TOKEN_HEADER]: await ensureVaultAccessToken(),
			},
			body: JSON.stringify({
				expectedRevision: currentRevision,
				vault: blob,
			}),
		});
	} catch (error) {
		if (error.status === 401 && state.vaultAuthKey) {
			await refreshVaultAccessTokenFromMemory();
			return saveVault(vaultDocument);
		}
		if (error.status === 409) {
			lock();
		}
		throw error;
	}

	applyUnlockedState({
		vault: nextDocument,
		vaultEncKey: state.vaultEncKey,
		vaultAuthKey: state.vaultAuthKey,
		revision: nextRevision,
		accessToken: state.accessToken,
		unlockMethod: state.unlockMethod,
		createdAt: state.createdAt ?? now,
		updatedAt: now,
	});
	postChannelMessage({
		type: 'vault-updated',
		payload: {
			vault: nextDocument,
			revision: nextRevision,
			createdAt: state.createdAt ?? now,
			updatedAt: now,
		},
	});
	return getSnapshot();
}

export async function setupPin(pin, freshVaultAccessToken) {
	if (!state.vault || !state.vaultEncKey || !state.vaultAuthKey) {
		throw new Error('Unlock the vault with the master password before setting up PIN unlock.');
	}
	if (!freshVaultAccessToken) {
		throw new Error('A fresh vault reauthentication token is required to set up PIN unlock.');
	}

	const pinAuthKdf = createPinAuthKdf();
	const pinAuthVerifier = await derivePinAuthKey(pin, pinAuthKdf);
	const data = await requestJson('/vault/pin/setup', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[ACCESS_TOKEN_HEADER]: freshVaultAccessToken,
		},
		body: JSON.stringify({
			deviceId: getDeviceId(),
			pinAuthKdf,
			pinAuthVerifier,
		}),
	});

	const localRecord = await createPinLocalRecord({
		deviceId: getDeviceId(),
		pin,
		pepper: data.pepper,
		vaultEncKey: state.vaultEncKey,
		vaultAuthKey: state.vaultAuthKey,
	});
	writeJsonLocal(getPinStorageKey(), localRecord);
	await refreshStatus();
	return getSnapshot();
}

export async function removePin(freshVaultAccessToken) {
	if (!freshVaultAccessToken) {
		throw new Error('A fresh vault reauthentication token is required to remove PIN unlock.');
	}

	await requestJson(`/vault/pin/${encodeURIComponent(getDeviceId())}`, {
		method: 'DELETE',
		headers: {
			[ACCESS_TOKEN_HEADER]: freshVaultAccessToken,
		},
	});
	clearLocalPinRecord();
	await refreshStatus();
	return getSnapshot();
}
