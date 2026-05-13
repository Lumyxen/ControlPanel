const API_BASE = '/api';

export function apiUrl(endpoint) {
	return `${API_BASE}${endpoint}`;
}

async function handleUnauthorizedResponse(response) {
	if (response.status !== 401) return false;
	let sessionExpired = false;
	try {
		const body = await response.clone().json();
		sessionExpired = body?.error === 'Not authenticated' || body?.error === 'Invalid session';
	} catch {}
	if (!sessionExpired) return false;
	try {
		const { redirectToLogin } = await import('../services/auth.js');
		redirectToLogin({ broadcast: true });
	} catch {
		localStorage.removeItem('ctrlpanel:sessionToken');
		window.location.replace('/login.html');
	}
	return true;
}

async function throwResponseError(response) {
	if (await handleUnauthorizedResponse(response)) {
		throw new Error('Session expired');
	}
	const error = await response.json().catch(() => ({}));
	const errMsg = typeof error.error === 'object' && error.error !== null
		? (error.error.message || JSON.stringify(error.error))
		: error.error;
	const problemMsg = error.detail || error.title;
	throw new Error(errMsg || problemMsg || `HTTP ${response.status}`);
}

export async function requestJson(endpoint, options = {}) {
	const headers = { ...options.headers };
	if (options.body && !headers['Content-Type'] && !headers['content-type']) {
		headers['Content-Type'] = 'application/json';
	}

	const response = await fetch(apiUrl(endpoint), { ...options, headers });
	if (!response.ok) {
		await throwResponseError(response);
	}
	return response.json();
}

export async function requestText(endpoint, options = {}) {
	const response = await fetch(apiUrl(endpoint), options);
	if (!response.ok) {
		await throwResponseError(response);
	}
	return response.text();
}

export async function fetchWithSession(endpoint, options = {}) {
	const response = await fetch(apiUrl(endpoint), options);
	if (await handleUnauthorizedResponse(response)) {
		throw new Error('Session expired');
	}
	return response;
}

export async function getModels() {
	return requestJson('/models');
}

export async function countChatTokens(payload, options = {}) {
	return requestJson('/chat/token-count', {
		method: 'POST',
		body: JSON.stringify(payload),
		...options,
	});
}

export async function submitGenerationTask(payload, options = {}) {
	return requestJson('/tasks/generate', {
		method: 'POST',
		body: JSON.stringify(payload),
		...options,
	});
}

export async function getTaskStatus(taskId) {
	return requestJson(`/tasks/${taskId}`);
}

function emitSseFrame(frame, onChunk, onDone) {
	const lines = frame.split(/\r?\n/);
	const dataLines = [];
	for (const line of lines) {
		if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).replace(/^ /, ''));
		}
	}
	if (dataLines.length === 0) return false;

	const payload = dataLines.join('\n');
	if (payload === '[DONE]') {
		if (onDone) onDone();
		return true;
	}

	try {
		const parsed = JSON.parse(payload);
		onChunk(parsed);
	} catch {
		// Ignore malformed SSE frames.
	}
	return false;
}

async function streamEventEndpoint(endpoint, resumeOffset, onChunk, signal = null, onDone = null, statusLoader = null) {
	const response = await fetch(apiUrl(endpoint), {
		headers: resumeOffset > 0 ? { 'X-Chunk-Offset': String(resumeOffset) } : {},
		signal,
	});
	if (!response.ok) {
		await throwResponseError(response);
	}
	if (!response.body) {
		throw new Error('Generation stream body is unavailable');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

			let frameEnd = buffer.indexOf('\n\n');
			while (frameEnd !== -1) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				if (emitSseFrame(frame, onChunk, onDone)) {
					await reader.cancel().catch(() => {});
					return;
				}
				frameEnd = buffer.indexOf('\n\n');
			}

			if (done) {
				if (buffer.trim()) {
					emitSseFrame(buffer, onChunk, onDone);
				}
				const status = statusLoader ? await statusLoader().catch(() => null) : null;
				const taskStatus = status?.status || '';
				if (taskStatus === 'failed') {
					throw new Error(status?.error || 'Generation failed');
				}
				if (taskStatus === 'completed' && onDone) onDone();
				return;
			}
		}
	} catch (error) {
		if (signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		throw error;
	}
}

export async function streamTask(taskId, resumeOffset, onChunk, signal = null, onDone = null) {
	return streamEventEndpoint(
		`/tasks/${taskId}/stream`,
		resumeOffset,
		onChunk,
		signal,
		onDone,
		() => getTaskStatus(taskId),
	);
}

export async function cancelTask(taskId, options = {}) {
	if (!taskId) return { status: 'cancelled', task_id: '' };

	const { unload = false } = options;
	const endpoint = `/tasks/${encodeURIComponent(taskId)}/cancel`;

	if (unload) {
		try {
			await fetch(apiUrl(endpoint), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
				keepalive: true,
			});
			return { status: 'cancelled', task_id: taskId, queued: true };
		} catch {
			return { status: 'cancel_failed', task_id: taskId };
		}
	}

	return requestJson(endpoint, { method: 'POST' });
}

export async function listTasks() {
	return requestJson('/tasks');
}

export async function getTaskByChat(chatId) {
	const response = await fetch(apiUrl(`/tasks/by-chat?chat_id=${encodeURIComponent(chatId)}`));
	if (await handleUnauthorizedResponse(response)) {
		return null;
	}
	const body = await response.json().catch(() => ({}));
	if (body?.found === false || body?.status === 'none') return null;
	if (!response.ok) {
		const errMsg = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
		throw new Error(errMsg);
	}
	return body;
}

export async function getSettings() {
	return requestJson('/config/settings');
}

export async function updateSettings(settings, options = {}) {
	return requestJson('/config/settings', {
		method: 'PUT',
		body: JSON.stringify(settings),
		...options,
	});
}

export async function getChatsData() {
	return requestJson('/chats');
}

export async function saveChatsData(data) {
	return requestJson('/chats', {
		method: 'PUT',
		body: JSON.stringify(data),
	});
}

export async function getChatData(chatId) {
	return requestJson(`/chats/${encodeURIComponent(chatId)}`);
}

export async function saveChatData(chatId, data) {
	return requestJson(`/chats/${encodeURIComponent(chatId)}`, {
		method: 'PUT',
		body: JSON.stringify(data),
	});
}

export async function deleteChatData(chatId) {
	return requestJson(`/chats/${encodeURIComponent(chatId)}`, {
		method: 'DELETE',
	});
}

export async function generateAiTitle(params) {
	return requestJson('/chat/generate-title', {
		method: 'POST',
		body: JSON.stringify(params),
	});
}

export async function generateResearchPlan(params, options = {}) {
	return requestJson('/chat/generate-research-plan', {
		method: 'POST',
		body: JSON.stringify(params),
		...options,
	});
}

export async function getToolPacks() {
	return requestJson('/tools/packs');
}

export async function reloadToolPacks() {
	return requestJson('/tools/reload', { method: 'POST' });
}

export async function getToolCatalog(params = {}) {
	const search = new URLSearchParams();
	if (params.query) search.set('query', params.query);
	if (params.limit != null) search.set('limit', String(params.limit));
	if (Array.isArray(params.enabledPackIds) && params.enabledPackIds.length > 0) {
		search.set('enabled_pack_ids', params.enabledPackIds.join(','));
	}
	const suffix = search.toString() ? `?${search.toString()}` : '';
	return requestJson(`/tools/catalog${suffix}`);
}

export async function listToolApprovals(taskId = '') {
	const suffix = taskId ? `?task_id=${encodeURIComponent(taskId)}` : '';
	return requestJson(`/tools/approvals${suffix}`);
}

export async function approveToolApproval(approvalId, note = '') {
	return requestJson(`/tools/approvals/${encodeURIComponent(approvalId)}/approve`, {
		method: 'POST',
		body: JSON.stringify({ note }),
	});
}

export async function denyToolApproval(approvalId, note = '') {
	return requestJson(`/tools/approvals/${encodeURIComponent(approvalId)}/deny`, {
		method: 'POST',
		body: JSON.stringify({ note }),
	});
}

export async function rollbackFileEdit(params) {
	return requestJson('/tools/file-edits/rollback', {
		method: 'POST',
		body: JSON.stringify(params || {}),
	});
}
