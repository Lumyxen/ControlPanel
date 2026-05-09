#ifndef TOOL_SYSTEM_H
#define TOOL_SYSTEM_H

#include <functional>
#include <memory>
#include <string>

#include <json/json.h>

class McpRegistry;

class ToolSystem {
public:
    struct RuntimePaths {
        std::string systemPackRoot;
        std::string userPackRoot;
        std::string toolingConfigPath;
        std::string mcpConfigPath;
        std::string webSearchRoot;
    };

    struct SessionOptions {
        std::string taskId;
        std::string chatId;
        Json::Value toolScope = Json::Value(Json::objectValue);
        Json::Value legacyTools = Json::Value(Json::arrayValue);
        bool revisionMode = false;
        std::function<void(const std::string&)> onStatusChange;
    };

    struct ExecutionResult {
        bool success = false;
        std::string modelOutput;
        Json::Value toolCall = Json::Value(Json::objectValue);
    };

    ToolSystem(const RuntimePaths& paths, McpRegistry* mcpRegistry = nullptr);
    ~ToolSystem();

    ToolSystem(const ToolSystem&) = delete;
    ToolSystem& operator=(const ToolSystem&) = delete;

    void initialize();
    void reload();
    void shutdown();

    void beginTaskSession(const SessionOptions& options);
    void endTaskSession(const std::string& taskId);

    Json::Value getModelToolsForTask(const std::string& taskId) const;
    bool requiresApproval(const std::string& taskId, const std::string& modelToolName) const;
    ExecutionResult executeToolCall(
        const std::string& taskId,
        const std::string& modelToolName,
        const std::string& toolCallId,
        const Json::Value& arguments,
        std::function<bool(const Json::Value&)> emitEvent,
        std::function<bool()> cancelCheck = nullptr);

    Json::Value getPackSummaries() const;
    Json::Value getCatalog(const std::string& query, const Json::Value& scope, int limit) const;
    Json::Value getSandboxHealth() const;
    Json::Value getToolingConfig() const;

    Json::Value listApprovals(const std::string& taskId = "") const;
    Json::Value resolveApproval(const std::string& approvalId, bool approved, const std::string& note = "");

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

#endif // TOOL_SYSTEM_H
