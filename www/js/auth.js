/**
 * auth.js — Client-side authentication & encryption for ctrlpanel.
 *
 * Algorithm : PBKDF2-HMAC-SHA256 (310 000 iterations) → AES-256-GCM
 *             AES-256-GCM is quantum-resistant (256-bit key survives Grover's
 *             algorithm halving; 128-bit effective security remains practical).
 *             Key derivation via PBKDF2-SHA256 is computationally hard enough
 *             for local use; Argon2id would be preferable when Web Crypto adds
 *             native support or a WASM module is bundled.
 *
 * Key store  : Raw key bytes (hex) in sessionStorage per-tab, shared across
 *              tabs via BroadcastChannel (same-origin only).
 *
 * Auth data  : Salt + sentinel stored on the BACKEND (/api/auth) rather than
 *              in the browser's localStorage. Falls back to localStorage for
 *              automatic one-time migration of existing installations.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ Backend  data/auth.json  (on-disk, server-side)                  │
 * │   salt        – hex, 32-byte PBKDF2 salt                         │
 * │   sentinel    – {iv, ct} hex strings (AES-256-GCM encrypted)     │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ sessionStorage  (per-tab; gone when all tabs / browser close)    │
 * │   ctrlpanel:sessionKey    – hex, 32-byte AES-256 raw key         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Cross-tab key sharing (BroadcastChannel "ctrlpanel:keyshare"):
 *   key-request  → new/locked tab asks for the key
 *   key-response → any unlocked tab answers with the raw key hex
 *   key-revoke   → logout() broadcasts this so every tab locks at once
 *
 * Public API:
 *   isUnlocked()            → boolean          synchronous
 *   isFirstRun()            → Promise<boolean> checks backend (async)
 *   syncFromOtherTabs()     → Promise<boolean> try to get key from a peer tab
 *   startKeyShareServer()   → void             serve key-request messages
 *   login(password)         → Promise<void>    throws on bad password
 *   setupPassword(password) → Promise<void>    first-run only
 *   logout()                → void             locks all open tabs
 *   encryptPayload(obj)     → Promise<{_enc,iv,ct}>
 *   decryptPayload(obj)     → Promise<any>     pass-through if not encrypted
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_KEY = 'ctrlpanel:sessionKey';   // sessionStorage

// Legacy localStorage keys — used only for one-time migration
const LS_SALT_KEY     = 'ctrlpanel:authSalt';
const LS_SENTINEL_KEY = 'ctrlpanel:authSentinel';

const SENTINEL_VALUE = 'ctrlpanel-v1-auth-ok';

// NIST SP 800-132 recommended minimum for PBKDF2-HMAC-SHA-256 (2023).
const PBKDF2_ITERS = 310_000;

const AUTH_API = '/api/auth';

const BC_CHANNEL      = 'ctrlpanel:keyshare';
const BC_KEY_REQUEST  = 'key-request';
const BC_KEY_RESPONSE = 'key-response';
const BC_KEY_REVOKE   = 'key-revoke';

const SYNC_TIMEOUT_MS = 300;

// ── Byte ↔ hex ────────────────────────────────────────────────────────────────

/** @param {Uint8Array} b @returns {string} */
function toHex(b) {
	return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** @param {string} h @returns {Uint8Array} */
function fromHex(h) {
	const a = new Uint8Array(h.length >>> 1);
	for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return a;
}

// ── Core crypto ───────────────────────────────────────────────────────────────

const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function deriveKey(password, salt, extractable = false) {
	const material = await crypto.subtle.importKey(
		'raw', ENC.encode(password), 'PBKDF2', false, ['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		extractable,
		['encrypt', 'decrypt']
	);
}

async function encryptRaw(key, plaintext) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(plaintext));
	return { iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}

async function decryptRaw(key, ivHex, ctHex) {
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromHex(ivHex) }, key, fromHex(ctHex)
	);
	return DEC.decode(plain);
}

// ── Session key I/O ───────────────────────────────────────────────────────────

async function saveKeyToSession(key) {
	const raw = await crypto.subtle.exportKey('raw', key);
	sessionStorage.setItem(SESSION_KEY, toHex(new Uint8Array(raw)));
}

async function loadKeyFromSession() {
	const hex = sessionStorage.getItem(SESSION_KEY);
	if (!hex) return null;
	return crypto.subtle.importKey(
		'raw', fromHex(hex), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
	);
}

// ── Backend auth API ──────────────────────────────────────────────────────────

/**
 * Fetch auth data from backend.
 * Returns { salt, sentinel } or {} if not configured.
 * @returns {Promise<{salt?: string, sentinel?: {iv: string, ct: string}}>}
 */
async function fetchAuthData() {
	const resp = await fetch(AUTH_API);
	if (!resp.ok) throw new Error('Auth service unavailable');
	return resp.json();
}

/**
 * Save auth data to backend.
 * @param {string} saltHex
 * @param {{iv: string, ct: string}} sentinel
 */
async function pushAuthData(saltHex, sentinel) {
	const resp = await fetch(AUTH_API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ salt: saltHex, sentinel }),
	});
	if (!resp.ok) {
		const err = await resp.json().catch(() => ({}));
		throw new Error(err.error || `Failed to save auth data (HTTP ${resp.status})`);
	}
}

/**
 * One-time migration: if the backend has no auth but localStorage does,
 * copy it to the backend and clear localStorage.
 * Returns true if migration occurred.
 * @returns {Promise<boolean>}
 */
async function migrateFromLocalStorage() {
	try {
		const saltHex     = localStorage.getItem(LS_SALT_KEY);
		const sentinelRaw = localStorage.getItem(LS_SENTINEL_KEY);
		if (!saltHex || !sentinelRaw) return false;
		const sentinel = JSON.parse(sentinelRaw);
		await pushAuthData(saltHex, sentinel);
		localStorage.removeItem(LS_SALT_KEY);
		localStorage.removeItem(LS_SENTINEL_KEY);
		console.log('[Auth] Migrated auth data from localStorage to backend.');
		return true;
	} catch (err) {
		console.warn('[Auth] Migration failed:', err);
		return false;
	}
}

// ── BroadcastChannel (single shared instance) ─────────────────────────────────

let _bc = null;

function getChannel() {
	if (_bc) return _bc;
	try { _bc = new BroadcastChannel(BC_CHANNEL); } catch { return null; }
	return _bc;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Is the session key present in THIS tab right now? (synchronous)
 * @returns {boolean}
 */
export function isUnlocked() {
	return !!sessionStorage.getItem(SESSION_KEY);
}

/**
 * Has a password ever been set up? Checks the backend, falls back to
 * localStorage for the migration case. (async)
 * @returns {Promise<boolean>}
 */
export async function isFirstRun() {
	try {
		const data = await fetchAuthData();
		if (data && data.salt) return false;
		// Backend has no auth — check if localStorage has it (migration pending)
		if (localStorage.getItem(LS_SALT_KEY)) return false;
		return true;
	} catch {
		// Backend unavailable — fall back to localStorage check
		return !localStorage.getItem(LS_SALT_KEY);
	}
}

/**
 * Ask any other open tab for the encryption key.
 * @returns {Promise<boolean>}
 */
export function syncFromOtherTabs() {
	return new Promise((resolve) => {
		const bc = getChannel();
		if (!bc) { resolve(false); return; }

		const timer = setTimeout(() => {
			bc.removeEventListener('message', handler);
			resolve(false);
		}, SYNC_TIMEOUT_MS);

		function handler(e) {
			if (e.data?.type !== BC_KEY_RESPONSE || !e.data.key) return;
			clearTimeout(timer);
			bc.removeEventListener('message', handler);
			sessionStorage.setItem(SESSION_KEY, e.data.key);
			resolve(true);
		}

		bc.addEventListener('message', handler);
		bc.postMessage({ type: BC_KEY_REQUEST });
	});
}

/**
 * Start listening for key-request and key-revoke messages from peer tabs.
 */
export function startKeyShareServer() {
	const bc = getChannel();
	if (!bc || bc._keyServerActive) return;
	bc._keyServerActive = true;

	bc.addEventListener('message', (e) => {
		const { type } = e.data ?? {};

		if (type === BC_KEY_REQUEST) {
			const localKey = sessionStorage.getItem(SESSION_KEY);
			if (localKey) bc.postMessage({ type: BC_KEY_RESPONSE, key: localKey });
			return;
		}

		if (type === BC_KEY_REVOKE) {
			sessionStorage.removeItem(SESSION_KEY);
			window.location.replace('./login.html');
		}
	});
}

/**
 * First-time password setup.
 * Saves salt + sentinel to the BACKEND.
 *
 * @param {string} password
 * @throws {Error} if a password is already configured.
 */
export async function setupPassword(password) {
	const firstRun = await isFirstRun();
	if (!firstRun) throw new Error('Password already configured. Use login() instead.');

	const salt     = crypto.getRandomValues(new Uint8Array(32));
	const key      = await deriveKey(password, salt, /*extractable=*/true);
	const sentinel = await encryptRaw(key, SENTINEL_VALUE);

	await pushAuthData(toHex(salt), sentinel);

	await saveKeyToSession(key);
	startKeyShareServer();
}

/**
 * Authenticate with the configured password.
 * Reads salt + sentinel from the backend (with localStorage migration fallback).
 *
 * @param {string} password
 * @throws {Error} on wrong password or missing setup.
 */
export async function login(password) {
	let saltHex, sentinel;

	// Try backend first
	try {
		const data = await fetchAuthData();
		if (data && data.salt) {
			saltHex  = data.salt;
			sentinel = data.sentinel;
		}
	} catch {
		// Backend unavailable — fall through to localStorage
	}

	// Migration: backend has no auth but localStorage does
	if (!saltHex) {
		const migrated = await migrateFromLocalStorage();
		if (migrated) {
			// Re-fetch from backend after migration
			try {
				const data = await fetchAuthData();
				if (data && data.salt) { saltHex = data.salt; sentinel = data.sentinel; }
			} catch {}
		}
		// Final fallback: read directly from localStorage (offline case)
		if (!saltHex) {
			saltHex = localStorage.getItem(LS_SALT_KEY);
			const raw = localStorage.getItem(LS_SENTINEL_KEY);
			sentinel  = raw ? JSON.parse(raw) : null;
		}
	}

	if (!saltHex)  throw new Error('No password has been set up yet.');
	if (!sentinel) throw new Error('Auth data missing, please re-run setup.');

	const key = await deriveKey(password, fromHex(saltHex), /*extractable=*/true);

	let plain;
	try { plain = await decryptRaw(key, sentinel.iv, sentinel.ct); }
	catch { throw new Error('Incorrect password.'); }

	if (plain !== SENTINEL_VALUE) throw new Error('Incorrect password.');

	await saveKeyToSession(key);
	startKeyShareServer();
}

/**
 * Lock the app.
 */
export function logout() {
	sessionStorage.removeItem(SESSION_KEY);
	try { getChannel()?.postMessage({ type: BC_KEY_REVOKE }); } catch { /* ignore */ }
}

// ── Payload helpers ───────────────────────────────────────────────────────────

/**
 * Encrypt any JSON-serialisable object with the session key.
 * Stored format: { _enc: true, iv: "<hex>", ct: "<hex>" }
 *
 * @param {*} obj
 * @returns {Promise<{_enc: true, iv: string, ct: string}>}
 */
export async function encryptPayload(obj) {
	const key = await loadKeyFromSession();
	if (!key) throw new Error('Not authenticated: session key missing.');
	const { iv, ct } = await encryptRaw(key, JSON.stringify(obj));
	return { _enc: true, iv, ct };
}

/**
 * Decrypt an encrypted envelope, or return an unencrypted value as-is.
 * The pass-through enables zero-downtime migration of pre-encryption data.
 *
 * @param {*} obj
 * @returns {Promise<*>}
 */
export async function decryptPayload(obj) {
	if (!obj?._enc) return obj;
	const key = await loadKeyFromSession();
	if (!key) throw new Error('Not authenticated: session key missing.');
	return JSON.parse(await decryptRaw(key, obj.iv, obj.ct));
}