export function formatKeepAlive(value) {
	if (value === 0) return 'Immediate';
	if (value === 31) return 'Infinite';
	return `${value} min${value === 1 ? '' : 's'}`;
}

function setValue(root, selector, value) {
	const element = root.querySelector(selector);
	if (element && value != null) element.value = value;
}

function setPair(root, sliderSelector, inputSelector, value) {
	if (value == null) return;
	const slider = root.querySelector(sliderSelector);
	const input = root.querySelector(inputSelector);
	if (slider) slider.value = value;
	if (input) input.value = value;
}

export function mountLlamacppSection(root, backendSection) {
	return {
		populate(settings) {
			if (!settings) return;

			const flashAttn = root.querySelector('#llamacpp-flash-attn');
			if (flashAttn && settings.llamacppFlashAttn != null) {
				flashAttn.checked = Boolean(settings.llamacppFlashAttn);
			}

			const cacheReuse = root.querySelector('#llamacpp-kv-cache-reuse');
			if (cacheReuse && settings.llamacppKvCacheReuse != null) {
				cacheReuse.checked = Boolean(settings.llamacppKvCacheReuse);
			}

			setValue(root, '#llamacpp-eval-batch-size', settings.llamacppEvalBatchSize);
			setValue(root, '#llamacpp-ctx-size', settings.llamacppCtxSize);
			setValue(root, '#llamacpp-gpu-layers', settings.llamacppGpuLayers);
			setValue(root, '#llamacpp-threads', settings.llamacppThreads);
			setValue(root, '#llamacpp-threads-batch', settings.llamacppThreadsBatch);
			setValue(root, '#llamacpp-kv-cache-type', settings.llamacppKvCacheType);
			setValue(root, '#llamacpp-parallel-slots', settings.llamacppMaxConcurrentInstances);
			setValue(root, '#llamacpp-max-loaded-models', settings.llamacppMaxLoadedModels);

			const concurrentGeneration = root.querySelector('#llamacpp-concurrent-generation');
			if (concurrentGeneration) {
				concurrentGeneration.checked = Boolean(
					settings.llamacppConcurrentGeneration ?? settings.llamacppTitleModelConcurrent ?? true
				);
			}

			setPair(root, '#llamacpp-top-p-slider', '#llamacpp-top-p', settings.llamacppTopP);
			setPair(root, '#llamacpp-min-p-slider', '#llamacpp-min-p', settings.llamacppMinP);
			setPair(root, '#llamacpp-repeat-penalty-slider', '#llamacpp-repeat-penalty', settings.llamacppRepeatPenalty);

			if (settings.llamacppModelKeepAlive != null) {
				const slider = root.querySelector('#llamacpp-keep-alive-slider');
				const display = root.querySelector('#llamacpp-keep-alive-display');
				const value = settings.llamacppModelKeepAlive === -1 ? 31 : settings.llamacppModelKeepAlive;
				if (slider) slider.value = value;
				if (display) display.textContent = formatKeepAlive(value);
			}

			if (settings.llamacppBackend != null) backendSection?.select(settings.llamacppBackend);
			if (settings.llamacppTag != null) setValue(root, '#llamacpp-tag-input', settings.llamacppTag);
		},

		read() {
			const keepAliveValue = parseInt(root.querySelector('#llamacpp-keep-alive-slider')?.value ?? '5', 10);
			return {
				llamacppFlashAttn: root.querySelector('#llamacpp-flash-attn')?.checked ?? true,
				llamacppKvCacheReuse: root.querySelector('#llamacpp-kv-cache-reuse')?.checked ?? true,
				llamacppEvalBatchSize: parseInt(root.querySelector('#llamacpp-eval-batch-size')?.value ?? '2048', 10) || 2048,
				llamacppCtxSize: parseInt(root.querySelector('#llamacpp-ctx-size')?.value ?? '0', 10) || 0,
				llamacppGpuLayers: parseInt(root.querySelector('#llamacpp-gpu-layers')?.value ?? '0', 10) || 0,
				llamacppThreads: parseInt(root.querySelector('#llamacpp-threads')?.value ?? '0', 10) || 0,
				llamacppThreadsBatch: parseInt(root.querySelector('#llamacpp-threads-batch')?.value ?? '0', 10) || 0,
				llamacppMaxConcurrentInstances: parseInt(root.querySelector('#llamacpp-parallel-slots')?.value ?? '4', 10) || 4,
				llamacppMaxLoadedModels: Math.max(0, parseInt(root.querySelector('#llamacpp-max-loaded-models')?.value ?? '2', 10) || 0),
				llamacppKvCacheType: root.querySelector('#llamacpp-kv-cache-type')?.value ?? 'f16',
				llamacppConcurrentGeneration: root.querySelector('#llamacpp-concurrent-generation')?.checked ?? true,
				llamacppTopP: parseFloat(root.querySelector('#llamacpp-top-p')?.value ?? '0.9') || 0.9,
				llamacppMinP: parseFloat(root.querySelector('#llamacpp-min-p')?.value ?? '0.05') || 0.05,
				llamacppRepeatPenalty: parseFloat(root.querySelector('#llamacpp-repeat-penalty')?.value ?? '1.15') || 1.15,
				llamacppModelKeepAlive: keepAliveValue === 31 ? -1 : keepAliveValue,
			};
		},

		dispose() {},
	};
}
