// API service for backend communication
const API_BASE = "/api";

async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
        "Content-Type": "application/json",
        ...options.headers,
    };

    try {
        const response = await fetch(url, {
            ...options,
            headers,
        });

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
 * @param {string}   model
 * @param {string}   prompt           - Full conversation history string
 * @param {number}   maxTokens
 * @param {function} onChunk          - Called with each parsed SSE chunk
 * @param {AbortSignal|null} signal
 * @param {string}   systemPrompt     - System prompt to prepend (sent to backend)
 * @param {number|null} temperature   - Sampling temperature (null = use backend default)
 * @param {number|null} contextWindow - Context window size to request (used by LM Studio via num_ctx)
 */
export async function streamChatMessage(
    model,
    prompt,
    maxTokens = 2048,
    onChunk,
    signal = null,
    systemPrompt = "",
    temperature = null,
    contextWindow = null,
) {
    const url = new URL(`${window.location.origin}${API_BASE}/chat/stream`);

    const headers = {
        "Content-Type": "application/json",
    };

    // Build request body – only include optional fields when they carry a value
    const requestPayload = {
        model,
        prompt,
        max_tokens: maxTokens,
    };
    if (systemPrompt) {
        requestPayload.system_prompt = systemPrompt;
    }
    if (temperature !== null && temperature !== undefined) {
        requestPayload.temperature = temperature;
    }
    if (contextWindow !== null && contextWindow > 0) {
        requestPayload.context_window = contextWindow;
    }

    try {
        const response = await fetch(url.toString(), {
            method: "POST",
            headers,
            body: JSON.stringify(requestPayload),
            signal
        });

        if (!response.ok) {
            let error = {};
            try {
                error = await response.json();
            } catch (e) {}
            const errMsg = typeof error.error === 'object' && error.error !== null
                ? (error.error.message || JSON.stringify(error.error))
                : error.error;
            throw new Error(errMsg || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("Response body is not readable");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let streamError = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            console.debug("[API] Received chunk:", chunk);
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            let streamFinished = false; // Flag to instantly kill the stream

            for (const line of lines) {
                console.debug("[API] Processing line:", line);
                if (line.startsWith("data: ")) {
                    const data = line.slice(6);
                    console.debug("[API] SSE data:", data);
                    
                    // Stop waiting for the server to close the socket
                    if (data === "[DONE]") {
                        streamFinished = true;
                        break; 
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        console.debug("[API] Parsed JSON:", parsed);
                        // Check for error in the stream
                        if (parsed.error) {
                            const errorMsg = typeof parsed.error === 'object' && parsed.error !== null
                                ? (parsed.error.message || JSON.stringify(parsed.error))
                                : String(parsed.error);
                            console.debug("[API] Error detected in stream:", errorMsg);
                            streamError = new Error(errorMsg);
                        }
                        if (onChunk) onChunk(parsed);
                    } catch (e) {
                        console.debug("[API] Failed to parse JSON:", e, "Data was:", data);
                    }
                }
            }
            if (streamFinished) break; // Break the while loop
        }

        // If we encountered an error in the stream, throw it after processing
        if (streamError) {
            throw streamError;
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err; // Re-throw to be handled gracefully
        console.error("Streaming request failed:", err);
        throw err;
    }
}

export async function getSettings() {
    return makeRequest("/config/settings");
}

export async function updateSettings(settings) {
    return makeRequest("/config/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
    });
}

// ── Chat persistence (backend storage) ───────────────────────────────────────

/**
 * Fetch the full chat state from the backend.
 * Returns { chats, currentChatId, pins }.
 */
export async function getChatsData() {
    return makeRequest("/chats");
}

/**
 * Persist the full chat state to the backend.
 * @param {{ chats: Array, currentChatId: string, pins: Array }} data
 */
export async function saveChatsData(data) {
    return makeRequest("/chats", {
        method: "PUT",
        body: JSON.stringify(data),
    });
}