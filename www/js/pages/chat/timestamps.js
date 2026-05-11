const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeTimestamp(value) {
	const timestamp = Number(value);
	return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function pad2(value) {
	return String(value).padStart(2, '0');
}

function getOrdinalSuffix(day) {
	const mod100 = day % 100;
	if (mod100 >= 11 && mod100 <= 13) return 'th';
	switch (day % 10) {
		case 1: return 'st';
		case 2: return 'nd';
		case 3: return 'rd';
		default: return 'th';
	}
}

function isSameLocalDate(a, b) {
	return a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate();
}

function formatClock(date, use24Hour) {
	if (use24Hour !== false) {
		return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
	}

	const hours = date.getHours();
	const period = hours >= 12 ? 'PM' : 'AM';
	const hour12 = hours % 12 || 12;
	return `${pad2(hour12)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${period}`;
}

export function formatAiMessageTimestamp(value) {
	const timestamp = normalizeTimestamp(value);
	if (!timestamp) return '';

	const date = new Date(timestamp);
	return [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate()),
	].join('-') + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatUserMessageTimestamp(value, { use24Hour = true, now = new Date() } = {}) {
	const timestamp = normalizeTimestamp(value);
	if (!timestamp) return '';

	const date = new Date(timestamp);
	const time = formatClock(date, use24Hour);
	if (isSameLocalDate(date, now)) return time;

	const day = date.getDate();
	return `${MONTH_NAMES[date.getMonth()]} ${day}${getOrdinalSuffix(day)} ${time}`;
}

export function getMessageTimestampDateTime(value) {
	const timestamp = normalizeTimestamp(value);
	if (!timestamp) return '';

	try {
		return new Date(timestamp).toISOString();
	} catch {
		return '';
	}
}
