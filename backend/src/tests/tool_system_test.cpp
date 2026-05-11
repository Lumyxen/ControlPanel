#include "config/config.h"
#include "services/tools/cli_tool.h"
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

void installLocalEcosystemPack(const fs::path& root) {
    Json::Value pack(Json::objectValue);
    pack["id"] = "local_ecosystem";
    pack["title"] = "Local Ecosystem";
    pack["version"] = "test";
    pack["description"] = "Test local ecosystem pack";
    pack["sourceType"] = "system";
    pack["defaultEnabled"] = false;
    writeJsonFile(root / "local_ecosystem" / "pack.json", pack);

    Json::Value tool(Json::objectValue);
    tool["id"] = "inspect_local_ecosystem";
    tool["title"] = "Inspect Local Ecosystem";
    tool["description"] = "Inspect the local machine";
    tool["executor"] = "native";
    tool["alwaysVisible"] = true;
    tool["inputSchema"]["type"] = "object";
    tool["inputSchema"]["additionalProperties"] = false;
    tool["inputSchema"]["properties"] = Json::Value(Json::objectValue);
    tool["selection"]["summary"] = "Inspect local ecosystem";
    tool["selection"]["tags"] = Json::Value(Json::arrayValue);
    tool["selection"]["whenToUse"] = "Use for tests";
    tool["selection"]["whenNotToUse"] = "Do not use outside tests";
    tool["policy"]["riskTier"] = "read";
    tool["policy"]["approvalMode"] = "auto";
    tool["policy"]["network"] = false;
    tool["policy"]["idempotent"] = true;
    tool["native"]["handler"] = "local_ecosystem_inspect";
    writeJsonFile(root / "local_ecosystem" / "tools" / "inspect_local_ecosystem.json", tool);
}

void installInternetTestingPack(const fs::path& root) {
    Json::Value pack(Json::objectValue);
    pack["id"] = "internet_testing";
    pack["title"] = "Internet Testing";
    pack["version"] = "test";
    pack["description"] = "Test internet pack";
    pack["sourceType"] = "system";
    pack["defaultEnabled"] = false;
    writeJsonFile(root / "internet_testing" / "pack.json", pack);

    Json::Value tool(Json::objectValue);
    tool["id"] = "test_internet_connection";
    tool["title"] = "Test Internet Connection";
    tool["description"] = "Test WAN and local network performance";
    tool["executor"] = "native";
    tool["alwaysVisible"] = true;
    tool["inputSchema"]["type"] = "object";
    tool["inputSchema"]["additionalProperties"] = false;
    tool["inputSchema"]["properties"]["include_wan"]["type"] = "boolean";
    tool["inputSchema"]["properties"]["include_local"]["type"] = "boolean";
    tool["inputSchema"]["properties"]["local_test_bytes"]["type"] = "integer";
    tool["selection"]["summary"] = "Test internet";
    tool["selection"]["tags"] = Json::Value(Json::arrayValue);
    tool["selection"]["whenToUse"] = "Use for tests";
    tool["selection"]["whenNotToUse"] = "Do not use outside tests";
    tool["policy"]["riskTier"] = "read";
    tool["policy"]["approvalMode"] = "auto";
    tool["policy"]["network"] = true;
    tool["policy"]["idempotent"] = true;
    tool["native"]["handler"] = "internet_testing_run";
    writeJsonFile(root / "internet_testing" / "tools" / "test_internet_connection.json", tool);
}

void installAssistantWorkspacePack(const fs::path& root) {
    Json::Value pack(Json::objectValue);
    pack["id"] = "assistant_workspace";
    pack["title"] = "Assistant Workspace";
    pack["version"] = "test";
    pack["description"] = "Test assistant workspace pack";
    pack["sourceType"] = "system";
    pack["defaultEnabled"] = false;
    writeJsonFile(root / "assistant_workspace" / "pack.json", pack);

    auto makeTool = [](const std::string& id, const std::string& title, const std::string& handler) {
        Json::Value tool(Json::objectValue);
        tool["id"] = id;
        tool["title"] = title;
        tool["description"] = title;
        tool["executor"] = "native";
        tool["alwaysVisible"] = true;
        tool["inputSchema"]["type"] = "object";
        tool["inputSchema"]["additionalProperties"] = true;
        tool["inputSchema"]["properties"]["action"]["type"] = "string";
        tool["inputSchema"]["required"] = Json::Value(Json::arrayValue);
        tool["inputSchema"]["required"].append("action");
        tool["selection"]["summary"] = title;
        tool["selection"]["tags"] = Json::Value(Json::arrayValue);
        tool["selection"]["whenToUse"] = "Use for tests";
        tool["selection"]["whenNotToUse"] = "Do not use outside tests";
        tool["policy"]["riskTier"] = "write";
        tool["policy"]["approvalMode"] = "auto";
        tool["policy"]["network"] = false;
        tool["policy"]["idempotent"] = false;
        tool["native"]["handler"] = handler;
        return tool;
    };

    writeJsonFile(
        root / "assistant_workspace" / "tools" / "chat_notes.json",
        makeTool("chat_notes", "Chat Notes", "assistant_workspace_chat_notes"));
    writeJsonFile(
        root / "assistant_workspace" / "tools" / "todo_list.json",
        makeTool("todo_list", "TODO List", "assistant_workspace_todo_list"));
}

void installCliPack(const fs::path& root) {
    Json::Value pack(Json::objectValue);
    pack["id"] = "cli";
    pack["title"] = "Sandboxed CLI";
    pack["version"] = "test";
    pack["description"] = "Test CLI pack";
    pack["sourceType"] = "system";
    pack["defaultEnabled"] = false;
    writeJsonFile(root / "cli" / "pack.json", pack);

    Json::Value tool(Json::objectValue);
    tool["id"] = "run_command";
    tool["title"] = "Run CLI Command";
    tool["description"] = "Run a sandboxed shell command";
    tool["executor"] = "native";
    tool["alwaysVisible"] = true;
    tool["inputSchema"]["type"] = "object";
    tool["inputSchema"]["additionalProperties"] = true;
    tool["inputSchema"]["required"] = Json::Value(Json::arrayValue);
    tool["inputSchema"]["required"].append("command");
    tool["selection"]["summary"] = "Run sandboxed shell commands";
    tool["selection"]["tags"] = Json::Value(Json::arrayValue);
    tool["selection"]["whenToUse"] = "Use for tests";
    tool["selection"]["whenNotToUse"] = "Do not use outside tests";
    tool["policy"]["riskTier"] = "write";
    tool["policy"]["approvalMode"] = "conditional";
    tool["policy"]["network"] = false;
    tool["policy"]["idempotent"] = false;
    tool["native"]["handler"] = "cli_run_command";
    writeJsonFile(root / "cli" / "tools" / "run_command.json", tool);
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

Json::Value localEcosystemScope() {
    Json::Value scope(Json::objectValue);
    scope["enabledPackIds"].append("local_ecosystem");
    return scope;
}

Json::Value internetTestingScope() {
    Json::Value scope(Json::objectValue);
    scope["enabledPackIds"].append("internet_testing");
    return scope;
}

Json::Value assistantWorkspaceScope() {
    Json::Value scope(Json::objectValue);
    scope["enabledPackIds"].append("assistant_workspace");
    return scope;
}

Json::Value cliScope() {
    Json::Value scope(Json::objectValue);
    scope["enabledPackIds"].append("cli");
    return scope;
}

void beginSession(ToolSystem& toolSystem, const std::string& taskId) {
    ToolSystem::SessionOptions options;
    options.taskId = taskId;
    options.toolScope = filesystemScope();
    toolSystem.beginTaskSession(options);
}

void setDefaultWorkingDirectory(Config& config, const fs::path& path) {
    Json::Value settings(Json::objectValue);
    settings["aiToolsDefaultWorkingDirectory"] = path.string();
    config.updateFromJson(settings);
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
    Config config((dataRoot / "settings.json").string());
    config.load();
    setDefaultWorkingDirectory(config, temp.path());
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot), nullptr, &config);
    toolSystem.initialize();
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
    Config config((dataRoot / "settings.json").string());
    config.load();
    setDefaultWorkingDirectory(config, temp.path());
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot), nullptr, &config);
    toolSystem.initialize();
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

void testLocalEcosystemInspectionCompletes() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installLocalEcosystemPack(packRoot);
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();

    ToolSystem::SessionOptions options;
    options.taskId = "task_local_ecosystem";
    options.toolScope = localEcosystemScope();
    toolSystem.beginTaskSession(options);

    const Json::Value tools = toolSystem.getModelToolsForTask("task_local_ecosystem");
    expect(hasModelTool(tools, "local_ecosystem__inspect_local_ecosystem"),
        "local ecosystem tool should be exposed");

    const ToolSystem::ExecutionResult result = toolSystem.executeToolCall(
        "task_local_ecosystem",
        "local_ecosystem__inspect_local_ecosystem",
        "call_local_ecosystem",
        Json::Value(Json::objectValue),
        nullptr);

    expect(result.success, "local ecosystem inspection should complete");
    expect(result.toolCall["output"]["os"].isObject(), "inspection should include os details");
    expect(result.toolCall["output"]["hardware"].isObject(), "inspection should include hardware details");
    expect(result.toolCall["output"]["software"].isObject(), "inspection should include software details");

    toolSystem.endTaskSession("task_local_ecosystem");
}

void testInternetTestingLocalBenchmarkCompletes() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installInternetTestingPack(packRoot);
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();

    ToolSystem::SessionOptions options;
    options.taskId = "task_internet_testing";
    options.toolScope = internetTestingScope();
    toolSystem.beginTaskSession(options);

    const Json::Value tools = toolSystem.getModelToolsForTask("task_internet_testing");
    expect(hasModelTool(tools, "internet_testing__test_internet_connection"),
        "internet testing tool should be exposed");

    Json::Value args(Json::objectValue);
    args["include_wan"] = false;
    args["include_local"] = true;
    args["local_test_bytes"] = 1024 * 1024;
    const ToolSystem::ExecutionResult result = toolSystem.executeToolCall(
        "task_internet_testing",
        "internet_testing__test_internet_connection",
        "call_internet_testing",
        args,
        nullptr);

    expect(result.success, "internet testing tool should complete");
    expect(result.toolCall["output"]["local"].isObject(), "internet testing should include local results");
#ifndef _WIN32
    expect(result.toolCall["output"]["local"].get("available", false).asBool(),
        "local loopback benchmark should be available on Linux");
    expect(result.toolCall["output"]["local"]["latency_ms"].isObject(),
        "local benchmark should include latency stats");
    expect(result.toolCall["output"]["local"]["download"].isObject(),
        "local benchmark should include download stats");
#endif

    toolSystem.endTaskSession("task_internet_testing");
}

void testAssistantWorkspacePersistsPerChat() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installAssistantWorkspacePack(packRoot);
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot));
    toolSystem.initialize();

    ToolSystem::SessionOptions firstOptions;
    firstOptions.taskId = "task_workspace_first";
    firstOptions.chatId = "chat-alpha";
    firstOptions.toolScope = assistantWorkspaceScope();
    toolSystem.beginTaskSession(firstOptions);

    const Json::Value tools = toolSystem.getModelToolsForTask("task_workspace_first");
    expect(hasModelTool(tools, "assistant_workspace__chat_notes"),
        "assistant workspace notes tool should be exposed");
    expect(hasModelTool(tools, "assistant_workspace__todo_list"),
        "assistant workspace TODO tool should be exposed");

    Json::Value planArgs(Json::objectValue);
    planArgs["action"] = "set_plan";
    planArgs["content"] = "1. Read context\n2. Implement change\n3. Verify";
    const ToolSystem::ExecutionResult planResult = toolSystem.executeToolCall(
        "task_workspace_first",
        "assistant_workspace__chat_notes",
        "call_plan",
        planArgs,
        nullptr);
    expect(planResult.success, "set_plan should complete");
    expect(planResult.toolCall["output"]["note"].get("id", "").asString() == "plan",
        "set_plan should write the special plan note");

    Json::Value replaceArgs(Json::objectValue);
    replaceArgs["action"] = "replace_all";
    Json::Value firstItem(Json::objectValue);
    firstItem["title"] = "Read context";
    firstItem["priority"] = "high";
    Json::Value secondItem(Json::objectValue);
    secondItem["title"] = "Verify";
    replaceArgs["items"].append(firstItem);
    replaceArgs["items"].append(secondItem);
    const ToolSystem::ExecutionResult replaceResult = toolSystem.executeToolCall(
        "task_workspace_first",
        "assistant_workspace__todo_list",
        "call_replace",
        replaceArgs,
        nullptr);
    expect(replaceResult.success, "replace_all TODO should complete");
    expect(replaceResult.toolCall["output"]["count"].asInt() == 2,
        "replace_all should persist two TODO items");

    toolSystem.endTaskSession("task_workspace_first");

    ToolSystem::SessionOptions secondOptions;
    secondOptions.taskId = "task_workspace_second";
    secondOptions.chatId = "chat-alpha";
    secondOptions.toolScope = assistantWorkspaceScope();
    toolSystem.beginTaskSession(secondOptions);

    Json::Value listArgs(Json::objectValue);
    listArgs["action"] = "list";
    const ToolSystem::ExecutionResult notesList = toolSystem.executeToolCall(
        "task_workspace_second",
        "assistant_workspace__chat_notes",
        "call_list_notes",
        listArgs,
        nullptr);
    expect(notesList.success, "notes list should complete");
    expect(notesList.toolCall["output"]["notes"].isArray() &&
           notesList.toolCall["output"]["notes"].size() == 1,
        "notes should persist across sessions in the same chat");

    const ToolSystem::ExecutionResult todosList = toolSystem.executeToolCall(
        "task_workspace_second",
        "assistant_workspace__todo_list",
        "call_list_todos",
        listArgs,
        nullptr);
    expect(todosList.success, "TODO list should complete");
    expect(todosList.toolCall["output"]["todos"].isArray() &&
           todosList.toolCall["output"]["todos"].size() == 2,
        "TODOs should persist across sessions in the same chat");

    toolSystem.endTaskSession("task_workspace_second");

    ToolSystem::SessionOptions isolatedOptions;
    isolatedOptions.taskId = "task_workspace_isolated";
    isolatedOptions.chatId = "chat-beta";
    isolatedOptions.toolScope = assistantWorkspaceScope();
    toolSystem.beginTaskSession(isolatedOptions);

    const ToolSystem::ExecutionResult isolatedNotes = toolSystem.executeToolCall(
        "task_workspace_isolated",
        "assistant_workspace__chat_notes",
        "call_isolated_notes",
        listArgs,
        nullptr);
    expect(isolatedNotes.success, "isolated notes list should complete");
    expect(isolatedNotes.toolCall["output"]["notes"].empty(),
        "notes should not leak across chats");

    toolSystem.endTaskSession("task_workspace_isolated");
}

void testCliRiskAssessment() {
    Json::Value args(Json::objectValue);
    args["command"] = "ls -la";
    cli_tool::RiskAssessment assessment = cli_tool::assessRisk(args);
    expect(!assessment.requiresApproval, "read-only ls should not require approval");
    expect(assessment.riskTier == "read", "read-only ls should stay read risk");

    args["command"] = "grep rm TODO.md";
    assessment = cli_tool::assessRisk(args);
    expect(!assessment.requiresApproval, "rm as a grep argument should not require approval");

    args["command"] = "rm -rf build";
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "rm should require approval");
    expect(assessment.riskTier == "destructive", "rm should be destructive risk");

    args["command"] = "sh -c \"rm -f scratch.txt\"";
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "rm inside sh -c should require approval");

    args["command"] = "find . -name '*.tmp' -delete";
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "find -delete should require approval");

    args["command"] = "printf '%s\\0' target.txt | xargs -0 -n 1 rm";
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "xargs rm should require approval");

    args["command"] = "printf hello > out.txt";
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "output redirection should require approval");
    expect(assessment.riskTier == "write", "output redirection should be write risk");

    args["command"] = "pwd";
    args["allow_network"] = true;
    assessment = cli_tool::assessRisk(args);
    expect(assessment.requiresApproval, "network-enabled CLI commands should require approval");
}

void testCliTouchyCommandRequestsApprovalBeforeExecution() {
    ScopedDir temp;
    const fs::path packRoot = temp.path() / "packs";
    const fs::path dataRoot = temp.path() / "data";
    installCliPack(packRoot);
    writeFile(temp.path() / "target.txt", "keep\n");

    Config config((dataRoot / "settings.json").string());
    config.load();
    setDefaultWorkingDirectory(config, temp.path());
    ToolSystem toolSystem(makeRuntimePaths(packRoot, dataRoot), nullptr, &config);
    toolSystem.initialize();

    const Json::Value sandboxHealth = toolSystem.getSandboxHealth();
    if (!sandboxHealth.get("available", false).asBool()) {
        return;
    }

    ToolSystem::SessionOptions options;
    options.taskId = "task_cli_approval";
    options.toolScope = cliScope();
    toolSystem.beginTaskSession(options);

    Json::Value args(Json::objectValue);
    args["command"] = "rm target.txt";

    bool sawApproval = false;
    const ToolSystem::ExecutionResult result = toolSystem.executeToolCall(
        "task_cli_approval",
        "cli__run_command",
        "call_cli_rm",
        args,
        [&](const Json::Value& event) {
            if (event.get("event", "").asString() == "approval_required") {
                sawApproval = true;
            }
            return true;
        },
        [&]() {
            return sawApproval;
        });

    expect(sawApproval, "rm command should emit an approval_required event");
    expect(!result.success, "cancelled approval should not execute successfully");
    expect(result.toolCall.get("status", "").asString() == "cancelled", "approval cancel should cancel the tool call");
    expect(fs::exists(temp.path() / "target.txt"), "rm command should not run before approval");

    const Json::Value approvals = toolSystem.listApprovals("task_cli_approval");
    expect(!approvals.empty(), "approval record should be stored");
    expect(approvals[0].get("riskTier", "").asString() == "destructive", "approval should carry destructive risk");

    toolSystem.endTaskSession("task_cli_approval");
}

} // namespace

int main() {
    try {
        testInvalidPromptToolFailsWithoutApproval();
        testNoopPromptToolCompletesWithoutApproval();
        testRevisionModeActivatesDraftEditor();
        testLocalEcosystemInspectionCompletes();
        testInternetTestingLocalBenchmarkCompletes();
        testAssistantWorkspacePersistsPerChat();
        testCliRiskAssessment();
        testCliTouchyCommandRequestsApprovalBeforeExecution();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "tool_system_test failed: " << exception.what() << "\n";
        return 1;
    }
}
