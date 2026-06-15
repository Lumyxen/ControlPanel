function fieldMarkup(field) {
	return `
		<label class="secret-dialog-field">
			<span>${field.label}</span>
			<input
				class="text-input"
				name="${field.id}"
				type="${field.type || 'password'}"
				autocomplete="${field.autocomplete || 'off'}"
				placeholder="${field.placeholder || ''}"
				${field.required === false ? '' : 'required'}
			/>
		</label>
	`;
}

export function requestSecretDialog({
	title,
	description = '',
	confirmLabel = 'Confirm',
	fields = [],
}) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `
			<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="secret-dialog-title">
				<h3 id="secret-dialog-title" class="modal-title">${title}</h3>
				${description ? `<p class="modal-message">${description}</p>` : ''}
				<form class="secret-dialog-form">
					<div class="secret-dialog-fields">${fields.map(fieldMarkup).join('')}</div>
					<div class="modal-actions">
						<button type="button" class="btn secret-dialog-cancel">Cancel</button>
						<button type="submit" class="btn btn-primary">${confirmLabel}</button>
					</div>
					<div class="secret-dialog-error" hidden></div>
				</form>
			</div>
		`;

		document.body.appendChild(overlay);
		const form = overlay.querySelector('form');
		const errorBox = overlay.querySelector('.secret-dialog-error');
		const cancelButton = overlay.querySelector('.secret-dialog-cancel');
		const firstInput = overlay.querySelector('input');
		requestAnimationFrame(() => overlay.classList.add('visible'));

		const close = (value) => {
			overlay.remove();
			resolve(value);
		};

		cancelButton?.addEventListener('click', () => close(null));
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) close(null);
		});

		form?.addEventListener('submit', (event) => {
			event.preventDefault();
			const values = Object.fromEntries(new FormData(form).entries());
			const mismatchedField = fields.find((field) => field.matches && values[field.id] !== values[field.matches]);
			if (mismatchedField) {
				errorBox.textContent = mismatchedField.mismatchMessage || 'Values do not match.';
				errorBox.hidden = false;
				return;
			}
			errorBox.hidden = true;
			close(values);
		});

		firstInput?.focus({ preventScroll: true });
	});
}
