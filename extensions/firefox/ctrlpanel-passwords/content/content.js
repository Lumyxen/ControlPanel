(function () {
	'use strict';

	const api = globalThis.browser;
	const buttons = new Map();
	let panel = null;
	let activeField = null;
	let unlockMode = 'pin';
	let scanTimer = 0;

	function isVisible(element) {
		if (!(element instanceof HTMLElement)) return false;
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
	}

	function isPasswordField(element) {
		return element instanceof HTMLInputElement &&
			String(element.type || '').toLowerCase() === 'password' &&
			!element.disabled &&
			!element.readOnly &&
			isVisible(element);
	}

	function isUsernameField(element) {
		if (!(element instanceof HTMLInputElement)) return false;
		if (element.disabled || element.readOnly || !isVisible(element)) return false;
		const type = String(element.type || 'text').toLowerCase();
		if (!['text', 'email', 'tel', 'search', 'url'].includes(type)) return false;
		const hint = `${element.name || ''} ${element.id || ''} ${element.autocomplete || ''} ${element.placeholder || ''}`.toLowerCase();
		return /user|email|login|account|member|identifier/.test(hint);
	}

	function formControls(field) {
		const root = field.form || document;
		return Array.from(root.querySelectorAll('input')).filter((input) => !input.disabled && !input.readOnly && isVisible(input));
	}

	function findPasswordNear(field) {
		if (isPasswordField(field)) return field;
		const controls = formControls(field);
		const index = controls.indexOf(field);
		const after = controls.slice(Math.max(0, index)).find(isPasswordField);
		return after || controls.find(isPasswordField) || null;
	}

	function findUsernameNear(field) {
		if (isUsernameField(field)) return field;
		const controls = formControls(field);
		const passwordIndex = controls.findIndex((input) => input === field || isPasswordField(input));
		const before = passwordIndex >= 0 ? controls.slice(0, passwordIndex).reverse().find(isUsernameField) : null;
		return before || controls.find(isUsernameField) || null;
	}

	function findPair(field) {
		return {
			username: findUsernameNear(field),
			password: findPasswordNear(field),
		};
	}

	function relevantFields() {
		const fields = new Set();
		for (const password of document.querySelectorAll('input[type="password"]')) {
			if (!isPasswordField(password)) continue;
			fields.add(password);
			const username = findUsernameNear(password);
			if (username) fields.add(username);
		}
		for (const username of document.querySelectorAll('input')) {
			if (!isUsernameField(username)) continue;
			if (findPasswordNear(username)) fields.add(username);
		}
		return Array.from(fields);
	}

	function message(payload) {
		return api.runtime.sendMessage(payload).then((response) => {
			if (!response?.ok) throw new Error(response?.error || 'CtrlPanel extension error');
			return response;
		});
	}

	function createButton(field) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'ctrlpanel-fill-button';
		button.textContent = 'CP';
		button.title = 'Show CtrlPanel passwords';
		button.setAttribute('aria-label', 'Show CtrlPanel passwords');
		button.addEventListener('mousedown', (event) => event.preventDefault());
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			openPanel(field);
		});
		document.documentElement.appendChild(button);
		buttons.set(field, button);
		positionButton(field, button);
	}

	function positionButton(field, button) {
		if (!document.documentElement.contains(field) || !isVisible(field)) {
			button.hidden = true;
			return;
		}
		const rect = field.getBoundingClientRect();
		button.hidden = false;
		button.style.top = `${Math.max(4, rect.top + (rect.height / 2) - 12)}px`;
		button.style.left = `${Math.min(window.innerWidth - 30, rect.right - 30)}px`;
	}

	function refreshButtons() {
		const fields = relevantFields();
		const current = new Set(fields);
		for (const [field, button] of buttons.entries()) {
			if (!current.has(field) || !document.documentElement.contains(field)) {
				button.remove();
				buttons.delete(field);
			}
		}
		for (const field of fields) {
			if (!buttons.has(field)) createButton(field);
			field.removeEventListener('focus', handleFieldFocus);
			field.removeEventListener('click', handleFieldFocus);
			field.addEventListener('focus', handleFieldFocus);
			field.addEventListener('click', handleFieldFocus);
		}
		repositionButtons();
	}

	function repositionButtons() {
		for (const [field, button] of buttons.entries()) {
			positionButton(field, button);
		}
		if (panel && activeField) positionPanel(activeField);
	}

	function scheduleScan() {
		window.clearTimeout(scanTimer);
		scanTimer = window.setTimeout(refreshButtons, 120);
	}

	function handleFieldFocus(event) {
		openPanel(event.currentTarget);
	}

	function closePanel() {
		panel?.remove();
		panel = null;
		activeField = null;
	}

	function panelHtml(title, body) {
		return `
			<div class="ctrlpanel-fill-head">
				<span>${escapeHtml(title)}</span>
				<button type="button" class="ctrlpanel-fill-close" aria-label="Close">x</button>
			</div>
			<div class="ctrlpanel-fill-body">${body}</div>
		`;
	}

	function ensurePanel() {
		if (panel) return panel;
		panel = document.createElement('div');
		panel.className = 'ctrlpanel-fill-panel';
		panel.addEventListener('mousedown', (event) => event.stopPropagation());
		panel.addEventListener('click', (event) => {
			const close = event.target.closest('.ctrlpanel-fill-close');
			if (close) {
				event.preventDefault();
				closePanel();
			}
		});
		document.documentElement.appendChild(panel);
		return panel;
	}

	function positionPanel(field) {
		if (!panel) return;
		const rect = field.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		let left = Math.min(Math.max(10, rect.left), window.innerWidth - panelRect.width - 10);
		let top = rect.bottom + 8;
		if (top + panelRect.height > window.innerHeight - 10) {
			top = Math.max(10, rect.top - panelRect.height - 8);
		}
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
	}

	function setPanelContent(field, title, body) {
		const element = ensurePanel();
		const parsed = new DOMParser().parseFromString(panelHtml(title, body), 'text/html');
		element.replaceChildren(...Array.from(parsed.body.childNodes));
		positionPanel(field);
	}

	function escapeHtml(value = '') {
		return String(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function unlockMarkup({ pinAvailable, error = '' } = {}) {
		const usePin = pinAvailable && unlockMode !== 'password';
		if (usePin) {
			return `
				${error ? `<div class="ctrlpanel-fill-error">${escapeHtml(error)}</div>` : ''}
				<form class="ctrlpanel-fill-form" data-unlock-form data-mode="pin">
					<label class="ctrlpanel-fill-field">
						<span>Vault PIN</span>
						<input class="ctrlpanel-fill-input" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required />
					</label>
					<div class="ctrlpanel-fill-actions">
						<button type="submit" class="ctrlpanel-fill-primary">Unlock</button>
						<button type="button" class="ctrlpanel-fill-secondary" data-use-password>Use password</button>
					</div>
				</form>
			`;
		}
		return `
			${error ? `<div class="ctrlpanel-fill-error">${escapeHtml(error)}</div>` : ''}
			<form class="ctrlpanel-fill-form" data-unlock-form data-mode="password">
				<label class="ctrlpanel-fill-field">
					<span>Vault master password</span>
					<input class="ctrlpanel-fill-input" name="password" type="password" autocomplete="current-password" required />
				</label>
				<label class="ctrlpanel-fill-check">
					<input type="checkbox" name="savePin" />
					<span>Set a PIN for this Firefox profile</span>
				</label>
				<label class="ctrlpanel-fill-field" data-pin-setup hidden>
					<span>New PIN</span>
					<input class="ctrlpanel-fill-input" name="pin" type="password" inputmode="numeric" autocomplete="new-password" />
				</label>
				<label class="ctrlpanel-fill-field" data-pin-setup hidden>
					<span>Confirm PIN</span>
					<input class="ctrlpanel-fill-input" name="confirmPin" type="password" inputmode="numeric" autocomplete="new-password" />
				</label>
				<div class="ctrlpanel-fill-actions">
					<button type="submit" class="ctrlpanel-fill-primary">Unlock</button>
					${pinAvailable ? '<button type="button" class="ctrlpanel-fill-secondary" data-use-pin>Use PIN</button>' : ''}
				</div>
			</form>
		`;
	}

	function attachUnlockHandlers(field, state) {
		panel.querySelector('[data-use-password]')?.addEventListener('click', () => {
			unlockMode = 'password';
			showUnlock(field, state);
		});
		panel.querySelector('[data-use-pin]')?.addEventListener('click', () => {
			unlockMode = 'pin';
			showUnlock(field, state);
		});
		const savePin = panel.querySelector('input[name="savePin"]');
		savePin?.addEventListener('change', () => {
			panel.querySelectorAll('[data-pin-setup]').forEach((element) => {
				element.hidden = !savePin.checked;
			});
		});
		panel.querySelector('[data-unlock-form]')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const form = event.currentTarget;
			const submit = form.querySelector('button[type="submit"]');
			const data = Object.fromEntries(new FormData(form).entries());
			submit.disabled = true;
			submit.textContent = 'Unlocking...';
			try {
				let response;
				if (form.dataset.mode === 'pin') {
					response = await message({ type: 'unlockPin', pin: String(data.pin || ''), url: location.href });
				} else {
					const wantsPin = data.savePin === 'on';
					if (wantsPin && !String(data.pin || '')) {
						throw new Error('PIN is required');
					}
					if (wantsPin && String(data.pin || '') !== String(data.confirmPin || '')) {
						throw new Error('PIN values do not match');
					}
					response = await message({
						type: 'unlockMaster',
						password: String(data.password || ''),
						savePin: wantsPin,
						pin: wantsPin ? String(data.pin || '') : '',
						url: location.href,
					});
				}
				renderLogins(field, response.logins || []);
			} catch (error) {
				showUnlock(field, { ...state, error: error.message || 'Unlock failed' });
			}
		});
		const input = panel.querySelector('input');
		window.setTimeout(() => input?.focus(), 0);
	}

	function showUnlock(field, state = {}) {
		setPanelContent(field, 'Unlock CtrlPanel', unlockMarkup(state));
		attachUnlockHandlers(field, state);
	}

	function renderLogins(field, logins) {
		if (!logins.length) {
			setPanelContent(
				field,
				'CtrlPanel Passwords',
				'<div class="ctrlpanel-fill-message">No saved logins match this page.</div>',
			);
			return;
		}
		const items = logins.map((login) => `
			<button type="button" class="ctrlpanel-fill-item" data-login-id="${escapeHtml(login.id)}">
				<span class="ctrlpanel-fill-title">${escapeHtml(login.title)}</span>
				<span class="ctrlpanel-fill-meta">${escapeHtml(login.username || 'No username')}${login.host ? ` - ${escapeHtml(login.host)}` : ''}</span>
			</button>
		`).join('');
		setPanelContent(field, 'Choose Login', `<div class="ctrlpanel-fill-list">${items}</div>`);
		panel.querySelectorAll('[data-login-id]').forEach((button) => {
			button.addEventListener('click', async () => {
				try {
					const response = await message({
						type: 'getLoginSecret',
						id: button.dataset.loginId,
						url: location.href,
					});
					fillFields(field, response.login);
					closePanel();
				} catch (error) {
					setPanelContent(field, 'CtrlPanel Passwords', `<div class="ctrlpanel-fill-error">${escapeHtml(error.message || 'Could not fill login')}</div>`);
				}
			});
		});
	}

	async function openPanel(field) {
		activeField = field;
		setPanelContent(field, 'CtrlPanel Passwords', '<div class="ctrlpanel-fill-message">Loading...</div>');
		try {
			const response = await message({ type: 'getLogins', url: location.href });
			if (response.locked) {
				unlockMode = response.pinAvailable ? 'pin' : 'password';
				showUnlock(field, response);
			} else {
				renderLogins(field, response.logins || []);
			}
		} catch (error) {
			setPanelContent(field, 'CtrlPanel Passwords', `<div class="ctrlpanel-fill-error">${escapeHtml(error.message || 'CtrlPanel is unavailable')}</div>`);
		}
	}

	function setNativeValue(input, value) {
		if (!input) return;
		const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
		descriptor?.set?.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
	}

	function fillFields(field, login) {
		const pair = findPair(field);
		if (pair.username && login.username) {
			setNativeValue(pair.username, login.username);
		}
		if (pair.password && login.password) {
			setNativeValue(pair.password, login.password);
		}
		(pair.password || pair.username || field)?.focus();
	}

	document.addEventListener('mousedown', (event) => {
		if (!panel) return;
		if (panel.contains(event.target)) return;
		for (const button of buttons.values()) {
			if (button.contains(event.target)) return;
		}
		closePanel();
	}, true);

	window.addEventListener('scroll', repositionButtons, true);
	window.addEventListener('resize', repositionButtons);

	const observer = new MutationObserver(scheduleScan);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden', 'disabled'] });

	refreshButtons();
}());
