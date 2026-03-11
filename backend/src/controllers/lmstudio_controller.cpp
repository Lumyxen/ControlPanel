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
// StreamingCtx
// ─────────────────────────────────────────────────────────────────────────────

struct StreamingCtx {
    std::deque<std::string> chunks;
    std::mutex              mutex;
    bool                    done  = false;
    std::atomic<bool>       cancelled{false};
    std::string             error;
};

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
        if (!body.isMember("model") || !body.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        std::string model        = body["model"].asString();
        std::string prompt       = body["prompt"].asString();
        int maxTokens            = body.isMember("max_tokens")     ? body["max_tokens"].asInt()     : 8192;
        std::string systemPrompt = body.isMember("system_prompt")  ? body["system_prompt"].asString(): "";
        double temperature       = body.isMember("temperature")    ? body["temperature"].asDouble() : -1.0;
        int contextWindow        = body.isMember("context_window") ? body["context_window"].asInt() : 0;

        Json::Value tools = body.isMember("tools")
            ? body["tools"]
            : Json::Value(Json::arrayValue);

        // Inject MCP tools (lmstudio only — llama.cpp tool support is pending)
        const bool isLlamaCpp = model.rfind("llamacpp::", 0) == 0;

        if (!isLlamaCpp && registry && registry->liveCount() > 0) {
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

        if (isLlamaCpp) {
            // ── llama.cpp path ────────────────────────────────────────────────
            if (!llamaCppService || !llamaCppService->isReady()) {
                res.status = 503;
                res.set_content("{\"error\": \"No llama.cpp model loaded\"}", "application/json");
                return;
            }

            std::thread([ctx, llamaCppService, model, prompt, maxTokens,
                         systemPrompt, temperature, contextWindow]() mutable {
                auto onChunk = [ctx](const std::string& chunk) -> bool {
                    if (ctx->cancelled.load()) return false;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->chunks.push_back(chunk);
                    return true;
                };
                auto onError = [ctx](const std::string& err) {
                    if (ctx->cancelled.load()) return;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->error = err;
                    ctx->done  = true;
                };

                llamaCppService->streamingChatWithCallback(
                    model, prompt, maxTokens, onChunk, onError,
                    systemPrompt, temperature, contextWindow);

                std::lock_guard<std::mutex> lock(ctx->mutex);
                ctx->done = true;
            }).detach();

        } else {
            // ── lmstudio path ─────────────────────────────────────────────────
            const bool useTools = tools.isArray() && !tools.empty();

            std::thread([ctx, &service, registry, model, prompt, maxTokens,
                         systemPrompt, temperature, contextWindow, tools, useTools]() mutable {
                auto onChunk =[ctx](const std::string& chunk) -> bool {
                    if (ctx->cancelled.load()) return false;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->chunks.push_back(chunk);
                    return true;
                };
                auto onError = [ctx](const std::string& err) {
                    if (ctx->cancelled.load()) return;
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->error = err;
                    ctx->done  = true;
                };

                if (useTools) {
                    Json::Value messages = service.buildMessages(prompt, systemPrompt);
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

                if (!to_write.empty()) {
                    if (!sink.write(to_write.data(), to_write.size())) {
                        ctx->cancelled.store(true);
                        return false;
                    }
                }

                if (is_done) {
                    sink.done();
                } else if (to_write.empty()) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(20));
                }

                return true;
            }
        );

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

        // llama.cpp local models
        if (llamaCppService && llamaCppService->isReady()) {
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