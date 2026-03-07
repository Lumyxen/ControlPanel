#ifndef OPENROUTER_SERVICE_H
#define OPENROUTER_SERVICE_H

#include <string>
#include <vector>
#include <functional>
#include <json/json.h>
#include "utils/encryption.h"

// Stream context for handling chunked responses
struct StreamContext {
    std::function<void(const std::string&)> onChunk;
    std::string buffer;
};

class OpenRouterService {
private:
    std::string apiKey;
    Encryption& encryption;

public:
    OpenRouterService(const std::string& apiKey, Encryption& encryption);
    
    Json::Value chat(const std::string& model, const std::string& prompt, int maxTokens = 2048, const std::string& systemPrompt = "") const;
    Json::Value streamingChat(const std::string& model, const std::string& prompt, int maxTokens = 2048, const std::string& systemPrompt = "") const;
    
    // Streaming with callback for SSE
    void streamingChatWithCallback(
        const std::string& model, 
        const std::string& prompt, 
        int maxTokens,
        std::function<void(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = ""
    ) const;
    
    Json::Value getModels() const;
    Json::Value getPricing() const;
    
private:
    Json::Value makeRequest(const std::string& endpoint, const Json::Value& body) const;
    std::string decryptApiKey() const;
    Json::Value parseConversationHistory(const std::string& prompt) const;
    Json::Value buildMessages(const std::string& prompt, const std::string& systemPrompt) const;
};

#endif // OPENROUTER_SERVICE_H