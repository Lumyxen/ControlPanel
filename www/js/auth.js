/**
 * auth.js — Client-side authentication for ctrlpanel.
 *
 * The backend handles all key derivation and encryption. The frontend only
 * needs to send the password and receive a session token.
 *
 * Session token stored in sessionStorage (per-tab), shared across tabs
 * via BroadcastChannel.
 *
 * Public API:
 *   isUnlocked()            → boolean          synchronous
 *   isFirstRun()            → Promise<boolean> checks backend (async)
 *   syncFromOtherTabs()     → Promise<boolean> try to get token from a peer tab
 *   startKeyShareServer()   → void             serve token-request messages
 *   login(password)         → Promise<void>    throws on bad password
 *   setupPassword(password) → Promise<void>    first-run only
 *   logout()                → Promise<void>    locks all open tabs
 *   getSessionToken()       → string|null      for API calls
 *   encryptPayload(obj)     → Promise<object>  pass-through (backend encrypts)
 *   decryptPayload(obj)     → Promise<any>     pass-through (backend decrypts)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_TOKEN_KEY = 'ctrlpanel:sessionToken';

const AUTH_SETUP   = '/api/auth/setup';
const AUTH_LOGIN   = '/api/auth/login';
const AUTH_LOGOUT  = '/api/auth/logout';
const AUTH_STATUS  = '/api/auth';

const BC_CHANNEL      = 'ctrlpanel:keyshare';
const BC_TOKEN_REQUEST  = 'key-request';
const BC_TOKEN_RESPONSE = 'key-response';
const BC_TOKEN_REVOKE   = 'key-revoke';

const SYNC_TIMEOUT_MS = 300;

// ── Session token management ──────────────────────────────────────────────────

/** Save session token to sessionStorage */
function saveTokenToSession(token) {
	sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

/** Load session token from sessionStorage */
function loadTokenFromSession() {
	return sessionStorage.getItem(SESSION_TOKEN_KEY) || null;
}

/** @returns {boolean} */
export function isUnlocked() {
	return !!loadTokenFromSession();
}

/** @returns {string|null} */
export function getSessionToken() {
	return loadTokenFromSession();
}

// ── BroadcastChannel cross-tab token sharing ─────────────────────────────────

let _channel = null;

function getChannel() {
	if (!_channel) _channel = new BroadcastChannel(BC_CHANNEL);
	return _channel;
}

/** Try to get the session token from another open tab. */
export async function syncFromOtherTabs() {
	return new Promise((resolve) => {
		const ch = getChannel();
		const handler = (e) => {
			if (e.data?.type === BC_TOKEN_RESPONSE && e.data?.token) {
				ch.removeEventListener('message', handler);
				saveTokenToSession(e.data.token);
				resolve(true);
			}
		};
		ch.addEventListener('message', handler);
		ch.postMessage({ type: BC_TOKEN_REQUEST });
		setTimeout(() => {
			ch.removeEventListener('message', handler);
			resolve(false);
		}, SYNC_TIMEOUT_MS);
	});
}

/** Listen for token requests from other tabs and respond. */
export function startKeyShareServer() {
	const ch = getChannel();
	ch.onmessage = (e) => {
		if (e.data?.type === BC_TOKEN_REQUEST) {
			const token = loadTokenFromSession();
			if (token) ch.postMessage({ type: BC_TOKEN_RESPONSE, token });
		} else if (e.data?.type === BC_TOKEN_REVOKE) {
			sessionStorage.removeItem(SESSION_TOKEN_KEY);
			// Redirect to login
			if (location.pathname !== '/login.html' && location.pathname !== '/login') {
				window.location.href = '/login.html';
			}
		}
	};
}

// ── Backend API ───────────────────────────────────────────────────────────────

/** Check if this is a first-run (no password set). */
export async function isFirstRun() {
	try {
		const res = await fetch(AUTH_STATUS);
		if (!res.ok) return true;
		const data = await res.json();
		return !data.setup;
	} catch {
		return true;
	}
}

/** Validate current session with the backend. Returns false if the session
 *  is stale (e.g. server restarted and lost the AES key). */
export async function validateSession() {
	const token = loadTokenFromSession();
	if (!token) return false;
	try {
		const res = await fetch('/api/auth/validate', {
			headers: { 'X-Session-Token': token },
		});
		if (!res.ok) return false;
		const data = await res.json();
		return data.valid === true;
	} catch {
		return false;
	}
}

/** First-time password setup. */
export async function setupPassword(password) {
	const res = await fetch(AUTH_SETUP, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error || 'Setup failed');
	}
	const data = await res.json();
	saveTokenToSession(data.sessionToken);
	startKeyShareServer();
}

/** Login with existing password. */
export async function login(password) {
	const res = await fetch(AUTH_LOGIN, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error || 'Login failed');
	}
	const data = await res.json();
	saveTokenToSession(data.sessionToken);
	startKeyShareServer();
}

/** Logout — revoke session on backend and broadcast to other tabs. */
export async function logout() {
	const token = loadTokenFromSession();
	if (token) {
		try {
			await fetch(AUTH_LOGOUT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Session-Token': token,
				},
			});
		} catch { /* ignore */ }
	}
	sessionStorage.removeItem(SESSION_TOKEN_KEY);
	getChannel().postMessage({ type: BC_TOKEN_REVOKE });
}

// ── Payload encryption/decryption (pass-through — backend handles it) ─────────

/**
 * Encrypt payload — now a pass-through.
 * The backend encrypts data before storing it.
 */
export async function encryptPayload(obj) {
	return obj;
}

/**
 * Decrypt payload — now a pass-through.
 * The backend decrypts data before sending it.
 */
export async function decryptPayload(obj) {
	return obj;
}
