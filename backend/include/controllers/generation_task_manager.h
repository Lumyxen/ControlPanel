#ifndef GENERATION_TASK_MANAGER_H
#define GENERATION_TASK_MANAGER_H

#include <atomic>
#include <chrono>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>

#include <json/json.h>

#include "httplib.h"

enum class TaskStatus {
    Pending,
    Running,
    WaitingApproval,
    Completed,
    Cancelled,
    Failed,
};

std::string taskStatusToString(TaskStatus status);

struct GenerationTask {
    std::string id;
    Json::Value request;

    mutable std::mutex mutex;
    std::deque<std::string> chunks;
    std::string error;
    std::string resultContent;
    std::string resultReasoning;
    Json::Value resultReasoningParts = Json::Value(Json::arrayValue);
    Json::Value resultToolCalls = Json::Value(Json::arrayValue);
    Json::Value resultLogprobs = Json::Value(Json::arrayValue);
    TaskStatus status = TaskStatus::Pending;
    std::shared_ptr<std::future<void>> workerFuture;

    std::atomic<bool> cancelled{false};
    std::atomic<bool> finalized{false};
    std::chrono::steady_clock::time_point created = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point updated = created;
};

class TaskManager {
public:
    struct TaskCreateResult {
        std::string id;
        std::shared_ptr<GenerationTask> task;
    };

    static TaskManager& instance();

    TaskCreateResult createTask(const Json::Value& request);
    void startTask(const std::shared_ptr<GenerationTask>& task, std::future<void> future);

    std::shared_ptr<GenerationTask> findTask(std::string_view taskId) const;
    Json::Value getTaskStatus(std::string_view taskId) const;
    Json::Value getTaskByChat(std::string_view chatId) const;
    Json::Value listTasks() const;
    void setTaskStatus(std::string_view taskId, TaskStatus status);

    void cancelTask(std::string_view taskId);
    void cancelAllTasks();
    void cleanupOldTasks(int maxAgeSeconds = 300);

private:
    TaskManager() = default;
    ~TaskManager();
    TaskManager(const TaskManager&) = delete;
    TaskManager& operator=(const TaskManager&) = delete;

    Json::Value buildSnapshot(const std::shared_ptr<GenerationTask>& task) const;

    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::shared_ptr<GenerationTask>> tasks_;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> preCancelledTasks_;
};

class ChatStore;
class LlamaCppService;
class McpRegistry;
class LmStudioService;
class ToolSystem;

void handleTaskSubmit(
    const httplib::Request& req,
    httplib::Response& res,
    LmStudioService& lmstudioService,
    LlamaCppService* llamaCppService,
    McpRegistry* registry,
    ChatStore* chatStore,
    ToolSystem* toolSystem);

void handleTaskStatus(const httplib::Request& req, httplib::Response& res, const std::string& taskId);
void handleTaskWait(const httplib::Request& req, httplib::Response& res, const std::string& taskId);
void handleTaskStream(const httplib::Request& req, httplib::Response& res, const std::string& taskId);
void handleTaskCancel(const httplib::Request& req, httplib::Response& res, const std::string& taskId);
void handleTaskList(const httplib::Request& req, httplib::Response& res);
void handleTaskByChat(const httplib::Request& req, httplib::Response& res);

#endif // GENERATION_TASK_MANAGER_H
