// www/js/chat/toolbar.js
// UI setup for chat toolbar controls: dropdowns, model selector, tools toggle, file upload.

import { getModels, getToolPacks } from '../../core/http.js';
import { setModelMetadata, getModelContextLimitFromUI, updateContextUI } from './context.js';
import {
	getChatModel,
	getCurrentChatId,
	getChatById,
	getChatToolScope,
	setChatModel,
	setChatToolScope,
	setLastSelectedModel,
	getLastSelectedModel,
} from './repository.js';
import * as SettingsStore from '../../services/settings.js';

// ─── Dropdowns ────────────────────────────────────────────────────────────────

export function initDropdowns(root, signal) {
	root.querySelectorAll('.chat-dropdown').forEach((dropdown) => {
		const toggle = dropdown.querySelector('.chat-dropdown-toggle');
		const menu   = dropdown.querySelector('.chat-dropdown-menu');
		const isMulti = dropdown.hasAttribute('data-multi');

		toggle?.addEventListener('click', (e) => {
			e.preventDefault();
			const isOpen = dropdown.classList.contains('open');
			root.querySelectorAll('.chat-dropdown.open').forEach((d) => {
				if (d !== dropdown) {
					d.classList.remove('open');
					d.querySelector('.chat-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
				}
			});
			dropdown.classList.toggle('open', !isOpen);
			toggle.setAttribute('aria-expanded', String(!isOpen));
		}, { signal });

		if (!isMulti) {
			const items = dropdown.querySelectorAll('.chat-dropdown-item');
			const label = dropdown.querySelector('.chat-dropdown-label');
			items.forEach((item) => {
				item.addEventListener('click', () => {
					items.forEach(i => { i.classList.remove('selected'); i.setAttribute('aria-selected', 'false'); });
					item.classList.add('selected');
					item.setAttribute('aria-selected', 'true');
					if (label) label.textContent = item.textContent;
					dropdown.classList.remove('open');
					toggle?.setAttribute('aria-expanded', 'false');
				}, { signal });
			});
		} else {
			menu?.addEventListener('click', (e) => e.stopPropagation(), { signal });
		}
	});

	document.addEventListener('click', (e) => {
		if (!e.target.closest('.chat-dropdown')) {
			root.querySelectorAll('.chat-dropdown.open').forEach((d) => {
				d.classList.remove('open');
				d.querySelector('.chat-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
			});
		}
	}, { signal });
}

// ─── Tools toggle ─────────────────────────────────────────────────────────────

export function initTools(root, signal) {
	const toolsDropdown = root.querySelector('[data-dropdown="tools"]');
	if (!toolsDropdown) return;
	const menu = toolsDropdown.querySelector('.chat-dropdown-menu');
	if (!menu) return;

	root._toolPackCache = [];

	const syncSelection = () => {
		const chatId = getCurrentChatId();
		const enabled = new Set(chatId ? getChatToolScope(chatId).enabledPackIds : []);
		const checkboxes = [...menu.querySelectorAll('input[type="checkbox"][name="tool-pack"]')];
		checkboxes.forEach((cb) => {
			cb.checked = enabled.has(cb.value);
		});
		toolsDropdown.classList.toggle('has-enabled-tools', enabled.size > 0);
	};

	const renderPacks = async () => {
		try {
			const response = await getToolPacks();
			const packs = Array.isArray(response?.packs) ? response.packs : [];
			root._toolPackCache = packs;
			menu.innerHTML = '';

			if (packs.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'chat-tool-empty';
				empty.textContent = 'No tool packs available';
				menu.appendChild(empty);
				toolsDropdown.classList.remove('has-enabled-tools');
				return;
			}

			for (const pack of packs) {
				const label = document.createElement('label');
				label.className = 'chat-tool-toggle';
				label.innerHTML = `
					<input type="checkbox" name="tool-pack" value="${pack.id}" />
					<span class="chat-tool-check" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
							<path d="M20 6L9 17l-5-5" />
						</svg>
					</span>
					<span class="chat-tool-label">${pack.title}</span>
				`;
				const meta = document.createElement('span');
				meta.className = 'chat-tool-meta';
				const sourceType = pack.sourceType || pack.source_type || 'system';
				const toolCount = Number(pack.toolCount || 0);
				meta.textContent = `${sourceType} • ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
				label.appendChild(meta);
				menu.appendChild(label);
			}

			[...menu.querySelectorAll('input[type="checkbox"][name="tool-pack"]')].forEach((cb) => {
				cb.addEventListener('change', () => {
					const chatId = getCurrentChatId();
					if (!chatId) return;
					const enabledPackIds = [...menu.querySelectorAll('input[type="checkbox"][name="tool-pack"]:checked')]
						.map((input) => input.value);
					setChatToolScope(chatId, enabledPackIds);
					syncSelection();
				}, { signal });
			});

			syncSelection();
		} catch (err) {
			console.error('Failed to load tool packs:', err);
			menu.innerHTML = '';
			const error = document.createElement('div');
			error.className = 'chat-tool-empty';
			error.textContent = 'Could not load tool packs';
			menu.appendChild(error);
			toolsDropdown.classList.remove('has-enabled-tools');
		}
	};

	root._syncToolPackPicker = syncSelection;
	root._reloadToolPackPicker = renderPacks;
	renderPacks();
}

// ─── File upload ──────────────────────────────────────────────────────────────

export function initUpload(root, inputEl, attachmentManager, signal) {
	const uploadBtn   = root.querySelector('#chatUploadBtn');
	const uploadInput = root.querySelector('#chatUploadInput');
	const uploadLabel = root.querySelector('#chatUploadLabel');
	if (!uploadBtn || !uploadInput) return;

	const updateCount = () => {
		const count = attachmentManager.getAttachments().length;
		if (count > 0) uploadBtn.dataset.count = String(count);
		else delete uploadBtn.dataset.count;
		if (uploadLabel) uploadLabel.textContent = 'Upload';
	};

	uploadBtn.addEventListener('click', () => uploadInput.click(), { signal });
	uploadInput.addEventListener('change', async () => {
		const selected = Array.from(uploadInput.files || []);
		uploadInput.value = '';
		for (const file of selected) await attachmentManager.addFile(file);
		updateCount();
	}, { signal });

	attachmentManager.options.onAttachmentAdded   = updateCount;
	attachmentManager.options.onAttachmentRemoved = updateCount;
	updateCount();
}

// ─── Input auto-resize / empty state ─────────────────────────────────────────

export function initAutoResize(element, signal) {
	const updatePlaceholder = () => {
		const isEmpty = (element.textContent || '').length === 0 &&
			!element.querySelector('.inline-attachment');
		element.dataset.empty = isEmpty ? 'true' : 'false';
	};
	element.addEventListener('input', updatePlaceholder, { signal });
	element.addEventListener('paste', () => setTimeout(updatePlaceholder, 0), { signal });
	requestAnimationFrame(updatePlaceholder);
	return updatePlaceholder;
}

// ─── Model display helper ─────────────────────────────────────────────────────

function modelDisplayName(modelId) {
	return modelId
		.replace('llamacpp::', '')
		.replace('lmstudio::', '')
		.split('/')
		.pop()
		.replace(/-/g, ' ');
}

// ─── Model list population ────────────────────────────────────────────────────

export async function loadAndPopulateModels(root, signal) {
	try {
		const response = await getModels();
		const models   = response?.data || [];

		setModelMetadata(models);

		const modelDropdown = root.querySelector('[data-dropdown="model"]');
		const menu = modelDropdown?.querySelector('.chat-dropdown-menu');
		if (!menu) return;

		menu.innerHTML = '';
		for (const model of models) {
			if (!model.id) continue;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'chat-dropdown-item';
			btn.setAttribute('role', 'option');
			btn.setAttribute('aria-selected', 'false');
			btn.dataset.value = model.id;
			if (model.context_length) btn.dataset.contextLength = String(model.context_length);

			const isLlamaCpp = model.source === 'llamacpp' || model.id.startsWith('llamacpp::');
			const badge      = isLlamaCpp ? 'GGUF' : 'LM Studio';
			const displayName = modelDisplayName(model.id);

			btn.innerHTML = `<span class="chat-dropdown-item-label">${displayName}</span><span class="chat-dropdown-item-badge">${badge}</span>`;

			btn.addEventListener('click', () => {
				menu.querySelectorAll('.chat-dropdown-item').forEach(i => {
					i.classList.remove('selected');
					i.setAttribute('aria-selected', 'false');
				});
				btn.classList.add('selected');
				btn.setAttribute('aria-selected', 'true');
				const label = modelDropdown.querySelector('.chat-dropdown-label');
				if (label) label.textContent = displayName;
				modelDropdown.classList.remove('open');
				modelDropdown.querySelector('.chat-dropdown-toggle')?.setAttribute('aria-expanded', 'false');

				const chatId = getCurrentChatId();
				if (chatId) setChatModel(chatId, model.id);
				setLastSelectedModel(model.id);

				if (root._updateLiveContext) {
					root._updateLiveContext();
				} else {
					updateContextUI(root, chatId ? getChatById(chatId) : null);
				}
			});

			menu.appendChild(btn);
		}

		selectModelForCurrentChat(root);

		if (root._updateLiveContext) {
			root._updateLiveContext();
		} else {
			const chatId = getCurrentChatId();
			updateContextUI(root, chatId ? getChatById(chatId) : null);
		}

	} catch (err) {
		console.error('Failed to load models:', err);
		if (root._updateLiveContext) {
			root._updateLiveContext();
		} else {
			const chatId = getCurrentChatId();
			updateContextUI(root, chatId ? getChatById(chatId) : null);
		}
	}
}

// ─── applyModel ───────────────────────────────────────────────────────────────

export function applyModel(root, modelId) {
	if (!modelId) return false;
	const modelDropdown = root.querySelector('[data-dropdown="model"]');
	if (!modelDropdown) return false;

	const items = modelDropdown.querySelectorAll('.chat-dropdown-item');
	const label = modelDropdown.querySelector('.chat-dropdown-label');
	let matched = false;

	items.forEach((item) => {
		const isMatch = item.dataset.value === modelId;
		item.classList.toggle('selected', isMatch);
		item.setAttribute('aria-selected', String(isMatch));
		if (isMatch) {
			matched = true;
			if (label) label.textContent = modelDisplayName(modelId);
		}
	});

	return matched;
}

// ─── selectModelForCurrentChat ────────────────────────────────────────────────

export function selectModelForCurrentChat(root) {
	const chatId = getCurrentChatId();
	const chatModel = chatId ? getChatModel(chatId) : null;

	if (chatModel && applyModel(root, chatModel)) return;

	const settings = SettingsStore.get();
	if (chatModel && settings?.defaultModel) {
		applyModel(root, settings.defaultModel);
		return;
	}

	const lastModel = getLastSelectedModel();
	if (lastModel && applyModel(root, lastModel)) return;

	if (settings?.defaultModel) applyModel(root, settings.defaultModel);
}
