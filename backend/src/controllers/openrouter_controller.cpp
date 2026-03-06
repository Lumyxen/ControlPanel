#include "controllers/openrouter_controller.h"
#include <json/json.h>
#include <sstream>
#include <mutex>
#include <deque>
#include <thread>
#include <chrono>
#include <cstring>
#include <iostream>

void handleChat(const httplib::Request& req, httplib::Response& res, OpenRouterService& service) {
    try {
        Json::Value requestBody;
        Json::CharReaderBuilder reader;
        std::string errs;
        
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &requestBody, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }

        if (!requestBody.isMember("model") || !requestBody.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        std::string model = requestBody["model"].asString();
        std::string prompt = requestBody["prompt"].asString();
        int maxTokens = requestBody.isMember("max_tokens") ? requestBody["max_tokens"].asInt() : 2048;

        auto response = service.chat(model, prompt, maxTokens);

        res.status = 200;
        res.set_content(response.toStyledString(), "application/json");

    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

// Thread-safe chunk queue for streaming
struct StreamingContext {
    std::deque<std::string> chunks;
    std::mutex mutex;
    bool done = false;
    std::string error;
};

void handleStreaming(const httplib::Request& req, httplib::Response& res, OpenRouterService& service) {
    try {
        Json::Value requestBody;
        Json::CharReaderBuilder reader;
        std::string errs;
        
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &requestBody, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }

        if (!requestBody.isMember("model") || !requestBody.isMember("prompt")) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
            return;
        }

        std::string model = requestBody["model"].asString();
        std::string prompt = requestBody["prompt"].asString();
        int maxTokens = requestBody.isMember("max_tokens") ? requestBody["max_tokens"].asInt() : 2048;

        // Set up SSE response headers
        res.set_header("Content-Type", "text/event-stream");
        res.set_header("Cache-Control", "no-cache");
        res.set_header("Connection", "keep-alive");
        
        // Create streaming context
        auto ctx = std::make_shared<StreamingContext>();
        
        // Start streaming in background
        std::thread([ctx, &service, model, prompt, maxTokens]() {
            service.streamingChatWithCallback(
                model, 
                prompt, 
                maxTokens,
                // onChunk callback
                [ctx](const std::string& chunk) {
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->chunks.push_back(chunk);
                },
                // onError callback
                [ctx](const std::string& error) {
                    std::lock_guard<std::mutex> lock(ctx->mutex);
                    ctx->error = error;
                    ctx->done = true;
                }
            );
            
            {
                std::lock_guard<std::mutex> lock(ctx->mutex);
                ctx->done = true;
            }
        }).detach();
        
        // Use content provider to stream chunks as they arrive
        res.set_content_provider(
            "text/event-stream",
            [ctx](size_t offset, httplib::DataSink& sink) -> bool {
                std::string to_write;
                bool is_done = false;
                
                {
                    std::lock_guard<std::mutex> lock(ctx->mutex);

                    if (!ctx->error.empty()) {
                        Json::Value errObj;
                        errObj["error"] = ctx->error;
                        // Use compact JSON writer to avoid multi-line SSE issues
                        Json::StreamWriterBuilder writer;
                        writer["indentation"] = "";
                        std::string errJson = Json::writeString(writer, errObj);
                        std::string errChunk = "data: " + errJson + "\n\n";
                        sink.write(errChunk.data(), errChunk.size());
                        sink.done();
                        return true;
                    }
                    
                    if (ctx->chunks.empty()) {
                        if (ctx->done) {
                            is_done = true;
                        }
                    } else {
                        // Gather chunks
                        while (!ctx->chunks.empty()) {
                            to_write += ctx->chunks.front();
                            ctx->chunks.pop_front();
                        }
                    }
                }
                
                if (!to_write.empty()) {
                    sink.write(to_write.data(), to_write.size());
                } 
                
                if (is_done) {
                    sink.done();
                } else if (to_write.empty()) {
                    // Only sleep if queue was empty to prevent spinlocking CPU
                    std::this_thread::sleep_for(std::chrono::milliseconds(20));
                }
                
                return true; // Return true to keep connection alive until done()
            }
        );

    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

void handleModels(const httplib::Request& req, httplib::Response& res, OpenRouterService& service) {
    try {
        auto models = service.getModels();
        res.status = 200;
        res.set_content(models.toStyledString(), "application/json");

    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}

void handlePricing(const httplib::Request& req, httplib::Response& res, OpenRouterService& service) {
    try {
        auto pricing = service.getPricing();
        res.status = 200;
        res.set_content(pricing.toStyledString(), "application/json");

    } catch (const std::exception& e) {
        res.status = 500;
        res.set_content("{\"error\": \"" + std::string(e.what()) + "\"}", "application/json");
    }
}