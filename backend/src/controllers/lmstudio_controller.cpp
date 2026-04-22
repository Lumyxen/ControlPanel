#include "controllers/lmstudio_controller.h"

#include <chrono>
#include <deque>
#include <future>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

#include "server/http_utils.h"
#include "services/llamacpp_service.h"
#include "services/mcp_registry.h"
#include "services/tools/tool_system.h"

namespace {

Json::Int64 nowMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

struct ScopeGuard {
    std::function<void()> fn;
    bool active = true;

    ~ScopeGuard() {
        if (active && fn) {
            fn();
        }
    }

    void dismiss() { active = false; }
};

struct StreamSession {
    mutable std::mutex mutex;
    std::deque<std::string> chunks;
    std::string error;
    bool done = false;
    bool closed = false;
    std::chrono::steady_clock::time_point lastWrite = std::chrono::steady_clock::now();
    std::shared_ptr<std::future<void>> workerFuture;
    std::atomic<bool> cancelled{false};
};

class StreamRegistry {
public:
    static StreamRegistry& instance() {
        static StreamRegistry registry;
        return registry;
    }

    void start() {
        stop_.store(false);
        if (!cleanupThread_.joinable()) {
            cleanupThread_ = std::thread([this]() { cleanupLoop(); });
        }
    }

    void stop() {
        stop_.store(true);
        if (cleanupThread_.joinable()) {
            cleanupThread_.join();
        }
    }

    void put(const std::string& streamId, const std::shared_ptr<StreamSession>& session) {
        if (streamId.empty()) {
            return;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_[streamId] = session;
    }

    void erase(const std::string& streamId) {
        if (streamId.empty()) {
            return;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_.erase(streamId);
    }

    void cancel(const std::string& streamId) {
        std::shared_ptr<StreamSession> session;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            const auto it = sessions_.find(streamId);
            if (it == sessions_.end()) {
                return;
            }
            session = it->second;
        }

        session->cancelled.store(true);
        std::lock_guard<std::mutex> sessionLock(session->mutex);
        session->done = true;
    }

private:
    void cleanupLoop() {
        while (!stop_.load()) {
            for (int index = 0; index < 60 && !stop_.load(); ++index) {
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }

            const auto now = std::chrono::steady_clock::now();
            std::lock_guard<std::mutex> lock(mutex_);
            for (auto it = sessions_.begin(); it != sessions_.end();) {
                std::lock_guard<std::mutex> sessionLock(it->second->mutex);
                const auto age = std::chrono::duration_cast<std::chrono::seconds>(now - it->second->lastWrite).count();
                const bool removable = (it->second->done || it->second->cancelled.load()) && age > 3600;
                if (removable) {
                    it = sessions_.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }

    std::atomic<bool> stop_{false};
    std::thread cleanupThread_;
    std::mutex mutex_;
    std::unordered_map<std::string, std::shared_ptr<StreamSession>> sessions_;
};

std::string takeErrorFrame(const std::shared_ptr<StreamSession>& session) {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->error.empty()) {
        return "";
    }

    Json::Value error(Json::objectValue);
    error["error"] = session->error;
    session->error.clear();
    return "data: " + writeJson(error) + "\n\n";
}

Json::Value buildPreparedMessages(const Json::Value& body, const std::string& systemPrompt) {
    Json::Value messages(Json::arrayValue);
    if (!systemPrompt.empty()) {
        Json::Value system(Json::objectValue);
        system["role"] = "system";
        system["content"] = systemPrompt;
        messages.append(system);
    }
    for (const auto& message : body["messages"]) {
        messages.append(message);
    }
    return messages;
}

Json::Value buildCountMessages(
    const Json::Value& body,
    const std::string& systemPrompt,
    bool isLlamaCpp,
    LmStudioService& service,
    LlamaCppService* llamaCppService) {
    const bool hasPrebuiltMessages =
        body.isMember("messages") && body["messages"].isArray();

    if (hasPrebuiltMessages) {
        return buildPreparedMessages(body, systemPrompt);
    }

    const std::string prompt = body.get("prompt", "").asString();
    if (isLlamaCpp && llamaCppService) {
        return llamaCppService->buildMessages(prompt, systemPrompt);
    }

    return service.buildMessages(prompt, systemPrompt);
}

} // namespace

void startStreamCleanupLoop() {
    StreamRegistry::instance().start();
}

void stopStreamCleanupLoop() {
    StreamRegistry::instance().stop();
}

void handleStopStream(const httplib::Request& req, httplib::Response& res) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string streamId = body.get("stream_id", "").asString();
    if (!streamId.empty()) {
        StreamRegistry::instance().cancel(streamId);
    }

    Json::Value result(Json::objectValue);
    result["status"] = "stopped";
    setJson(res, result);
}

void handleChat(const httplib::Request& req, httplib::Response& res, LmStudioService& service) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    if (!body.isMember("model") || !body.isMember("prompt")) {
        setJsonError(res, 400, "Missing required fields: model, prompt");
        return;
    }

    const Json::Value response = service.chat(
        body["model"].asString(),
        body["prompt"].asString(),
        body.get("max_tokens", 8192).asInt(),
        body.get("system_prompt", "").asString(),
        body.get("temperature", -1.0).asDouble());
    setJson(res, response);
}

void handleTokenCount(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& service,
    LlamaCppService* llamaCppService) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const bool hasPrebuiltMessages =
        body.isMember("messages") && body["messages"].isArray();
    const bool hasPrompt = body.isMember("prompt") && body["prompt"].isString();
    const bool hasSystemPrompt = body.isMember("system_prompt") && body["system_prompt"].isString();

    if (!body.isMember("model") || (!hasPrebuiltMessages && !hasPrompt && !hasSystemPrompt)) {
        setJsonError(res, 400, "Missing required fields: model and prompt/messages/system_prompt");
        return;
    }

    const std::string model = body["model"].asString();
    const std::string systemPrompt = body.get("system_prompt", "").asString();
    const bool isLlamaCpp = model.rfind("llamacpp::", 0) == 0;

    if (isLlamaCpp && !llamaCppService) {
        setJsonError(res, 503, "llama.cpp service not available");
        return;
    }

    try {
        const Json::Value messages = buildCountMessages(
            body,
            systemPrompt,
            isLlamaCpp,
            service,
            llamaCppService);

        const int promptTokens = isLlamaCpp
            ? llamaCppService->countTokens(model, messages)
            : service.countTokens(model, messages);

        Json::Value result(Json::objectValue);
        result["prompt_tokens"] = promptTokens;
        setJson(res, result);
    } catch (const std::exception& exception) {
        setJsonError(res, 500, exception.what());
    } catch (...) {
        setJsonError(res, 500, "Could not count tokens");
    }
}

void handleStreaming(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& service,
    McpRegistry* registry,
    ToolSystem* toolSystem,
    LlamaCppService* llamaCppService) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    if (!body.isMember("model") || !body.isMember("prompt")) {
        setJsonError(res, 400, "Missing required fields: model, prompt");
        return;
    }

    const bool hasPrebuiltMessages =
        body.isMember("messages") && body["messages"].isArray() && !body["messages"].empty();

    const std::string model = body["model"].asString();
    const std::string prompt = body["prompt"].asString();
    const int maxTokens = body.get("max_tokens", 8192).asInt();
    const std::string systemPrompt = body.get("system_prompt", "").asString();
    const double temperature = body.get("temperature", -1.0).asDouble();
    const int contextWindow = body.get("context_window", 0).asInt();
    const std::string streamId = body.get("stream_id", "").asString();
    const bool emitLogprobs = body.get("logprobs", false).asBool();

    Json::Value tools = body.isMember("tools") ? body["tools"] : Json::Value(Json::arrayValue);
    const Json::Value toolScope = body.get("tool_scope", Json::Value(Json::objectValue));

    const bool isLlamaCpp = model.rfind("llamacpp::", 0) == 0;
    if (isLlamaCpp) {
        if (!llamaCppService) {
            setJsonError(res, 503, "llama.cpp service not available");
            return;
        }
    }

    auto session = std::make_shared<StreamSession>();
    StreamRegistry::instance().put(streamId, session);
    ScopeGuard unregisterOnExit{[streamId]() { StreamRegistry::instance().erase(streamId); }};
    const std::string toolSessionId = streamId.empty()
        ? "stream_" + std::to_string(nowMillis())
        : streamId;

    if (toolSystem) {
        ToolSystem::SessionOptions options;
        options.taskId = toolSessionId;
        options.toolScope = toolScope;
        options.legacyTools = tools;
        toolSystem->beginTaskSession(options);
    }

    auto onChunk = [session](const std::string& chunk) -> bool {
        if (session->cancelled.load()) {
            return false;
        }
        if (!chunk.empty()) {
            std::lock_guard<std::mutex> lock(session->mutex);
            session->chunks.push_back(chunk);
        }
        return !session->cancelled.load();
    };

    auto onError = [session](const std::string& error) {
        if (session->cancelled.load()) {
            return;
        }
        std::lock_guard<std::mutex> lock(session->mutex);
        session->error = error;
        session->done = true;
    };

    auto cancelCheck = [session]() {
        return session->cancelled.load();
    };

    const Json::Value preparedMessages = hasPrebuiltMessages
        ? buildPreparedMessages(body, systemPrompt)
        : Json::Value(Json::arrayValue);

    session->workerFuture = std::make_shared<std::future<void>>(std::async(
        std::launch::async,
        [session,
         &service,
         registry,
         llamaCppService,
         isLlamaCpp,
         model,
         prompt,
         maxTokens,
         systemPrompt,
         temperature,
         contextWindow,
         emitLogprobs,
         tools,
         hasPrebuiltMessages,
         onChunk,
         onError,
         cancelCheck,
         preparedMessages,
         toolSystem,
         toolSessionId]() mutable {
            struct SessionGuard {
                ToolSystem* toolSystem = nullptr;
                std::string toolSessionId;
                ~SessionGuard() {
                    if (toolSystem && !toolSessionId.empty()) {
                        toolSystem->endTaskSession(toolSessionId);
                    }
                }
            } sessionGuard{toolSystem, toolSessionId};
            try {
                if (isLlamaCpp) {
                    Json::Value messages = hasPrebuiltMessages
                        ? preparedMessages
                        : llamaCppService->buildMessages(prompt, systemPrompt);
                    llamaCppService->streamingChatWithTools(
                        model,
                        messages,
                        tools,
                        toolSessionId,
                        maxTokens,
                        onChunk,
                        onError,
                        toolSystem,
                        temperature,
                        contextWindow,
                        cancelCheck,
                        emitLogprobs);
                } else {
                    const bool useTools = tools.isArray() && !tools.empty();
                    if (toolSystem || useTools || hasPrebuiltMessages) {
                        Json::Value messages = hasPrebuiltMessages
                            ? preparedMessages
                            : service.buildMessages(prompt, systemPrompt);
                        service.streamingChatWithTools(
                            model,
                            messages,
                            tools,
                            toolSessionId,
                            maxTokens,
                            onChunk,
                            onError,
                            toolSystem,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    } else {
                        service.streamingChatWithCallback(
                            model,
                            prompt,
                            maxTokens,
                            onChunk,
                            onError,
                            systemPrompt,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    }
                }
            } catch (const std::exception& exception) {
                onError(exception.what());
            } catch (...) {
                onError("Streaming generation failed");
            }

            std::lock_guard<std::mutex> lock(session->mutex);
            session->done = true;
        }));

    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    res.set_content_provider(
        "text/event-stream",
        [session](std::size_t, httplib::DataSink& sink) -> bool {
            if (session->cancelled.load()) {
                return false;
            }
            if (!sink.is_writable()) {
                session->cancelled.store(true);
                return false;
            }

            const std::string errorFrame = takeErrorFrame(session);
            if (!errorFrame.empty()) {
                if (!sink.write(errorFrame.data(), errorFrame.size())) {
                    session->cancelled.store(true);
                    return false;
                }
                sink.done();
                return false;
            }

            std::string payload;
            bool done = false;
            bool shouldHeartbeat = false;
            {
                std::lock_guard<std::mutex> lock(session->mutex);
                while (!session->chunks.empty()) {
                    payload += session->chunks.front();
                    session->chunks.pop_front();
                }

                done = session->done;
                const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - session->lastWrite).count();
                shouldHeartbeat = payload.empty() && !done && elapsed >= 100;
            }

            if (!payload.empty()) {
                if (!sink.write(payload.data(), payload.size())) {
                    session->cancelled.store(true);
                    return false;
                }
                std::lock_guard<std::mutex> lock(session->mutex);
                session->lastWrite = std::chrono::steady_clock::now();
            } else if (shouldHeartbeat) {
                if (!sink.write(":\n\n", 3)) {
                    session->cancelled.store(true);
                    return false;
                }
                std::lock_guard<std::mutex> lock(session->mutex);
                session->lastWrite = std::chrono::steady_clock::now();
            }

            if (done) {
                sink.done();
                return false;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            return true;
        },
        [session, streamId](bool) {
            session->cancelled.store(true);
            {
                std::lock_guard<std::mutex> lock(session->mutex);
                session->closed = true;
            }

            if (session->workerFuture && session->workerFuture->valid()) {
                session->workerFuture->wait_for(std::chrono::seconds(5));
            }

            StreamRegistry::instance().erase(streamId);
        });

    unregisterOnExit.dismiss();
}

void handleLmStudioModels(const httplib::Request&, httplib::Response& res, LmStudioService& service) {
    setJson(res, service.getModels());
}

void handleModels(
    const httplib::Request&,
    httplib::Response& res,
    LmStudioService& service,
    const std::string& llamaCppModelsDir,
    int llamaCppContextLength,
    LlamaCppService* llamaCppService) {
    Json::Value combined(Json::objectValue);
    combined["data"] = Json::Value(Json::arrayValue);

    const Json::Value lmstudioModels = service.getModels();
    if (lmstudioModels.isMember("data") && lmstudioModels["data"].isArray()) {
        for (const auto& model : lmstudioModels["data"]) {
            combined["data"].append(model);
        }
    }

    Json::Value llamaModels(Json::objectValue);
    bool usedLiveService = false;
    if (llamaCppService) {
        llamaModels = llamaCppService->getModels();
        usedLiveService = !llamaModels.isMember("error");
    }

    if (!usedLiveService) {
        llamaModels["data"] = Json::Value(Json::arrayValue);
        const auto scanned = LlamaCppService::scanModelDirectory(
            llamaCppModelsDir,
            llamaCppContextLength > 0 ? llamaCppContextLength : 65536);
        for (const auto& model : scanned) {
            Json::Value entry(Json::objectValue);
            entry["id"] = model.id;
            entry["name"] = model.name;
            entry["source"] = "llamacpp";
            entry["context_length"] = model.contextLength;
            entry["max_tokens"] = model.maxTokens;
            entry["loaded"] = model.loaded;
            entry["has_tokenizer"] = !model.tokenizerPath.empty();
            entry["has_mmproj"] = !model.mmprojPath.empty();
            llamaModels["data"].append(entry);
        }
    }

    if (llamaModels.isMember("data") && llamaModels["data"].isArray()) {
        for (const auto& model : llamaModels["data"]) {
            combined["data"].append(model);
        }
    }

    setJson(res, combined);
}
