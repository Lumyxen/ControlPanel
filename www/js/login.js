/**
 * login.js — Controller for login.html
 *
 * Responsibilities:
 *   1. If already unlocked, redirect immediately.
 *   2. If not yet unlocked, try syncFromOtherTabs().
 *   3. Detect first-run vs normal login and configure the UI accordingly.
 *   4. Handle form submission: setupPassword() or login() → redirect on success.
 */

import { isUnlocked, isFirstRun, syncFromOtherTabs, setupPassword, login } from './auth.js';

// ── Fast-path: already have a key ─────────────────────────────────────────────

if (isUnlocked()) {
	window.location.replace('./');
	throw new Error('Already authenticated — redirecting.');
}

const synced = await syncFromOtherTabs();
if (synced) {
	window.location.replace('./');
	throw new Error('Key synced from peer tab — redirecting.');
}

// ── DOM references ────────────────────────────────────────────────────────────

const modeBanner    = /** @type {HTMLElement}       */ (document.getElementById('mode-banner'));
const modeIcon      = /** @type {SVGElement}        */ (document.getElementById('mode-icon'));
const modeLabel     = /** @type {HTMLElement}       */ (document.getElementById('mode-label'));
const authTitle     = /** @type {HTMLElement}       */ (document.getElementById('auth-title'));
const authSubtitle  = /** @type {HTMLElement}       */ (document.getElementById('auth-subtitle'));
const form          = /** @type {HTMLFormElement}   */ (document.getElementById('auth-form'));
const passwordInput = /** @type {HTMLInputElement}  */ (document.getElementById('password'));
const confirmGroup  = /** @type {HTMLElement}       */ (document.getElementById('confirm-group'));
const confirmInput  = /** @type {HTMLInputElement}  */ (document.getElementById('confirm'));
const submitBtn     = /** @type {HTMLButtonElement} */ (document.getElementById('submit-btn'));
const errorBox      = /** @type {HTMLElement}       */ (document.getElementById('error-box'));

// ── First-run vs login mode ───────────────────────────────────────────────────

// isFirstRun() is now async (checks backend)
const firstRun = await isFirstRun();

if (firstRun) {
	// ── Setup mode ────────────────────────────────────────────────────────────

	// Banner
	modeBanner.classList.replace('mode-unlock', 'mode-setup');
	modeLabel.textContent = 'First-time setup';
	// Key → pencil icon
	modeIcon.innerHTML = `
		<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
		<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
	`;

	// Header copy
	authTitle.textContent    = 'Set up your password';
	authSubtitle.textContent = 'Choose a password to encrypt your control panel. It encrypts all stored chat data. There is no recovery option, so don\'t forget it.';

	// Reveal confirm field
	confirmGroup.hidden   = false;
	confirmInput.required = true;

	// Autocomplete hints for password managers
	passwordInput.setAttribute('autocomplete', 'new-password');

	// Submit label
	submitBtn.textContent = 'Create password';

	// Document title
	document.title = 'Control Panel — Set up password';

} else {
	// ── Unlock mode (default) ─────────────────────────────────────────────────
	document.title = 'Control Panel — Unlock';
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function showError(msg) {
	errorBox.textContent = msg;
	errorBox.hidden = false;
	errorBox.setAttribute('role', 'alert');
}

function clearError() {
	errorBox.hidden = true;
	errorBox.textContent = '';
	errorBox.removeAttribute('role');
}

// ── Loading state ─────────────────────────────────────────────────────────────

function setLoading(on) {
	submitBtn.disabled     = on;
	passwordInput.disabled = on;
	if (confirmInput) confirmInput.disabled = on;
	submitBtn.setAttribute('aria-busy', String(on));

	if (on) {
		submitBtn.dataset.prev = submitBtn.textContent;
		submitBtn.textContent  = firstRun ? 'Creating…' : 'Unlocking…';
	} else if (submitBtn.dataset.prev) {
		submitBtn.textContent = submitBtn.dataset.prev;
		delete submitBtn.dataset.prev;
	}
}

// ── Form submission ───────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
	e.preventDefault();
	clearError();

	const password = passwordInput.value;

	if (!password) {
		showError('Please enter a password.');
		passwordInput.focus();
		return;
	}

	if (firstRun) {
		if (password !== confirmInput.value) {
			showError('Passwords do not match.');
			confirmInput.focus();
			return;
		}
	}

	setLoading(true);

	try {
		if (firstRun) {
			await setupPassword(password);
		} else {
			await login(password);
		}
		window.location.replace('./');
	} catch (err) {
		setLoading(false);
		showError(err.message || 'Something went wrong. Please try again.');
	}
});

passwordInput.addEventListener('input', clearError);
if (confirmInput) confirmInput.addEventListener('input', clearError);

passwordInput.focus();