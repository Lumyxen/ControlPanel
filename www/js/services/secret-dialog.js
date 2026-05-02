function fieldMarkup(field) {
	return `
		<label class="vault-dialog-field">
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
		overlay.className = 'vault-dialog-overlay';
		overlay.innerHTML = `
			<div class="vault-dialog card" role="dialog" aria-modal="true" aria-labelledby="vault-dialog-title">
				<h3 id="vault-dialog-title" class="card-title">${title}</h3>
				${description ? `<p class="vault-dialog-copy">${description}</p>` : ''}
				<form class="vault-dialog-form">
					<div class="vault-dialog-fields">${fields.map(fieldMarkup).join('')}</div>
					<div class="vault-dialog-actions">
						<button type="button" class="btn vault-dialog-cancel">Cancel</button>
						<button type="submit" class="btn btn-primary">${confirmLabel}</button>
					</div>
					<div class="vault-dialog-error" hidden></div>
				</form>
			</div>
		`;

		document.body.appendChild(overlay);
		const form = overlay.querySelector('form');
		const errorBox = overlay.querySelector('.vault-dialog-error');
		const cancelButton = overlay.querySelector('.vault-dialog-cancel');
		const firstInput = overlay.querySelector('input');

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
