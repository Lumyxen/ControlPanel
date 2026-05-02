import {
	getSnapshotState,
	init as initVault,
	lock as lockVault,
	refreshStatus,
	saveVault,
	setupVault,
	subscribe as subscribeVault,
	unlockWithMasterPassword,
	unlockWithPin,
} from '../services/vault.js';
import { mountStarfield } from './login/starfield.js';

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'medium',
	timeStyle: 'short',
});

function escapeHtml(value = '') {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function navigationType() {
	return globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type || 'navigate';
}

function createEmptyCredential() {
	const now = Date.now();
	return {
		id: `cred-${now}-${Math.random().toString(16).slice(2, 8)}`,
		title: '',
		username: '',
		password: '',
		url: '',
		notes: '',
		createdAt: now,
		updatedAt: now,
	};
}

function formatTimestamp(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return '—';
	return timestampFormatter.format(numeric);
}

export function mountPasswordManagerPage(root) {
	let selectedId = null;
	let banner = null;
	let addMenuOpen = false;
	let stopStarfield = () => {};

	const body = root.querySelector('#vault-page-body') || root;
	const contentShell = root.closest('.content');

	function syncShellMode(isAuthScreen) {
		contentShell?.classList.toggle('content-bleed', isAuthScreen);
	}

	function setBanner(message, tone = 'info') {
		banner = message ? { message, tone } : null;
		render();
	}

	function selectDefault(snapshot) {
		if (!snapshot?.vault?.items?.length) {
			selectedId = null;
			return;
		}
		if (!snapshot.vault.items.some((item) => item.id === selectedId)) {
			selectedId = snapshot.vault.items[0].id;
		}
	}

	function currentCredential(snapshot) {
		return snapshot.vault?.items?.find((item) => item.id === selectedId) || null;
	}

	function bannerMarkup() {
		if (!banner) return '';
		return `<div class="vault-banner vault-banner-${banner.tone}">${escapeHtml(banner.message)}</div>`;
	}

	function readCredentialForm(form, seed = createEmptyCredential()) {
		const data = Object.fromEntries(new FormData(form).entries());
		return {
			id: String(data.id || seed.id),
			title: String(data.title || '').trim(),
			username: String(data.username || '').trim(),
			password: String(data.password || ''),
			url: String(data.url || '').trim(),
			notes: String(data.notes || ''),
			createdAt: Number(data.createdAt) || seed.createdAt || Date.now(),
			updatedAt: Date.now(),
		};
	}

	function credentialFormMarkup(credential, { id, compact = false } = {}) {
		const formId = id || 'vault-editor-form';
		return `
			<form id="${formId}" class="vault-editor-form ${compact ? 'vault-editor-form-compact' : ''}">
				<input type="hidden" name="id" value="${escapeHtml(credential.id)}" />
				<input type="hidden" name="createdAt" value="${escapeHtml(credential.createdAt)}" />
				<div class="option-row">
					<label for="${formId}-title">Title</label>
					<input id="${formId}-title" class="text-input" name="title" value="${escapeHtml(credential.title)}" required />
				</div>
				<div class="option-row">
					<label for="${formId}-username">Username</label>
					<input id="${formId}-username" class="text-input" name="username" value="${escapeHtml(credential.username)}" autocomplete="username" />
				</div>
				<div class="option-row">
					<label for="${formId}-password">Password</label>
					<input id="${formId}-password" class="text-input" name="password" type="password" value="${escapeHtml(credential.password)}" autocomplete="current-password" />
				</div>
				<div class="option-row">
					<label for="${formId}-url">URL</label>
					<input id="${formId}-url" class="text-input" name="url" type="url" value="${escapeHtml(credential.url)}" autocomplete="url" />
				</div>
				<div class="option-row">
					<label for="${formId}-notes">Notes</label>
					<textarea id="${formId}-notes" class="text-input vault-notes ${compact ? 'vault-notes-compact' : ''}" name="notes" rows="${compact ? '4' : '10'}">${escapeHtml(credential.notes)}</textarea>
				</div>
				<div class="vault-editor-actions">
					<button type="submit" class="btn btn-primary">${compact ? 'Add Credential' : 'Save Credential'}</button>
					${compact
						? '<button type="button" id="vault-add-cancel" class="btn">Cancel</button>'
						: `<button type="button" id="vault-delete-item" class="btn btn-danger" ${selectedId ? '' : 'disabled'}>Delete Credential</button>`}
				</div>
			</form>
		`;
	}

	function renderSetup() {
		body.innerHTML = `
			<section class="vault-simple-shell">
				<canvas class="vault-simple-starfield" data-vault-starfield aria-hidden="true"></canvas>
				<div class="vault-simple-stage">
					${bannerMarkup()}
					<div class="vault-simple-card card">
						<div class="vault-simple-copy">
							<h1 class="vault-simple-title">Create vault password</h1>
							<p class="vault-simple-description">Choose a master password for the password manager. It stays separate from the main panel login.</p>
						</div>
						<form id="vault-setup-form" class="vault-lock-form">
							<label class="vault-field">
								<span>Vault master password</span>
								<input class="text-input" name="password" type="password" autocomplete="new-password" required />
							</label>
							<label class="vault-field">
								<span>Confirm password</span>
								<input class="text-input" name="confirm" type="password" autocomplete="new-password" required />
							</label>
							<div class="vault-lock-actions">
								<button type="submit" class="btn btn-primary">Create Vault</button>
							</div>
						</form>
					</div>
				</div>
			</section>
		`;

		body.querySelector('#vault-setup-form')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const data = Object.fromEntries(new FormData(event.currentTarget).entries());
			if (!data.password || data.password !== data.confirm) {
				setBanner('Passwords do not match.', 'error');
				return;
			}
			try {
				setBanner('Creating vault...');
				await setupVault(String(data.password));
				setBanner('Vault ready.', 'success');
			} catch (error) {
				setBanner(error.message || 'Failed to create vault.', 'error');
			}
		});
	}

	function renderLocked(snapshot) {
		body.innerHTML = `
			<section class="vault-simple-shell">
				<canvas class="vault-simple-starfield" data-vault-starfield aria-hidden="true"></canvas>
				<div class="vault-simple-stage">
					${bannerMarkup()}
					<div class="vault-simple-card card">
						<div class="vault-simple-copy">
							<h1 class="vault-simple-title">Unlock password manager</h1>
							<p class="vault-simple-description">The panel session is active, but the vault must be unlocked separately.</p>
						</div>
						<form id="vault-master-form" class="vault-lock-form">
							<label class="vault-field">
								<span>Vault master password</span>
								<input class="text-input" name="password" type="password" autocomplete="current-password" required />
							</label>
							<div class="vault-lock-actions">
								<button type="submit" class="btn btn-primary">Unlock with Password</button>
							</div>
						</form>
						${snapshot.hasPinUnlock ? `
							<div class="vault-divider"></div>
							<form id="vault-pin-form" class="vault-lock-form vault-pin-form">
								<label class="vault-field">
									<span>Device PIN</span>
									<input class="text-input" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required />
								</label>
								<div class="vault-lock-actions">
									<button type="submit" class="btn">Unlock with PIN</button>
								</div>
							</form>
						` : snapshot.pin?.configured ? `
							<div class="vault-note vault-note-inline">This device has a server PIN slot, but the local browser record is missing. Use the master password to set it up again.</div>
						` : ''}
					</div>
				</div>
			</section>
		`;

		body.querySelector('#vault-master-form')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const password = String(new FormData(event.currentTarget).get('password') || '');
			try {
				setBanner('Unlocking vault...');
				await unlockWithMasterPassword(password);
				setBanner(null);
			} catch (error) {
				setBanner(error.message || 'Vault unlock failed.', 'error');
			}
		});

		body.querySelector('#vault-pin-form')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const pin = String(new FormData(event.currentTarget).get('pin') || '');
			try {
				setBanner('Unlocking with PIN...');
				await unlockWithPin(pin);
				setBanner(null);
			} catch (error) {
				setBanner(error.message || 'PIN unlock failed.', 'error');
			}
		});
	}

	function renderUnlocked(snapshot) {
		selectDefault(snapshot);
		const items = snapshot.vault?.items || [];
		const selected = currentCredential(snapshot);
		const addDraft = createEmptyCredential();

		body.innerHTML = `
			${bannerMarkup()}
			<section class="vault-dashboard vault-dashboard-list-first">
				<section class="vault-workspace">
					<section class="vault-list card">
						<div class="vault-panel-head vault-list-head">
							<div>
								<h1 class="card-title">Credentials</h1>
								<p class="vault-panel-copy">${escapeHtml(String(items.length))} saved ${items.length === 1 ? 'credential' : 'credentials'}.</p>
							</div>
							<div class="vault-toolbar">
								<div class="vault-add-popover-wrap">
									<button type="button" id="vault-new-item" class="btn btn-primary" aria-haspopup="menu" aria-expanded="${addMenuOpen ? 'true' : 'false'}">New Credential</button>
									${addMenuOpen ? `
										<div class="vault-add-menu" role="menu" aria-label="New credential">
											${credentialFormMarkup(addDraft, { id: 'vault-add-form', compact: true })}
										</div>
									` : ''}
								</div>
								<button type="button" id="vault-lock-now" class="btn">Lock Vault</button>
							</div>
						</div>
						<div class="vault-item-list vault-item-list-main">
							${items.length ? items.map((item) => `
								<button type="button" class="vault-item ${item.id === selectedId ? 'active' : ''}" data-item-id="${escapeHtml(item.id)}">
									<span class="vault-item-title">${escapeHtml(item.title || 'Untitled')}</span>
									<span class="vault-item-meta">${escapeHtml(item.username || 'No username')}</span>
									<span class="vault-item-meta vault-item-url">${escapeHtml(item.url || 'No URL')}</span>
									<span class="vault-item-meta vault-item-updated">Updated ${escapeHtml(formatTimestamp(item.updatedAt || item.createdAt))}</span>
								</button>
							`).join('') : '<div class="vault-empty">No credentials yet.</div>'}
						</div>
					</section>

					<aside class="vault-main-column">
						<section class="vault-editor card" aria-live="polite">
							<div class="vault-panel-head">
								<div>
									<h2 class="card-title">Credential Details</h2>
									<p class="vault-panel-copy">${selected ? 'Edit the selected credential.' : 'Select a credential to edit.'}</p>
								</div>
							</div>
							${selected ? credentialFormMarkup(selected) : '<div class="vault-empty vault-empty-details">Select an item from the credentials list.</div>'}
						</section>
					</aside>
				</section>
			</section>
		`;

		for (const button of body.querySelectorAll('[data-item-id]')) {
			button.addEventListener('click', () => {
				selectedId = button.dataset.itemId;
				addMenuOpen = false;
				render();
			});
		}

		body.querySelector('#vault-new-item')?.addEventListener('click', () => {
			addMenuOpen = !addMenuOpen;
			render();
		});

		body.querySelector('#vault-add-cancel')?.addEventListener('click', () => {
			addMenuOpen = false;
			render();
		});

		body.querySelector('#vault-add-form')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const nextItem = readCredentialForm(event.currentTarget, addDraft);
			const nextItems = [...items, nextItem];

			try {
				setBanner('Saving credential...');
				await saveVault({
					...snapshot.vault,
					items: nextItems,
				});
				selectedId = nextItem.id;
				addMenuOpen = false;
				setBanner('Credential added.', 'success');
			} catch (error) {
				setBanner(error.message || 'Failed to create credential.', 'error');
			}
		});

		body.querySelector('#vault-lock-now')?.addEventListener('click', () => {
			addMenuOpen = false;
			lockVault();
			setBanner('Vault locked.', 'success');
		});

		body.querySelector('#vault-editor-form')?.addEventListener('submit', async (event) => {
			event.preventDefault();
			const nextItem = readCredentialForm(event.currentTarget, selected || createEmptyCredential());
			const existing = items.some((item) => item.id === nextItem.id);
			const nextItems = existing
				? items.map((item) => (item.id === nextItem.id ? nextItem : item))
				: [...items, nextItem];

			try {
				setBanner('Saving vault...');
				await saveVault({
					...snapshot.vault,
					items: nextItems,
				});
				selectedId = nextItem.id;
				setBanner('Vault saved.', 'success');
			} catch (error) {
				setBanner(error.message || 'Failed to save vault.', 'error');
			}
		});

		body.querySelector('#vault-delete-item')?.addEventListener('click', async () => {
			if (!selectedId) return;
			const nextItems = items.filter((item) => item.id !== selectedId);
			selectedId = nextItems[0]?.id || null;
			try {
				setBanner('Saving vault...');
				await saveVault({
					...snapshot.vault,
					items: nextItems,
				});
				setBanner('Credential removed.', 'success');
			} catch (error) {
				setBanner(error.message || 'Failed to delete credential.', 'error');
			}
		});
	}

	function render() {
		const snapshot = getSnapshotState();
		const isAuthScreen = !snapshot.setup || !snapshot.unlocked;
		root.dataset.vaultUnlocked = snapshot.unlocked ? 'true' : 'false';
		root.dataset.vaultState = !snapshot.setup ? 'setup' : snapshot.unlocked ? 'unlocked' : 'locked';
		syncShellMode(isAuthScreen);

		if (!snapshot.setup) {
			renderSetup();
		} else if (!snapshot.unlocked) {
			renderLocked(snapshot);
		} else {
			renderUnlocked(snapshot);
		}

		stopStarfield();
		stopStarfield = () => {};
		const canvas = body.querySelector('[data-vault-starfield]');
		if (!canvas) return;
		const shell = canvas.closest('.vault-simple-shell');
		if (!shell) return;
		stopStarfield = mountStarfield(canvas, {
			getSize: () => {
				const rect = shell.getBoundingClientRect();
				return { width: rect.width, height: rect.height };
			},
			observeTarget: shell,
		});
	}

	const unsubscribe = subscribeVault(() => render());
	const allowAutoShare = navigationType() !== 'reload';
	initVault({ allowAutoShare }).then(render).catch((error) => {
		setBanner(error.message || 'Failed to load vault status.', 'error');
		refreshStatus().catch(() => {});
	});

	return () => {
		syncShellMode(false);
		stopStarfield();
		unsubscribe();
	};
}
