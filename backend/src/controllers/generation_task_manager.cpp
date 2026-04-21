#include "controllers/generation_task_manager.h"

#include <algorithm>
#include <cstdio>
#include <sstream>
#include <thread>

#include "controllers/chat_controller.h"
#include "server/http_utils.h"
#include "services/llamacpp_service.h"
#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include "services/tools/tool_system.h"

namespace {

struct ParsedTaskOutput {
    std::string content;
    std::string reasoning;
    Json::Value reasoningParts = Json::Value(Json::arrayValue);
    Json::Value toolCalls = Json::Value(Json::arrayValue);
    Json::Value logprobs = Json::Value(Json::arrayValue);
};

std::string generateTaskId() {
    const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    return "task_" + std::to_string(millis) + "_" + std::to_string(std::rand() % 1000000);
}

void trimWhitespace(std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        value.clear();
        return;
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    value = value.substr(start, end - start + 1);
}

std::vector<std::string> extractSsePayloads(const std::string& chunk) {
    std::vector<std::string> payloads;
    std::istringstream stream(chunk);
    std::string line;
    while (std::getline(stream, line)) {
        if (line.rfind("data:", 0) != 0) {
            continue;
        }
        std::string payload = line.substr(5);
        if (!payload.empty() && payload.front() == ' ') {
            payload.erase(payload.begin());
        }
        payloads.push_back(std::move(payload));
    }
    return payloads;
}

void appendLogprobEntries(
    Json::Value& outputLogprobs,
    const Json::Value& choice,
    const Json::Value& delta,
    const std::string& fallbackText) {
    if (!fallbackText.empty() && delta.isMember("logprob")) {
        Json::Value entry(Json::objectValue);
        entry["text"] = fallbackText;
        entry["logprob"] = delta["logprob"];
        outputLogprobs.append(entry);
        return;
    }

    if (!choice.isMember("logprobs") || !choice["logprobs"].isObject() ||
        !choice["logprobs"].isMember("content") || !choice["logprobs"]["content"].isArray()) {
        return;
    }

    const Json::Value& entries = choice["logprobs"]["content"];
    bool appended = false;
    for (const auto& item : entries) {
        if (!item.isObject() || !item.isMember("logprob")) {
            continue;
        }

        const std::string token = item.get("token", "").asString();
        if (token.empty()) {
            continue;
        }

        Json::Value entry(Json::objectValue);
        entry["text"] = token;
        entry["logprob"] = item["logprob"];
        outputLogprobs.append(entry);
        appended = true;
    }

    if (!appended && !fallbackText.empty() && entries.size() == 1 &&
        entries[0].isObject() && entries[0].isMember("logprob")) {
        Json::Value entry(Json::objectValue);
        entry["text"] = fallbackText;
        entry["logprob"] = entries[0]["logprob"];
        outputLogprobs.append(entry);
    }
}

void upsertToolCall(Json::Value& toolCalls, const Json::Value& toolCall) {
    if (!toolCall.isObject()) {
        return;
    }
    if (!toolCalls.isArray()) {
        toolCalls = Json::Value(Json::arrayValue);
    }

    const std::string toolCallId = toolCall.get("id", "").asString();
    if (!toolCallId.empty()) {
        for (auto& existing : toolCalls) {
            if (existing.isObject() && existing.get("id", "").asString() == toolCallId) {
                existing = toolCall;
                return;
            }
        }
    }

    toolCalls.append(toolCall);
}

void appendReasoningTextPart(Json::Value& reasoningParts, const std::string& text) {
    if (text.empty()) {
        return;
    }
    if (!reasoningParts.isArray()) {
        reasoningParts = Json::Value(Json::arrayValue);
    }

    if (!reasoningParts.empty()) {
        Json::Value& last = reasoningParts[reasoningParts.size() - 1];
        if (last.isObject() && last.get("type", "").asString() == "text") {
            last["content"] = last.get("content", "").asString() + text;
            return;
        }
    }

    Json::Value part(Json::objectValue);
    part["type"] = "text";
    part["content"] = text;
    reasoningParts.append(part);
}

void upsertReasoningToolPart(Json::Value& reasoningParts, const Json::Value& toolCall) {
    if (!toolCall.isObject()) {
        return;
    }
    if (!reasoningParts.isArray()) {
        reasoningParts = Json::Value(Json::arrayValue);
    }

    const std::string toolCallId = toolCall.get("id", "").asString();
    if (!toolCallId.empty()) {
        for (auto& existing : reasoningParts) {
            if (!existing.isObject() || existing.get("type", "").asString() != "tool_call") {
                continue;
            }
            if (existing.get("toolCallId", "").asString() != toolCallId) {
                continue;
            }
            existing["toolCallId"] = toolCallId;
            existing["toolCall"] = toolCall;
            return;
        }
    }

    Json::Value part(Json::objectValue);
    part["type"] = "tool_call";
    if (!toolCallId.empty()) {
        part["toolCallId"] = toolCallId;
    }
    part["toolCall"] = toolCall;
    reasoningParts.append(part);
}

ParsedTaskOutput parseTaskOutput(const std::deque<std::string>& chunks) {
    ParsedTaskOutput output;
    std::string fullContent;
    std::string fullReasoning;
    bool reasoningFromContent = false;

    for (const auto& chunk : chunks) {
        for (const auto& payload : extractSsePayloads(chunk)) {
            if (payload.empty() || payload == "[DONE]") {
                continue;
            }

            Json::CharReaderBuilder reader;
            std::string errors;
            std::istringstream stream(payload);
            Json::Value json;
            if (!Json::parseFromStream(reader, stream, &json, &errors)) {
                continue;
            }

            if (json.get("type", "").asString() == "retract") {
                fullContent.clear();
                fullReasoning.clear();
                output.reasoningParts = Json::Value(Json::arrayValue);
                output.toolCalls = Json::Value(Json::arrayValue);
                output.logprobs = Json::Value(Json::arrayValue);
                reasoningFromContent = false;
                continue;
            }

            if ((json.get("type", "").asString() == "tool_execution" ||
                 json.get("type", "").asString() == "tool_event") &&
                json.isMember("tool_call")) {
                upsertToolCall(output.toolCalls, json["tool_call"]);
                upsertReasoningToolPart(output.reasoningParts, json["tool_call"]);
                continue;
            }

            if (!json.isMember("choices") || !json["choices"].isArray() || json["choices"].empty()) {
                continue;
            }

            const Json::Value& choice = json["choices"][0];
            const Json::Value& delta = choice["delta"];
            if (delta.isMember("reasoning") && delta["reasoning"].isString()) {
                const std::string reasoningDelta = delta["reasoning"].asString();
                fullReasoning += reasoningDelta;
                appendReasoningTextPart(output.reasoningParts, reasoningDelta);
            }
            if (delta.isMember("content") && delta["content"].isString()) {
                const std::string token = delta["content"].asString();
                fullContent += token;
                appendLogprobEntries(output.logprobs, choice, delta, token);
            }
        }
    }

    std::string remaining = fullContent;
    while (true) {
        const std::size_t thinkStart = remaining.find("<think>");
        if (thinkStart == std::string::npos) {
            output.content += remaining;
            break;
        }

        output.content += remaining.substr(0, thinkStart);
        const std::size_t thinkEnd = remaining.find("</think>", thinkStart + 7);
        if (thinkEnd == std::string::npos) {
            output.reasoning += remaining.substr(thinkStart + 7);
            reasoningFromContent = true;
            break;
        }

        output.reasoning += remaining.substr(thinkStart + 7, thinkEnd - thinkStart - 7) + "\n\n";
        reasoningFromContent = true;
        remaining = remaining.substr(thinkEnd + 8);
    }

    if (!fullReasoning.empty()) {
        if (!output.reasoning.empty()) {
            output.reasoning += "\n\n";
        }
        output.reasoning += fullReasoning;
    }

    trimWhitespace(output.content);
    trimWhitespace(output.reasoning);
    if (reasoningFromContent) {
        output.reasoningParts = Json::Value(Json::arrayValue);
    }
    return output;
}

void saveParsedOutputToTask(
    const std::shared_ptr<GenerationTask>& task,
    const ParsedTaskOutput& output) {
    std::lock_guard<std::mutex> lock(task->mutex);
    task->resultContent = output.content;
    task->resultReasoning = output.reasoning;
    task->resultReasoningParts = output.reasoningParts;
    task->resultToolCalls = output.toolCalls;
    task->resultLogprobs = output.logprobs;
}

void persistParsedOutputToChat(
    ChatStore* chatStore,
    const std::shared_ptr<GenerationTask>& task,
    const ParsedTaskOutput& output) {
    const std::string chatId = task->request.get("chat_id", "").asString();
    const std::string parentUserId = task->request.get("parent_user_node_id", "").asString();
    if (!chatStore || chatId.empty()) {
        return;
    }

    if (output.content.empty() && output.reasoning.empty() && output.toolCalls.empty()) {
        return;
    }

    chatStore->appendAssistantMessage(
        chatId,
        parentUserId,
        output.content,
        output.reasoning,
        output.reasoningParts,
        output.toolCalls,
        output.logprobs);
}

} // namespace

std::string taskStatusToString(TaskStatus status) {
    switch (status) {
        case TaskStatus::Pending:
            return "pending";
        case TaskStatus::Running:
            return "running";
        case TaskStatus::WaitingApproval:
            return "waiting_approval";
        case TaskStatus::Completed:
            return "completed";
        case TaskStatus::Cancelled:
            return "cancelled";
        case TaskStatus::Failed:
            return "failed";
    }
    return "unknown";
}

TaskManager::~TaskManager() {
    cancelAllTasks();
}

TaskManager& TaskManager::instance() {
    static TaskManager manager;
    return manager;
}

TaskManager::TaskCreateResult TaskManager::createTask(const Json::Value& request) {
    auto task = std::make_shared<GenerationTask>();
    task->request = request;
    task->created = std::chrono::steady_clock::now();
    task->updated = task->created;

    std::string requestedId = request.get("task_id", "").asString();
    std::string id = requestedId.empty() ? generateTaskId() : requestedId;

    std::lock_guard<std::mutex> lock(mutex_);
    while (tasks_.find(id) != tasks_.end()) {
        id = requestedId.empty() ? generateTaskId() : requestedId + "_" + std::to_string(std::rand() % 1000000);
        requestedId.clear();
    }

    task->id = id;
    if (preCancelledTasks_.erase(id) > 0) {
        task->cancelled.store(true);
        task->status = TaskStatus::Cancelled;
        task->finalized.store(true);
    }

    tasks_[id] = task;
    return {id, task};
}

void TaskManager::startTask(const std::shared_ptr<GenerationTask>& task, std::future<void> future) {
    if (!task) {
        return;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    task->workerFuture = std::make_shared<std::future<void>>(std::move(future));
    if (!task->cancelled.load() && task->status == TaskStatus::Pending) {
        task->status = TaskStatus::Running;
        task->updated = std::chrono::steady_clock::now();
    }
}

std::shared_ptr<GenerationTask> TaskManager::findTask(std::string_view taskId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = tasks_.find(std::string(taskId));
    return it == tasks_.end() ? nullptr : it->second;
}

Json::Value TaskManager::buildSnapshot(const std::shared_ptr<GenerationTask>& task) const {
    Json::Value result(Json::objectValue);
    if (!task) {
        result["error"] = "Task not found";
        return result;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    result["id"] = task->id;
    result["status"] = taskStatusToString(task->status);
    result["finalized"] = task->finalized.load();
    result["chunkCount"] = static_cast<int>(task->chunks.size());
    if (!task->error.empty()) {
        result["error"] = task->error;
    }

    if (task->finalized.load() &&
        (!task->resultContent.empty() || !task->resultReasoning.empty() ||
         !task->resultReasoningParts.empty() || !task->resultToolCalls.empty() ||
         !task->resultLogprobs.empty())) {
        result["result"]["content"] = task->resultContent;
        result["result"]["reasoning"] = task->resultReasoning;
        result["result"]["reasoningParts"] = task->resultReasoningParts;
        result["result"]["toolCalls"] = task->resultToolCalls;
        result["result"]["logprobs"] = task->resultLogprobs;
    }

    return result;
}

Json::Value TaskManager::getTaskStatus(std::string_view taskId) const {
    return buildSnapshot(findTask(taskId));
}

Json::Value TaskManager::getTaskByChat(std::string_view chatId) const {
    std::shared_ptr<GenerationTask> bestTask;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            if (task->request.get("chat_id", "").asString() != chatId) {
                continue;
            }
            if (!bestTask || task->created > bestTask->created) {
                bestTask = task;
            }
        }
    }

    if (!bestTask) {
        Json::Value result(Json::objectValue);
        result["found"] = false;
        result["chat_id"] = std::string(chatId);
        result["status"] = "none";
        return result;
    }

    Json::Value result = buildSnapshot(bestTask);
    result["found"] = true;
    result["chat_id"] = std::string(chatId);
    return result;
}

Json::Value TaskManager::listTasks() const {
    std::vector<std::shared_ptr<GenerationTask>> tasks;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            tasks.push_back(task);
        }
    }

    Json::Value result(Json::arrayValue);
    for (const auto& task : tasks) {
        result.append(buildSnapshot(task));
    }
    return result;
}

void TaskManager::setTaskStatus(std::string_view taskId, TaskStatus status) {
    auto task = findTask(taskId);
    if (!task) {
        return;
    }

    std::lock_guard<std::mutex> lock(task->mutex);
    task->status = status;
    task->updated = std::chrono::steady_clock::now();
}

void TaskManager::cancelTask(std::string_view taskId) {
    const std::string id(taskId);
    if (id.empty()) {
        return;
    }

    std::shared_ptr<GenerationTask> task;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto it = tasks_.find(id);
        if (it == tasks_.end()) {
            preCancelledTasks_[id] = std::chrono::steady_clock::now();
            return;
        }
        task = it->second;
    }

    task->cancelled.store(true);
    std::lock_guard<std::mutex> taskLock(task->mutex);
    if (task->status == TaskStatus::Pending ||
        task->status == TaskStatus::Running ||
        task->status == TaskStatus::WaitingApproval) {
        task->status = TaskStatus::Cancelled;
        task->updated = std::chrono::steady_clock::now();
    }
}

void TaskManager::cancelAllTasks() {
    std::vector<std::shared_ptr<GenerationTask>> tasks;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, task] : tasks_) {
            tasks.push_back(task);
        }
    }

    const auto now = std::chrono::steady_clock::now();
    for (const auto& task : tasks) {
        task->cancelled.store(true);
        std::lock_guard<std::mutex> taskLock(task->mutex);
        if (task->status == TaskStatus::Pending ||
            task->status == TaskStatus::Running ||
            task->status == TaskStatus::WaitingApproval) {
            task->status = TaskStatus::Cancelled;
            task->updated = now;
        }
    }
}

void TaskManager::cleanupOldTasks(int maxAgeSeconds) {
    const auto now = std::chrono::steady_clock::now();

    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = tasks_.begin(); it != tasks_.end();) {
        const auto& task = it->second;
        const auto age = std::chrono::duration_cast<std::chrono::seconds>(now - task->updated).count();
        const bool isTerminal =
            task->status == TaskStatus::Completed ||
            task->status == TaskStatus::Cancelled ||
            task->status == TaskStatus::Failed;
        if (isTerminal && age > maxAgeSeconds) {
            it = tasks_.erase(it);
        } else {
            ++it;
        }
    }

    for (auto it = preCancelledTasks_.begin(); it != preCancelledTasks_.end();) {
        const auto age = std::chrono::duration_cast<std::chrono::seconds>(now - it->second).count();
        if (age > maxAgeSeconds) {
            it = preCancelledTasks_.erase(it);
        } else {
            ++it;
        }
    }
}

void handleTaskSubmit(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& lmstudioService,
    LlamaCppService* llamaCppService,
    McpRegistry* registry,
    ChatStore* chatStore,
    ToolSystem* toolSystem) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    if (!body.isMember("model") || !body.isMember("prompt")) {
        setJsonError(res, 400, "Missing required fields: model, prompt");
        return;
    }

    Json::Value request(Json::objectValue);
    request["model"] = body["model"];
    request["prompt"] = body["prompt"];
    request["max_tokens"] = body.get("max_tokens", 8192);
    request["system_prompt"] = body.get("system_prompt", "");
    request["temperature"] = body.get("temperature", -1.0);
    request["context_window"] = body.get("context_window", 0);
    request["logprobs"] = body.get("logprobs", false);

    if (body.isMember("task_id") && body["task_id"].isString() && !body["task_id"].asString().empty()) {
        request["task_id"] = body["task_id"];
    }
    if (body.isMember("messages") && body["messages"].isArray()) {
        request["messages"] = body["messages"];
    }
    if (body.isMember("tools") && body["tools"].isArray()) {
        request["tools"] = body["tools"];
    }
    if (body.isMember("tool_scope") && body["tool_scope"].isObject()) {
        request["tool_scope"] = body["tool_scope"];
    }
    if (body.isMember("chat_id") && body["chat_id"].isString() && !body["chat_id"].asString().empty()) {
        request["chat_id"] = body["chat_id"];
    }
    if (body.isMember("parent_user_node_id") && body["parent_user_node_id"].isString() &&
        !body["parent_user_node_id"].asString().empty()) {
        request["parent_user_node_id"] = body["parent_user_node_id"];
    }

    Json::Value tools = request.isMember("tools") ? request["tools"] : Json::Value(Json::arrayValue);
    request["tools"] = tools;

    const bool isLlamaCpp = request.get("model", "").asString().rfind("llamacpp::", 0) == 0;
    if (isLlamaCpp) {
        if (!llamaCppService) {
            setJsonError(res, 503, "llama.cpp service not available");
            return;
        }
    }

    auto [taskId, task] = TaskManager::instance().createTask(request);
    if (!task || task->cancelled.load()) {
        Json::Value result(Json::objectValue);
        result["task_id"] = taskId;
        result["status"] = "cancelled";
        setJson(res, result, 202);
        return;
    }

    const bool hasPrebuiltMessages =
        request.isMember("messages") && request["messages"].isArray() && !request["messages"].empty();

    if (toolSystem) {
        ToolSystem::SessionOptions sessionOptions;
        sessionOptions.taskId = taskId;
        sessionOptions.chatId = request.get("chat_id", "").asString();
        sessionOptions.toolScope = request.get("tool_scope", Json::Value(Json::objectValue));
        sessionOptions.legacyTools = tools;
        sessionOptions.onStatusChange = [taskId](const std::string& status) {
            if (status == "waiting_approval") {
                TaskManager::instance().setTaskStatus(taskId, TaskStatus::WaitingApproval);
            } else if (status == "running") {
                TaskManager::instance().setTaskStatus(taskId, TaskStatus::Running);
            }
        };
        toolSystem->beginTaskSession(sessionOptions);
    }

    auto future = std::async(
        std::launch::async,
        [task, &lmstudioService, toolSystem, chatStore, llamaCppService, isLlamaCpp, hasPrebuiltMessages, tools]() mutable {
            struct FinalizeGuard {
                std::shared_ptr<GenerationTask> task;
                ToolSystem* toolSystem = nullptr;

                ~FinalizeGuard() {
                    if (toolSystem && task) {
                        toolSystem->endTaskSession(task->id);
                    }
                    if (task) {
                        task->finalized.store(true);
                    }
                }
            } finalizeGuard{task, toolSystem};

            auto onChunk = [task](const std::string& chunk) -> bool {
                if (task->cancelled.load()) {
                    return false;
                }

                if (!chunk.empty()) {
                    std::lock_guard<std::mutex> lock(task->mutex);
                    task->chunks.push_back(chunk);
                    task->updated = std::chrono::steady_clock::now();
                }
                return !task->cancelled.load();
            };

            auto onError = [task](const std::string& error) {
                if (task->cancelled.load()) {
                    return;
                }
                std::lock_guard<std::mutex> lock(task->mutex);
                task->error = error;
                task->status = TaskStatus::Failed;
                task->updated = std::chrono::steady_clock::now();
            };

            auto cancelCheck = [task]() {
                return task->cancelled.load();
            };

            const std::string model = task->request.get("model", "").asString();
            const std::string prompt = task->request.get("prompt", "").asString();
            const int maxTokens = task->request.get("max_tokens", 8192).asInt();
            const std::string systemPrompt = task->request.get("system_prompt", "").asString();
            const double temperature = task->request.get("temperature", -1.0).asDouble();
            const int contextWindow = task->request.get("context_window", 0).asInt();
            const bool emitLogprobs = task->request.get("logprobs", false).asBool();

            try {
                if (isLlamaCpp) {
                    Json::Value messages = hasPrebuiltMessages
                        ? task->request["messages"]
                        : llamaCppService->buildMessages(prompt, systemPrompt);

                    llamaCppService->streamingChatWithTools(
                        model,
                        messages,
                        tools,
                        task->id,
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
                            ? task->request["messages"]
                            : lmstudioService.buildMessages(prompt, systemPrompt);

                        lmstudioService.streamingChatWithTools(
                            model,
                            messages,
                            tools,
                            task->id,
                            maxTokens,
                            onChunk,
                            onError,
                            toolSystem,
                            temperature,
                            contextWindow,
                            cancelCheck,
                            emitLogprobs);
                    } else {
                        lmstudioService.streamingChatWithCallback(
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
                onError("Generation failed");
            }

            std::deque<std::string> chunkCopy;
            {
                std::lock_guard<std::mutex> lock(task->mutex);
                chunkCopy = task->chunks;
            }

            const ParsedTaskOutput output = parseTaskOutput(chunkCopy);
            saveParsedOutputToTask(task, output);
            persistParsedOutputToChat(chatStore, task, output);

            std::lock_guard<std::mutex> lock(task->mutex);
            if (task->cancelled.load()) {
                task->status = TaskStatus::Cancelled;
            } else if (task->status == TaskStatus::Pending ||
                       task->status == TaskStatus::Running ||
                       task->status == TaskStatus::WaitingApproval) {
                task->status = TaskStatus::Completed;
            }
            task->updated = std::chrono::steady_clock::now();
        });

    TaskManager::instance().startTask(task, std::move(future));

    Json::Value result(Json::objectValue);
    result["task_id"] = taskId;
    result["status"] = "pending";
    setJson(res, result, 202);
}

void handleTaskStatus(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    if (!TaskManager::instance().findTask(taskId)) {
        setJsonError(res, 404, "Task not found");
        return;
    }

    Json::Value status = TaskManager::instance().getTaskStatus(taskId);
    setJson(res, status);
}

void handleTaskWait(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    for (int attempt = 0; attempt < 3000; ++attempt) {
        auto task = TaskManager::instance().findTask(taskId);
        if (!task) {
            setJsonError(res, 404, "Task not found");
            return;
        }

        Json::Value snapshot = TaskManager::instance().getTaskStatus(taskId);
        const std::string status = snapshot.get("status", "").asString();
        if (status == "completed" || status == "failed" || status == "cancelled") {
            Json::Value result(Json::objectValue);
            result["status"] = status;
            if (snapshot.isMember("result")) {
                result["result"] = snapshot["result"];
            }
            if (snapshot.isMember("error") && !snapshot["error"].asString().empty()) {
                result["error"] = snapshot["error"];
            }
            setJson(res, result);
            return;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    setJsonError(res, 408, "Task timeout");
}

void handleTaskStream(const httplib::Request& req, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    auto task = TaskManager::instance().findTask(taskId);
    if (!task) {
        setJsonError(res, 404, "Task not found");
        return;
    }

    std::size_t resumeOffset = 0;
    if (req.has_header("X-Chunk-Offset")) {
        try {
            resumeOffset = std::stoull(req.get_header_value("X-Chunk-Offset"));
        } catch (...) {
            resumeOffset = 0;
        }
    }

    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    res.set_content_provider(
        "text/event-stream",
        [task, offset = resumeOffset](std::size_t, httplib::DataSink& sink) mutable -> bool {
            std::string payload;
            bool done = false;

            {
                std::lock_guard<std::mutex> lock(task->mutex);
                std::size_t index = 0;
                for (const auto& chunk : task->chunks) {
                    if (index >= offset) {
                        payload += chunk;
                    }
                    ++index;
                }
                offset = task->chunks.size();
                done = task->finalized.load();
            }

            if (!payload.empty()) {
                if (!sink.write(payload.data(), payload.size())) {
                    return false;
                }
                sink.os.flush();
            } else if (!done) {
                if (!sink.write(":\n\n", 3)) {
                    return false;
                }
                sink.os.flush();
            }

            if (done) {
                sink.done();
                return false;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            return true;
        });
}

void handleTaskCancel(const httplib::Request&, httplib::Response& res, const std::string& taskId) {
    if (taskId.empty()) {
        setJsonError(res, 400, "Missing task ID");
        return;
    }

    TaskManager::instance().cancelTask(taskId);
    Json::Value result(Json::objectValue);
    result["status"] = "cancelled";
    result["task_id"] = taskId;
    setJson(res, result);
}

void handleTaskList(const httplib::Request&, httplib::Response& res) {
    Json::Value result(Json::objectValue);
    result["tasks"] = TaskManager::instance().listTasks();
    setJson(res, result);
}

void handleTaskByChat(const httplib::Request& req, httplib::Response& res) {
    std::string chatId;
    if (req.matches.size() > 1) {
        chatId = req.matches[1];
    } else if (req.has_param("chat_id")) {
        chatId = req.get_param_value("chat_id");
    }

    if (chatId.empty()) {
        setJsonError(res, 400, "Missing chat_id");
        return;
    }

    Json::Value result = TaskManager::instance().getTaskByChat(chatId);
    setJson(res, result);
}
