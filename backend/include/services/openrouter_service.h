#ifndef OPENROUTER_SERVICE_H
#define OPENROUTER_SERVICE_H

#include <string>
#include <vector>
#include <functional>
#include <json/json.h>
#include "utils/encryption.h"

// Forward-declare so we don't pull in the full registry header here
class McpRegistry;

// Stream context for handling chunked responses
struct StreamContext {
    std::function<bool(const std::string&)> onChunk;
    std::string buffer;

    // Tool-call accumulation across chunks
    // Keyed by tool-call index.  Each entry: { id, name, accumulated_args }
    struct ToolCallAccum {
        std::string id;
        std::string name;
        std::string argumentsJson; // built up from streaming deltas
    };
    std::vector<ToolCallAccum> toolCalls;
    std::string finishReason;
};

class OpenRouterService {
public:
    OpenRouterService(const std::string& apiKey, Encryption& encryption);

    Json::Value chat(
        const std::string& model,
        const std::string& prompt,
        int maxTokens           = 2048,
        const std::string& systemPrompt = "",
        double temperature      = -1.0
    ) const;

    /** Original single-turn streaming (no tool loop). */
    void streamingChatWithCallback(
        const std::string& model,
        const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = "",
        double temperature = -1.0,
        int numCtx = 0
    ) const;

    // ── Tool-aware streaming (agentic loop) ───────────────────────────────────
    /**
     * Stream a chat with optional MCP tool support.
     *
     * @param model          OpenRouter model ID
     * @param messages       Full messages array (role/content objects).
     *                       Use buildMessages() to build from a prompt string.
     * @param tools          OpenAI-format tools array (may be empty/null).
     * @param maxTokens      Max output tokens
     * @param onChunk        SSE chunk callback (forwarded straight to the client)
     * @param onError        Error callback
     * @param registry       MCP registry used to execute tool calls.
     *                       Pass nullptr to disable tool execution.
     * @param temperature    -1 = omit field
     */
    void streamingChatWithTools(
        const std::string&  model,
        Json::Value         messages,
        const Json::Value&  tools,
        int                 maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        McpRegistry*        registry,
        double              temperature   = -1.0,
        int                 numCtx        = 0
    ) const;

    // ── Utilities ─────────────────────────────────────────────────────────────
    Json::Value getModels()  const;

    /** Fetch model list from a local LM Studio server. */
    Json::Value getLmStudioModels() const;

    /** Set / get the LM Studio base URL (default: http://localhost:1234). */
    void        setLmStudioUrl(const std::string& url) { lmStudioUrl_ = url; }
    std::string getLmStudioUrl() const                 { return lmStudioUrl_; }

    /** Build a messages array from the legacy string prompt format. */
    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

private:
    std::string  apiKey;
    std::string  lmStudioUrl_ = "http://localhost:1234";
    Encryption&  encryption;

    Json::Value makeRequest(const std::string& endpoint,
                            const Json::Value& body) const;
    std::string decryptApiKey() const;
    Json::Value parseConversationHistory(const std::string& prompt) const;

    /** Single-round streaming into a StreamContext; returns finish reason. */
    std::string streamOneRound(
        const Json::Value& requestBody,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::vector<StreamContext::ToolCallAccum>& toolCallsOut
    ) const;
};

#endif // OPENROUTER_SERVICE_H