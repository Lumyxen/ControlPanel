// backend/src/controllers/lmstudio_controller.cpp
#include "controllers/lmstudio_controller.h"
#include "services/mcp_registry.h"
#include <json/json.h>
#include <sstream>
#include <mutex>
#include <deque>
#include <thread>
#include <chrono>
#include <iostream>
#include <atomic>
#include <unordered_map>
#include <shared_mutex>

// ─────────────────────────────────────────────────────────────────────────────
// Stream state registry for explicit cancellation
// ─────────────────────────────────────────────────────────────────────────────

struct StreamingCtx {
    std::deque<std::string> chunks;
    std::mutex              mutex;
    bool                    done  = false;
    std::atomic<bool>       cancelled{false};
    std::string             error;
    std::chrono::steady_clock::time_point last_write = std::chrono::steady_clock::now();
};

static std::unordered_map<std::string, std::shared_ptr<StreamingCtx>> g_active_streams;
static std::shared_mutex g_active_streams_mutex;

// ─────────────────────────────────────────────────────────────────────────────
// handleStopStream
// ─────────────────────────────────────────────────────────────────────────────

void handleStopStream(const httplib::Request& req, httplib::Response& res) {
    try {
        Json::Value body;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }

        std::string stream_id = body.isMember("stream_id") ? body["stream_id"].asString() : "";
        if (!stream_id.empty()) {
            std::shared_lock<std::shared_mutex> lock(g_active_streams_mutex);
            auto it = g_active_streams.find(stream_id);
            if (it != g_active_streams.end()) {
                it->second->cancelled.store(true);
                std::cout << "[Streaming] Explicitly cancelled stream " << stream_id << "\n";
            }
        }
        res.status = 200;
        res.set_content("{\"status\": \"stopped\"}", "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleChat  (non-streaming, lmstudio only)
// ─────────────────────────────────────────────────────────────────────────────

void handleChat(const httplib::Request& req, httplib::Response& res, LmStudioService& service) {
    try {
        Json::Value body;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }
        if (!body.isMember("model") || !body.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        std::string model        = body["model"].asString();
        std::string prompt       = body["prompt"].asString();
        int maxTokens            = body.isMember("max_tokens")    ? body["max_tokens"].asInt()     : 8192;
        std::string systemPrompt = body.isMember("system_prompt") ? body["system_prompt"].asString(): "";
        double temperature       = body.isMember("temperature")   ? body["temperature"].asDouble() : -1.0;

        auto response = service.chat(model, prompt, maxTokens, systemPrompt, temperature);
        res.status = 200;
        res.set_content(response.toStyledString(), "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleStreaming
// ─────────────────────────────────────────────────────────────────────────────

void handleStreaming(const httplib::Request& req, httplib::Response& res,
                     LmStudioService& service, McpRegistry* registry,
                     LlamaCppService* llamaCppService) {
    try {
        Json::Value body;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &body, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }
        // The frontend always sends "prompt" (used by llama.cpp and text-only LM Studio)
        // and additionally sends "messages" when the thread contains image content blocks
        // (for vision-capable models). Both fields are validated below.
        if (!body.isMember("model") || !body.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        // "messages" is only present when the thread has image content (vision request).
        const bool hasPrebuiltMessages = body.isMember("messages") && body["messages"].isArray()
                                         && !body["messages"].empty();

        std::string model        = body["model"].asString();
        std::string prompt       = body["prompt"].asString();
        int maxTokens            = body.isMember("max_tokens")     ? body["max_tokens"].asInt()      : 8192;
        std::string systemPrompt = body.isMember("system_prompt")  ? body["system_prompt"].asString(): "";
        double temperature       = body.isMember("temperature")    ? body["temperature"].asDouble()  : -1.0;
        int contextWindow        = body.isMember("context_window") ? body["context_window"].asInt()  : 0;
        std::string stream_id    = body.isMember("stream_id")      ? body["stream_id"].asString()    : "";

        // If the frontend sent a structured messages array, use it directly so that
        // image content blocks (type: "image_url") are forwarded to the model as-is,
        // enabling vision on any model that supports it.  Prepend the system prompt
        // as the first message when one is configured.
        Json::Value prebuiltMessages(Json::arrayValue);
        if (hasPrebuiltMessages) {
            if (!systemPrompt.empty()) {
                Json::Value sysMsg;
                sysMsg["role"]    = "system";
                sysMsg["content"] = systemPrompt;
                prebuiltMessages.append(sysMsg);
            }
            for (const auto& m : body["messages"])
                prebuiltMessages.append(m);
        }

        Json::Value tools = body.isMember("tools")
            ? body["tools"]
            : Json::Value(Json::arrayValue);

        // Inject MCP tools for all backends (llama.cpp and LM Studio)
        if (registry && registry->liveCount() > 0) {
            Json::Value mcpTools = registry->getAggregatedTools();
            for (const auto& t : mcpTools)
                tools.append(t);
            std::cout << "[Streaming] Injected " << mcpTools.size()
                      << " MCP tool(s) into request\n";
        }

        res.set_header("Content-Type",  "text/event-stream");
        res.set_header("Cache-Control", "no-cache");
        res.set_header("Connection",    "keep-alive");

        auto ctx = std::make_shared<StreamingCtx>();

        if (!stream_id.empty()) {
            std::unique_lock<std::shared_mutex> lock(g_active_streams_mutex);
            g_active_streams[stream_id] = ctx;
        }

        const bool isLlamaCpp = model.rfind("llamacpp::", 0) == 0;

        if (isLlamaCpp) {
            // ── llama.cpp path ────────────────────────────────────────────────
            if (!llamaCppService) {
                res.status = 503;
                res.set_content("{\"error\": \"llama.cpp service not available\"}", "application/json");
                return;
            }

            // Always use streamingChatWithTools so that MCP tools and vision
            // messages are handled uniformly.  When tools is empty and there
            // are no prebuilt messages the service falls back to plain inference.
            Json::Value llamaMessages = hasPrebuiltMessages
                ? prebuiltMessages
                : llamaCppService->buildMessages(prompt, systemPrompt);

            std::thread([ctx, llamaCppService, model, llamaMessages, tools,
                         maxTokens, temperature, contextWindow, registry]() mutable {
                auto onChunk = [ctx](const std::string& chunk) -> bool {
                    if (ctx->cancelled.load()) return false;
                    if (!chunk.empty()) {
                        std::lock_guard<std::mutex> lock(ctx->mutex);
                        ctx->chunks.push_back(chunk);
                    }
                    return true;
                };
                auto onError = [ctx](const std::string& err) {
                    if (ctx->cancelled.load()) return;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->error = err;
                    ctx->done  = true;
                };

                llamaCppService->streamingChatWithTools(
                    model, llamaMessages, tools,
                    maxTokens, onChunk, onError, registry,
                    temperature, contextWindow);

                std::lock_guard<std::mutex> lock(ctx->mutex);
                ctx->done = true;
            }).detach();

        } else {
            // ── lmstudio path ─────────────────────────────────────────────────
            const bool useTools = tools.isArray() && !tools.empty();

            std::thread([ctx, &service, registry, model, prompt, maxTokens,
                         systemPrompt, temperature, contextWindow, tools,
                         useTools, hasPrebuiltMessages, prebuiltMessages]() mutable {
                auto onChunk =[ctx](const std::string& chunk) -> bool {
                    if (ctx->cancelled.load()) return false;
                    if (!chunk.empty()) {
                        std::lock_guard<std::mutex> lock(ctx->mutex);
                        ctx->chunks.push_back(chunk);
                    }
                    return true;
                };
                auto onError = [ctx](const std::string& err) {
                    if (ctx->cancelled.load()) return;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->error = err;
                    ctx->done  = true;
                };

                if (useTools || hasPrebuiltMessages) {
                    // Use streamingChatWithTools for both tool calls and vision:
                    //   - It accepts a pre-built messages array (preserving image_url blocks)
                    //   - With an empty tools array it does a single round with no tool_choice
                    Json::Value messages = hasPrebuiltMessages
                        ? prebuiltMessages
                        : service.buildMessages(prompt, systemPrompt);
                    service.streamingChatWithTools(
                        model, messages, tools, maxTokens,
                        onChunk, onError, registry, temperature, contextWindow);
                } else {
                    service.streamingChatWithCallback(
                        model, prompt, maxTokens, onChunk, onError,
                        systemPrompt, temperature, contextWindow);
                }

                std::lock_guard<std::mutex> lock(ctx->mutex);
                ctx->done = true;
            }).detach();
        }

        // ── SSE content provider (same for both paths) ────────────────────────
        res.set_content_provider(
            "text/event-stream",
            [ctx](size_t /*offset*/, httplib::DataSink& sink) -> bool {
                if (ctx->cancelled.load()) {
                    return false;
                }

                if (!sink.is_writable()) {
                    ctx->cancelled.store(true);
                    return false;
                }

                std::string to_write;
                bool is_done = false;

                {
                    std::lock_guard<std::mutex> lock(ctx->mutex);

                    if (!ctx->error.empty()) {
                        Json::Value errObj;
                        errObj["error"] = ctx->error;
                        Json::StreamWriterBuilder wb;
                        wb["indentation"] = "";
                        std::string errChunk = "data: " + Json::writeString(wb, errObj) + "\n\n";
                        sink.write(errChunk.data(), errChunk.size());
                        sink.done();
                        return true;
                    }

                    if (ctx->chunks.empty()) {
                        is_done = ctx->done;
                    } else {
                        while (!ctx->chunks.empty()) {
                            to_write += ctx->chunks.front();
                            ctx->chunks.pop_front();
                        }
                    }
                }

                auto now = std::chrono::steady_clock::now();

                if (!to_write.empty()) {
                    if (!sink.write(to_write.data(), to_write.size())) {
                        ctx->cancelled.store(true);
                        return false;
                    }
                    ctx->last_write = now;
                }

                if (is_done) {
                    sink.done();
                } else if (to_write.empty()) {
                    // Occasionally flush an empty SSE comment to reliably detect dropped HTTP client connections
                    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - ctx->last_write).count() >= 500) {
                        if (!sink.write(":\n\n", 3)) {
                            ctx->cancelled.store(true);
                            return false;
                        }
                        ctx->last_write = now;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(20));
                }

                return !ctx->cancelled.load();
            },[stream_id](bool /*success*/) {
                if (!stream_id.empty()) {
                    std::unique_lock<std::shared_mutex> lock(g_active_streams_mutex);
                    g_active_streams.erase(stream_id);
                }
            }
        );

    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleLmStudioModels  — returns ONLY LM Studio models (for URL testing)
// ─────────────────────────────────────────────────────────────────────────────

void handleLmStudioModels(const httplib::Request& /*req*/, httplib::Response& res,
                          LmStudioService& service) {
    try {
        Json::Value models = service.getModels();
        res.status = 200;
        res.set_content(models.toStyledString(), "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// handleModels  — merges LM Studio + llama.cpp model lists
// ─────────────────────────────────────────────────────────────────────────────

void handleModels(const httplib::Request& /*req*/, httplib::Response& res,
                  LmStudioService& service, LlamaCppService* llamaCppService) {
    try {
        Json::Value combined;
        combined["data"] = Json::Value(Json::arrayValue);

        // LM Studio models (may fail / return empty if server is down)
        Json::Value lmsModels = service.getModels();
        if (lmsModels.isMember("data") && lmsModels["data"].isArray()) {
            for (const auto& m : lmsModels["data"])
                combined["data"].append(m);
        }

        // llama.cpp local models (directory scan — no model needs to be loaded)
        if (llamaCppService) {
            Json::Value lcpModels = llamaCppService->getModels();
            if (lcpModels.isMember("data") && lcpModels["data"].isArray()) {
                for (const auto& m : lcpModels["data"])
                    combined["data"].append(m);
            }
        }

        res.status = 200;
        res.set_content(combined.toStyledString(), "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}