const SESSION_TOKEN_KEY = 'ctrlpanel:sessionToken';
const AUTH_PENDING_ATTR = 'data-auth-pending';
const AUTH_REDIRECTING_ATTR = 'data-auth-redirecting';
const LOGIN_PATH = '/login.html';

const AUTH_SETUP = '/api/auth/setup';
const AUTH_LOGIN = '/api/auth/login';
const AUTH_LOGOUT = '/api/auth/logout';
const AUTH_STATUS = '/api/auth';
const AUTH_REAUTH = '/api/auth/reauth';

const BC_CHANNEL = 'ctrlpanel:auth';
const BC_TOKEN_REVOKE = 'token-revoke';

const AUTH_PUBLIC_PATHS = new Set([
	'/api/auth',
	'/api/auth/setup',
	'/api/auth/login',
	'/api/auth/validate',
]);

let _channel = null;
let _channelStarted = false;
let _reauthInProgress = false;

async function isSessionExpiredResponse(response) {
	if (response.status !== 401) return false;
	try {
		const body = await response.clone().json();
		return body?.error === 'Not authenticated' || body?.error === 'Invalid session';
	} catch {
		return false;
	}
}

function getChannel() {
	if (!_channel) _channel = new BroadcastChannel(BC_CHANNEL);
	return _channel;
}

function saveToken(token) {
	localStorage.setItem(SESSION_TOKEN_KEY, token);
}

function clearToken() {
	localStorage.removeItem(SESSION_TOKEN_KEY);
}

function loadToken() {
	return localStorage.getItem(SESSION_TOKEN_KEY) || null;
}

function setAuthUiBlocked(blocked, attrName = AUTH_PENDING_ATTR) {
	const root = document.documentElement;
	if (root) {
		if (blocked) root.setAttribute(attrName, 'true');
		else root.removeAttribute(attrName);
	}

	if (document.body) {
		document.body.inert = blocked;
	}
}

function blurActiveElement() {
	const active = document.activeElement;
	if (active && typeof active.blur === 'function') {
		active.blur();
	}
}

function normaliseRequestUrl(input) {
	try {
		if (input instanceof URL) return input;
		if (input instanceof Request) return new URL(input.url, location.origin);
		return new URL(String(input), location.origin);
	} catch {
		return null;
	}
}

function isProtectedBackendUrl(input) {
	const url = normaliseRequestUrl(input);
	if (!url || url.origin !== location.origin) return false;
	if (url.pathname === '/health') return false;
	if (AUTH_PUBLIC_PATHS.has(url.pathname)) return false;
	return url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp');
}

export function isUnlocked() {
	return !!loadToken();
}

export function getSessionToken() {
	return loadToken();
}

export function getAuthorizationHeader(token = loadToken()) {
	return token ? `Bearer ${token}` : '';
}

export function buildAuthHeaders(headers = {}) {
	const auth = getAuthorizationHeader();
	return auth ? { ...headers, Authorization: auth } : { ...headers };
}

export function buildAuthenticatedBackendUrl(input) {
	const url = normaliseRequestUrl(input);
	return url ? url.toString() : String(input);
}

export function releaseAuthGate() {
	if (_reauthInProgress) return;
	const root = document.documentElement;
	setAuthUiBlocked(false);
	root?.removeAttribute(AUTH_REDIRECTING_ATTR);
	if (root) root.style.visibility = '';
}

export function redirectToLogin(options = {}) {
	const { broadcast = false } = options;
	if (_reauthInProgress) return;
	_reauthInProgress = true;
	clearToken();
	setAuthUiBlocked(true);
	document.documentElement?.setAttribute(AUTH_REDIRECTING_ATTR, 'true');
	blurActiveElement();
	if (broadcast) {
		try {
			getChannel().postMessage({ type: BC_TOKEN_REVOKE });
		} catch {}
	}
	window.location.replace(LOGIN_PATH);
}

if (typeof globalThis.fetch === 'function' && !globalThis.__ctrlpanelAuthFetchPatched) {
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input, init) => {
		const protectedRequest = isProtectedBackendUrl(input);
		let requestInput = input;
		let requestInit = init;

		if (protectedRequest) {
			if (_reauthInProgress) {
				throw new Error('Session expired');
			}

			const token = loadToken();
			if (!token) {
				redirectToLogin({ broadcast: true });
				throw new Error('Session expired');
			}

			const request = new Request(input, init);
			const headers = new Headers(request.headers);
			if (!headers.has('Authorization')) {
				headers.set('Authorization', `Bearer ${token}`);
			}
			requestInput = new Request(request, { headers });
			requestInit = undefined;
		}

		const response = await originalFetch(requestInput, requestInit);
		if (protectedRequest && await isSessionExpiredResponse(response)) {
			redirectToLogin({ broadcast: true });
			throw new Error('Session expired');
		}
		return response;
	};
	globalThis.__ctrlpanelAuthFetchPatched = true;
}

export async function syncFromOtherTabs() {
	return !!loadToken();
}

export function startKeyShareServer() {
	if (_channelStarted) return;
	_channelStarted = true;
	const ch = getChannel();
	ch.onmessage = (event) => {
		if (event.data?.type === BC_TOKEN_REVOKE) {
			redirectToLogin();
		}
	};

	window.addEventListener('storage', (event) => {
		if (event.key === SESSION_TOKEN_KEY && !event.newValue) {
			redirectToLogin();
		}
	});
}

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

export async function validateSession() {
	const token = loadToken();
	if (!token) return false;
	try {
		const res = await fetch('/api/auth/validate', {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return false;
		const data = await res.json();
		return data.valid === true;
	} catch {
		return false;
	}
}

async function submitPassword(endpoint, password) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error || 'Authentication failed');
	}
	return res.json();
}

export async function setupPassword(password) {
	const data = await submitPassword(AUTH_SETUP, password);
	saveToken(data.sessionToken);
	startKeyShareServer();
}

export async function login(password) {
	const data = await submitPassword(AUTH_LOGIN, password);
	saveToken(data.sessionToken);
	startKeyShareServer();
}

export async function reauthPanelPassword(password) {
	const res = await fetch(AUTH_REAUTH, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: getAuthorizationHeader(),
		},
		body: JSON.stringify({ password }),
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error || 'Panel reauthentication failed');
	}
	const data = await res.json();
	return data.reauthToken;
}

export async function logout() {
	if (loadToken()) {
		try {
			await fetch(AUTH_LOGOUT, {
				method: 'POST',
				headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
			});
		} catch {}
	}
	clearToken();
	try {
		getChannel().postMessage({ type: BC_TOKEN_REVOKE });
	} catch {}
}

export async function encryptPayload(obj) {
	return obj;
}

export async function decryptPayload(obj) {
	return obj;
}
