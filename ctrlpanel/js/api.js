// API service for backend communication
import {
    isDemoEnabled,
    mockGetModels,
    mockGetPricing,
    mockSendChatMessage,
    mockStreamChatMessage,
    mockGetSettings,
    mockUpdateSettings,
    mockGetPromptTemplates,
    mockCreatePromptTemplate,
    mockUpdatePromptTemplate,
    mockDeletePromptTemplate,
} from './demo-mode.js';

const API_BASE = "http://127.0.0.1:1024/api";

async function makeRequest(endpoint, options = {}) {
    // If in demo mode, return mock responses
    if (isDemoEnabled()) {
        return makeMockRequest(endpoint, options);
    }
    
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

/**
 * Make mock request for demo mode
 * @param {string} endpoint - API endpoint
 * @param {Object} options - request options
 * @returns {Promise<any>}
 */
async function makeMockRequest(endpoint, options = {}) {
    console.log(`[DemoMode] Mock API call: ${endpoint}`);
    
    // Parse body if present
    let body = {};
    if (options.body) {
        try {
            body = JSON.parse(options.body);
        } catch (e) {
            // Ignore parse errors
        }
    }
    
    // Route to appropriate mock function
    switch (endpoint) {
        case '/models':
            return mockGetModels();
        case '/pricing':
            return mockGetPricing();
        case '/chat':
            return mockSendChatMessage(body.model, body.prompt, body.max_tokens);
        case '/config/settings':
            if (options.method === 'PUT') {
                return mockUpdateSettings(body);
            }
            return mockGetSettings();
        case '/config/prompt-templates':
            if (options.method === 'POST') {
                return mockCreatePromptTemplate(body.name, body.template);
            }
            return mockGetPromptTemplates();
        default:
            // Handle paths with IDs
            if (endpoint.startsWith('/config/prompt-templates/')) {
                const id = parseInt(endpoint.split('/').pop());
                if (options.method === 'PUT') {
                    return mockUpdatePromptTemplate(id, body);
                } else if (options.method === 'DELETE') {
                    return mockDeletePromptTemplate(id);
                }
            }
            throw new Error(`Unknown endpoint: ${endpoint}`);
    }
}

export async function getModels() {
    return makeRequest("/models");
}

export async function getPricing() {
    return makeRequest("/pricing");
}

export async function sendChatMessage(model, prompt, maxTokens = 2048) {
    return makeRequest("/chat", {
        method: "POST",
        body: JSON.stringify({
            model,
            prompt,
            max_tokens: maxTokens,
        }),
    });
}

export async function streamChatMessage(model, prompt, maxTokens = 2048, onChunk, signal = null) {
    // If in demo mode, use mock streaming
    if (isDemoEnabled()) {
        return mockStreamChatMessage(model, prompt, maxTokens, onChunk);
    }
    
    const url = new URL(`${API_BASE}/chat/stream`);

    const headers = {
        "Content-Type": "application/json",
    };

    try {
        const response = await fetch(url.toString(), {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                prompt,
                max_tokens: maxTokens,
            }),
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

export async function getPromptTemplates() {
    return makeRequest("/config/prompt-templates");
}

export async function createPromptTemplate(name, template) {
    return makeRequest("/config/prompt-templates", {
        method: "POST",
        body: JSON.stringify({ name, template }),
    });
}

export async function updatePromptTemplate(id, data) {
    return makeRequest(`/config/prompt-templates/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
}

export async function deletePromptTemplate(id) {
    return makeRequest(`/config/prompt-templates/${id}`, {
        method: "DELETE",
    });
}