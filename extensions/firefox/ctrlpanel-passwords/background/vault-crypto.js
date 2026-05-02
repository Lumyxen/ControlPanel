(function () {
	'use strict';

	const VAULT_KDF_ITERATIONS = 600000;
	const PIN_AUTH_ITERATIONS = 310000;
	const PIN_WRAP_ITERATIONS = 310000;
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();

	function bytesToHex(bytes) {
		return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
	}

	function hexToBytes(hex) {
		if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0) {
			throw new Error('Invalid hex value');
		}
		const bytes = new Uint8Array(hex.length / 2);
		for (let i = 0; i < hex.length; i += 2) {
			bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
		}
		return bytes;
	}

	function bytesToBase64(bytes) {
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}

	function base64ToBytes(base64) {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function randomBytes(length) {
		return crypto.getRandomValues(new Uint8Array(length));
	}

	async function deriveBytes(secret, saltHex, iterations, length) {
		const material = await crypto.subtle.importKey(
			'raw',
			textEncoder.encode(secret),
			'PBKDF2',
			false,
			['deriveBits'],
		);
		const bits = await crypto.subtle.deriveBits(
			{
				name: 'PBKDF2',
				hash: 'SHA-256',
				salt: hexToBytes(saltHex),
				iterations,
			},
			material,
			length * 8,
		);
		return new Uint8Array(bits);
	}

	async function importAesKey(keyHex, usage) {
		return crypto.subtle.importKey('raw', hexToBytes(keyHex), 'AES-GCM', false, usage);
	}

	async function decryptJsonWithKey(blob, keyHex) {
		const key = await importAesKey(keyHex, ['decrypt']);
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: base64ToBytes(blob.iv),
			},
			key,
			base64ToBytes(blob.ct),
		);
		return JSON.parse(textDecoder.decode(plaintext));
	}

	async function encryptJsonWithKey(value, keyHex) {
		const iv = randomBytes(12);
		const key = await importAesKey(keyHex, ['encrypt']);
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				key,
				textEncoder.encode(JSON.stringify(value)),
			),
		);
		return {
			iv: bytesToBase64(iv),
			ct: bytesToBase64(ciphertext),
		};
	}

	async function computeHmacHex(keyHex, message) {
		const key = await crypto.subtle.importKey(
			'raw',
			hexToBytes(keyHex),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
		return bytesToHex(new Uint8Array(signature));
	}

	function randomHex(length) {
		return bytesToHex(randomBytes(length));
	}

	async function deriveVaultMaterial(password, kdf = {}) {
		const salt = kdf.salt || randomHex(32);
		const iterations = Number.parseInt(kdf.iterations ?? VAULT_KDF_ITERATIONS, 10) || VAULT_KDF_ITERATIONS;
		const bytes = await deriveBytes(password, salt, iterations, 64);
		const vaultEncKey = bytesToHex(bytes.slice(0, 32));
		const vaultAuthKey = bytesToHex(bytes.slice(32));
		return {
			kdf: {
				type: 'pbkdf2',
				hash: 'sha256',
				iterations,
				salt,
			},
			vaultEncKey,
			vaultAuthKey,
		};
	}

	async function decryptVaultData(blob, vaultEncKey) {
		if (!blob || typeof blob !== 'object') {
			throw new Error('Missing vault blob');
		}
		return decryptJsonWithKey(blob, vaultEncKey);
	}

	function createPinAuthKdf() {
		return {
			type: 'pbkdf2',
			hash: 'sha256',
			iterations: PIN_AUTH_ITERATIONS,
			salt: randomHex(16),
		};
	}

	async function derivePinAuthKey(pin, pinAuthKdf) {
		const iterations = Number.parseInt(pinAuthKdf.iterations ?? PIN_AUTH_ITERATIONS, 10) || PIN_AUTH_ITERATIONS;
		const bytes = await deriveBytes(pin, pinAuthKdf.salt, iterations, 32);
		return bytesToHex(bytes);
	}

	async function createPinLocalRecord({ deviceId, pin, pepper, vaultEncKey, vaultAuthKey }) {
		const wrapSalt = randomHex(16);
		const wrapKeyBytes = await deriveBytes(`${pin}:${pepper}`, wrapSalt, PIN_WRAP_ITERATIONS, 32);
		const wrapKey = bytesToHex(wrapKeyBytes);
		const wrapped = await encryptJsonWithKey({ vaultEncKey, vaultAuthKey }, wrapKey);
		return {
			version: 1,
			deviceId,
			wrap: {
				type: 'pbkdf2',
				hash: 'sha256',
				iterations: PIN_WRAP_ITERATIONS,
				salt: wrapSalt,
			},
			payload: wrapped,
			createdAt: Date.now(),
		};
	}

	async function unwrapPinLocalRecord(record, pin, pepper) {
		if (!record?.wrap?.salt || !record?.payload) {
			throw new Error('PIN unlock record is missing required fields');
		}
		const wrapKeyBytes = await deriveBytes(
			`${pin}:${pepper}`,
			record.wrap.salt,
			Number.parseInt(record.wrap.iterations ?? PIN_WRAP_ITERATIONS, 10) || PIN_WRAP_ITERATIONS,
			32,
		);
		const payload = await decryptJsonWithKey(record.payload, bytesToHex(wrapKeyBytes));
		return {
			vaultEncKey: payload.vaultEncKey,
			vaultAuthKey: payload.vaultAuthKey,
		};
	}

	globalThis.CtrlPanelVaultCrypto = {
		createMasterProof: (vaultAuthKey, challenge) => computeHmacHex(vaultAuthKey, `vault:master:${challenge}`),
		createPinProof: (pinAuthKey, challenge) => computeHmacHex(pinAuthKey, `vault:pin:${challenge}`),
		createPinAuthKdf,
		createPinLocalRecord,
		decryptVaultData,
		derivePinAuthKey,
		deriveVaultMaterial,
		unwrapPinLocalRecord,
	};
}());
