#include "controllers/openrouter_controller.h"
#include "services/mcp_registry.h"
#include <json/json.h>
#include <sstream>
#include <mutex>
#include <deque>
#include <thread>
#include <chrono>
#include <iostream>
#include <atomic>

void handleChat(const httplib::Request& req, httplib::Response& res, OpenRouterService& service) {
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
        int maxTokens            = body.isMember("max_tokens")    ? body["max_tokens"].asInt()     : 2048;
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

// ── Streaming context ─────────────────────────────────────────────────────────
struct StreamingCtx {
    std::deque<std::string> chunks;
    std::mutex              mutex;
    bool                    done  = false;
    std::atomic<bool>       cancelled{false};
    std::string             error;
};

void handleStreaming(const httplib::Request& req, httplib::Response& res,
                     OpenRouterService& service, McpRegistry* registry) {
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
        int maxTokens            = body.isMember("max_tokens")     ? body["max_tokens"].asInt()     : 2048;
        std::string systemPrompt = body.isMember("system_prompt")  ? body["system_prompt"].asString(): "";
        double temperature       = body.isMember("temperature")    ? body["temperature"].asDouble() : -1.0;
        // context_window is forwarded to LM Studio as num_ctx so it uses the full loaded context
        int contextWindow        = body.isMember("context_window") ? body["context_window"].asInt() : 0;

        // Build tools array:
        // 1. Any tools explicitly sent by the client
        // 2. Always append all live MCP tools from the registry
        Json::Value tools = body.isMember("tools")
            ? body["tools"]
            : Json::Value(Json::arrayValue);

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

        std::thread([ctx, &service, registry, model, prompt, maxTokens,
                     systemPrompt, temperature, contextWindow, tools]() mutable {
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

            bool useTools = tools.isArray() && !tools.empty();

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

void handleModels(const httplib::Request& /*req*/, httplib::Response& res,
                  OpenRouterService& service) {
    try {
        res.status = 200;
        res.set_content(service.getModels().toStyledString(), "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

void handleLmStudioModels(const httplib::Request& /*req*/, httplib::Response& res,
                           OpenRouterService& service) {
    try {
        Json::Value result = service.getLmStudioModels();
        res.status = 200;
        res.set_content(result.toStyledString(), "application/json");
    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}