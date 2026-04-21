function setValue(root, selector, value) {
	const element = root.querySelector(selector);
	if (element && value != null) element.value = value;
}

function setToggle(root, selector, value) {
	const element = root.querySelector(selector);
	if (element && value != null) element.checked = Boolean(value);
}

export function mountAiSection(root) {
	return {
		populate(settings) {
			if (!settings) return;
			setValue(root, '#default-model-input', settings.defaultModel);
			setValue(root, '#max-tokens-input', settings.fallbackMaxOutputTokens);
			setValue(root, '#system-prompt-input', settings.systemPrompt);
			setValue(root, '#lmstudio-url-input', settings.lmStudioUrl);

			if (settings.temperature != null) {
				const value = parseFloat(settings.temperature) || 0.7;
				const slider = root.querySelector('#temperature-slider');
				const input = root.querySelector('#temperature-input');
				if (slider) slider.value = value;
				if (input) input.value = value;
			}

			setToggle(root, '#logprob-highlight-high', settings.logprobHighlightHigh);
			setToggle(root, '#logprob-highlight-medium', settings.logprobHighlightMedium);
			setToggle(root, '#logprob-highlight-low', settings.logprobHighlightLow);
			setToggle(root, '#logprob-history-high', settings.logprobHistoryHigh);
			setToggle(root, '#logprob-history-medium', settings.logprobHistoryMedium);
			setToggle(root, '#logprob-history-low', settings.logprobHistoryLow);
			setToggle(root, '#ai-title-enabled', settings.aiTitleEnabled !== false);
			setValue(root, '#ai-title-model-input', settings.aiTitleModel || '');
			setValue(root, '#ai-title-system-prompt-input', settings.aiTitleSystemPrompt || '');
		},

		read() {
			const slider = root.querySelector('#temperature-slider');
			const input = root.querySelector('#temperature-input');
			return {
				systemPrompt: root.querySelector('#system-prompt-input')?.value ?? '',
				defaultModel: root.querySelector('#default-model-input')?.value?.trim() ?? '',
				temperature: parseFloat(input?.value ?? slider?.value ?? '0.7') || 0.7,
				fallbackMaxOutputTokens: parseInt(root.querySelector('#max-tokens-input')?.value ?? '8192', 10) || 8192,
				lmStudioUrl: root.querySelector('#lmstudio-url-input')?.value?.trim() || 'http://localhost:1234',
				logprobHighlightHigh: root.querySelector('#logprob-highlight-high')?.checked ?? false,
				logprobHighlightMedium: root.querySelector('#logprob-highlight-medium')?.checked ?? false,
				logprobHighlightLow: root.querySelector('#logprob-highlight-low')?.checked ?? true,
				logprobHistoryHigh: root.querySelector('#logprob-history-high')?.checked ?? false,
				logprobHistoryMedium: root.querySelector('#logprob-history-medium')?.checked ?? false,
				logprobHistoryLow: root.querySelector('#logprob-history-low')?.checked ?? false,
				aiTitleEnabled: root.querySelector('#ai-title-enabled')?.checked ?? true,
				aiTitleModel: root.querySelector('#ai-title-model-input')?.value?.trim() ?? '',
				aiTitleSystemPrompt: root.querySelector('#ai-title-system-prompt-input')?.value ?? '',
			};
		},

		dispose() {},
	};
}
