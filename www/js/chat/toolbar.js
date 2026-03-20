// www/js/chat/toolbar.js
// UI setup for chat toolbar controls: dropdowns, model selector, tools toggle, file upload.

import { getModels } from '../api.js';
import { setModelMetadata, getModelContextLimitFromUI, updateContextUI } from './context.js';
import { getChatModel, getCurrentChatId, getChatById, setChatModel, setLastSelectedModel, getLastSelectedModel } from './store.js';
import * as SettingsStore from '../settings-store.js';

export const TOOLS_KEY = 'ctrlpanel:toolsEnabled';

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
	const checkboxes = [...toolsDropdown.querySelectorAll('input[type="checkbox"][name="tool"]')];
	const enabled = new Set(JSON.parse(localStorage.getItem(TOOLS_KEY) || '[]'));
	checkboxes.forEach(cb => { cb.checked = enabled.has(cb.value); });

	const update = () => {
		const enabledValues = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
		toolsDropdown.classList.toggle('has-enabled-tools', enabledValues.length > 0);
		localStorage.setItem(TOOLS_KEY, JSON.stringify(enabledValues));
	};
	checkboxes.forEach(cb => cb.addEventListener('change', update, { signal }));
	update();
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
		const isEmpty = (element.textContent || '').trim().length === 0 &&
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
