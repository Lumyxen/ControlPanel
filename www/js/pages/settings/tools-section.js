import { getToolPacks, reloadToolPacks } from '../../core/http.js';

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
		refresh: () => render(false),
	};
}
