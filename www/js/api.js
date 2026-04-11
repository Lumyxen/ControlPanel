// www/js/api.js
// HTTP client for all backend communication.
// SSE stream handling is intentionally quiet — verbose debug logging removed.

const API_BASE = "/api";

async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = { "Content-Type": "application/json", ...options.headers };

    // Attach session token if available
    try {
        const { getSessionToken } = await import('./auth.js');
        const token = getSessionToken();
        if (token) {
            headers['X-Session-Token'] = token;
        }
    } catch { /* auth.js may not be loaded */ }

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        if (response.status === 401) {
            // Session invalidated — redirect to login
            sessionStorage.removeItem('ctrlpanel:sessionToken');
            window.location.replace('/login.html');
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

export async function getModels() {
    return makeRequest("/models");
}

// ─── Task-based generation API ───────────────────────────────────────────────
// These functions support backend-managed generation that persists across
// browser tab close/reload. The frontend submits a task, then opens an SSE
// stream to receive chunks. If the tab closes mid-generation, the task
// continues on the backend and can be resumed on reconnect.

/**
 * Submit a generation task to the backend.
 * Returns the task_id immediately. Generation runs in the background.
 */
export async function submitGenerationTask(payload) {
    return makeRequest("/tasks/generate", { method: "POST", body: JSON.stringify(payload) });
}

/**
 * Get the status of a generation task (lightweight polling).
 */
export async function getTaskStatus(taskId) {
    return makeRequest(`/tasks/${taskId}`);
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
    return new Promise((resolve, reject) => {
        const url = `/api/tasks/${taskId}/stream`;
        const es = new EventSource(url);

        const cleanup = () => {
            es.close();
            if (signal) signal.removeEventListener('abort', abortHandler);
        };

        const abortHandler = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };

        if (signal) signal.addEventListener('abort', abortHandler);

        es.addEventListener('error', () => {
            cleanup();
            resolve();
        });

        es.onmessage = (event) => {
            if (event.data === '[DONE]') {
                cleanup();
                if (onDone) onDone();
                resolve();
                return;
            }
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.error) {
                    const msg = typeof parsed.error === 'object' && parsed.error !== null
                        ? (parsed.error.message || JSON.stringify(parsed.error))
                        : String(parsed.error);
                    cleanup();
                    reject(new Error(msg));
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
export async function cancelTask(taskId) {
    return makeRequest(`/tasks/${taskId}/cancel`, { method: "POST" });
}

/** List all generation tasks (for debug/admin). */
export async function listTasks() {
    return makeRequest("/tasks");
}

/** Find the latest task for a given chat. Returns null if no task found. */
export async function getTaskByChat(chatId) {
    try {
        const url = `${API_BASE}/tasks/by-chat?chat_id=${encodeURIComponent(chatId)}`;
        const headers = { "Content-Type": "application/json" };
        try {
            const { getSessionToken } = await import('./auth.js');
            const token = getSessionToken();
            if (token) headers['X-Session-Token'] = token;
        } catch {}

        const response = await fetch(url, { headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return body;
        return body;
    } catch {
        return null;
    }
}

export async function getSettings()          { return makeRequest("/config/settings"); }
export async function updateSettings(s)      { return makeRequest("/config/settings", { method: "PUT", body: JSON.stringify(s) }); }
export async function getChatsData()         { return makeRequest("/chats"); }
export async function saveChatsData(data)    { return makeRequest("/chats", { method: "PUT", body: JSON.stringify(data) }); }

/**
 * Generate an AI title for a chat based on the first user message.
 * @param {Object} params
 * @param {string} params.message - The user's first message
 * @param {string} params.model - The model to use for generation
 * @param {string} [params.system_prompt] - Optional system prompt
 * @returns {Promise<{title: string}>}
 */
export async function generateAiTitle(params) {
    return makeRequest("/chat/generate-title", {
        method: "POST",
        body: JSON.stringify(params),
    });
}
