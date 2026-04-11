#ifndef LMSTUDIO_SERVICE_H
#define LMSTUDIO_SERVICE_H

#include <string>
#include <vector>
#include <functional>
#include <json/json.h>

class McpRegistry;

struct StreamContext {
    std::function<bool(const std::string&)> onChunk;
    std::string buffer;

    struct ToolCallAccum {
        std::string id;
        std::string name;
        std::string argumentsJson;
    };
    std::vector<ToolCallAccum> toolCalls;
    std::string finishReason;
};

class LmStudioService {
public:
    LmStudioService();

    Json::Value chat(
        const std::string& model,
        const std::string& prompt,
        int maxTokens           = 2048,
        const std::string& systemPrompt = "",
        double temperature      = -1.0
    ) const;

    void streamingChatWithCallback(
        const std::string& model,
        const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = "",
        double temperature = -1.0,
        int numCtx = 0,
        std::function<bool()> cancelCheck = nullptr,
        bool emitLogprobs = false
    ) const;

    void streamingChatWithTools(
        const std::string&  model,
        Json::Value         messages,
        const Json::Value&  tools,
        int                 maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        McpRegistry*        registry,
        double              temperature   = -1.0,
        int                 numCtx        = 0,
        std::function<bool()> cancelCheck = nullptr,
        bool                emitLogprobs  = false
    ) const;

    Json::Value getModels() const;

    void        setLmStudioUrl(const std::string& url) { lmStudioUrl_ = url; }
    std::string getLmStudioUrl() const                 { return lmStudioUrl_; }

    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

    // Generate a concise chat title from user message using the LLM
    std::string generateTitle(const std::string& model,
                              const std::string& userMessage,
                              const std::string& systemPrompt = "") const;

private:
    std::string lmStudioUrl_ = "http://localhost:1234";

    Json::Value makeRequest(const std::string& endpoint,
                            const Json::Value& body) const;
    Json::Value parseConversationHistory(const std::string& prompt) const;

    std::string streamOneRound(
        const Json::Value& requestBody,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::vector<StreamContext::ToolCallAccum>& toolCallsOut
    ) const;
};

#endif // LMSTUDIO_SERVICE_H