#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include <curl/curl.h>
#include <json/json.h>
#include <iostream>
#include <sstream>
#include <vector>
#include <map>
#include <chrono>

static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

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
            continue;
        }

        Json::Value parsed;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream ds(data);
        if (!Json::parseFromStream(reader, ds, &parsed, &errs)) {
            if (ctx->onChunk) {
                if (!ctx->onChunk(line + "\n\n")) return 0;
            }
            continue;
        }

        if (parsed.isMember("error")) {
            Json::StreamWriterBuilder wb;
            wb["indentation"] = "";
            if (ctx->onChunk) {
                if (!ctx->onChunk("data: " + Json::writeString(wb, parsed) + "\n\n")) return 0;
            }
            ctx->finishReason = "_api_error_";
            continue;
        }

        if (!parsed.isMember("choices") || !parsed["choices"].isArray()
                || parsed["choices"].empty()) continue;

        const Json::Value& choice = parsed["choices"][0];

        if (choice.isMember("finish_reason") && !choice["finish_reason"].isNull()) {
            ctx->finishReason = choice["finish_reason"].asString();
        }

        if (!choice.isMember("delta")) continue;
        const Json::Value& delta = choice["delta"];

        if (delta.isMember("tool_calls") && delta["tool_calls"].isArray()) {
            for (const auto& tc : delta["tool_calls"]) {
                int idx = tc.get("index", 0).asInt();
                while ((int)ctx->toolCalls.size() <= idx)
                    ctx->toolCalls.push_back({});

                if (tc.isMember("id") && tc["id"].isString())
                    ctx->toolCalls[idx].id = tc["id"].asString();

                if (tc.isMember("function")) {
                    const auto& fn = tc["function"];
                    if (fn.isMember("name") && fn["name"].isString())
                        ctx->toolCalls[idx].name += fn["name"].asString();
                    if (fn.isMember("arguments") && fn["arguments"].isString())
                        ctx->toolCalls[idx].argumentsJson += fn["arguments"].asString();
                }
            }
            continue;
        }

        bool hasContent   = delta.isMember("content")   && delta["content"].isString() && !delta["content"].asString().empty();
        bool hasReasoning = delta.isMember("reasoning") && delta["reasoning"].isString() && !delta["reasoning"].asString().empty();

        if (hasContent || hasReasoning) {
            Json::Value newDelta;
            if (hasContent)   newDelta["content"]   = delta["content"].asString();
            if (hasReasoning) newDelta["reasoning"] = delta["reasoning"].asString();

            Json::Value newChoice;
            newChoice["delta"] = newDelta;

            Json::Value newJson;
            newJson["choices"].append(newChoice);

            Json::StreamWriterBuilder wb;
            wb["indentation"] = "";
            if (ctx->onChunk) {
                if (!ctx->onChunk("data: " + Json::writeString(wb, newJson) + "\n\n")) return 0;
            }
        }
    }

    return realsize;
}

static int ProgressCallback(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t ultotal, curl_off_t ulnow) {
    StreamContext* ctx = static_cast<StreamContext*>(clientp);
    if (ctx->onChunk && !ctx->onChunk("")) {
        return 1; // Return non-zero to abort the curl transfer immediately
    }
    return 0;
}

LmStudioService::LmStudioService() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
}

Json::Value LmStudioService::buildMessages(const std::string& prompt,
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

Json::Value LmStudioService::parseConversationHistory(const std::string& prompt) const {
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

Json::Value LmStudioService::chat(
        const std::string& model, const std::string& prompt,
        int maxTokens, const std::string& systemPrompt, double temperature) const {
    Json::Value body;
    body["model"]      = model;
    body["messages"]   = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    if (temperature >= 0.0) body["temperature"] = temperature;
    return makeRequest("/chat/completions", body);
}

std::string LmStudioService::streamOneRound(
        const Json::Value& requestBody,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::vector<StreamContext::ToolCallAccum>& toolCallsOut) const {

    CURL* curl = curl_easy_init();
    if (!curl) { onError("Failed to init CURL"); return "_internal_error_"; }

    Json::Value mutableBody = requestBody;
    std::string modelId = mutableBody.get("model", "").asString();
    if (modelId.rfind("lmstudio::", 0) == 0) {
        mutableBody["model"] = modelId.substr(10);
    }

    std::string url = lmStudioUrl_ + "/v1/chat/completions";
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    headers = curl_slist_append(headers, "Expect:");

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string jsonBody = Json::writeString(wb, mutableBody);

    StreamContext ctx;
    ctx.onChunk = onChunk;

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION,   CURL_HTTP_VERSION_1_1);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,  (long)jsonBody.size());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,     jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  WriteCallbackStream);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &ctx);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 120L);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, ProgressCallback);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &ctx);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res == CURLE_WRITE_ERROR || res == CURLE_ABORTED_BY_CALLBACK) {
        return "_cancelled_";
    }

    if (res != CURLE_OK) {
        onError(std::string("Connection error: ") + curl_easy_strerror(res));
        return "_internal_error_";
    }
    
    if (httpCode != 200) {
        std::string cleanMsg;
        if (!ctx.buffer.empty()) {
            Json::Value errJson;
            Json::CharReaderBuilder rb;
            std::string errs2;
            std::istringstream ss(ctx.buffer);
            if (Json::parseFromStream(rb, ss, &errJson, &errs2) && errJson.isMember("error")) {
                const Json::Value& errObj = errJson["error"];
                if (errObj.isObject()) {
                    cleanMsg = errObj.get("message", "").asString();
                } else if (errObj.isString()) {
                    cleanMsg = errObj.asString();
                }
            }
        }
        if (cleanMsg.empty()) {
            cleanMsg = "HTTP " + std::to_string(httpCode) + " error";
            if (!ctx.buffer.empty())
                cleanMsg += ": " + ctx.buffer.substr(0, 200);
        }
        onError(cleanMsg);
        return "_internal_error_";
    }

    toolCallsOut = std::move(ctx.toolCalls);
    return ctx.finishReason;
}

void LmStudioService::streamingChatWithCallback(
        const std::string& model, const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt, double temperature, int numCtx) const {

    Json::Value body;
    body["model"]      = model;
    body["messages"]   = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    body["stream"]     = true;
    if (temperature >= 0.0) body["temperature"] = temperature;
    if (numCtx > 0)         body["num_ctx"]     = numCtx;

    std::vector<StreamContext::ToolCallAccum> unused;
    std::string finishReason = streamOneRound(body, onChunk, onError, unused);

    if (finishReason != "_cancelled_") {
        if (onChunk) onChunk("data: [DONE]\n\n");
    }
}

void LmStudioService::streamingChatWithTools(
        const std::string& model,
        Json::Value messages,
        const Json::Value& tools,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        McpRegistry* registry,
        double temperature, int numCtx) const {

    for (;;) {
        Json::Value body;
        body["model"]      = model;
        body["messages"]   = messages;
        body["max_tokens"] = maxTokens;
        body["stream"]     = true;
        if (temperature >= 0.0) body["temperature"] = temperature;
        if (numCtx > 0)         body["num_ctx"]     = numCtx;

        if (!tools.isNull() && tools.isArray() && !tools.empty()) {
            body["tools"]       = tools;
            body["tool_choice"] = "auto";
        }

        std::vector<StreamContext::ToolCallAccum> toolCalls;
        const std::string finishReason = streamOneRound(body, onChunk, onError, toolCalls);

        if (finishReason == "_cancelled_") return;
        if (finishReason == "_internal_error_" || finishReason == "_api_error_") return;

        if (toolCalls.empty()) {
            break;
        }

        Json::Value assistantMsg;
        assistantMsg["role"]       = "assistant";
        assistantMsg["content"]    = Json::Value();
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

        for (const auto& tc : toolCalls) {
            if (onChunk) {
                Json::Value fakeChoice;
                fakeChoice["delta"]["reasoning"] = "\n*Executing tool: " + tc.name + "*\n";
                Json::Value fakeJson;
                fakeJson["choices"].append(fakeChoice);
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                if (!onChunk("data: " + Json::writeString(wb, fakeJson) + "\n\n")) return;
            }

            std::string resultStr;

            if (registry) {
                Json::Value args(Json::objectValue);
                if (!tc.argumentsJson.empty()) {
                    Json::CharReaderBuilder rb;
                    std::string errs;
                    std::istringstream ss(tc.argumentsJson);
                    Json::parseFromStream(rb, ss, &args, &errs);
                }

                Json::Value result = registry->callTool(tc.name, args);

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

            Json::Value toolResultMsg;
            toolResultMsg["role"]         = "tool";
            toolResultMsg["tool_call_id"] = tc.id;
            toolResultMsg["content"]      = resultStr;
            messages.append(toolResultMsg);

            if (onChunk) {
                Json::Value toolEvent;
                toolEvent["type"] = "tool_execution";
                toolEvent["tool_call"]["id"] = tc.id;
                toolEvent["tool_call"]["name"] = tc.name;
                toolEvent["tool_call"]["arguments"] = tc.argumentsJson;
                toolEvent["tool_call"]["output"] = resultStr;

                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                if (!onChunk("data: " + Json::writeString(wb, toolEvent) + "\n\n")) return;
            }
        }
    }

    if (onChunk) onChunk("data: [DONE]\n\n");
}

static Json::Value lmStudioGet(const std::string& url, long& httpCodeOut) {
    httpCodeOut = 0;
    CURL* curl = curl_easy_init();
    if (!curl) {
        Json::Value err; err["error"] = "Failed to init CURL"; return err;
    }
    std::string responseStr;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  WriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &responseStr);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        5L);

    CURLcode res = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCodeOut);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        Json::Value err;
        err["error"] = std::string("LM Studio unreachable: ") + curl_easy_strerror(res);
        return err;
    }
    if (httpCodeOut != 200) {
        Json::Value err;
        err["error"] = "LM Studio returned HTTP " + std::to_string(httpCodeOut);
        return err;
    }

    Json::Value result;
    Json::CharReaderBuilder reader;
    std::string errs;
    std::istringstream stream(responseStr);
    if (!Json::parseFromStream(reader, stream, &result, &errs)) {
        Json::Value err; err["error"] = "Failed to parse LM Studio response"; return err;
    }
    return result;
}

Json::Value LmStudioService::getModels() const {
    std::map<std::string, int> nativeCtxMap;
    {
        long httpCode = 0;
        Json::Value nativeResult = lmStudioGet(lmStudioUrl_ + "/api/v1/models", httpCode);
        if (httpCode == 200 && nativeResult.isMember("data") && nativeResult["data"].isArray()) {
            for (const auto& m : nativeResult["data"]) {
                std::string id = m.get("id", "").asString();
                if (id.empty()) continue;
                if (m.isMember("max_context_length") && m["max_context_length"].isInt()) {
                    nativeCtxMap[id] = m["max_context_length"].asInt();
                }
            }
        }
    }

    long httpCode = 0;
    Json::Value result = lmStudioGet(lmStudioUrl_ + "/v1/models", httpCode);
    if (httpCode != 200) return result;

    Json::Value out;
    out["data"] = Json::Value(Json::arrayValue);
    const Json::Value& src = result.isMember("data") ? result["data"] : result;
    if (!src.isArray()) return out;

    for (const auto& m : src) {
        std::string id = m.get("id", "").asString();
        if (id.empty()) continue;

        Json::Value nm;
        nm["id"]     = "lmstudio::" + id;
        nm["name"]   = m.isMember("name") ? m["name"] : Json::Value(id);
        nm["source"] = "lmstudio";

        int ctx_len = 0;
        auto it = nativeCtxMap.find(id);
        if (it != nativeCtxMap.end() && it->second > 0) {
            ctx_len = it->second;
        }
        if (ctx_len <= 0) {
            if      (m.isMember("context_length")          && m["context_length"].isInt())          ctx_len = m["context_length"].asInt();
            else if (m.isMember("context_window")          && m["context_window"].isInt())          ctx_len = m["context_window"].asInt();
            else if (m.isMember("max_context_length")      && m["max_context_length"].isInt())      ctx_len = m["max_context_length"].asInt();
            else if (m.isMember("max_position_embeddings") && m["max_position_embeddings"].isInt()) ctx_len = m["max_position_embeddings"].asInt();
            else if (m.isMember("architecture") && m["architecture"].isObject()
                     && m["architecture"].isMember("context_length"))                               ctx_len = m["architecture"]["context_length"].asInt();
        }
        if (ctx_len <= 0) ctx_len = 8192;
        nm["context_length"] = ctx_len;

        int max_tokens = 8192;
        if      (m.isMember("max_tokens")            && m["max_tokens"].isInt())            max_tokens = m["max_tokens"].asInt();
        else if (m.isMember("max_completion_tokens") && m["max_completion_tokens"].isInt()) max_tokens = m["max_completion_tokens"].asInt();
        nm["max_tokens"] = max_tokens;

        out["data"].append(nm);
    }
    return out;
}

Json::Value LmStudioService::makeRequest(const std::string& endpoint,
                                            const Json::Value& body) const {
    CURL* curl = curl_easy_init();
    if (!curl) throw std::runtime_error("Failed to init CURL");

    Json::Value mutableBody = body;
    std::string modelId = mutableBody.get("model", "").asString();
    if (modelId.rfind("lmstudio::", 0) == 0) {
        mutableBody["model"] = modelId.substr(10);
    }

    std::string url = lmStudioUrl_ + "/v1" + endpoint;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Expect:");

    std::string jsonBody = mutableBody.toStyledString();
    std::string responseStr;
    
    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION,   CURL_HTTP_VERSION_1_1);
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
        result["error"] = "Failed to connect: " + std::string(curl_easy_strerror(res));
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