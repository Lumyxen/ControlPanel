const API_BASE = "/api";

export function apiUrl(endpoint) {
	return `${API_BASE}${endpoint}`;
}

async function handleUnauthorizedResponse(response) {
	if (response.status !== 401) return false;
	try {
		const { redirectToLogin } = await import('../services/auth.js');
		redirectToLogin({ broadcast: true });
	} catch {
		sessionStorage.removeItem('ctrlpanel:sessionToken');
		window.location.replace('/login.html');
	}
	return true;
}

export async function requestJson(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = { "Content-Type": "application/json", ...options.headers };

    // Attach session token if available
    try {
        const { getSessionToken } = await import('../services/auth.js');
        const token = getSessionToken();
        if (token) {
            headers['X-Session-Token'] = token;
        }
    } catch { /* auth.js may not be loaded */ }

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        if (await handleUnauthorizedResponse(response)) {
            throw new Error('Session expired');
        }
        const error = await response.json().catch(() => ({}));
        const errMsg = typeof error.error === 'object' && error.error !== null
            ? (error.error.message || JSON.stringify(error.error))
            : error.error;
        throw new Error(errMsg || `HTTP ${response.status}`);
    }
    return await response.json();
}

export async function requestText(endpoint, options = {}) {
	const response = await fetch(apiUrl(endpoint), options);
	if (!response.ok) {
		if (await handleUnauthorizedResponse(response)) {
			throw new Error('Session expired');
		}
		throw new Error(`HTTP ${response.status}`);
	}
	return response.text();
}

export async function fetchWithSession(endpoint, options = {}) {
	const headers = { ...options.headers };
	try {
		const { getSessionToken } = await import('../services/auth.js');
		const token = getSessionToken();
		if (token) headers['X-Session-Token'] = token;
	} catch {}
	const response = await fetch(apiUrl(endpoint), { ...options, headers });
	if (await handleUnauthorizedResponse(response)) {
		throw new Error('Session expired');
	}
	return response;
}

export async function getModels() {
    return requestJson("/models");
}

export async function countChatTokens(payload, options = {}) {
    return requestJson("/chat/token-count", {
        method: "POST",
        body: JSON.stringify(payload),
        ...options,
    });
}

// ─── Task-based generation API ───────────────────────────────────────────────
// These functions support backend-managed generation. The frontend submits a
// task, then opens an SSE stream to receive chunks. The caller is responsible
// for explicitly cancelling tasks when the user stops generation or the page
// unloads.

/**
 * Submit a generation task to the backend.
 * Returns the task_id immediately. Generation runs in the background.
 */
export async function submitGenerationTask(payload, options = {}) {
    return requestJson("/tasks/generate", {
        method: "POST",
        body: JSON.stringify(payload),
        ...options,
    });
}

/**
 * Get the status of a generation task (lightweight polling).
 */
export async function getTaskStatus(taskId) {
    return requestJson(`/tasks/${taskId}`);
}

/**
 * Stream a generation task using EventSource (proper SSE in browsers).
 * Replays all accumulated chunks then waits for completion.
 *
 * @param {string}   taskId
 * @param {number}   resumeOffset  - Not used with EventSource (always starts from 0)
 * @param {function} onChunk       - Called with each parsed SSE chunk
 * @param {AbortSignal} signal
 * @param {function} onDone        - Called when task completes
 */
export async function streamTask(taskId, _resumeOffset, onChunk, signal = null, onDone = null) {
    const { buildAuthenticatedBackendUrl } = await import('../services/auth.js');
    return new Promise((resolve, reject) => {
        const url = buildAuthenticatedBackendUrl(`/api/tasks/${taskId}/stream`);
        const es = new EventSource(url);
        let settled = false;

        const cleanup = () => {
            es.close();
            if (signal) signal.removeEventListener('abort', abortHandler);
        };

        const resolveOnce = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        const abortHandler = () => {
            cleanup();
            rejectOnce(new DOMException('Aborted', 'AbortError'));
        };

        if (signal?.aborted) {
            cleanup();
            rejectOnce(new DOMException('Aborted', 'AbortError'));
            return;
        }

        if (signal) signal.addEventListener('abort', abortHandler);

        es.addEventListener('error', () => {
            cleanup();
            void (async () => {
                const deadline = Date.now() + 3000;
                while (!settled && Date.now() < deadline) {
                    try {
                        const status = await getTaskStatus(taskId);
                        const taskStatus = status?.status || '';
                        if (taskStatus === 'completed' || taskStatus === 'cancelled') {
                            if (taskStatus === 'completed' && onDone) onDone();
                            resolveOnce();
                            return;
                        }
                        if (taskStatus === 'failed') {
                            rejectOnce(new Error(status?.error || 'Generation failed'));
                            return;
                        }
                    } catch {
                        // Keep polling briefly in case the task snapshot races the stream close.
                    }

                    await new Promise((pollResolve) => setTimeout(pollResolve, 100));
                }
                rejectOnce(new Error('Generation stream disconnected'));
            })();
        });

        es.onmessage = (event) => {
            if (event.data === '[DONE]') {
                cleanup();
                if (onDone) onDone();
                resolveOnce();
                return;
            }
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.error) {
                    const msg = typeof parsed.error === 'object' && parsed.error !== null
                        ? (parsed.error.message || JSON.stringify(parsed.error))
                        : String(parsed.error);
                    cleanup();
                    rejectOnce(new Error(msg));
                    return;
                }
                onChunk(parsed);
            } catch {
                // ignore malformed SSE frames
            }
        };
    });
}

/** Cancel a running generation task. */
export async function cancelTask(taskId, options = {}) {
    if (!taskId) return { status: 'cancelled', task_id: '' };

    const { unload = false } = options;
    const endpoint = `/tasks/${encodeURIComponent(taskId)}/cancel`;

    if (unload) {
        const { buildAuthenticatedBackendUrl, getSessionToken } = await import('../services/auth.js');
        const token = getSessionToken();
        const url = buildAuthenticatedBackendUrl(`${API_BASE}${endpoint}`);
        const body = JSON.stringify(token ? { sessionToken: token } : {});
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
            if (ok) {
                return { status: 'cancelled', task_id: taskId, queued: true };
            }
        }

        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            });
            return { status: 'cancelled', task_id: taskId, queued: true };
        } catch {
            return { status: 'cancel_failed', task_id: taskId };
        }
    }

    return requestJson(endpoint, { method: "POST" });
}

/** List all generation tasks (for debug/admin). */
export async function listTasks() {
    return requestJson("/tasks");
}

/** Find the latest task for a given chat. Returns null if no task found. */
export async function getTaskByChat(chatId) {
    try {
        const url = `${API_BASE}/tasks/by-chat?chat_id=${encodeURIComponent(chatId)}`;
        const headers = { "Content-Type": "application/json" };
        try {
            const { getSessionToken } = await import('../services/auth.js');
            const token = getSessionToken();
            if (token) headers['X-Session-Token'] = token;
        } catch {}

        const response = await fetch(url, { headers });
        if (await handleUnauthorizedResponse(response)) return null;
        const body = await response.json().catch(() => ({}));
        if (body?.found === false || body?.status === 'none') return null;
        if (!response.ok) return body;
        return body;
    } catch {
        return null;
    }
}

export async function getSettings()          { return requestJson("/config/settings"); }
export async function updateSettings(s)      { return requestJson("/config/settings", { method: "PUT", body: JSON.stringify(s) }); }
export async function getChatsData()         { return requestJson("/chats"); }
export async function saveChatsData(data)    { return requestJson("/chats", { method: "PUT", body: JSON.stringify(data) }); }
export async function getChatData(chatId)    { return requestJson(`/chats/${encodeURIComponent(chatId)}`); }
export async function saveChatData(chatId, data) {
    return requestJson(`/chats/${encodeURIComponent(chatId)}`, { method: "PUT", body: JSON.stringify(data) });
}
export async function deleteChatData(chatId) {
    return requestJson(`/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
}

/**
 * Generate an AI title for a chat based on the first user message.
 * @param {Object} params
 * @param {string} params.message - Ordered chat history used to derive the title
 * @param {string} params.model - The model to use for generation
 * @param {string} [params.title_system_prompt] - Optional title-specific system prompt
 * @returns {Promise<{title: string}>}
 */
export async function generateAiTitle(params) {
    return requestJson("/chat/generate-title", {
        method: "POST",
        body: JSON.stringify(params),
    });
}

export async function getToolPacks() {
	return requestJson("/tools/packs");
}

export async function reloadToolPacks() {
	return requestJson("/tools/reload", { method: "POST" });
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
