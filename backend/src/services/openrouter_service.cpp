#include "services/openrouter_service.h"
#include <curl/curl.h>
#include <json/json.h>
#include <iostream>
#include <sstream>
#include <vector>

// libcurl write callback
size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

// Parse conversation history from "User: content\n\nAssistant: content\n\n..." format
// into proper OpenAI message format
Json::Value OpenRouterService::parseConversationHistory(const std::string& prompt) const {
    Json::Value messages(Json::arrayValue);
    
    // Split the prompt by double newlines to separate messages
    std::vector<std::string> lines;
    std::string current;
    std::istringstream stream(prompt);
    std::string line;
    
    while (std::getline(stream, line)) {
        // Check if this line starts a new message (User: or Assistant:)
        if ((line.find("User:") == 0 || line.find("Assistant:") == 0) && !current.empty()) {
            lines.push_back(current);
            current = line;
        } else {
            if (!current.empty()) {
                current += "\n";
            }
            current += line;
        }
    }
    if (!current.empty()) {
        lines.push_back(current);
    }
    
    // Also try a simpler approach: split by "\n\n" and check each part
    if (lines.empty()) {
        std::string delimiter = "\n\n";
        size_t pos = 0;
        std::string token;
        std::string tempPrompt = prompt;
        while ((pos = tempPrompt.find(delimiter)) != std::string::npos) {
            token = tempPrompt.substr(0, pos);
            if (!token.empty()) {
                lines.push_back(token);
            }
            tempPrompt.erase(0, pos + delimiter.length());
        }
        if (!tempPrompt.empty()) {
            lines.push_back(tempPrompt);
        }
    }
    
    // Parse each line into a message
    for (const std::string& msgLine : lines) {
        std::string trimmed = msgLine;
        // Trim leading whitespace
        size_t start = trimmed.find_first_not_of(" \t\n\r");
        if (start != std::string::npos) {
            trimmed = trimmed.substr(start);
        }
        
        Json::Value message;
        if (trimmed.find("User:") == 0) {
            message["role"] = "user";
            std::string content = trimmed.substr(5); // Remove "User:"
            // Trim leading whitespace from content
            size_t contentStart = content.find_first_not_of(" \t");
            if (contentStart != std::string::npos) {
                content = content.substr(contentStart);
            }
            message["content"] = content;
            messages.append(message);
        } else if (trimmed.find("Assistant:") == 0) {
            message["role"] = "assistant";
            std::string content = trimmed.substr(10); // Remove "Assistant:"
            // Trim leading whitespace from content
            size_t contentStart = content.find_first_not_of(" \t");
            if (contentStart != std::string::npos) {
                content = content.substr(contentStart);
            }
            message["content"] = content;
            messages.append(message);
        } else if (!trimmed.empty()) {
            // If no prefix found, treat as user message (fallback)
            message["role"] = "user";
            message["content"] = trimmed;
            messages.append(message);
        }
    }
    
    // If no messages were parsed, treat the entire prompt as a single user message
    if (messages.empty() && !prompt.empty()) {
        Json::Value message;
        message["role"] = "user";
        message["content"] = prompt;
        messages.append(message);
    }
    
    return messages;
}

// libcurl write callback for streaming responses
size_t WriteCallbackStream(char* contents, size_t size, size_t nmemb, void* userp) {
    StreamContext* ctx = (StreamContext*)userp;
    size_t realsize = size * nmemb;
    
    ctx->buffer.append(contents, realsize);
    
    // Process complete lines
    size_t pos;
    while ((pos = ctx->buffer.find('\n')) != std::string::npos) {
        std::string line = ctx->buffer.substr(0, pos);
        ctx->buffer.erase(0, pos + 1);
        
        // Handle carriage return if it exists (from \r\n)
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        
        if (line.find("data: ") == 0) {
            std::string data = line.substr(6);
            if (data == "[DONE]") {
                // Forward the [DONE] marker as-is
                if (ctx->onChunk) {
                    ctx->onChunk("data: [DONE]\n\n");
                }
                continue;
            }
            
            // Parse the JSON delta
            Json::Value parsedJson;
            Json::CharReaderBuilder reader;
            std::string errs;
            std::istringstream dataStream(data);
            
            if (Json::parseFromStream(reader, dataStream, &parsedJson, &errs)) {
                // Extract content and reasoning from choices[0].delta
                std::string content;
                std::string reasoning;
                bool hasContent = false;
                bool hasReasoning = false;
                
                if (parsedJson.isMember("choices") && parsedJson["choices"].isArray() &&
                    !parsedJson["choices"].empty() && parsedJson["choices"][0].isMember("delta")) {
                    const Json::Value& delta = parsedJson["choices"][0]["delta"];
                    
                    if (delta.isMember("content") && !delta["content"].asString().empty()) {
                        content = delta["content"].asString();
                        hasContent = true;
                    }
                    
                    if (delta.isMember("reasoning") && !delta["reasoning"].asString().empty()) {
                        reasoning = delta["reasoning"].asString();
                        hasReasoning = true;
                    }
                }
                
                // Create new JSON object with only non-empty fields
                if (hasContent || hasReasoning) {
                    Json::Value newDelta;
                    if (hasContent) {
                        newDelta["content"] = content;
                    }
                    if (hasReasoning) {
                        newDelta["reasoning"] = reasoning;
                    }
                    
                    Json::Value newChoice;
                    newChoice["delta"] = newDelta;
                    
                    Json::Value newJson;
                    newJson["choices"].append(newChoice);
                    
                    // Create reformatted SSE line
                    Json::StreamWriterBuilder writer;
                    writer["indentation"] = "";
                    std::string newData = Json::writeString(writer, newJson);
                    
                    if (ctx->onChunk) {
                        ctx->onChunk("data: " + newData + "\n\n");
                    }
                }
            } else {
                // If parsing fails, forward the original line
                if (ctx->onChunk) {
                    ctx->onChunk(line + "\n\n");
                }
            }
        }
    }
    
    return realsize;
}

// Callback to capture HTTP error response body
size_t WriteCallbackErrorBuffer(char* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

OpenRouterService::OpenRouterService(const std::string& apiKey, Encryption& encryption)
    : apiKey(apiKey), encryption(encryption) {
    // Don't require API key at startup - allow server to start without it
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

Json::Value OpenRouterService::chat(const std::string& model, const std::string& prompt, int maxTokens) const {
    Json::Value requestBody;
    requestBody["model"] = model;
    requestBody["messages"] = parseConversationHistory(prompt);
    requestBody["max_tokens"] = maxTokens;
    
    return makeRequest("/chat/completions", requestBody);
}

Json::Value OpenRouterService::streamingChat(const std::string& model, const std::string& prompt, int maxTokens) const {
    Json::Value requestBody;
    requestBody["model"] = model;
    requestBody["messages"] = parseConversationHistory(prompt);
    requestBody["max_tokens"] = maxTokens;
    requestBody["stream"] = true;
    
    return makeRequest("/chat/completions", requestBody);
}

// Streaming callback that sends data directly to the client via callback
void OpenRouterService::streamingChatWithCallback(
    const std::string& model,
    const std::string& prompt,
    int maxTokens,
    std::function<void(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError
) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
        onError("Failed to initialize CURL");
        return;
    }
    
    std::string decryptedKey = decryptApiKey();
    
    if (decryptedKey.empty()) {
        onError("OpenRouter API key not configured");
        curl_easy_cleanup(curl);
        return;
    }
    
    std::string url = "https://openrouter.ai/api/v1/chat/completions";
    
    struct curl_slist* headers = NULL;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "HTTP-Referer: http://localhost");
    headers = curl_slist_append(headers, "X-Title: CtrlPanel");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    headers = curl_slist_append(headers, "Expect:");
    
    Json::Value requestBody;
    requestBody["model"] = model;
    requestBody["messages"] = parseConversationHistory(prompt);
    requestBody["max_tokens"] = maxTokens;
    requestBody["stream"] = true;
    
    std::string jsonBody = requestBody.toStyledString();
    
    // Set up streaming context with callback
    StreamContext streamCtx;
    streamCtx.onChunk = onChunk;
    
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)jsonBody.length());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    
    // Use the streaming write callback for real-time processing
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallbackStream);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &streamCtx);
    
    CURLcode res = curl_easy_perform(curl);
    
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        std::string errMsg = std::string("Failed to connect to OpenRouter: ") + curl_easy_strerror(res);
        std::cerr << "[OpenRouterService] CURL error, calling onError with: " << errMsg << std::endl;
        onError(errMsg);
        return;
    }
    
    if (httpCode != 200) {
        // For non-200 responses, the response was captured in the stream buffer
        // Try to parse it as an error
        Json::Value errorJson;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(streamCtx.buffer);

        if (Json::parseFromStream(reader, stream, &errorJson, &errs)) {
            // OpenRouter typically returns errors in error.message or error.code
            if (errorJson.isMember("error")) {
                const Json::Value& errorObj = errorJson["error"];
                std::string errorMsg;
                if (errorObj.isObject()) {
                    if (errorObj.isMember("message")) {
                        errorMsg = errorObj["message"].asString();
                        onError(errorMsg);
                        return;
                    }
                    if (errorObj.isMember("code")) {
                        errorMsg = "OpenRouter error: " + errorObj["code"].asString();
                        onError(errorMsg);
                        return;
                    }
                } else if (errorObj.isString()) {
                    errorMsg = errorObj.asString();
                    onError(errorMsg);
                    return;
                }
            }
        }

        // Fallback to HTTP error code with partial response if parsing failed
        std::string errorMsg = "HTTP error: " + std::to_string(httpCode);
        if (!streamCtx.buffer.empty()) {
            errorMsg += " - " + streamCtx.buffer.substr(0, 500); // Limit response length
        }
        onError(errorMsg);
        return;
    }
    
    // Process any remaining data in the buffer (incomplete final line)
    if (!streamCtx.buffer.empty()) {
        std::string line = streamCtx.buffer;
        // Handle carriage return if it exists (from \r\n)
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        
        if (line.find("data: ") == 0) {
            std::string data = line.substr(6);
            if (data != "[DONE]") {
                // Parse the JSON delta
                Json::Value parsedJson;
                Json::CharReaderBuilder reader;
                std::string errs;
                std::istringstream dataStream(data);
                
                if (Json::parseFromStream(reader, dataStream, &parsedJson, &errs)) {
                    // Extract content and reasoning from choices[0].delta
                    std::string content;
                    std::string reasoning;
                    bool hasContent = false;
                    bool hasReasoning = false;
                    
                    if (parsedJson.isMember("choices") && parsedJson["choices"].isArray() &&
                        !parsedJson["choices"].empty() && parsedJson["choices"][0].isMember("delta")) {
                        const Json::Value& delta = parsedJson["choices"][0]["delta"];
                        
                        if (delta.isMember("content") && !delta["content"].asString().empty()) {
                            content = delta["content"].asString();
                            hasContent = true;
                        }
                        
                        if (delta.isMember("reasoning") && !delta["reasoning"].asString().empty()) {
                            reasoning = delta["reasoning"].asString();
                            hasReasoning = true;
                        }
                    }
                    
                    // Create new JSON object with only non-empty fields
                    if (hasContent || hasReasoning) {
                        Json::Value newDelta;
                        if (hasContent) {
                            newDelta["content"] = content;
                        }
                        if (hasReasoning) {
                            newDelta["reasoning"] = reasoning;
                        }
                        
                        Json::Value newChoice;
                        newChoice["delta"] = newDelta;
                        
                        Json::Value newJson;
                        newJson["choices"].append(newChoice);
                        
                        // Create reformatted SSE line
                        Json::StreamWriterBuilder writer;
                        writer["indentation"] = "";
                        std::string newData = Json::writeString(writer, newJson);
                        
                        if (onChunk) {
                            onChunk("data: " + newData + "\n\n");
                        }
                    }
                } else {
                    // If parsing fails, forward the original line
                    if (onChunk) {
                        onChunk(line + "\n\n");
                    }
                }
            }
        }
    }
    
    // Send final chunk to signal completion
    if (onChunk) {
        onChunk("data:[DONE]\n\n");
    }
}

Json::Value OpenRouterService::getModels() const {
    // Try to fetch models from OpenRouter first
    try {
        std::string decryptedKey = decryptApiKey();
        if (!decryptedKey.empty()) {
            CURL* curl = curl_easy_init();
            if (curl) {
                std::string responseStr;
                std::string url = "https://openrouter.ai/api/v1/models";
                
                struct curl_slist* headers = NULL;
                headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
                
                curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
                curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
                curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
                curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseStr);
                curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
                curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
                
                CURLcode res = curl_easy_perform(curl);
                long httpCode = 0;
                curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
                curl_slist_free_all(headers);
                curl_easy_cleanup(curl);
                
                if (res == CURLE_OK && httpCode == 200) {
                    Json::Value result;
                    Json::CharReaderBuilder reader;
                    std::string errs;
                    std::istringstream stream(responseStr);
                    if (Json::parseFromStream(reader, stream, &result, &errs)) {
                        if (result.isMember("data") && result["data"].isArray()) {
                            // Normalize the response to ensure consistent field names
                            Json::Value normalizedResponse;
                            normalizedResponse["data"] = Json::Value(Json::arrayValue);
                            
                            for (const auto& model : result["data"]) {
                                Json::Value normalizedModel;

                                // Copy basic fields
                                if (model.isMember("id")) {
                                    normalizedModel["id"] = model["id"];
                                }
                                if (model.isMember("name")) {
                                    normalizedModel["name"] = model["name"];
                                }
                                if (model.isMember("provider")) {
                                    normalizedModel["provider"] = model["provider"];
                                }

                                // Extract context_length
                                int contextLength = 0;
                                if (model.isMember("context_length")) {
                                    contextLength = model["context_length"].asInt();
                                    normalizedModel["context_length"] = contextLength;
                                }

                                // Extract strictly the max output tokens from OpenRouter
                                int maxTokens = 0;
                                if (model.isMember("top_provider") && model["top_provider"].isObject()) {
                                    const auto& topProvider = model["top_provider"];
                                    if (topProvider.isMember("max_completion_tokens")) {
                                        maxTokens = topProvider["max_completion_tokens"].asInt();
                                    }
                                }

                                // Default to 8192 if the API omits the completion limit entirely
                                const int DEFAULT_MAX_TOKENS = 8192;

                                if (maxTokens <= 0) {
                                    maxTokens = DEFAULT_MAX_TOKENS;
                                }

                                normalizedModel["max_tokens"] = maxTokens;

                                normalizedResponse["data"].append(normalizedModel);
                            }
                            
                            return normalizedResponse;
                        }
                    }
                }
            }
        }
    } catch (...) {
        // Fall back to default models if fetch fails
    }
    
    // Default models if API call fails
    Json::Value response;
    response["data"] = Json::Value(Json::arrayValue);
    
    Json::Value model1;
    model1["id"] = "openai/gpt-4o-mini";
    model1["name"] = "OpenAI GPT-4o Mini";
    model1["provider"] = "OpenAI";
    model1["context_length"] = 128000;
    model1["max_tokens"] = 16384;
    response["data"].append(model1);
    
    Json::Value model2;
    model2["id"] = "google/gemma-2-9b-it";
    model2["name"] = "Google Gemma 2 9B";
    model2["provider"] = "Google";
    model2["context_length"] = 8192;
    model2["max_tokens"] = 8192;
    response["data"].append(model2);
    
    Json::Value model3;
    model3["id"] = "meta-llama/llama-3-8b-instruct";
    model3["name"] = "Meta Llama 3 8B";
    model3["provider"] = "Meta";
    model3["context_length"] = 8192;
    model3["max_tokens"] = 8192;
    response["data"].append(model3);
    
    Json::Value model4;
    model4["id"] = "mistralai/mistral-7b-instruct-v0.3";
    model4["name"] = "Mistral 7B Instruct v0.3";
    model4["provider"] = "Mistral";
    model4["context_length"] = 32768;
    model4["max_tokens"] = 8192;
    response["data"].append(model4);
    
    return response;
}

Json::Value OpenRouterService::getPricing() const {
    Json::Value response;
    response["data"] = Json::Value(Json::arrayValue);
    
    Json::Value model1Pricing;
    model1Pricing["id"] = "openai/gpt-4o-mini";
    model1Pricing["price_per_1k_input"] = 0.00000015;
    model1Pricing["price_per_1k_output"] = 0.0000006;
    response["data"].append(model1Pricing);
    
    Json::Value model2Pricing;
    model2Pricing["id"] = "google/gemma-2-9b-it";
    model2Pricing["price_per_1k_input"] = 0.00000003;
    model2Pricing["price_per_1k_output"] = 0.00000009;
    response["data"].append(model2Pricing);
    
    Json::Value model3Pricing;
    model3Pricing["id"] = "meta-llama/llama-3-8b-instruct";
    model3Pricing["price_per_1k_input"] = 0.00000003;
    model3Pricing["price_per_1k_output"] = 0.00000004;
    response["data"].append(model3Pricing);
    
    Json::Value model4Pricing;
    model4Pricing["id"] = "mistralai/mistral-7b-instruct-v0.3";
    model4Pricing["price_per_1k_input"] = 0.0000002;
    model4Pricing["price_per_1k_output"] = 0.0000002;
    response["data"].append(model4Pricing);
    
    return response;
}

Json::Value OpenRouterService::makeRequest(const std::string& endpoint, const Json::Value& body) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize CURL");
    }
    
    std::string decryptedKey = decryptApiKey();
    
    if (decryptedKey.empty()) {
        Json::Value error;
        error["error"] = "OpenRouter API key not configured";
        return error;
    }
    
    std::string url = "https://openrouter.ai/api/v1" + endpoint;
    std::string responseStr;
    
    struct curl_slist* headers = NULL;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "HTTP-Referer: http://localhost");
    headers = curl_slist_append(headers, "X-Title: CtrlPanel");
    
    // Disable the "Expect: 100-continue" header that libcurl automatically
    // adds to payloads > 1024 bytes, as it frequently causes 400 errors.
    headers = curl_slist_append(headers, "Expect:");
    
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
    
    std::string jsonBody = body.toStyledString();
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)jsonBody.length());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseStr);
    curl_easy_setopt(curl, CURLOPT_FAILONERROR, 0L);
    
    CURLcode res = curl_easy_perform(curl);
    
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    
    Json::Value result;
    Json::CharReaderBuilder reader;
    std::string errs;
    std::istringstream stream(responseStr);
    
    if (res != CURLE_OK) {
        result["error"] = "Failed to connect to OpenRouter: " + std::string(curl_easy_strerror(res));
        return result;
    }
    
    if (httpCode != 200) {
        if (Json::parseFromStream(reader, stream, &result, &errs)) {
            if (result.isMember("error")) {
                return result;
            }
        }
        result["error"] = "HTTP error: " + std::to_string(httpCode);
        result["response"] = responseStr;
        return result;
    }
    
    if (!Json::parseFromStream(reader, stream, &result, &errs)) {
        result["error"] = "Failed to parse response";
        result["raw"] = responseStr;
        return result;
    }
    
    return result;
}

std::string OpenRouterService::decryptApiKey() const {
    if (apiKey.empty()) {
        return "";
    }
    
    // Check if it is a plain text OpenRouter key - if so, don't decrypt
    if (apiKey.substr(0, 6) == "sk-or-") {
        return apiKey;
    }
    
    try {
        return encryption.decrypt(apiKey);
    } catch (...) {
        return apiKey;
    }
}
