#include "services/tools/file_reader_tool.h"
#include "services/tools/tool_system.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

class ScopedDir {
public:
    ScopedDir() {
        path_ = fs::temp_directory_path() / ("ctrlpanel-tool-system-test-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path_);
    }

    ~ScopedDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }

    const fs::path& path() const {
        return path_;
    }

private:
    fs::path path_;
};

class ScopedCurrentPath {
public:
    explicit ScopedCurrentPath(const fs::path& nextPath)
        : previousPath_(fs::current_path()) {
        fs::current_path(nextPath);
    }

    ~ScopedCurrentPath() {
        std::error_code ec;
        fs::current_path(previousPath_, ec);
    }

private:
    fs::path previousPath_;
};

void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void writeFile(const fs::path& path, const std::string& body) {
    fs::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    expect(file.is_open(), "Failed to create test file");
    file << body;
}

void writeJsonFile(const fs::path& path, const Json::Value& value) {
    fs::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    expect(file.is_open(), "Failed to create JSON file");
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(value, &file);
}

std::string readVersion(const fs::path& workspace, const std::string& path) {
    Json::Value args(Json::objectValue);
    args["path"] = path;
    const Json::Value result = file_reader_tool::readFile(args, workspace);
    expect(!result.isMember("error"), "readVersion returned an unexpected error");
    expect(result["version"].isString(), "readFile should return a version");
    return result["version"].asString();
}

void installFilesystemEditPack(const fs::path& root) {
    Json::Value pack(Json::objectValue);
    pack["id"] = "filesystem";
    pack["title"] = "Filesystem";
    pack["version"] = "test";
    pack["description"] = "Test filesystem pack";
    pack["sourceType"] = "system";
    pack["defaultEnabled"] = false;
    writeJsonFile(root / "filesystem" / "pack.json", pack);

    Json::Value tool(Json::objectValue);
    tool["id"] = "edit_file";
    tool["title"] = "Edit File";
    tool["description"] = "Edit a file";
    tool["executor"] = "native";
    tool["alwaysVisible"] = true;
    tool["inputSchema"]["type"] = "object";
    tool["inputSchema"]["additionalProperties"] = true;
    tool["inputSchema"]["required"] = Json::Value(Json::arrayValue);
    tool["inputSchema"]["required"].append("path");
    tool["inputSchema"]["required"].append("operation");
    tool["inputSchema"]["required"].append("expected_version");
    tool["selection"]["summary"] = "Edit files";
    tool["selection"]["tags"] = Json::Value(Json::arrayValue);
    tool["selection"]["whenToUse"] = "Use for tests";
    tool["selection"]["whenNotToUse"] = "Do not use outside tests";
    tool["policy"]["riskTier"] = "write";
    tool["policy"]["approvalMode"] = "prompt";
    tool["policy"]["network"] = false;
    tool["policy"]["idempotent"] = false;
    tool["native"]["handler"] = "filesystem_edit_file";
    writeJsonFile(root / "filesystem" / "tools" / "edit_file.json", tool);
}

ToolSystem::RuntimePaths makeRuntimePaths(const fs::path& systemPackRoot, const fs::path& dataRoot) {
    ToolSystem::RuntimePaths paths;
    paths.systemPackRoot = systemPackRoot.string();
    paths.userPackRoot = (dataRoot / "user-packs").string();
    paths.toolingConfigPath = (dataRoot / "tooling.json").string();
    paths.mcpConfigPath = (dataRoot / "mcp.json").string();
    return paths;
}

Json::Value filesystemScope() {
    Json::Value scope(Json::objectValue);
    scope["enabledPackIds"].append("filesystem");
    return scope;
}

void beginSession(ToolSystem& toolSystem, const std::string& taskId) {
    ToolSystem::SessionOptions options;
    options.taskId = taskId;
    options.toolScope = filesystemScope();
    toolSystem.beginTaskSession(options);
}

bool hasModelTool(const Json::Value& tools, const std::string& name) {
    if (!tools.isArray()) {
        return false;
    }
    for (const auto& tool : tools) {
        if (tool.isObject() &&
            tool["function"].isObject() &&
            tool["function"].get("name", "").asString() == name) {
            return true;
        }
    }
    return false;
}

void testInvalidPromptToolFailsWithoutApproval() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installFilesystemEditPack(packRoot);
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();
    ScopedCurrentPath workspace(temp.path());
    beginSession(toolSystem, "task_invalid");

    Json::Value args(Json::objectValue);
    args["path"] = "missing/empty.txt";
    args["operation"] = "write";
    args["expected_version"] = "missing";
    args["create_parent_directories"] = true;

    std::vector<Json::Value> events;
    const ToolSystem::ExecutionResult result = toolSystem.executeToolCall(
        "task_invalid",
        "filesystem__edit_file",
        "call_invalid",
        args,
        [&](const Json::Value& event) {
            events.push_back(event);
            return true;
        });

    expect(!result.success, "invalid edit should fail");
    expect(result.toolCall.get("status", "").asString() == "failed", "invalid edit should emit failed status");
    expect(toolSystem.listApprovals("task_invalid").empty(), "invalid edit should not create an approval");
    expect(!fs::exists(temp.path() / "missing"), "invalid preflight should not create parent directories");
    for (const auto& event : events) {
        expect(event.get("event", "").asString() != "approval_required", "invalid edit should not request approval");
    }
    toolSystem.endTaskSession("task_invalid");
}

void testNoopPromptToolCompletesWithoutApproval() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installFilesystemEditPack(packRoot);
    writeFile(temp.path() / "same.txt", "same\n");
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();
    ScopedCurrentPath workspace(temp.path());
    beginSession(toolSystem, "task_noop");

    Json::Value args(Json::objectValue);
    args["path"] = "same.txt";
    args["operation"] = "write";
    args["content"] = "same\n";
    args["expected_version"] = readVersion(temp.path(), "same.txt");

    std::vector<Json::Value> events;
    const ToolSystem::ExecutionResult result = toolSystem.executeToolCall(
        "task_noop",
        "filesystem__edit_file",
        "call_noop",
        args,
        [&](const Json::Value& event) {
            events.push_back(event);
            return true;
        });

    expect(result.success, "no-op edit should complete");
    expect(result.toolCall.get("status", "").asString() == "completed", "no-op edit should emit completed status");
    expect(toolSystem.listApprovals("task_noop").empty(), "no-op edit should not create an approval");
    expect(!result.toolCall["output"]["rollback_available"].asBool(), "no-op edit should not create rollback data");
    for (const auto& event : events) {
        expect(event.get("event", "").asString() != "approval_required", "no-op edit should not request approval");
    }
    toolSystem.endTaskSession("task_noop");
}

void testRevisionModeActivatesDraftEditor() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();

    ToolSystem::SessionOptions options;
    options.taskId = "task_revision";
    options.revisionMode = true;
    toolSystem.beginTaskSession(options);

    const Json::Value tools = toolSystem.getModelToolsForTask("task_revision");
    expect(hasModelTool(tools, "draft_editor__create_draft"), "revision mode should expose create_draft");
    expect(hasModelTool(tools, "draft_editor__annotate_issue"), "revision mode should expose annotate_issue");
    expect(hasModelTool(tools, "draft_editor__commit_final"), "revision mode should expose commit_final");

    Json::Value createArgs(Json::objectValue);
    createArgs["content"] = "Draft answer.";
    createArgs["summary"] = "Created draft.";
    const ToolSystem::ExecutionResult createResult = toolSystem.executeToolCall(
        "task_revision",
        "draft_editor__create_draft",
        "call_create",
        createArgs,
        nullptr);
    expect(createResult.success, "create_draft should complete");
    expect(createResult.toolCall["output"].get("operation", "").asString() == "create_draft",
        "create_draft should report its operation");

    Json::Value issueArgs(Json::objectValue);
    issueArgs["label"] = "none";
    issueArgs["severity"] = "none";
    issueArgs["note"] = "No material issues.";
    const ToolSystem::ExecutionResult issueResult = toolSystem.executeToolCall(
        "task_revision",
        "draft_editor__annotate_issue",
        "call_issue",
        issueArgs,
        nullptr);
    expect(issueResult.success, "annotate_issue should complete");
    expect(issueResult.toolCall["output"]["issues"].isArray() &&
           !issueResult.toolCall["output"]["issues"].empty(),
        "annotate_issue should record issues");

    Json::Value commitArgs(Json::objectValue);
    commitArgs["change_summary"] = "Reviewed and finalized.";
    const ToolSystem::ExecutionResult commitResult = toolSystem.executeToolCall(
        "task_revision",
        "draft_editor__commit_final",
        "call_commit",
        commitArgs,
        nullptr);
    expect(commitResult.success, "commit_final should complete");
    expect(commitResult.toolCall["output"].get("final", false).asBool(),
        "commit_final should mark the draft final");

    toolSystem.endTaskSession("task_revision");
}

} // namespace

int main() {
    try {
        testInvalidPromptToolFailsWithoutApproval();
        testNoopPromptToolCompletesWithoutApproval();
        testRevisionModeActivatesDraftEditor();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "tool_system_test failed: " << exception.what() << "\n";
        return 1;
    }
}
