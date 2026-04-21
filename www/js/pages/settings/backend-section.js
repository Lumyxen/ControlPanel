const VALID_BACKENDS = ['auto', 'cpu', 'cuda', 'rocm', 'vulkan'];

export function mountBackendSection(root) {
	return {
		select(value) {
			const selectedValue = VALID_BACKENDS.includes(value) ? value : 'auto';
			root.querySelectorAll('input[name="llamacpp-backend"]').forEach((radio) => {
				const isSelected = radio.value === selectedValue;
				radio.checked = isSelected;
				const tile = radio.closest('.flavour-tile');
				if (tile) {
					tile.classList.toggle('selected', isSelected);
					tile.setAttribute('aria-checked', String(isSelected));
				}
			});
		},

		read() {
			return {
				backend: root.querySelector('input[name="llamacpp-backend"]:checked')?.value || 'auto',
				tag: root.querySelector('#llamacpp-tag-input')?.value?.trim() || 'b8846',
			};
		},

		dispose() {},
	};
}
