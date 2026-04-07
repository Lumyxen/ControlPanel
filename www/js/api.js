// www/js/api.js
// HTTP client for all backend communication.
// SSE stream handling is intentionally quiet — verbose debug logging removed.

const API_BASE = "/api";

async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = { "Content-Type": "application/json", ...options.headers };
    try {
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const errMsg = typeof error.error === 'object' && error.error !== null
                ? (error.error.message || JSON.stringify(error.error))
                : error.error;
            throw new Error(errMsg || `HTTP ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        console.error("API request failed:", err);
        throw err;
    }
}

export async function getModels() {
    return makeRequest("/models");
}

/**
 * Stream a chat message.
 *
 * @param {string}      model
 * @param {string}      prompt        - Full conversation history string (fallback when messages is null)
 * @param {number}      maxTokens
 * @param {function}    onChunk       - Called with each parsed SSE chunk
 * @param {AbortSignal} signal
 * @param {string}      systemPrompt
 * @param {number|null} temperature   - Sampling temperature (null = backend default)
 * @param {number|null} contextWindow - Context window size (used by LM Studio via num_ctx)
 * @param {string|null} streamId      - Identifier for explicit halt via /chat/stop
 * @param {Array|null}  messages      - Structured OpenAI-format messages (enables vision/multimodal).
 *                                      When provided, takes precedence over prompt.
 * @param {function}    onDone        - Called when stream completes (success or error)
 * @param {boolean}     logprobs      - Whether to emit per-token logprobs (default: false)
 */
export async function streamChatMessage(
    model, prompt, maxTokens = 8192, onChunk,
    signal = null, systemPrompt = "", temperature = null,
    contextWindow = null, streamId = null, messages = null,
    onDone = null,
    logprobs = false,
) {
    const url = new URL(`${window.location.origin}${API_BASE}/chat/stream`);
    const payload = { model, max_tokens: maxTokens, prompt };

    if (messages && messages.length > 0)  payload.messages       = messages;
    if (systemPrompt)                      payload.system_prompt  = systemPrompt;
    if (temperature !== null && temperature !== undefined) payload.temperature = temperature;
    if (contextWindow !== null && contextWindow > 0)       payload.context_window = contextWindow;
    if (streamId)                          payload.stream_id      = streamId;
    if (logprobs)                          payload.logprobs       = logprobs;

    try {
        const response = await fetch(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });

        if (!response.ok) {
            let error = {};
            try { error = await response.json(); } catch {}
            const errMsg = typeof error.error === 'object' && error.error !== null
                ? (error.error.message || JSON.stringify(error.error))
                : error.error;
            throw new Error(errMsg || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("Response body is not readable");

        const decoder = new TextDecoder();
        let buffer = "";
        let streamError = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            let streamFinished = false;
            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6);
                if (data === "[DONE]") { streamFinished = true; break; }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        const msg = typeof parsed.error === 'object' && parsed.error !== null
                            ? (parsed.error.message || JSON.stringify(parsed.error))
                            : String(parsed.error);
                        streamError = new Error(msg);
                    }
                    if (onChunk) onChunk(parsed);
                } catch { /* ignore malformed SSE frames */ }
            }
            if (streamFinished) {
                if (onDone) onDone();
                break;
            }
        }

        if (streamError) throw streamError;
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.error("Streaming request failed:", err);
        throw err;
    } finally {
        if (onDone) onDone();
    }
}

/** Explicitly cancel a running stream (overcomes TCP/OS layer cache delays). */
export async function stopChatMessage(streamId) {
    return makeRequest("/chat/stop", { method: "POST", body: JSON.stringify({ stream_id: streamId }) });
}

export async function getSettings()          { return makeRequest("/config/settings"); }
export async function updateSettings(s)      { return makeRequest("/config/settings", { method: "PUT", body: JSON.stringify(s) }); }
export async function getChatsData()         { return makeRequest("/chats"); }
export async function saveChatsData(data)    { return makeRequest("/chats", { method: "PUT", body: JSON.stringify(data) }); }
