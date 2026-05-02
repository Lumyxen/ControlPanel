(function () {
	'use strict';

	const api = globalThis.browser;
	const form = document.querySelector('#settings-form');
	const serverOrigin = document.querySelector('#server-origin');
	const status = document.querySelector('#status');
	const lockButton = document.querySelector('#lock-vault');

	function setStatus(message, tone = '') {
		status.textContent = message;
		status.style.color = tone === 'error'
			? '#b91c1c'
			: tone === 'success'
				? '#15803d'
				: '';
	}

	async function send(message) {
		const response = await api.runtime.sendMessage(message);
		if (!response?.ok) throw new Error(response?.error || 'Extension request failed');
		return response;
	}

	async function load() {
		try {
			const response = await send({ type: 'getSettings' });
			serverOrigin.value = response.settings.serverOrigin;
		} catch (error) {
			setStatus(error.message || 'Could not load settings', 'error');
		}
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		setStatus('Saving...');
		try {
			await send({
				type: 'setSettings',
				settings: {
					serverOrigin: serverOrigin.value,
				},
			});
			setStatus('Saved.', 'success');
		} catch (error) {
			setStatus(error.message || 'Could not save settings', 'error');
		}
	});

	lockButton.addEventListener('click', async () => {
		setStatus('Locking...');
		try {
			await send({ type: 'lock' });
			setStatus('Vault locked.', 'success');
		} catch (error) {
			setStatus(error.message || 'Could not lock vault', 'error');
		}
	});

	load();
}());
