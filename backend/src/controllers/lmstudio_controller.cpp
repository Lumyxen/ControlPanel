// backend/src/controllers/lmstudio_controller.cpp
#include "controllers/lmstudio_controller.h"
#include "services/mcp_registry.h"
#include <json/json.h>
#include <sstream>
#include <mutex>
#include <deque>
#include <thread>
#include <future>
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

    // FIX: Track the worker future so cleanup can detect when the inference
    // thread has actually finished, and the content_provider can avoid racing
    // on ctx state during teardown.
    std::shared_ptr<std::future<void>> workerFuture;
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
        if (!body.isMember("model") || !body.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        const bool hasPrebuiltMessages = body.isMember("messages") && body["messages"].isArray()
                                         && !body["messages"].empty();

        std::string model        = body["model"].asString();
        std::string prompt       = body["prompt"].asString();
        int maxTokens            = body.isMember("max_tokens")     ? body["max_tokens"].asInt()      : 8192;
        std::string systemPrompt = body.isMember("system_prompt")  ? body["system_prompt"].asString(): "";
        double temperature       = body.isMember("temperature")    ? body["temperature"].asDouble()  : -1.0;
        int contextWindow        = body.isMember("context_window") ? body["context_window"].asInt()  : 0;
        std::string stream_id    = body.isMember("stream_id")      ? body["stream_id"].asString()    : "";
        bool emitLogprobs        = body.isMember("logprobs")       ? body["logprobs"].asBool()       : false;

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

        // ── Shared onChunk / onError lambdas ──────────────────────────────────
        // Both backends use these same lambdas to queue chunks and errors.
        // onChunk returns false immediately when cancelled — this propagates
        // back through doInference and stops token generation within one decode.
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
        auto cancelCheck = [ctx]() -> bool {
            return ctx->cancelled.load();
        };

        if (isLlamaCpp) {
            // ── llama.cpp path ────────────────────────────────────────────────
            if (!llamaCppService) {
                res.status = 503;
                res.set_content("{\"error\": \"llama.cpp service not available\"}", "application/json");
                return;
            }

            Json::Value llamaMessages = hasPrebuiltMessages
                ? prebuiltMessages
                : llamaCppService->buildMessages(prompt, systemPrompt);

            // FIX: Use std::async instead of a detached std::thread so the
            // future can be stored and checked during cleanup.  The inference
            // thread is no longer "fire and forget" — its lifetime is tied to
            // the StreamingCtx via workerFuture.
            auto future = std::make_shared<std::future<void>>(
                std::async(std::launch::async,
                    [ctx, llamaCppService, model, llamaMessages, tools,
                     maxTokens, temperature, contextWindow, registry,
                     onChunk, onError, cancelCheck, emitLogprobs]() mutable {
                        llamaCppService->streamingChatWithTools(
                            model, llamaMessages, tools,
                            maxTokens, onChunk, onError, registry,
                            temperature, contextWindow, cancelCheck, emitLogprobs);

                        std::lock_guard<std::mutex> lock(ctx->mutex);
                        ctx->done = true;
                    }
                )
            );
            ctx->workerFuture = future;

        } else {
            // ── lmstudio path ─────────────────────────────────────────────────
            const bool useTools = tools.isArray() && !tools.empty();

            auto future = std::make_shared<std::future<void>>(
                std::async(std::launch::async,
                    [ctx, &service, registry, model, prompt, maxTokens,
                     systemPrompt, temperature, contextWindow, tools,
                     useTools, hasPrebuiltMessages, prebuiltMessages,
                     onChunk, onError, cancelCheck, emitLogprobs]() mutable {
                        if (useTools || hasPrebuiltMessages) {
                            Json::Value messages = hasPrebuiltMessages
                                ? prebuiltMessages
                                : service.buildMessages(prompt, systemPrompt);
                            service.streamingChatWithTools(
                                model, messages, tools, maxTokens,
                                onChunk, onError, registry, temperature, contextWindow,
                                cancelCheck, emitLogprobs);
                        } else {
                            service.streamingChatWithCallback(
                                model, prompt, maxTokens, onChunk, onError,
                                systemPrompt, temperature, contextWindow,
                                cancelCheck, emitLogprobs);
                        }

                        std::lock_guard<std::mutex> lock(ctx->mutex);
                        ctx->done = true;
                    }
                )
            );
            ctx->workerFuture = future;
        }

        // ── SSE content provider ──────────────────────────────────────────────
        //
        // FIX 1: Heartbeat interval reduced from 500 ms to 100 ms.
        //        This halves the worst-case delay between a client disconnecting
        //        and the server detecting it via a failed sink.write(), which in
        //        turn sets ctx->cancelled and stops the inference thread.
        //
        // FIX 2: sink.is_writable() is checked at the top of every provider
        //        call (unchanged from before) AND the heartbeat is attempted
        //        more frequently so TCP-level disconnects are caught sooner.
        //
        // FIX 3: When the provider finishes (either done or cancelled), it
        //        waits up to 2 s for the worker future to complete.  This
        //        prevents the StreamingCtx from being destroyed while the
        //        inference thread is still writing to ctx->chunks.
        res.set_content_provider(
            "text/event-stream",
            [ctx](size_t /*offset*/, httplib::DataSink& sink) -> bool {
                // Already cancelled — stop immediately
                if (ctx->cancelled.load()) {
                    return false;
                }

                // Detect client disconnect
                if (!sink.is_writable()) {
                    ctx->cancelled.store(true);
                    std::cout << "[Streaming] Client disconnected; cancelling inference\n";
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
                        // Write failed — client dropped the connection
                        ctx->cancelled.store(true);
                        std::cout << "[Streaming] Write failed; cancelling inference\n";
                        return false;
                    }
                    ctx->last_write = now;
                }

                if (is_done) {
                    sink.done();
                } else if (to_write.empty()) {
                    // FIX: Heartbeat every 100 ms (was 500 ms).
                    // Sending a no-op SSE comment serves two purposes:
                    //   1. Keeps the TCP connection alive (anti-idle timeout).
                    //   2. Detects a dropped client faster — write() failure
                    //      is the primary signal for client disconnect.
                    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - ctx->last_write).count();
                    if (elapsed >= 100) {
                        if (!sink.write(":\n\n", 3)) {
                            ctx->cancelled.store(true);
                            std::cout << "[Streaming] Heartbeat write failed; cancelling inference\n";
                            return false;
                        }
                        ctx->last_write = now;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }

                return !ctx->cancelled.load();
            },
            [ctx, stream_id](bool /*success*/) {
                // FIX: Ensure ctx->cancelled is set so the worker exits its
                // inference loop even if the provider exited for a non-error
                // reason (e.g. sink.done() was called normally).  This is a
                // no-op when inference already finished cleanly.
                ctx->cancelled.store(true);

                // Wait for the worker future with a short timeout so the ctx
                // shared_ptr isn't destroyed beneath a still-running thread.
                if (ctx->workerFuture && ctx->workerFuture->valid()) {
                    auto status = ctx->workerFuture->wait_for(std::chrono::seconds(5));
                    if (status != std::future_status::ready) {
                        std::cerr << "[Streaming] Worker did not finish within timeout "
                                     "after stream closed (stream_id=" << stream_id << ")\n";
                    }
                }

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
// handleLmStudioModels
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

        Json::Value lmsModels = service.getModels();
        if (lmsModels.isMember("data") && lmsModels["data"].isArray()) {
            for (const auto& m : lmsModels["data"])
                combined["data"].append(m);
        }

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
