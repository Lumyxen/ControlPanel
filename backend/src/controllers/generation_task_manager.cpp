// backend/src/controllers/generation_task_manager.cpp
#include "controllers/generation_task_manager.h"
#include "httplib.h"
#include "services/lmstudio_service.h"
#include "services/llamacpp_service.h"
#include "services/mcp_registry.h"
#include "controllers/chat_controller.h"
#include <sstream>
#include <iostream>
#include <thread>
#include <algorithm>

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

std::string taskStatusToString(TaskStatus s) {
    switch (s) {
        case TaskStatus::PENDING:   return "pending";
        case TaskStatus::RUNNING:   return "running";
        case TaskStatus::COMPLETED: return "completed";
        case TaskStatus::CANCELLED: return "cancelled";
        case TaskStatus::FAILED:    return "failed";
    }
    return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskManager singleton
// ─────────────────────────────────────────────────────────────────────────────

TaskManager::TaskManager() {}
TaskManager::~TaskManager() {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    for (auto& [id, task] : tasks_) {
        task->cancelled.store(true);
    }
}

TaskManager& TaskManager::instance() {
    static TaskManager inst;
    return inst;
}

// ─────────────────────────────────────────────────────────────────────────────
// createTask — allocates and registers a task, returns the raw pointer + ID
// ─────────────────────────────────────────────────────────────────────────────

struct TaskCreateResult {
    std::string id;
    GenerationTask* task;
};

TaskManager::TaskCreateResult TaskManager::createTask(const Json::Value& request) {
    auto task = std::make_unique<GenerationTask>();
    task->id = "task_" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count())
        + "_" + std::to_string(rand() % 1000000);
    task->request = request;
    task->status = TaskStatus::PENDING;
    task->created = std::chrono::steady_clock::now();
    task->updated = task->created;

    std::string id = task->id;
    GenerationTask* rawPtr = task.get();

    {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        tasks_[id] = std::move(task);
    }

    return {id, rawPtr};
}

// ─────────────────────────────────────────────────────────────────────────────
// startTask — marks a task as running and attaches a future
// ─────────────────────────────────────────────────────────────────────────────

void TaskManager::startTask(const std::string& taskId, std::future<void> future) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = tasks_.find(taskId);
    if (it == tasks_.end()) return;

    it->second->workerFuture = std::make_shared<std::future<void>>(std::move(future));

    {
        std::lock_guard<std::mutex> chunkLock(it->second->chunksMutex);
        if (it->second->status == TaskStatus::PENDING) {
            it->second->status = TaskStatus::RUNNING;
            it->second->updated = std::chrono::steady_clock::now();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// getTaskStatus
// ─────────────────────────────────────────────────────────────────────────────

Json::Value TaskManager::getTaskStatus(std::string_view taskId) const {
    Json::Value result;
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = tasks_.find(std::string(taskId));
    if (it == tasks_.end()) {
        result["error"] = "Task not found";
        return result;
    }

    const auto& task = it->second;
    std::lock_guard<std::mutex> chunkLock(task->chunksMutex);
    result["id"]     = task->id;
    result["status"] = taskStatusToString(task->status);
    result["error"]  = task->error;
    result["chunkCount"] = static_cast<int>(task->chunks.size());

    // Include parsed result when task is completed
    if (task->status == TaskStatus::COMPLETED && !task->resultContent.empty()) {
        result["result"]["content"]    = task->resultContent;
        result["result"]["reasoning"]  = task->resultReasoning;
        result["result"]["toolCalls"]  = task->resultToolCalls;
        result["result"]["logprobs"]   = task->resultLogprobs;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// getTask
// ─────────────────────────────────────────────────────────────────────────────

const GenerationTask* TaskManager::getTask(std::string_view taskId) const {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = tasks_.find(std::string(taskId));
    if (it == tasks_.end()) return nullptr;
    return it->second.get();
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelTask
// ─────────────────────────────────────────────────────────────────────────────

void TaskManager::cancelTask(std::string_view taskId) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = tasks_.find(std::string(taskId));
    if (it == tasks_.end()) return;

    auto& task = it->second;
    task->cancelled.store(true);

    {
        std::lock_guard<std::mutex> chunkLock(task->chunksMutex);
        if (task->status == TaskStatus::RUNNING || task->status == TaskStatus::PENDING) {
            task->status = TaskStatus::CANCELLED;
            task->updated = std::chrono::steady_clock::now();
        }
    }

    std::cout << "[TaskManager] Cancelled task " << taskId << "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// listTasks
// ─────────────────────────────────────────────────────────────────────────────

Json::Value TaskManager::listTasks() const {
    Json::Value result(Json::arrayValue);
    std::shared_lock<std::shared_mutex> lock(mutex_);
    for (const auto& [id, task] : tasks_) {
        std::lock_guard<std::mutex> chunkLock(task->chunksMutex);
        Json::Value t;
        t["id"]     = task->id;
        t["status"] = taskStatusToString(task->status);
        t["error"]  = task->error;
        result.append(t);
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanupOldTasks
// ─────────────────────────────────────────────────────────────────────────────

void TaskManager::cleanupOldTasks(int maxAgeSeconds) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    std::vector<std::string> toRemove;

    for (const auto& [id, task] : tasks_) {
        auto age = std::chrono::duration_cast<std::chrono::seconds>(now - task->updated).count();
        if ((task->status == TaskStatus::COMPLETED ||
             task->status == TaskStatus::CANCELLED ||
             task->status == TaskStatus::FAILED) && age > maxAgeSeconds) {
            toRemove.push_back(id);
        }
    }

    for (const auto& id : toRemove) {
        tasks_.erase(id);
    }

    if (!toRemove.empty()) {
        std::cout << "[TaskManager] Cleaned up " << toRemove.size() << " old task(s)\n";
    }
}

Json::Value TaskManager::getTaskByChat(std::string_view chatId) const {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    std::string bestId;
    std::chrono::steady_clock::time_point bestTime{};

    for (const auto& [id, task] : tasks_) {
        const std::string& reqChatId = task->request.get("chat_id", "").asString();
        if (reqChatId == chatId && task->created > bestTime) {
            bestId = id;
            bestTime = task->created;
        }
    }

    if (bestId.empty()) {
        Json::Value result;
        result["error"] = "No task found for chat";
        return result;
    }

    const auto& task = tasks_.at(bestId);
    std::lock_guard<std::mutex> chunkLock(task->chunksMutex);
    Json::Value result;
    result["id"] = task->id;
    result["status"] = taskStatusToString(task->status);
    result["error"] = task->error;
    result["chunkCount"] = static_cast<int>(task->chunks.size());

    if (task->status == TaskStatus::COMPLETED && !task->resultContent.empty()) {
        result["result"]["content"] = task->resultContent;
        result["result"]["reasoning"] = task->resultReasoning;
        result["result"]["toolCalls"] = task->resultToolCalls;
        result["result"]["logprobs"] = task->resultLogprobs;
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Helpers
// ─────────────────────────────────────────────────────────────────────────────

static bool parseJsonBody(const std::string& body, Json::Value& out, httplib::Response& res) {
    Json::CharReaderBuilder rb;
    std::string errs;
    std::istringstream ss(body);
    if (!Json::parseFromStream(rb, ss, &out, &errs)) {
        res.status = 400;
        res.set_content("{\"error\":\"Invalid JSON\"}", "application/json");
        return false;
    }
    return true;
}

// ── POST /api/tasks/generate ─────────────────────────────────────────────────

void handleTaskSubmit(const httplib::Request& req, httplib::Response& res,
                      LmStudioService& lmstudioService,
                      LlamaCppService* llamaCppService,
                      McpRegistry* registry,
                      ChatStore* chatStore) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) return;

    if (!body.isMember("model") || !body.isMember("prompt")) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing required fields: model, prompt\"}", "application/json");
        return;
    }

    // Build the request object stored in the task
    Json::Value request;
    request["model"]         = body["model"];
    request["prompt"]        = body["prompt"];
    request["max_tokens"]    = body.get("max_tokens", 8192);
    request["system_prompt"] = body.get("system_prompt", "");
    request["temperature"]   = body.get("temperature", -1.0);
    request["context_window"]= body.get("context_window", 0);
    request["logprobs"]      = body.get("logprobs", false);
    if (body.isMember("messages") && body["messages"].isArray())
        request["messages"] = body["messages"];
    if (body.isMember("tools") && body["tools"].isArray())
        request["tools"] = body["tools"];

    // Chat metadata for auto-saving results on completion
    if (body.isMember("chat_id") && !body["chat_id"].asString().empty())
        request["chat_id"] = body["chat_id"];
    if (body.isMember("parent_user_node_id") && !body["parent_user_node_id"].asString().empty())
        request["parent_user_node_id"] = body["parent_user_node_id"];

    // Inject MCP tools
    Json::Value tools(Json::arrayValue);
    if (request.isMember("tools") && request["tools"].isArray()) {
        tools = request["tools"];
    }
    if (registry && registry->liveCount() > 0) {
        Json::Value mcpTools = registry->getAggregatedTools();
        for (const auto& t : mcpTools)
            tools.append(t);
        std::cout << "[TaskSubmit] Injected " << mcpTools.size() << " MCP tool(s)\n";
    }
    request["tools"] = tools;

    // Create the task
    auto [taskId, task] = TaskManager::instance().createTask(request);

    // Build the executor with task captured by raw pointer (safe because task
    // lifetime is managed by TaskManager's map, and the executor runs until
    // completion or cancellation)
    const bool isLlamaCpp = request.get("model", "").asString().rfind("llamacpp::", 0) == 0;
    const bool hasPrebuiltMessages = request.isMember("messages") && request["messages"].isArray()
                                      && !request["messages"].empty();

    auto future = std::async(std::launch::async,
        [task, &lmstudioService, llamaCppService, registry, isLlamaCpp,
         hasPrebuiltMessages, tools, taskId, chatStore]() {

        std::cout << "[TaskManager] Task " << task->id
                  << " inference started (model=" << task->request.get("model", "").asString() << ")\n";

        // onChunk: push SSE chunk to task's queue, return false if cancelled
        auto onChunk = [task](const std::string& chunk) -> bool {
            if (task->cancelled.load()) return false;
            if (!chunk.empty()) {
                std::lock_guard<std::mutex> lock(task->chunksMutex);
                task->chunks.push_back(chunk);
            }
            return !task->cancelled.load();
        };

        auto onError = [task](const std::string& err) {
            if (task->cancelled.load()) return;
            std::lock_guard<std::mutex> lock(task->chunksMutex);
            task->error = err;
            task->status = TaskStatus::FAILED;
            task->updated = std::chrono::steady_clock::now();
        };

        auto cancelCheck = [task]() -> bool {
            return task->cancelled.load();
        };

        // Extract params from task->request
        const std::string model        = task->request.get("model", "").asString();
        const std::string prompt       = task->request.get("prompt", "").asString();
        const int maxTokens            = task->request.get("max_tokens", 8192).asInt();
        const std::string systemPrompt = task->request.get("system_prompt", "").asString();
        const double temperature       = task->request.get("temperature", -1.0).asDouble();
        const int contextWindow        = task->request.get("context_window", 0).asInt();
        const bool emitLogprobs        = task->request.get("logprobs", false).asBool();

        if (isLlamaCpp) {
            if (!llamaCppService) {
                onError("llama.cpp service not available");
                return;
            }

            Json::Value llamaMessages = hasPrebuiltMessages
                ? task->request["messages"]
                : llamaCppService->buildMessages(prompt, systemPrompt);

            llamaCppService->streamingChatWithTools(
                model, llamaMessages, tools, maxTokens,
                onChunk, onError, registry, temperature, contextWindow,
                cancelCheck, emitLogprobs);
        } else {
            const bool useTools = tools.isArray() && !tools.empty();
            if (useTools || hasPrebuiltMessages) {
                Json::Value messages = hasPrebuiltMessages
                    ? task->request["messages"]
                    : lmstudioService.buildMessages(prompt, systemPrompt);
                lmstudioService.streamingChatWithTools(
                    model, messages, tools, maxTokens,
                    onChunk, onError, registry, temperature, contextWindow,
                    cancelCheck, emitLogprobs);
            } else {
                lmstudioService.streamingChatWithCallback(
                    model, prompt, maxTokens, onChunk, onError,
                    systemPrompt, temperature, contextWindow,
                    cancelCheck, emitLogprobs);
            }
        }

        // ── Parse the final result and save to chat store ─────────────────────
        std::string fullContent, fullReasoning;
        Json::Value allToolCalls(Json::arrayValue);
        Json::Value allLogprobs(Json::arrayValue);

        {
            std::lock_guard<std::mutex> lock(task->chunksMutex);
            for (const auto& chunkStr : task->chunks) {
                // Parse SSE data line
                std::string line = chunkStr;
                // Skip "data: " prefix
                size_t prefixLen = 6;
                if (line.size() < prefixLen) continue;
                std::string data = line.substr(prefixLen);
                if (data.empty() || data == "[DONE]") continue;

                Json::CharReaderBuilder rb;
                std::string errs;
                std::istringstream ss(data);
                Json::Value json;
                if (!Json::parseFromStream(rb, ss, &json, &errs)) continue;

                // Check for tool_execution type
                if (json.isMember("type") && json["type"] == "tool_execution" &&
                    json.isMember("tool_call")) {
                    allToolCalls.append(json["tool_call"]);
                    continue;
                }

                // Check for retract type
                if (json.isMember("type") && json["type"] == "retract") {
                    fullContent.clear();
                    fullReasoning.clear();
                    allToolCalls.clear();
                    allLogprobs.clear();
                    continue;
                }

                // Parse content/reasoning chunks
                if (json.isMember("choices") && json["choices"].isArray() &&
                    !json["choices"].empty() && json["choices"][0].isMember("delta")) {
                    const auto& delta = json["choices"][0]["delta"];
                    if (delta.isMember("reasoning") && delta["reasoning"].isString()) {
                        fullReasoning += delta["reasoning"].asString();
                    }
                    if (delta.isMember("content") && delta["content"].isString()) {
                        std::string tokenText = delta["content"].asString();
                        fullContent += tokenText;
                    }
                    // Collect logprobs as { text, logprob } objects to match
                    // the format expected by the frontend highlighter
                    if (delta.isMember("logprob") && delta.isMember("content")) {
                        Json::Value lpEntry;
                        lpEntry["text"] = delta["content"].asString();
                        lpEntry["logprob"] = delta["logprob"];
                        allLogprobs.append(lpEntry);
                    }
                }
            }
        }

        // Parse <think> tags from content (same logic as frontend's parseStreamReasoning)
        std::string parsedContent, parsedReasoning;
        {
            std::string remaining = fullContent;
            while (true) {
                size_t startIdx = remaining.find("<think>");
                if (startIdx == std::string::npos) {
                    parsedContent += remaining;
                    break;
                }
                parsedContent += remaining.substr(0, startIdx);
                size_t endIdx = remaining.find("</think>", startIdx + 7);
                if (endIdx == std::string::npos) {
                    parsedReasoning += remaining.substr(startIdx + 7);
                    break;
                }
                parsedReasoning += remaining.substr(startIdx + 7, endIdx - startIdx - 7) + "\n\n";
                remaining = remaining.substr(endIdx + 8);
            }
        }

        // Combine reasoning
        if (!fullReasoning.empty()) {
            parsedReasoning += (parsedReasoning.empty() ? "" : "\n\n") + fullReasoning;
        }

        // Trim whitespace
        auto trim = [](std::string& s) {
            size_t start = s.find_first_not_of(" \t\n\r");
            if (start == std::string::npos) { s.clear(); return; }
            size_t end = s.find_last_not_of(" \t\n\r");
            s = s.substr(start, end - start + 1);
        };
        trim(parsedContent);
        trim(parsedReasoning);

        // Save parsed result on the task so the frontend can fetch
        task->resultContent = parsedContent;
        task->resultReasoning = parsedReasoning;
        task->resultToolCalls = allToolCalls;
        task->resultLogprobs = allLogprobs;

        const std::string chatId = task->request.get("chat_id", "").asString();
        const std::string parentUserId = task->request.get("parent_user_node_id", "").asString();

        // Save directly to the encrypted chat store on the backend
        if (chatStore && !chatId.empty() &&
            (!parsedContent.empty() || !parsedReasoning.empty() || !allToolCalls.empty())) {
            if (chatStore->appendAssistantMessage(chatId, parentUserId, parsedContent,
                                                  parsedReasoning, allToolCalls, allLogprobs)) {
                std::cout << "[TaskManager] Task " << task->id
                          << " result saved to chat store (chat=" << chatId << ")\n";
            } else {
                std::cerr << "[TaskManager] Task " << task->id
                          << " FAILED to save to chat store (chat=" << chatId << ")\n";
            }
        }

        // Mark completed (if not already failed/cancelled)
        {
            std::lock_guard<std::mutex> lock(task->chunksMutex);
            if (task->status == TaskStatus::RUNNING || task->status == TaskStatus::PENDING) {
                task->status = TaskStatus::COMPLETED;
                std::cout << "[TaskManager] Task " << task->id << " completed\n";
            }
            task->updated = std::chrono::steady_clock::now();
        }
    });

    TaskManager::instance().startTask(taskId, std::move(future));

    // Return the task ID
    Json::Value result;
    result["task_id"] = taskId;
    result["status"]  = "pending";
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.status = 202;
    res.set_content(Json::writeString(wb, result), "application/json");
}

// ── GET /api/tasks/:id ───────────────────────────────────────────────────────

void handleTaskStatus(const httplib::Request& req, httplib::Response& res,
                      const std::string& taskId) {
    (void)req;

    if (taskId.empty()) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing task ID\"}", "application/json");
        return;
    }

    Json::Value status = TaskManager::instance().getTaskStatus(taskId);
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    if (status.isMember("error")) {
        res.status = 404;
    } else {
        res.status = 200;
    }
    res.set_content(Json::writeString(wb, status), "application/json");
}

// ── GET /api/tasks/:id/wait — blocks until task completes ─────────────────────

void handleTaskWait(const httplib::Request& req, httplib::Response& res,
                    const std::string& taskId) {
    (void)req;

    if (taskId.empty()) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing task ID\"}", "application/json");
        return;
    }

    // Wait for the task to complete (blocks the request thread)
    const auto& taskPtr = TaskManager::instance().getTask(taskId);
    if (!taskPtr) {
        res.status = 404;
        res.set_content("{\"error\": \"Task not found\"}", "application/json");
        return;
    }

    // Poll in-place every 200ms until done (this is a single blocking request)
    for (int i = 0; i < 3000; i++) { // max 10 minutes
        auto* t = TaskManager::instance().getTask(taskId);
        if (!t) {
            res.status = 404;
            res.set_content("{\"error\": \"Task disappeared\"}", "application/json");
            return;
        }

        {
            std::lock_guard<std::mutex> lock(t->chunksMutex);
            if (t->status == TaskStatus::COMPLETED) {
                Json::Value result;
                result["status"] = "completed";
                if (!t->resultContent.empty()) {
                    result["result"]["content"] = t->resultContent;
                    result["result"]["reasoning"] = t->resultReasoning;
                    result["result"]["toolCalls"] = t->resultToolCalls;
                    result["result"]["logprobs"] = t->resultLogprobs;
                }
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                res.status = 200;
                res.set_content(Json::writeString(wb, result), "application/json");
                return;
            }
            if (t->status == TaskStatus::FAILED) {
                Json::Value result;
                result["status"] = "failed";
                result["error"] = t->error;
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                res.status = 200;
                res.set_content(Json::writeString(wb, result), "application/json");
                return;
            }
            if (t->status == TaskStatus::CANCELLED) {
                Json::Value result;
                result["status"] = "cancelled";
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                res.status = 200;
                res.set_content(Json::writeString(wb, result), "application/json");
                return;
            }
        }

        // Task still running — sleep and check again
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    res.status = 408;
    res.set_content("{\"error\": \"Task timeout\"}", "application/json");
}

// ── GET /api/tasks/:id/stream — SSE replay + live streaming ──────────────────

void handleTaskStream(const httplib::Request& req, httplib::Response& res,
                      const std::string& taskId) {
    (void)req;

    if (taskId.empty()) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing task ID\"}", "application/json");
        return;
    }

    const GenerationTask* task = TaskManager::instance().getTask(taskId);
    if (!task) {
        res.status = 404;
        res.set_content("{\"error\": \"Task not found\"}", "application/json");
        return;
    }

    size_t resumeOffset = 0;
    if (req.has_header("X-Chunk-Offset")) {
        try { resumeOffset = std::stoull(req.get_header_value("X-Chunk-Offset")); } catch (...) {}
    }

    // Don't set Content-Type header - set_content_provider handles it
    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection",    "keep-alive");

    res.set_content_provider(
        "text/event-stream",
        [task, offset = resumeOffset](size_t /*offset_param*/, httplib::DataSink& sink) mutable -> bool {
            if (task->cancelled.load()) return false;

            bool isDone = false;
            std::string toWrite;

            {
                std::lock_guard<std::mutex> lock(task->chunksMutex);
                isDone = (task->status == TaskStatus::COMPLETED ||
                          task->status == TaskStatus::CANCELLED ||
                          task->status == TaskStatus::FAILED);

                // Collect only new chunks since last call
                size_t idx = 0;
                for (const auto& chunk : task->chunks) {
                    if (idx >= offset) {
                        toWrite += chunk;
                    }
                    idx++;
                }
                offset = task->chunks.size();
            }

            // Write any new chunks
            if (!toWrite.empty()) {
                if (!sink.write(toWrite.data(), toWrite.size())) {
                    return false;
                }
                sink.os.flush();
            } else if (!isDone) {
                // Heartbeat to keep connection alive (SSE comment)
                if (!sink.write(":\n\n", 3)) {
                    return false;
                }
                sink.os.flush();
            }

            if (isDone) {
                sink.done();
                return false;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            return true;
        },
        [task](bool /*success*/) {
            (void)task;
        }
    );
}

// ── POST /api/tasks/:id/cancel ───────────────────────────────────────────────

void handleTaskCancel(const httplib::Request& req, httplib::Response& res,
                      const std::string& taskId) {
    (void)req;

    if (taskId.empty()) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing task ID\"}", "application/json");
        return;
    }

    TaskManager::instance().cancelTask(taskId);

    Json::Value result;
    result["status"] = "cancelled";
    result["task_id"] = taskId;
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.status = 200;
    res.set_content(Json::writeString(wb, result), "application/json");
}

// ── GET /api/tasks — list all tasks ──────────────────────────────────────────

void handleTaskList(const httplib::Request& /*req*/, httplib::Response& res) {
    Json::Value tasks = TaskManager::instance().listTasks();
    Json::Value result;
    result["tasks"] = tasks;
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.status = 200;
    res.set_content(Json::writeString(wb, result), "application/json");
}

// ── GET /api/tasks/by-chat/<chatId> ──────────────────────────────────────────

void handleTaskByChat(const httplib::Request& req, httplib::Response& res) {
    // Accept chat_id from path or query param
    std::string chatId;
    if (req.matches.size() > 1) {
        chatId = req.matches[1];
    } else if (req.has_param("chat_id")) {
        chatId = req.get_param_value("chat_id");
    }

    if (chatId.empty()) {
        res.status = 400;
        res.set_content("{\"error\": \"Missing chat_id\"}", "application/json");
        return;
    }

    Json::Value result = TaskManager::instance().getTaskByChat(chatId);
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string body = Json::writeString(wb, result);
    res.status = result.isMember("error") ? 404 : 200;
    res.set_content(body, "application/json");
}
