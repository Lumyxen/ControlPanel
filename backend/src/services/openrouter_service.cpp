#include "services/openrouter_service.h"
#include "services/mcp_registry.h"
#include <curl/curl.h>
#include <json/json.h>
#include <iostream>
#include <sstream>
#include <vector>

// ── libcurl helpers ───────────────────────────────────────────────────────────
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

static size_t WriteCallbackErrorBuffer(char* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

// ── Streaming write callback ──────────────────────────────────────────────────
// Processes SSE lines.  Forwards content/reasoning chunks via onChunk.
// Accumulates tool_calls for the caller to inspect after the stream ends.
static size_t WriteCallbackStream(char* contents, size_t size, size_t nmemb, void* userp) {
    StreamContext* ctx = static_cast<StreamContext*>(userp);
    size_t realsize = size * nmemb;

    ctx->buffer.append(contents, realsize);

    size_t pos;
    while ((pos = ctx->buffer.find('\n')) != std::string::npos) {
        std::string line = ctx->buffer.substr(0, pos);
        ctx->buffer.erase(0, pos + 1);

        if (!line.empty() && line.back() == '\r') line.pop_back();

        if (line.find("data: ") != 0) continue;

        std::string data = line.substr(6);

        if (data == "[DONE]") {
            // Do NOT forward [DONE] to the client yet; it will be sent when all rounds are complete.
            continue;
        }

        Json::Value parsed;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream ds(data);
        if (!Json::parseFromStream(reader, ds, &parsed, &errs)) {
            if (ctx->onChunk) ctx->onChunk(line + "\n\n");
            continue;
        }

        // Handle direct SSE stream errors from OpenRouter
        if (parsed.isMember("error")) {
            Json::StreamWriterBuilder wb;
            wb["indentation"] = "";
            if (ctx->onChunk) ctx->onChunk("data: " + Json::writeString(wb, parsed) + "\n\n");
            ctx->finishReason = "_api_error_";
            continue;
        }

        if (!parsed.isMember("choices") || !parsed["choices"].isArray()
                || parsed["choices"].empty()) continue;

        const Json::Value& choice = parsed["choices"][0];

        // Capture finish_reason when present
        if (choice.isMember("finish_reason") && !choice["finish_reason"].isNull()) {
            ctx->finishReason = choice["finish_reason"].asString();
        }

        if (!choice.isMember("delta")) continue;
        const Json::Value& delta = choice["delta"];

        // ── Accumulate tool_calls ─────────────────────────────────────────────
        if (delta.isMember("tool_calls") && delta["tool_calls"].isArray()) {
            for (const auto& tc : delta["tool_calls"]) {
                int idx = tc.get("index", 0).asInt();
                while ((int)ctx->toolCalls.size() <= idx)
                    ctx->toolCalls.push_back({});

                if (tc.isMember("id"))
                    ctx->toolCalls[idx].id = tc["id"].asString();

                if (tc.isMember("function")) {
                    const auto& fn = tc["function"];
                    if (fn.isMember("name"))
                        ctx->toolCalls[idx].name += fn["name"].asString();
                    if (fn.isMember("arguments"))
                        ctx->toolCalls[idx].argumentsJson += fn["arguments"].asString();
                }
            }
            // Do NOT forward tool_call deltas to the client
            continue;
        }

        // ── Forward content / reasoning ───────────────────────────────────────
        bool hasContent   = delta.isMember("content")   && !delta["content"].asString().empty();
        bool hasReasoning = delta.isMember("reasoning") && !delta["reasoning"].asString().empty();

        if (hasContent || hasReasoning) {
            Json::Value newDelta;
            if (hasContent)   newDelta["content"]   = delta["content"].asString();
            if (hasReasoning) newDelta["reasoning"]  = delta["reasoning"].asString();

            Json::Value newChoice;
            newChoice["delta"] = newDelta;

            Json::Value newJson;
            newJson["choices"].append(newChoice);

            Json::StreamWriterBuilder wb;
            wb["indentation"] = "";
            if (ctx->onChunk)
                ctx->onChunk("data: " + Json::writeString(wb, newJson) + "\n\n");
        }
    }

    return realsize;
}

// ── Constructor ───────────────────────────────────────────────────────────────
OpenRouterService::OpenRouterService(const std::string& apiKey, Encryption& encryption)
    : apiKey(apiKey), encryption(encryption) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

// ── buildMessages ─────────────────────────────────────────────────────────────
Json::Value OpenRouterService::buildMessages(const std::string& prompt,
                                              const std::string& systemPrompt) const {
    Json::Value messages(Json::arrayValue);
    if (!systemPrompt.empty()) {
        Json::Value sys;
        sys["role"]    = "system";
        sys["content"] = systemPrompt;
        messages.append(sys);
    }
    for (const auto& m : parseConversationHistory(prompt))
        messages.append(m);
    return messages;
}

// ── Legacy helpers ────────────────────────────────────────────────────────────
Json::Value OpenRouterService::parseConversationHistory(const std::string& prompt) const {
    Json::Value messages(Json::arrayValue);
    std::vector<std::string> lines;
    std::string current;
    std::istringstream stream(prompt);
    std::string line;

    while (std::getline(stream, line)) {
        if ((line.find("User:") == 0 || line.find("Assistant:") == 0) && !current.empty()) {
            lines.push_back(current);
            current = line;
        } else {
            if (!current.empty()) current += "\n";
            current += line;
        }
    }
    if (!current.empty()) lines.push_back(current);

    if (lines.empty()) {
        std::string delimiter = "\n\n", token, tempPrompt = prompt;
        size_t p = 0;
        while ((p = tempPrompt.find(delimiter)) != std::string::npos) {
            token = tempPrompt.substr(0, p);
            if (!token.empty()) lines.push_back(token);
            tempPrompt.erase(0, p + delimiter.length());
        }
        if (!tempPrompt.empty()) lines.push_back(tempPrompt);
    }

    for (const std::string& msgLine : lines) {
        std::string trimmed = msgLine;
        size_t start = trimmed.find_first_not_of(" \t\n\r");
        if (start != std::string::npos) trimmed = trimmed.substr(start);

        Json::Value message;
        if (trimmed.find("User:") == 0) {
            message["role"]    = "user";
            std::string c = trimmed.substr(5);
            size_t cs = c.find_first_not_of(" \t");
            if (cs != std::string::npos) c = c.substr(cs);
            message["content"] = c;
            messages.append(message);
        } else if (trimmed.find("Assistant:") == 0) {
            message["role"]    = "assistant";
            std::string c = trimmed.substr(10);
            size_t cs = c.find_first_not_of(" \t");
            if (cs != std::string::npos) c = c.substr(cs);
            message["content"] = c;
            messages.append(message);
        } else if (!trimmed.empty()) {
            message["role"]    = "user";
            message["content"] = trimmed;
            messages.append(message);
        }
    }

    if (messages.empty() && !prompt.empty()) {
        Json::Value m;
        m["role"]    = "user";
        m["content"] = prompt;
        messages.append(m);
    }
    return messages;
}

// ── chat (non-streaming) ──────────────────────────────────────────────────────
Json::Value OpenRouterService::chat(
        const std::string& model, const std::string& prompt,
        int maxTokens, const std::string& systemPrompt, double temperature) const {
    Json::Value body;
    body["model"]      = model;
    body["messages"]   = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    if (temperature >= 0.0) body["temperature"] = temperature;
    return makeRequest("/chat/completions", body);
}

// ── streamingChat (simple, non-tool) ─────────────────────────────────────────
Json::Value OpenRouterService::streamingChat(
        const std::string& model, const std::string& prompt,
        int maxTokens, const std::string& systemPrompt, double temperature) const {
    Json::Value body;
    body["model"]      = model;
    body["messages"]   = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    body["stream"]     = true;
    if (temperature >= 0.0) body["temperature"] = temperature;
    return makeRequest("/chat/completions", body);
}

// ── streamOneRound ────────────────────────────────────────────────────────────
// Executes one streaming request and returns the finish_reason string.
// Tool call deltas are accumulated into toolCallsOut; content is forwarded via onChunk.
std::string OpenRouterService::streamOneRound(
        const Json::Value& requestBody,
        std::function<void(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::vector<StreamContext::ToolCallAccum>& toolCallsOut) const {

    CURL* curl = curl_easy_init();
    if (!curl) { onError("Failed to init CURL"); return "_internal_error_"; }

    std::string decryptedKey = decryptApiKey();
    if (decryptedKey.empty()) {
        onError("OpenRouter API key not configured");
        curl_easy_cleanup(curl);
        return "_internal_error_";
    }

    const std::string url = "https://openrouter.ai/api/v1/chat/completions";

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "HTTP-Referer: http://localhost");
    headers = curl_slist_append(headers, "X-Title: CtrlPanel");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    headers = curl_slist_append(headers, "Expect:");

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string jsonBody = Json::writeString(wb, requestBody);

    StreamContext ctx;
    ctx.onChunk = onChunk;

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION,   CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,  (long)jsonBody.size());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,     jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  WriteCallbackStream);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &ctx);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L); // Abort if stalled
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 120L); // for 120 seconds

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        onError(std::string("CURL error: ") + curl_easy_strerror(res));
        return "_internal_error_";
    }
    if (httpCode != 200) {
        onError("HTTP error: " + std::to_string(httpCode)
                + (ctx.buffer.empty() ? "" : " - " + ctx.buffer.substr(0, 300)));
        return "_internal_error_";
    }

    toolCallsOut = std::move(ctx.toolCalls);
    return ctx.finishReason;
}

// ── streamingChatWithCallback (legacy, no tool loop) ─────────────────────────
void OpenRouterService::streamingChatWithCallback(
        const std::string& model, const std::string& prompt,
        int maxTokens,
        std::function<void(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt, double temperature) const {

    Json::Value body;
    body["model"]      = model;
    body["messages"]   = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    body["stream"]     = true;
    if (temperature >= 0.0) body["temperature"] = temperature;

    std::vector<StreamContext::ToolCallAccum> unused;
    streamOneRound(body, onChunk, onError, unused);

    if (onChunk) onChunk("data: [DONE]\n\n");
}

// ── streamingChatWithTools (agentic tool loop) ────────────────────────────────
void OpenRouterService::streamingChatWithTools(
        const std::string& model,
        Json::Value messages,
        const Json::Value& tools,
        int maxTokens,
        std::function<void(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        McpRegistry* registry,
        double temperature) const {

    for (;;) {
        // Build request body
        Json::Value body;
        body["model"]      = model;
        body["messages"]   = messages;
        body["max_tokens"] = maxTokens;
        body["stream"]     = true;
        if (temperature >= 0.0) body["temperature"] = temperature;

        // Attach tools on every round so the model can keep using them
        if (!tools.isNull() && tools.isArray() && !tools.empty()) {
            body["tools"]       = tools;
            body["tool_choice"] = "auto";
        }

        std::vector<StreamContext::ToolCallAccum> toolCalls;
        const std::string finishReason = streamOneRound(body, onChunk, onError, toolCalls);

        if (finishReason == "_internal_error_" || finishReason == "_api_error_") {
            return; // Error already sent up the pipe via WriteCallbackStream or onError
        }

        // ── No tool calls → we're done ────────────────────────────────────────
        if (toolCalls.empty()) {
            break;
        }

        if (finishReason != "tool_calls") {
            std::cout << "[OpenRouter] Unexpected finish_reason '" << finishReason
                      << "' with tool_calls present — continuing\n";
        }

        // ── Execute tool calls ────────────────────────────────────────────────
        // 1. Append the assistant's tool-use message
        Json::Value assistantMsg;
        assistantMsg["role"]       = "assistant";
        assistantMsg["content"]    = Json::Value();  // null content during tool use
        assistantMsg["tool_calls"] = Json::Value(Json::arrayValue);

        for (const auto& tc : toolCalls) {
            Json::Value tcObj;
            tcObj["id"]   = tc.id;
            tcObj["type"] = "function";
            tcObj["function"]["name"]      = tc.name;
            tcObj["function"]["arguments"] = tc.argumentsJson;
            assistantMsg["tool_calls"].append(tcObj);
        }
        messages.append(assistantMsg);

        // 2. Execute each tool and append result messages
        for (const auto& tc : toolCalls) {
            std::cout << "[OpenRouter] Executing tool: " << tc.name << "\n";

            // Parse arguments first so we can send them to the frontend
            Json::Value args(Json::objectValue);
            if (!tc.argumentsJson.empty()) {
                Json::CharReaderBuilder rb;
                std::string errs;
                std::istringstream ss(tc.argumentsJson);
                Json::parseFromStream(rb, ss, &args, &errs);
            }

            std::string resultStr;

            if (registry) {
                Json::Value result = registry->callTool(tc.name, args);

                // Convert MCP content array → plain string for the tool message
                if (result.isArray()) {
                    for (const auto& item : result) {
                        if (item.get("type", "").asString() == "text")
                            resultStr += item.get("text", "").asString();
                    }
                } else {
                    Json::StreamWriterBuilder wb;
                    wb["indentation"] = "";
                    resultStr = Json::writeString(wb, result);
                }
            } else {
                resultStr = "{\"error\": \"No MCP registry available\"}";
            }

            // Send a structured tool_call event so the frontend can display
            // the tool name, input arguments, and output result visually.
            if (onChunk) {
                Json::Value tcEvent;
                tcEvent["tool_call"]["name"]   = tc.name;
                tcEvent["tool_call"]["input"]  = args;
                tcEvent["tool_call"]["output"] = resultStr;
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                onChunk("data: " + Json::writeString(wb, tcEvent) + "\n\n");
            }

            Json::Value toolResultMsg;
            toolResultMsg["role"]         = "tool";
            toolResultMsg["tool_call_id"] = tc.id;
            toolResultMsg["content"]      = resultStr;
            messages.append(toolResultMsg);
        }

        // Loop to next round with updated messages
    }

    if (onChunk) onChunk("data: [DONE]\n\n");
}

// ── getModels ─────────────────────────────────────────────────────────────────
Json::Value OpenRouterService::getModels() const {
    try {
        std::string decryptedKey = decryptApiKey();
        if (!decryptedKey.empty()) {
            CURL* curl = curl_easy_init();
            if (curl) {
                std::string url = "https://openrouter.ai/api/v1/models";
                std::string responseStr;
                struct curl_slist* headers = nullptr;
                headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
                headers = curl_slist_append(headers, "Content-Type: application/json");

                curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
                curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
                curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  WriteCallback);
                curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &responseStr);
                curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
                curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
                curl_easy_setopt(curl, CURLOPT_TIMEOUT,        30L);

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
                    if (Json::parseFromStream(reader, stream, &result, &errs)
                            && result.isMember("data") && result["data"].isArray()) {
                        Json::Value normalizedResponse;
                        normalizedResponse["data"] = Json::Value(Json::arrayValue);
                        for (const auto& model : result["data"]) {
                            Json::Value nm;
                            if (model.isMember("id"))   nm["id"]   = model["id"];
                            if (model.isMember("name")) nm["name"] = model["name"];
                            if (model.isMember("provider")) nm["provider"] = model["provider"];
                            if (model.isMember("context_length")) nm["context_length"] = model["context_length"];
                            int maxTokens = 0;
                            if (model.isMember("top_provider") && model["top_provider"].isObject()
                                    && model["top_provider"].isMember("max_completion_tokens"))
                                maxTokens = model["top_provider"]["max_completion_tokens"].asInt();
                            nm["max_tokens"] = maxTokens > 0 ? maxTokens : 8192;
                            normalizedResponse["data"].append(nm);
                        }
                        return normalizedResponse;
                    }
                }
            }
        }
    } catch (...) {}

    // Fallback
    Json::Value response;
    response["data"] = Json::Value(Json::arrayValue);
    auto addModel = [&](const char* id, const char* name, const char* prov,
                        int ctx, int mt) {
        Json::Value m;
        m["id"] = id; m["name"] = name; m["provider"] = prov;
        m["context_length"] = ctx; m["max_tokens"] = mt;
        response["data"].append(m);
    };
    addModel("openai/gpt-4o-mini",                    "OpenAI GPT-4o Mini",        "OpenAI",   128000, 16384);
    addModel("google/gemma-2-9b-it",                  "Google Gemma 2 9B",         "Google",     8192,  8192);
    addModel("meta-llama/llama-3-8b-instruct",        "Meta Llama 3 8B",           "Meta",       8192,  8192);
    addModel("mistralai/mistral-7b-instruct-v0.3",    "Mistral 7B Instruct v0.3",  "Mistral",  32768,  8192);
    return response;
}

// ── getPricing ────────────────────────────────────────────────────────────────
Json::Value OpenRouterService::getPricing() const {
    Json::Value response;
    response["data"] = Json::Value(Json::arrayValue);
    return response;
}

// ── makeRequest ───────────────────────────────────────────────────────────────
Json::Value OpenRouterService::makeRequest(const std::string& endpoint,
                                            const Json::Value& body) const {
    CURL* curl = curl_easy_init();
    if (!curl) throw std::runtime_error("Failed to init CURL");

    const std::string decryptedKey = decryptApiKey();
    if (decryptedKey.empty()) {
        Json::Value err;
        err["error"] = "OpenRouter API key not configured";
        return err;
    }

    std::string url = "https://openrouter.ai/api/v1" + endpoint;
    std::string responseStr;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("Authorization: Bearer " + decryptedKey).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "HTTP-Referer: http://localhost");
    headers = curl_slist_append(headers, "X-Title: CtrlPanel");
    headers = curl_slist_append(headers, "Expect:");

    std::string jsonBody = body.toStyledString();
    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION,   CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,  (long)jsonBody.size());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,     jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &responseStr);
    curl_easy_setopt(curl, CURLOPT_FAILONERROR,    0L);

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
        if (Json::parseFromStream(reader, stream, &result, &errs) && result.isMember("error"))
            return result;
        result["error"] = "HTTP error: " + std::to_string(httpCode);
        return result;
    }
    if (!Json::parseFromStream(reader, stream, &result, &errs)) {
        result["error"] = "Failed to parse response";
        result["raw"]   = responseStr;
    }
    return result;
}

// ── decryptApiKey ─────────────────────────────────────────────────────────────
std::string OpenRouterService::decryptApiKey() const {
    if (apiKey.empty()) return "";
    if (apiKey.substr(0, 6) == "sk-or-") return apiKey;
    try { return encryption.decrypt(apiKey); } catch (...) { return apiKey; }
}