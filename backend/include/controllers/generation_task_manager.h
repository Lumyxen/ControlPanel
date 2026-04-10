#ifndef GENERATION_TASK_MANAGER_H
#define GENERATION_TASK_MANAGER_H

#include "httplib.h"
#include <string>
#include <string_view>
#include <unordered_map>
#include <shared_mutex>
#include <mutex>
#include <deque>
#include <future>
#include <atomic>
#include <chrono>
#include <functional>
#include <json/json.h>

// ─────────────────────────────────────────────────────────────────────────────
// GenerationTask — persistent state for a single generation request
// ─────────────────────────────────────────────────────────────────────────────

enum class TaskStatus {
    PENDING,     // Submitted, not yet started
    RUNNING,     // Inference in progress
    COMPLETED,   // Finished successfully
    CANCELLED,   // User or system cancelled
    FAILED       // Error during generation
};

std::string taskStatusToString(TaskStatus s);

struct GenerationTask {
    std::string              id;
    TaskStatus               status = TaskStatus::PENDING;
    Json::Value              request;
    std::deque<std::string>  chunks;
    mutable std::mutex       chunksMutex;
    std::atomic<bool>        cancelled{false};
    std::string              error;
    std::chrono::steady_clock::time_point created;
    std::chrono::steady_clock::time_point updated;

    std::shared_ptr<std::future<void>> workerFuture;

    // Parsed result — filled when the task completes
    std::string              resultContent;
    std::string              resultReasoning;
    Json::Value              resultToolCalls;
    Json::Value              resultLogprobs;
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskManager — singleton managing all generation tasks
// ─────────────────────────────────────────────────────────────────────────────

class TaskManager {
public:
    static TaskManager& instance();

    // Allocate a task and register it in the map. Returns the ID and raw ptr.
    // The caller is responsible for starting the task via startTask().
    struct TaskCreateResult {
        std::string id;
        GenerationTask* task;
    };
    TaskCreateResult createTask(const Json::Value& request);

    // Mark the task as running and attach a future.
    void startTask(const std::string& taskId, std::future<void> future);

    // Get task status (lightweight, for polling)
    Json::Value getTaskStatus(std::string_view taskId) const;

    // Get a task pointer (returns nullptr if not found). Caller must hold the
    // shared_mutex read lock while accessing the task.
    const GenerationTask* getTask(std::string_view taskId) const;

    // Cancel a running task
    void cancelTask(std::string_view taskId);

    // List all tasks
    Json::Value listTasks() const;

    // Clean up completed/failed/cancelled tasks older than N seconds
    void cleanupOldTasks(int maxAgeSeconds = 300);

    // Find the most recent task for a given chat
    Json::Value getTaskByChat(std::string_view chatId) const;

private:
    TaskManager();
    ~TaskManager();
    TaskManager(const TaskManager&) = delete;
    TaskManager& operator=(const TaskManager&) = delete;

    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, std::unique_ptr<GenerationTask>> tasks_;
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handlers (declared here, defined in the .cpp)
// ─────────────────────────────────────────────────────────────────────────────

struct LmStudioService;
struct LlamaCppService;
class McpRegistry;

// Note: ChatStore is defined in chat_controller.h
class ChatStore;

void handleTaskSubmit  (const httplib::Request& req, httplib::Response& res,
                        LmStudioService& lmstudioService,
                        LlamaCppService* llamaCppService,
                        McpRegistry* registry,
                        ChatStore* chatStore);

void handleTaskStatus  (const httplib::Request& req, httplib::Response& res,
                        const std::string& taskId);
void handleTaskWait    (const httplib::Request& req, httplib::Response& res,
                        const std::string& taskId);
void handleTaskStream  (const httplib::Request& req, httplib::Response& res,
                        const std::string& taskId);
void handleTaskCancel  (const httplib::Request& req, httplib::Response& res,
                        const std::string& taskId);
void handleTaskList    (const httplib::Request& req, httplib::Response& res);
void handleTaskByChat  (const httplib::Request& req, httplib::Response& res);

#endif // GENERATION_TASK_MANAGER_H
