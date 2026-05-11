import { getToolPacks, reloadToolPacks } from '../../core/http.js';

function setValue(root, selector, value) {
	const element = root.querySelector(selector);
	if (element && value != null) element.value = value;
}

function enhanceThemedSelect(select) {
	if (!select || select.dataset.themedSelect === 'true') return;
	select.dataset.themedSelect = 'true';
	select.classList.add('settings-native-select-hidden');

	const wrapper = document.createElement('div');
	wrapper.className = 'settings-themed-select';

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'settings-themed-select-button';
	button.setAttribute('aria-haspopup', 'listbox');
	button.setAttribute('aria-expanded', 'false');

	const label = document.createElement('span');
	label.className = 'settings-themed-select-label';
	const arrow = document.createElement('span');
	arrow.className = 'settings-themed-select-arrow';
	arrow.setAttribute('aria-hidden', 'true');
	button.append(label, arrow);

	const menu = document.createElement('div');
	menu.className = 'settings-themed-select-menu';
	menu.setAttribute('role', 'listbox');
	menu.hidden = true;

	const close = () => {
		menu.hidden = true;
		button.setAttribute('aria-expanded', 'false');
	};

	const refresh = () => {
		const selected = [...select.options].find((option) => option.value === select.value) || select.options[0];
		label.textContent = selected?.textContent || '';
		menu.querySelectorAll('.settings-themed-select-option').forEach((optionButton) => {
			const selectedOption = optionButton.dataset.value === select.value;
			optionButton.classList.toggle('selected', selectedOption);
			optionButton.setAttribute('aria-selected', String(selectedOption));
		});
	};

	for (const option of select.options) {
		const optionButton = document.createElement('button');
		optionButton.type = 'button';
		optionButton.className = 'settings-themed-select-option';
		optionButton.dataset.value = option.value;
		optionButton.textContent = option.textContent;
		optionButton.setAttribute('role', 'option');
		optionButton.addEventListener('click', () => {
			select.value = option.value;
			select.dispatchEvent(new Event('change', { bubbles: true }));
			refresh();
			close();
			button.focus();
		});
		menu.appendChild(optionButton);
	}

	button.addEventListener('click', (event) => {
		event.stopPropagation();
		const opening = menu.hidden;
		document.querySelectorAll('.settings-themed-select-menu').forEach((openMenu) => {
			if (openMenu !== menu) openMenu.hidden = true;
		});
		menu.hidden = !opening;
		button.setAttribute('aria-expanded', String(opening));
		if (opening) {
			menu.querySelector('.settings-themed-select-option.selected')?.focus();
		}
	});

	button.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
		if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			menu.hidden = false;
			button.setAttribute('aria-expanded', 'true');
			menu.querySelector('.settings-themed-select-option.selected, .settings-themed-select-option')?.focus();
		}
	});

	menu.addEventListener('keydown', (event) => {
		const options = [...menu.querySelectorAll('.settings-themed-select-option')];
		const index = options.indexOf(document.activeElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			button.focus();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
			options[(next + options.length) % options.length]?.focus();
		}
	});

	select.addEventListener('change', refresh);
	select.insertAdjacentElement('afterend', wrapper);
	wrapper.append(button, menu);
	select._ctrlpanelThemedSelectRefresh = refresh;
	refresh();
}

document.addEventListener('click', () => {
	document.querySelectorAll('.settings-themed-select-menu').forEach((menu) => {
		menu.hidden = true;
		menu.closest('.settings-themed-select')?.querySelector('.settings-themed-select-button')?.setAttribute('aria-expanded', 'false');
	});
});

function buildChip(text) {
	const chip = document.createElement('span');
	chip.className = 'settings-inline-chip';
	chip.textContent = text;
	return chip;
}

function renderPackList(container, packs) {
	container.innerHTML = '';

	if (!Array.isArray(packs) || packs.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'settings-placeholder';
		empty.textContent = 'No tool packs discovered.';
		container.appendChild(empty);
		return;
	}

	for (const pack of packs) {
		const card = document.createElement('div');
		card.className = 'settings-tool-pack';

		const head = document.createElement('div');
		head.className = 'settings-tool-pack-head';

		const titleWrap = document.createElement('div');
		titleWrap.className = 'settings-tool-pack-copy';
		const title = document.createElement('div');
		title.className = 'settings-tool-pack-title';
		title.textContent = pack.title || pack.id || 'Tool Pack';
		const description = document.createElement('div');
		description.className = 'settings-tool-pack-description';
		description.textContent = pack.description || '';
		titleWrap.append(title, description);

		const chipRow = document.createElement('div');
		chipRow.className = 'settings-tool-pack-chips';
		chipRow.append(
			buildChip(pack.sourceType || 'system'),
			buildChip(`${pack.toolCount || 0} tool${Number(pack.toolCount || 0) === 1 ? '' : 's'}`),
			buildChip(pack.defaultEnabled ? 'default enabled' : 'opt-in')
		);
		if (Array.isArray(pack.executors)) {
			for (const executor of pack.executors) {
				chipRow.appendChild(buildChip(executor));
			}
		}

		head.append(titleWrap, chipRow);
		card.appendChild(head);

		if (pack.health) {
			const health = document.createElement('div');
			health.className = 'settings-tool-pack-health';
			if (pack.health.sandbox) {
				health.textContent = pack.health.sandbox.available
					? 'Sandbox executor available'
					: `Sandbox unavailable: ${pack.health.sandbox.reason || 'bubblewrap not found'}`;
			} else {
				health.textContent = pack.health.available === false
					? 'Some executors unavailable'
					: 'Executors ready';
			}
			card.appendChild(health);
		}

		container.appendChild(card);
	}
}

export function mountToolsSection(root) {
	const listEl = root.querySelector('#tool-packs-list');
	const reloadBtn = root.querySelector('#reload-tool-packs');
	const statusEl = root.querySelector('#tool-packs-status');
	const sandboxEl = root.querySelector('#tool-sandbox-health');
	const defaultWorkingDirectoryInput = root.querySelector('#ai-tools-working-directory-input');
	const weatherLocationInput = root.querySelector('#weather-location-input');
	const weatherMeasurementSystemSelect = root.querySelector('#weather-measurement-system');
	const weatherCustomUnits = root.querySelector('#weather-custom-units');
	const weatherUnitTemperature = root.querySelector('#weather-unit-temperature');
	const weatherUnitWindSpeed = root.querySelector('#weather-unit-wind-speed');
	const weatherUnitPrecipitation = root.querySelector('#weather-unit-precipitation');

	[
		weatherMeasurementSystemSelect,
		weatherUnitTemperature,
		weatherUnitWindSpeed,
		weatherUnitPrecipitation,
	].forEach(enhanceThemedSelect);

	const renderWeatherCustomUnits = () => {
		if (weatherCustomUnits) {
			weatherCustomUnits.hidden = weatherMeasurementSystemSelect?.value !== 'custom';
		}
	};

	weatherMeasurementSystemSelect?.addEventListener('change', renderWeatherCustomUnits);

	const render = async (reload = false) => {
		if (!listEl) return;
		if (statusEl) statusEl.textContent = reload ? 'Reloading…' : 'Loading…';
		try {
			const data = reload ? await reloadToolPacks() : await getToolPacks();
			renderPackList(listEl, data?.packs || []);
			if (sandboxEl) {
				const sandbox = data?.sandbox || {};
				sandboxEl.textContent = sandbox.available
					? `Sandbox: available (${sandbox.binary || 'bwrap'})`
					: `Sandbox: unavailable${sandbox.reason ? ` — ${sandbox.reason}` : ''}`;
			}
			if (statusEl) {
				statusEl.textContent = reload ? 'Reloaded.' : '';
				if (reload) {
					setTimeout(() => {
						if (statusEl.textContent === 'Reloaded.') statusEl.textContent = '';
					}, 2500);
				}
			}
		} catch (err) {
			if (statusEl) statusEl.textContent = `Error: ${err.message}`;
			if (sandboxEl) sandboxEl.textContent = 'Sandbox: unavailable';
			if (listEl) {
				listEl.innerHTML = '';
				const error = document.createElement('div');
				error.className = 'settings-placeholder';
				error.textContent = 'Could not load tool pack state.';
				listEl.appendChild(error);
			}
		}
	};

	reloadBtn?.addEventListener('click', () => {
		reloadBtn.disabled = true;
		render(true).finally(() => {
			reloadBtn.disabled = false;
		});
	});

	render(false);

	return {
		populate(settings) {
			if (!settings) return;
			setValue(root, '#ai-tools-working-directory-input', settings.aiToolsDefaultWorkingDirectory);
			setValue(root, '#weather-location-input', settings.weatherLocation || '');
			setValue(root, '#weather-measurement-system', settings.weatherMeasurementSystem || 'metric');
			setValue(root, '#weather-unit-temperature', settings.weatherCustomUnits?.temperature || 'celsius');
			setValue(root, '#weather-unit-wind-speed', settings.weatherCustomUnits?.windSpeed || 'kmh');
			setValue(root, '#weather-unit-precipitation', settings.weatherCustomUnits?.precipitation || 'mm');
			[
				weatherMeasurementSystemSelect,
				weatherUnitTemperature,
				weatherUnitWindSpeed,
				weatherUnitPrecipitation,
			].forEach((select) => select?._ctrlpanelThemedSelectRefresh?.());
			renderWeatherCustomUnits();
		},
		read() {
			return {
				aiToolsDefaultWorkingDirectory: defaultWorkingDirectoryInput?.value?.trim() ?? '',
				weatherLocation: weatherLocationInput?.value?.trim() ?? '',
				weatherMeasurementSystem: weatherMeasurementSystemSelect?.value || 'metric',
				weatherCustomUnits: {
					temperature: weatherUnitTemperature?.value || 'celsius',
					windSpeed: weatherUnitWindSpeed?.value || 'kmh',
					precipitation: weatherUnitPrecipitation?.value || 'mm',
				},
			};
		},
		refresh: () => render(false),
	};
}
