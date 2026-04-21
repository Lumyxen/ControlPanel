function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function placeholder(text) {
	return `<div class="settings-placeholder">${escapeHtml(text)}</div>`;
}

function downloadButton(modelId) {
	return `<button type="button" class="btn settings-compact-button" data-hf-download="${escapeHtml(modelId)}">Download</button>`;
}

function initModelManager(root) {
	const searchInput = root.querySelector('#hf-search-input');
	const searchBtn = root.querySelector('#hf-search-btn');
	const statusDiv = root.querySelector('#hf-search-status');
	const resultsList = root.querySelector('#hf-results-list');
	const sortSelect = root.querySelector('#hf-sort-select');
	const filterImage = root.querySelector('#hf-filter-image');
	const filterAudio = root.querySelector('#hf-filter-audio');
	const localList = root.querySelector('#hf-local-models-list');

	if (!searchInput || !searchBtn || !statusDiv || !resultsList || !sortSelect || !filterImage || !filterAudio || !localList) {
		return () => {};
	}

	function showStatus(message, type = 'info') {
		const classes = ['badge', 'settings-status-badge'];
		if (type === 'success') classes.push('badge-success');
		if (type === 'error') classes.push('badge-error');
		statusDiv.innerHTML = `<span class="${classes.join(' ')}">${escapeHtml(message)}</span>`;
	}

	function renderSearchPlaceholder(message) {
		resultsList.innerHTML = placeholder(message);
	}

	function renderLocalPlaceholder(message) {
		localList.innerHTML = placeholder(message);
	}

	function renderSearchBadges(model) {
		const badges = [];
		const hasVision = model.has_image_support || (model.tags && (model.tags.includes('vision') || model.tags.includes('llava')));
		const hasAudio = model.has_audio_support;
		if (hasVision) badges.push('<span class="badge settings-badge-vision">Vision</span>');
		if (hasAudio) badges.push('<span class="badge settings-badge-audio">Audio</span>');
		badges.push('<span class="badge">GGUF</span>');
		return badges.join(' ');
	}

	function renderResults(models) {
		resultsList.innerHTML = '';
		models.forEach((model) => {
			const card = document.createElement('div');
			card.className = 'settings-model-card';
			card.innerHTML = `
				<div class="settings-model-head">
					<div class="settings-model-body">
						<div class="settings-model-title">${escapeHtml(model.name)}</div>
						<div class="settings-badge-row">${renderSearchBadges(model)}</div>
						<div class="settings-model-stats">
							<span>${(model.downloads || 0).toLocaleString()} downloads</span>
							<span>${(model.likes || 0).toLocaleString()} likes</span>
							${model.pipeline_tag ? `<span>${escapeHtml(model.pipeline_tag)}</span>` : ''}
						</div>
					</div>
					<div id="dl-area-${model.id.replace(/[^a-zA-Z0-9]/g, '_')}" class="settings-download-area">
						${downloadButton(model.id)}
					</div>
				</div>
			`;
			resultsList.appendChild(card);
		});
	}

	async function searchModels() {
		const query = searchInput.value.trim();
		if (!query) {
			showStatus('Enter a search query', 'warning');
			return;
		}

		showStatus('Searching…');
		renderSearchPlaceholder('Searching…');

		try {
			const params = new URLSearchParams({ search: query, limit: '20', sort: sortSelect.value });
			if (filterImage.checked) params.append('image_support', '1');
			if (filterAudio.checked) params.append('audio_support', '1');

			const response = await fetch(`/api/huggingface/search?${params.toString()}`);
			const data = await response.json();

			if (data.error) {
				showStatus(`Error: ${data.error}`, 'error');
				resultsList.innerHTML = '';
				return;
			}

			if (!data.data || data.data.length === 0) {
				showStatus('No models found', 'warning');
				resultsList.innerHTML = '';
				return;
			}

			showStatus(`Found ${data.total} model(s)`, 'success');
			renderResults(data.data);
		} catch (error) {
			showStatus(`Search failed: ${error.message}`, 'error');
			resultsList.innerHTML = '';
		}
	}

	async function showQuantPicker(modelId, button) {
		const originalText = button.textContent;
		button.textContent = 'Loading…';
		button.disabled = true;

		try {
			const response = await fetch(`/api/huggingface/files?model_id=${encodeURIComponent(modelId)}`);
			const data = await response.json();

			if (data.error || !data.gguf || !data.gguf.length) {
				showStatus('No GGUF files found', 'warning');
				button.textContent = originalText;
				button.disabled = false;
				return;
			}

			const area = button.parentElement;
			area.innerHTML = '';

			const wrapper = document.createElement('div');
			wrapper.className = 'settings-inline-controls';

			const select = document.createElement('select');
			select.className = 'text-input settings-compact-select';

			const order = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q5_K_S', 'Q4_0', 'Q3_K_M', 'Q6_K', 'Q8_0', 'IQ4_XS', 'IQ4_NL', 'Q2_K', 'IQ3_M', 'IQ3_S'];
			const sorted = data.gguf.slice().sort((left, right) => {
				let leftIndex = -1;
				let rightIndex = -1;
				for (let index = 0; index < order.length; index += 1) {
					if (left.name.includes(order[index])) leftIndex = index;
					if (right.name.includes(order[index])) rightIndex = index;
				}
				return (leftIndex >= 0 ? leftIndex : 999) - (rightIndex >= 0 ? rightIndex : 999);
			});

			sorted.forEach((file, index) => {
				const option = document.createElement('option');
				option.value = file.path;
				option.textContent = file.name;
				if (index === 0) option.selected = true;
				select.appendChild(option);
			});

			const downloadBtn = document.createElement('button');
			downloadBtn.type = 'button';
			downloadBtn.className = 'btn settings-compact-button';
			downloadBtn.textContent = 'Download';

			const cancelBtn = document.createElement('button');
			cancelBtn.type = 'button';
			cancelBtn.className = 'btn settings-compact-button';
			cancelBtn.textContent = 'Cancel';
			cancelBtn.addEventListener('click', () => {
				area.innerHTML = downloadButton(modelId);
			});

			downloadBtn.addEventListener('click', () => {
				const filePath = select.value;
				const slashPos = modelId.indexOf('/');
				const provider = slashPos >= 0 ? modelId.substring(0, slashPos) : 'unknown';
				let modelName = slashPos >= 0 ? modelId.substring(slashPos + 1) : modelId;
				const ggufName = filePath.split('/').pop();
				const quants = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q5_K_S', 'Q4_0', 'Q3_K_M', 'Q6_K', 'Q8_0', 'IQ4_XS', 'IQ4_NL', 'IQ3_M', 'IQ3_S', 'Q2_K', 'IQ2_M', 'IQ2_XS', 'IQ2_S', 'Q4_AWQ', 'FP16', 'FP32'];

				for (const quant of quants) {
					if (ggufName.includes(quant)) {
						modelName += `-${quant}`;
						break;
					}
				}

				const directoryName = `${provider}/${modelName}`;
				const mmprojPath = data.mmproj?.[0]?.path || '';
				const tokenizerPath = data.tokenizer?.[0]?.path || '';

				area.innerHTML = '';
				startDownload(modelId, directoryName, filePath, mmprojPath, tokenizerPath, area);
			});

			wrapper.append(select, downloadBtn, cancelBtn);
			area.appendChild(wrapper);
		} catch (error) {
			showStatus(`Failed to list files: ${error.message}`, 'error');
			button.textContent = originalText;
			button.disabled = false;
		}
	}

	function startDownload(modelId, directoryName, ggufPath, mmprojPath, tokenizerPath, area) {
		showStatus(`Starting download of ${modelId}…`);

		fetch('/api/huggingface/download', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model_id: modelId,
				directory_name: directoryName,
				gguf_path: ggufPath,
				mmproj_path: mmprojPath,
				tokenizer_path: tokenizerPath,
			}),
		})
			.then((response) => response.json())
			.then((result) => {
				if (result.status !== 'started') {
					showStatus(`Download failed: ${result.error || 'Unknown error'}`, 'error');
					area.innerHTML = downloadButton(modelId);
					return;
				}

				const jobId = result.job_id;
				const statusEl = document.createElement('span');
				statusEl.className = 'settings-inline-status';
				statusEl.textContent = '0%';
				area.appendChild(statusEl);

				const cancelBtn = document.createElement('button');
				cancelBtn.type = 'button';
				cancelBtn.className = 'btn settings-compact-button';
				cancelBtn.textContent = 'Cancel';
				cancelBtn.addEventListener('click', () => {
					fetch('/api/huggingface/cancel-download', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ job_id: jobId }),
					});
				});
				area.appendChild(cancelBtn);

				const pollTimer = setInterval(() => {
					fetch(`/api/huggingface/download-status?job_id=${encodeURIComponent(jobId)}`)
						.then((response) => response.json())
						.then((status) => {
							if (status.status === 'completed') {
								clearInterval(pollTimer);
								showStatus(`Downloaded → ${status.directory_name}`, 'success');
								area.innerHTML = downloadButton(modelId);
								loadLocalModels();
							} else if (status.status === 'failed') {
								clearInterval(pollTimer);
								showStatus(`Download failed: ${status.error || 'Unknown error'}`, 'error');
								area.innerHTML = downloadButton(modelId);
							} else {
								const percent = Math.round(status.percent || 0);
								statusEl.textContent = `${status.current_file ? `${status.current_file} ` : ''}${percent}%`;
							}
						})
						.catch(() => {});
				}, 500);
			})
			.catch((error) => {
				showStatus(`Download failed: ${error.message}`, 'error');
				area.innerHTML = downloadButton(modelId);
			});
	}

	async function deleteModel(modelId, button) {
		if (!confirm(`Delete "${modelId}"?\nThis will permanently remove the model files.`)) return;

		const originalText = button.textContent;
		button.textContent = 'Deleting…';
		button.disabled = true;

		try {
			const response = await fetch('/api/models', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model_id: modelId }),
			});
			const result = await response.json();

			if (result.status === 'deleted') {
				showStatus(`Deleted ${modelId}`, 'success');
				loadLocalModels();
			} else if (result.status === 'not_found') {
				showStatus('Model not found', 'warning');
				loadLocalModels();
			} else {
				showStatus(`Delete failed: ${result.error || 'Unknown error'}`, 'error');
				button.textContent = originalText;
				button.disabled = false;
			}
		} catch (error) {
			showStatus(`Delete failed: ${error.message}`, 'error');
			button.textContent = originalText;
			button.disabled = false;
		}
	}

	async function installTokenizer(modelId, button) {
		const directoryName = modelId.startsWith('llamacpp::') ? modelId.substring(10) : '';
		const originalText = button.textContent;
		button.textContent = 'Installing…';
		button.disabled = true;
		showStatus(`Installing tokenizer for ${modelId}…`);

		try {
			const response = await fetch('/api/huggingface/install-tokenizer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model_id: modelId, directory_name: directoryName }),
			});
			const result = await response.json();

			if (result.status === 'installed') {
				showStatus(`Tokenizer installed (${result.files_downloaded} file(s))`, 'success');
				loadLocalModels();
			} else {
				showStatus(`Tokenizer install failed: ${result.error || 'Unknown error'}`, 'error');
				button.textContent = originalText;
				button.disabled = false;
			}
		} catch (error) {
			showStatus(`Tokenizer install failed: ${error.message}`, 'error');
			button.textContent = originalText;
			button.disabled = false;
		}
	}

	async function loadLocalModels() {
		try {
			const response = await fetch('/api/models');
			const data = await response.json();
			const localModels = (data.data || []).filter((model) => model.source === 'llamacpp');

			if (!localModels.length) {
				renderLocalPlaceholder('No local models');
				return;
			}

			localList.innerHTML = '';
			localModels.forEach((model) => {
				const badges = [];
				if (model.has_tokenizer) badges.push('<span class="badge settings-badge-tokenizer">Tokenizer</span>');
				if (model.has_mmproj) badges.push('<span class="badge settings-badge-mmproj">Vision</span>');
				if (model.loaded) badges.push('<span class="badge badge-success">Loaded</span>');

				const actionButtons = [];
				if (!model.has_tokenizer) {
					actionButtons.push(`<button type="button" class="btn settings-compact-button" data-install-tokenizer="${escapeHtml(model.id)}">Install Tokenizer</button>`);
				}
				actionButtons.push(`<button type="button" class="btn btn-danger-sm settings-compact-button" data-delete-model="${escapeHtml(model.id)}">Delete</button>`);

				const card = document.createElement('div');
				card.className = 'settings-model-card';
				card.innerHTML = `
					<div class="settings-model-head">
						<div class="settings-model-body">
							<div class="settings-model-title">${escapeHtml(model.name)}</div>
							<div class="settings-badge-row">${badges.join(' ')}</div>
							<div class="settings-model-meta">Context: ${((model.context_length || 'N/A')).toLocaleString?.() || model.context_length || 'N/A'} tokens</div>
						</div>
						<div class="settings-model-actions">
							<span class="badge settings-model-id">${escapeHtml(model.id)}</span>
							${actionButtons.join('')}
						</div>
					</div>
				`;
				localList.appendChild(card);
			});
		} catch {
			renderLocalPlaceholder('Failed to load');
		}
	}

	const handleResultsClick = (event) => {
		const button = event.target.closest('[data-hf-download]');
		if (!button) return;
		showQuantPicker(button.dataset.hfDownload, button);
	};

	const handleLocalListClick = (event) => {
		const deleteBtn = event.target.closest('[data-delete-model]');
		if (deleteBtn) {
			deleteModel(deleteBtn.dataset.deleteModel, deleteBtn);
			return;
		}

		const tokenizerBtn = event.target.closest('[data-install-tokenizer]');
		if (tokenizerBtn) {
			installTokenizer(tokenizerBtn.dataset.installTokenizer, tokenizerBtn);
		}
	};

	const handleSearchKeyPress = (event) => {
		if (event.key === 'Enter') searchModels();
	};

	searchBtn.addEventListener('click', searchModels);
	searchInput.addEventListener('keypress', handleSearchKeyPress);
	resultsList.addEventListener('click', handleResultsClick);
	localList.addEventListener('click', handleLocalListClick);

	loadLocalModels();

	return () => {
		searchBtn.removeEventListener('click', searchModels);
		searchInput.removeEventListener('keypress', handleSearchKeyPress);
		resultsList.removeEventListener('click', handleResultsClick);
		localList.removeEventListener('click', handleLocalListClick);
	};
}

export function mountModelManager(root) {
	return initModelManager(root);
}
