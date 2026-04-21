function read(storage, key) {
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function write(storage, key, value) {
	try {
		if (value == null) storage.removeItem(key);
		else storage.setItem(key, String(value));
		return true;
	} catch {
		return false;
	}
}

export function readLocal(key) {
	return read(localStorage, key);
}

export function writeLocal(key, value) {
	return write(localStorage, key, value);
}

export function readSession(key) {
	return read(sessionStorage, key);
}

export function writeSession(key, value) {
	return write(sessionStorage, key, value);
}

export function readJsonLocal(key, fallback = null) {
	const raw = readLocal(key);
	if (!raw) return fallback;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

export function writeJsonLocal(key, value) {
	try {
		return writeLocal(key, JSON.stringify(value));
	} catch {
		return false;
	}
}
