#include "services/tools/tool_system.h"

#include "services/tools/calculator_tool.h"
#include "services/tools/file_edit_tool.h"
#include "services/tools/file_reader_tool.h"
#include "services/tools/filesystem_tool.h"
#include "services/tools/tool_argument_validator.h"
#include "services/tools/web_search_tool.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <curl/curl.h>

#ifndef _WIN32
#include <fcntl.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

#include "server/http_utils.h"
#include "services/mcp_registry.h"

namespace fs = std::filesystem;

namespace {

using Clock = std::chrono::system_clock;

Json::Int64 nowMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now().time_since_epoch()).count());
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::vector<std::string> tokenizeSearchTerms(const std::string& value) {
    std::vector<std::string> terms;
    std::string current;
    current.reserve(value.size());

    for (char ch : value) {
        const unsigned char c = static_cast<unsigned char>(ch);
        if (std::isalnum(c)) {
            current.push_back(static_cast<char>(std::tolower(c)));
            continue;
        }
        if (current.size() >= 2) {
            terms.push_back(current);
        }
        current.clear();
    }

    if (current.size() >= 2) {
        terms.push_back(current);
    }
    return terms;
}

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string sanitizeIdentifier(const std::string& input) {
    std::string output;
    output.reserve(input.size());
    for (char c : input) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') {
            output.push_back(c);
        } else {
            output.push_back('_');
        }
    }
    return output.empty() ? "tool" : output;
}

Json::Value readJsonFile(const fs::path& path, const Json::Value& fallback = Json::Value()) {
    std::ifstream file(path);
    if (!file.is_open()) {
        return fallback;
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    Json::Value root;
    if (!Json::parseFromStream(reader, file, &root, &errors)) {
        std::cerr << "[ToolSystem] Failed to parse " << path << ": " << errors << "\n";
        return fallback;
    }
    return root;
}

void writeJsonFile(const fs::path& path, const Json::Value& value) {
    fs::create_directories(path.parent_path());
    std::ofstream file(path);
    if (!file.is_open()) {
        return;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(value, &file);
}

std::string jsonToString(const Json::Value& value) {
    return writeJson(value);
}

Json::Value stringOrJson(const std::string& value) {
    Json::Value parsed;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(value);
    if (Json::parseFromStream(reader, stream, &parsed, &errors)) {
        return parsed;
    }
    return Json::Value(value);
}

Json::Value makeToolErrorResult(const std::string& message) {
    Json::Value result(Json::objectValue);
    result["error"] = message;
    return result;
}

Json::Value makeArray(const std::vector<std::string>& values) {
    Json::Value out(Json::arrayValue);
    for (const auto& value : values) {
        out.append(value);
    }
    return out;
}

std::string getStringArg(const Json::Value& value, const std::string& key, const std::string& fallback = "") {
    if (value.isObject() && value.isMember(key) && value[key].isString()) {
        return value[key].asString();
    }
    return fallback;
}

bool getBoolArg(const Json::Value& value, const std::string& key, bool fallback = false) {
    if (value.isObject() && value.isMember(key) && value[key].isBool()) {
        return value[key].asBool();
    }
    return fallback;
}

int getIntArg(const Json::Value& value, const std::string& key, int fallback = 0) {
    if (value.isObject() && value.isMember(key) && value[key].isInt()) {
        return value[key].asInt();
    }
    return fallback;
}

Json::Value deepMerge(Json::Value base, const Json::Value& overlay) {
    if (!base.isObject() || !overlay.isObject()) {
        return overlay;
    }

    for (const auto& key : overlay.getMemberNames()) {
        if (base.isMember(key) && base[key].isObject() && overlay[key].isObject()) {
            base[key] = deepMerge(base[key], overlay[key]);
        } else {
            base[key] = overlay[key];
        }
    }
    return base;
}

std::string interpolateString(const std::string& input, const Json::Value& args) {
    std::string output = input;
    std::size_t position = 0;
    while ((position = output.find("{{", position)) != std::string::npos) {
        const std::size_t close = output.find("}}", position + 2);
        if (close == std::string::npos) {
            break;
        }

        const std::string token = trimCopy(output.substr(position + 2, close - position - 2));
        std::string replacement;
        if (token.rfind("args.", 0) == 0) {
            const std::string key = token.substr(5);
            if (args.isObject() && args.isMember(key)) {
                const Json::Value& value = args[key];
                if (value.isString()) {
                    replacement = value.asString();
                } else if (value.isBool()) {
                    replacement = value.asBool() ? "true" : "false";
                } else if (value.isNumeric()) {
                    replacement = writeJson(value);
                } else {
                    replacement = jsonToString(value);
                }
            }
        }
        output.replace(position, close - position + 2, replacement);
        position += replacement.size();
    }
    return output;
}

Json::Value interpolateJson(Json::Value value, const Json::Value& args) {
    if (value.isString()) {
        return Json::Value(interpolateString(value.asString(), args));
    }
    if (value.isArray()) {
        for (auto& item : value) {
            item = interpolateJson(item, args);
        }
        return value;
    }
    if (value.isObject()) {
        for (const auto& key : value.getMemberNames()) {
            value[key] = interpolateJson(value[key], args);
        }
    }
    return value;
}

Json::Value splitCsv(const std::string& csv) {
    Json::Value values(Json::arrayValue);
    std::stringstream stream(csv);
    std::string item;
    while (std::getline(stream, item, ',')) {
        item = trimCopy(item);
        if (!item.empty()) {
            values.append(item);
        }
    }
    return values;
}

std::string joinTags(const Json::Value& value) {
    if (!value.isArray()) {
        return "";
    }
    std::string output;
    for (const auto& item : value) {
        if (!item.isString()) {
            continue;
        }
        if (!output.empty()) {
            output += " ";
        }
        output += item.asString();
    }
    return output;
}

size_t curlWriteToString(void* contents, size_t size, size_t nmemb, void* userp) {
    const size_t total = size * nmemb;
    static_cast<std::string*>(userp)->append(static_cast<char*>(contents), total);
    return total;
}

Json::Value parseMaybeJson(const std::string& body) {
    Json::Value parsed;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(body);
    if (Json::parseFromStream(reader, stream, &parsed, &errors)) {
        return parsed;
    }
    return Json::Value(body);
}

Json::Value extractByPath(const Json::Value& root, const std::string& path) {
    if (path.empty()) {
        return root;
    }

    const Json::Value* current = &root;
    std::stringstream stream(path);
    std::string token;
    while (std::getline(stream, token, '.')) {
        token = trimCopy(token);
        if (token.empty() || !current->isObject() || !current->isMember(token)) {
            return Json::Value();
        }
        current = &(*current)[token];
    }
    return *current;
}

const char* kCalculatorBatchRunner = R"PY(
import itertools
import json
import math
import statistics
from pathlib import Path

SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}

try:
    request = json.loads(Path("/workspace/request.json").read_text())
    scope = {
        "__builtins__": SAFE_BUILTINS,
        "input_data": request.get("input", {}),
        "itertools": itertools,
        "math": math,
        "statistics": statistics,
    }
    exec(compile(request.get("program", ""), "<calculator_batch>", "exec"), scope, scope)
    if "result" not in scope:
        raise RuntimeError("Program must assign result")

    output = json.dumps(scope["result"], separators=(",", ":"), allow_nan=False)
    if len(output) > 20000:
        raise RuntimeError("Result is too large")

    print(json.dumps({
        "sandboxed": True,
        "language": "python",
        "result": scope["result"],
        "output": output,
    }, separators=(",", ":"), allow_nan=False))
except Exception as exc:
    print(json.dumps({"error": str(exc)}, separators=(",", ":")))
)PY";

enum class ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Cancelled,
};

std::string approvalStatusToString(ApprovalStatus status) {
    switch (status) {
        case ApprovalStatus::Pending: return "pending";
        case ApprovalStatus::Approved: return "approved";
        case ApprovalStatus::Denied: return "denied";
        case ApprovalStatus::Cancelled: return "cancelled";
    }
    return "unknown";
}

struct ApprovalRequestState {
    std::string id;
    std::string taskId;
    std::string toolCallId;
    std::string modelToolName;
    std::string canonicalToolId;
    std::string title;
    std::string packId;
    std::string executor;
    std::string riskTier;
    Json::Value input = Json::Value(Json::objectValue);
    Json::Int64 createdAt = nowMillis();
    Json::Int64 resolvedAt = 0;
    ApprovalStatus status = ApprovalStatus::Pending;
    std::string note;

    mutable std::mutex mutex;
    std::condition_variable cv;
};

struct ToolDefinition {
    std::string canonicalId;
    std::string packId;
    std::string toolId;
    std::string modelName;
    std::string title;
    std::string description;
    std::string executor;
    std::string sourceType;
    std::string rootPath;
    Json::Value inputSchema = Json::Value(Json::objectValue);
    Json::Value selection = Json::Value(Json::objectValue);
    Json::Value policy = Json::Value(Json::objectValue);
    Json::Value config = Json::Value(Json::objectValue);
    bool defaultEnabled = false;
    bool alwaysVisible = false;
    bool listedInCatalog = true;
    bool listedInPackSummary = true;
};

struct ToolPackRecord {
    std::string id;
    std::string title;
    std::string version;
    std::string description;
    std::string sourceType;
    std::string rootPath;
    bool defaultEnabled = false;
    bool synthetic = false;
    std::vector<std::string> toolIds;
};

struct ToolSession {
    std::string taskId;
    std::string chatId;
    std::string workingDirectory;
    Json::Value toolScope = Json::Value(Json::objectValue);
    Json::Value legacyTools = Json::Value(Json::arrayValue);
    std::unordered_set<std::string> enabledPackIds;
    std::unordered_set<std::string> loadedToolIds;
    std::function<void(const std::string&)> onStatusChange;
    std::string draftContent;
    Json::Value draftIssues = Json::Value(Json::arrayValue);
    int nextDraftIssueId = 1;
    bool draftCommitted = false;
};

struct SandboxResult {
    bool success = false;
    int exitCode = -1;
    bool timedOut = false;
    std::string stdoutText;
    std::string stderrText;
    std::string error;
};

class SandboxRuntime {
public:
    Json::Value health() const {
        std::lock_guard<std::mutex> lock(mutex_);
        refreshUnlocked();

        Json::Value result(Json::objectValue);
        result["available"] = available_;
        result["binary"] = binaryPath_;
        result["reason"] = reason_;
        return result;
    }

    SandboxResult execute(const Json::Value& sandboxConfig, const Json::Value& args) {
        SandboxResult result;
#ifdef _WIN32
        result.error = "Sandbox execution is only implemented on Linux in phase one";
        return result;
#else
        {
            std::lock_guard<std::mutex> lock(mutex_);
            refreshUnlocked();
            if (!available_) {
                result.error = reason_.empty() ? "bubblewrap is unavailable" : reason_;
                return result;
            }
        }

        const std::string command = getStringArg(sandboxConfig, "command");
        if (command.empty()) {
            result.error = "Sandbox tool is missing sandbox.command";
            return result;
        }

        Json::Value argsArray = sandboxConfig.isMember("args") ? sandboxConfig["args"] : Json::Value(Json::arrayValue);
        argsArray = interpolateJson(argsArray, args);
        const std::string workspaceRoot = getStringArg(sandboxConfig, "workspaceRoot");
        const bool allowNetwork = getBoolArg(sandboxConfig, "allowNetwork", false);
        const int timeoutMs = std::max(1000, getIntArg(sandboxConfig, "timeoutMs", 15000));

        fs::path tempDir;
        try {
            tempDir = fs::temp_directory_path() / ("ctrlpanel-sandbox-" + std::to_string(nowMillis()));
            fs::create_directories(tempDir);
        } catch (const std::exception& exception) {
            result.error = std::string("Failed to create sandbox temp dir: ") + exception.what();
            return result;
        }

        const fs::path homeDir = tempDir / "home";
        const fs::path tmpDir = tempDir / "tmp";
        fs::create_directories(homeDir);
        fs::create_directories(tmpDir);

        std::vector<std::string> commandPieces;
        commandPieces.push_back(binaryPath_);
        commandPieces.push_back("--die-with-parent");
        commandPieces.push_back("--unshare-ipc");
        commandPieces.push_back("--unshare-pid");
        commandPieces.push_back("--unshare-uts");
        if (!allowNetwork) {
            commandPieces.push_back("--unshare-net");
        }
        commandPieces.push_back("--proc");
        commandPieces.push_back("/proc");
        commandPieces.push_back("--dev");
        commandPieces.push_back("/dev");

        for (const auto& dir : {"/usr", "/bin", "/lib", "/lib64", "/etc"}) {
            if (fs::exists(dir)) {
                commandPieces.push_back("--ro-bind");
                commandPieces.push_back(dir);
                commandPieces.push_back(dir);
            }
        }

        commandPieces.push_back("--tmpfs");
        commandPieces.push_back("/tmp");
        commandPieces.push_back("--dir");
        commandPieces.push_back("/workspace");
        commandPieces.push_back("--setenv");
        commandPieces.push_back("HOME");
        commandPieces.push_back("/home/sandbox");
        commandPieces.push_back("--chdir");
        commandPieces.push_back("/workspace");
        commandPieces.push_back("--bind");
        commandPieces.push_back(homeDir.string());
        commandPieces.push_back("/home/sandbox");

        if (!workspaceRoot.empty()) {
            commandPieces.push_back("--bind");
            commandPieces.push_back(interpolateString(workspaceRoot, args));
            commandPieces.push_back("/workspace");
        }

        commandPieces.push_back("--");
        commandPieces.push_back("/bin/sh");
        commandPieces.push_back("-lc");

        std::string shellCommand = interpolateString(command, args);
        for (const auto& argValue : argsArray) {
            if (!argValue.isString()) {
                continue;
            }
            shellCommand += " ";
            shellCommand += interpolateString(argValue.asString(), args);
        }
        commandPieces.push_back(shellCommand);

        std::vector<char*> argv;
        argv.reserve(commandPieces.size() + 1);
        for (auto& piece : commandPieces) {
            argv.push_back(piece.data());
        }
        argv.push_back(nullptr);

        int stdoutPipe[2] = {-1, -1};
        int stderrPipe[2] = {-1, -1};
        if (pipe(stdoutPipe) != 0 || pipe(stderrPipe) != 0) {
            result.error = "Failed to create sandbox pipes";
            if (stdoutPipe[0] >= 0) close(stdoutPipe[0]);
            if (stdoutPipe[1] >= 0) close(stdoutPipe[1]);
            if (stderrPipe[0] >= 0) close(stderrPipe[0]);
            if (stderrPipe[1] >= 0) close(stderrPipe[1]);
            fs::remove_all(tempDir);
            return result;
        }

        const pid_t pid = fork();
        if (pid < 0) {
            result.error = "Failed to fork sandbox process";
            close(stdoutPipe[0]); close(stdoutPipe[1]);
            close(stderrPipe[0]); close(stderrPipe[1]);
            fs::remove_all(tempDir);
            return result;
        }

        if (pid == 0) {
            dup2(stdoutPipe[1], STDOUT_FILENO);
            dup2(stderrPipe[1], STDERR_FILENO);
            close(stdoutPipe[0]);
            close(stdoutPipe[1]);
            close(stderrPipe[0]);
            close(stderrPipe[1]);
            execvp(argv[0], argv.data());
            std::perror("execvp bwrap");
            _exit(127);
        }

        close(stdoutPipe[1]);
        close(stderrPipe[1]);

        fcntl(stdoutPipe[0], F_SETFL, fcntl(stdoutPipe[0], F_GETFL, 0) | O_NONBLOCK);
        fcntl(stderrPipe[0], F_SETFL, fcntl(stderrPipe[0], F_GETFL, 0) | O_NONBLOCK);

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        bool stdoutOpen = true;
        bool stderrOpen = true;
        int status = 0;
        while (stdoutOpen || stderrOpen) {
            fd_set readSet;
            FD_ZERO(&readSet);
            int maxFd = -1;
            if (stdoutOpen) {
                FD_SET(stdoutPipe[0], &readSet);
                maxFd = std::max(maxFd, stdoutPipe[0]);
            }
            if (stderrOpen) {
                FD_SET(stderrPipe[0], &readSet);
                maxFd = std::max(maxFd, stderrPipe[0]);
            }

            auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                deadline - std::chrono::steady_clock::now());
            if (remaining.count() <= 0) {
                result.timedOut = true;
                kill(pid, SIGKILL);
                break;
            }

            timeval timeout;
            timeout.tv_sec = remaining.count() / 1000;
            timeout.tv_usec = (remaining.count() % 1000) * 1000;

            const int selectResult = select(maxFd + 1, &readSet, nullptr, nullptr, &timeout);
            if (selectResult < 0) {
                result.error = "Sandbox select() failed";
                kill(pid, SIGKILL);
                break;
            }

            auto drainPipe = [](int fd, bool& open, std::string& output) {
                char buffer[4096];
                for (;;) {
                    const ssize_t bytes = read(fd, buffer, sizeof(buffer));
                    if (bytes > 0) {
                        output.append(buffer, static_cast<std::size_t>(bytes));
                        continue;
                    }
                    if (bytes == 0) {
                        open = false;
                    }
                    break;
                }
            };

            if (stdoutOpen && FD_ISSET(stdoutPipe[0], &readSet)) {
                drainPipe(stdoutPipe[0], stdoutOpen, result.stdoutText);
            }
            if (stderrOpen && FD_ISSET(stderrPipe[0], &readSet)) {
                drainPipe(stderrPipe[0], stderrOpen, result.stderrText);
            }

            const pid_t waitResult = waitpid(pid, &status, WNOHANG);
            if (waitResult == pid && !stdoutOpen && !stderrOpen) {
                break;
            }
        }

        waitpid(pid, &status, 0);
        close(stdoutPipe[0]);
        close(stderrPipe[0]);
        fs::remove_all(tempDir);

        if (result.timedOut) {
            result.exitCode = 124;
            result.error = "Sandbox command timed out";
            return result;
        }

        if (WIFEXITED(status)) {
            result.exitCode = WEXITSTATUS(status);
            result.success = result.exitCode == 0;
        } else if (WIFSIGNALED(status)) {
            result.exitCode = 128 + WTERMSIG(status);
            result.error = "Sandbox command terminated by signal";
        }

        if (!result.success && result.error.empty() && !result.stderrText.empty()) {
            result.error = trimCopy(result.stderrText);
        }
        return result;
#endif
    }

private:
    void refreshUnlocked() const {
        if (checked_) {
            return;
        }
        checked_ = true;
#ifdef _WIN32
        available_ = false;
        reason_ = "bubblewrap is only supported on Linux in phase one";
        return;
#else
        const std::array<const char*, 4> candidates = {"/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap", "bwrap"};
        for (const char* candidate : candidates) {
            if (std::strchr(candidate, '/')) {
                if (fs::exists(candidate)) {
                    available_ = true;
                    binaryPath_ = candidate;
                    reason_.clear();
                    return;
                }
            } else if (std::system("command -v bwrap >/dev/null 2>&1") == 0) {
                available_ = true;
                binaryPath_ = "bwrap";
                reason_.clear();
                return;
            }
        }
        available_ = false;
        reason_ = "bubblewrap (bwrap) was not found in PATH";
#endif
    }

    mutable std::mutex mutex_;
    mutable bool checked_ = false;
    mutable bool available_ = false;
    mutable std::string binaryPath_;
    mutable std::string reason_;
};

struct ToolSystemConfig {
    Json::Value root = Json::Value(Json::objectValue);
    std::unordered_set<std::string> disabledPackIds;
};

ToolSystemConfig parseToolingConfig(const fs::path& path) {
    ToolSystemConfig config;
    config.root = readJsonFile(path, Json::Value(Json::objectValue));
    const Json::Value disabled = config.root.get("disabledPackIds", Json::Value(Json::arrayValue));
    if (disabled.isArray()) {
        for (const auto& value : disabled) {
            if (value.isString()) {
                config.disabledPackIds.insert(value.asString());
            }
        }
    }
    return config;
}

Json::Value normalizeScope(const Json::Value& input) {
    Json::Value scope = input.isObject() ? input : Json::Value(Json::objectValue);
    if (!scope.isMember("enabledPackIds") || !scope["enabledPackIds"].isArray()) {
        scope["enabledPackIds"] = Json::Value(Json::arrayValue);
    }
    return scope;
}

std::unordered_set<std::string> scopeToSet(const Json::Value& scope) {
    std::unordered_set<std::string> result;
    if (!scope.isObject()) {
        return result;
    }
    const Json::Value enabled = scope.get("enabledPackIds", Json::Value(Json::arrayValue));
    if (!enabled.isArray()) {
        return result;
    }
    for (const auto& item : enabled) {
        if (item.isString()) {
            result.insert(item.asString());
        }
    }
    return result;
}

} // namespace

struct ToolSystem::Impl {
    explicit Impl(const RuntimePaths& inPaths, McpRegistry* registry)
        : paths(inPaths), mcpRegistry(registry) {
        if (!paths.webSearchRoot.empty()) {
            WebSearchTool::Options options;
            options.storageRoot = paths.webSearchRoot;
            options.databasePath = (fs::path(paths.webSearchRoot) / "index.sqlite3").string();
            webSearch = std::make_unique<WebSearchTool>(std::move(options));
            std::string error;
            if (!webSearch->initialize(&error)) {
                std::cerr << "[ToolSystem] Web search initialization failed: " << error << "\n";
            }
        }
    }

    RuntimePaths paths;
    McpRegistry* mcpRegistry = nullptr;
    mutable std::mutex mutex;
    ToolSystemConfig toolingConfig;
    SandboxRuntime sandbox;
    std::unique_ptr<WebSearchTool> webSearch;
    std::unordered_map<std::string, ToolPackRecord> packs;
    std::vector<std::string> packOrder;
    std::unordered_map<std::string, ToolDefinition> toolsByCanonicalId;
    std::unordered_map<std::string, std::string> modelNameToCanonicalId;
    std::unordered_map<std::string, ToolSession> sessions;
    std::unordered_map<std::string, std::shared_ptr<ApprovalRequestState>> approvals;
    std::unordered_map<std::string, std::string> chatWorkingDirectories;

    void clearUnlocked() {
        packs.clear();
        packOrder.clear();
        toolsByCanonicalId.clear();
        modelNameToCanonicalId.clear();
    }

    void registerPackUnlocked(const ToolPackRecord& pack) {
        packs[pack.id] = pack;
        packOrder.push_back(pack.id);
    }

    void registerToolUnlocked(const ToolDefinition& tool) {
        toolsByCanonicalId[tool.canonicalId] = tool;
        modelNameToCanonicalId[tool.modelName] = tool.canonicalId;
        auto packIt = packs.find(tool.packId);
        if (packIt != packs.end()) {
            packIt->second.toolIds.push_back(tool.canonicalId);
        }
    }

    void installControlPlaneToolsUnlocked() {
        ToolPackRecord pack;
        pack.id = "system-control";
        pack.title = "Internal Tool Control Plane";
        pack.version = "1";
        pack.description = "Synthetic harness tools for catalog search and deferred schema loading.";
        pack.sourceType = "system";
        pack.rootPath = "";
        pack.defaultEnabled = false;
        pack.synthetic = true;
        registerPackUnlocked(pack);

        auto makePolicy = []() {
            Json::Value policy(Json::objectValue);
            policy["riskTier"] = "read";
            policy["approvalMode"] = "auto";
            policy["network"] = false;
            policy["idempotent"] = true;
            return policy;
        };

        auto makeSelection = [](const std::string& summary, const std::string& whenToUse, const std::string& whenNotToUse) {
            Json::Value selection(Json::objectValue);
            selection["summary"] = summary;
            selection["tags"] = Json::Value(Json::arrayValue);
            selection["whenToUse"] = whenToUse;
            selection["whenNotToUse"] = whenNotToUse;
            return selection;
        };

        ToolDefinition search;
        search.canonicalId = "system/search_tool_catalog";
        search.packId = pack.id;
        search.toolId = "search_tool_catalog";
        search.modelName = "search_tool_catalog";
        search.title = "Search Tool Catalog";
        search.description = "Search the internal tool catalog and return compact descriptors for relevant tools. Use this before attempting to load real tool schemas.";
        search.executor = "native";
        search.sourceType = "system";
        search.alwaysVisible = true;
        search.listedInCatalog = false;
        search.listedInPackSummary = false;
        search.policy = makePolicy();
        search.selection = makeSelection(
            "Search available tools by capability, task intent, and constraints.",
            "Use when the current active tool list does not contain the capability you need.",
            "Do not use when you already have the exact tool definition loaded.");
        search.inputSchema["type"] = "object";
        search.inputSchema["additionalProperties"] = false;
        search.inputSchema["properties"]["query"]["type"] = "string";
        search.inputSchema["properties"]["intent"]["type"] = "string";
        search.inputSchema["properties"]["constraints"]["type"] = "object";
        search.inputSchema["properties"]["limit"]["type"] = "integer";
        Json::Value searchRequired(Json::arrayValue);
        searchRequired.append("query");
        search.inputSchema["required"] = searchRequired;
        search.config["native"]["handler"] = "search_tool_catalog";
        registerToolUnlocked(search);

        ToolDefinition load;
        load.canonicalId = "system/load_tool_definitions";
        load.packId = pack.id;
        load.toolId = "load_tool_definitions";
        load.modelName = "load_tool_definitions";
        load.title = "Load Tool Definitions";
        load.description = "Load specific tool schemas into the active tool set for this task. Only previously discovered, in-scope tools can be loaded.";
        load.executor = "native";
        load.sourceType = "system";
        load.alwaysVisible = true;
        load.listedInCatalog = false;
        load.listedInPackSummary = false;
        load.policy = makePolicy();
        load.selection = makeSelection(
            "Load selected tool definitions into the active tool set.",
            "Use after catalog search identifies the tools you need for the current task.",
            "Do not use to explore capabilities; search the catalog first.");
        load.inputSchema["type"] = "object";
        load.inputSchema["additionalProperties"] = false;
        load.inputSchema["properties"]["tool_ids"]["type"] = "array";
        load.inputSchema["properties"]["tool_ids"]["items"]["type"] = "string";
        Json::Value loadRequired(Json::arrayValue);
        loadRequired.append("tool_ids");
        load.inputSchema["required"] = loadRequired;
        load.config["native"]["handler"] = "load_tool_definitions";
        registerToolUnlocked(load);
    }

    void installDraftEditorToolsUnlocked() {
        ToolPackRecord pack;
        pack.id = "draft_editor";
        pack.title = "Draft Editor";
        pack.version = "1";
        pack.description = "Synthetic assistant-draft editing tools for transparent revision mode.";
        pack.sourceType = "system";
        pack.rootPath = "";
        pack.defaultEnabled = false;
        pack.synthetic = true;
        registerPackUnlocked(pack);

        auto makePolicy = []() {
            Json::Value policy(Json::objectValue);
            policy["riskTier"] = "read";
            policy["approvalMode"] = "auto";
            policy["network"] = false;
            policy["idempotent"] = false;
            return policy;
        };

        auto makeSelection = [](const std::string& summary) {
            Json::Value selection(Json::objectValue);
            selection["summary"] = summary;
            selection["tags"] = Json::Value(Json::arrayValue);
            selection["tags"].append("revision");
            selection["tags"].append("draft");
            selection["whenToUse"] = "Use inside transparent revision mode to edit the temporary assistant draft.";
            selection["whenNotToUse"] = "Do not use for user files, filesystem edits, or ordinary answer text outside revision mode.";
            return selection;
        };

        auto baseSchema = []() {
            Json::Value schema(Json::objectValue);
            schema["type"] = "object";
            schema["additionalProperties"] = false;
            return schema;
        };

        auto stringProperty = [](Json::Value& schema, const std::string& name, const std::string& description) {
            schema["properties"][name]["type"] = "string";
            schema["properties"][name]["description"] = description;
        };

        auto required = [](std::initializer_list<const char*> names) {
            Json::Value result(Json::arrayValue);
            for (const char* name : names) {
                result.append(name);
            }
            return result;
        };

        auto registerDraftTool = [&](const std::string& toolId,
                                     const std::string& title,
                                     const std::string& description,
                                     const Json::Value& schema,
                                     const std::string& handler) {
            ToolDefinition tool;
            tool.canonicalId = pack.id + "/" + toolId;
            tool.packId = pack.id;
            tool.toolId = toolId;
            tool.modelName = sanitizeIdentifier(pack.id) + "__" + toolId;
            tool.title = title;
            tool.description = description;
            tool.executor = "native";
            tool.sourceType = "system";
            tool.inputSchema = schema;
            tool.selection = makeSelection(description);
            tool.policy = makePolicy();
            tool.defaultEnabled = false;
            tool.alwaysVisible = true;
            tool.listedInCatalog = false;
            tool.listedInPackSummary = false;
            tool.config["native"]["handler"] = handler;
            registerToolUnlocked(tool);
        };

        Json::Value createSchema = baseSchema();
        stringProperty(createSchema, "content", "The complete current working draft.");
        stringProperty(createSchema, "summary", "A short user-visible note describing the draft pass.");
        createSchema["required"] = required({"content"});
        registerDraftTool(
            "create_draft",
            "Create Draft",
            "Create or replace the temporary assistant draft with a complete first version.",
            createSchema,
            "draft_editor_create");

        Json::Value annotateSchema = baseSchema();
        stringProperty(annotateSchema, "label", "Issue category such as unclear_thesis, unsupported_claim, repetition, ordering, uncertain_fact, code_risk, or none.");
        stringProperty(annotateSchema, "severity", "Issue severity: low, medium, high, or none.");
        stringProperty(annotateSchema, "span", "The short draft span or section this issue refers to.");
        stringProperty(annotateSchema, "note", "Concrete user-visible review note.");
        stringProperty(annotateSchema, "recommended_action", "Targeted edit that should address the issue.");
        annotateSchema["required"] = required({"label", "severity", "note"});
        registerDraftTool(
            "annotate_issue",
            "Annotate Issue",
            "Record one concrete review note against the current draft.",
            annotateSchema,
            "draft_editor_annotate_issue");

        Json::Value replaceSchema = baseSchema();
        stringProperty(replaceSchema, "target", "Exact text in the current draft to replace.");
        stringProperty(replaceSchema, "replacement", "Replacement text.");
        stringProperty(replaceSchema, "summary", "Short user-visible note explaining the edit.");
        replaceSchema["properties"]["occurrence"]["type"] = "integer";
        replaceSchema["properties"]["occurrence"]["description"] = "One-based occurrence number to replace. Defaults to 1.";
        replaceSchema["required"] = required({"target", "replacement"});
        registerDraftTool(
            "replace_text",
            "Replace Text",
            "Replace a targeted span in the current assistant draft.",
            replaceSchema,
            "draft_editor_replace_text");

        Json::Value insertSchema = baseSchema();
        stringProperty(insertSchema, "target", "Exact text in the current draft to insert after.");
        stringProperty(insertSchema, "insertion", "Text to insert after the target.");
        stringProperty(insertSchema, "summary", "Short user-visible note explaining the edit.");
        insertSchema["properties"]["occurrence"]["type"] = "integer";
        insertSchema["properties"]["occurrence"]["description"] = "One-based occurrence number to insert after. Defaults to 1.";
        insertSchema["required"] = required({"target", "insertion"});
        registerDraftTool(
            "insert_after",
            "Insert After",
            "Insert text after a targeted span in the current assistant draft.",
            insertSchema,
            "draft_editor_insert_after");

        Json::Value deleteSchema = baseSchema();
        stringProperty(deleteSchema, "target", "Exact text in the current draft to delete.");
        stringProperty(deleteSchema, "summary", "Short user-visible note explaining the edit.");
        deleteSchema["properties"]["occurrence"]["type"] = "integer";
        deleteSchema["properties"]["occurrence"]["description"] = "One-based occurrence number to delete. Defaults to 1.";
        deleteSchema["required"] = required({"target"});
        registerDraftTool(
            "delete_text",
            "Delete Text",
            "Delete a targeted span in the current assistant draft.",
            deleteSchema,
            "draft_editor_delete_text");

        Json::Value commitSchema = baseSchema();
        stringProperty(commitSchema, "change_summary", "Concise summary of meaningful changes made before committing.");
        stringProperty(commitSchema, "content", "Optional complete final answer. If omitted, the current draft is committed.");
        commitSchema["required"] = required({"change_summary"});
        registerDraftTool(
            "commit_final",
            "Commit Final",
            "Commit the current assistant draft as the final answer for the transcript.",
            commitSchema,
            "draft_editor_commit_final");
    }

    void loadManifestPackUnlocked(const fs::path& packDir, const std::string& fallbackSourceType) {
        const fs::path packPath = packDir / "pack.json";
        if (!fs::exists(packPath)) {
            return;
        }

        const Json::Value packJson = readJsonFile(packPath, Json::Value());
        if (!packJson.isObject()) {
            return;
        }

        const std::string packId = getStringArg(packJson, "id");
        const std::string title = getStringArg(packJson, "title");
        const std::string version = getStringArg(packJson, "version");
        const std::string description = getStringArg(packJson, "description");
        const std::string sourceType = getStringArg(packJson, "sourceType", fallbackSourceType);
        if (packId.empty() || title.empty() || version.empty() || description.empty() || sourceType.empty()) {
            std::cerr << "[ToolSystem] Skipping malformed pack at " << packDir << "\n";
            return;
        }
        if (toolingConfig.disabledPackIds.find(packId) != toolingConfig.disabledPackIds.end()) {
            std::cout << "[ToolSystem] Pack disabled by tooling config: " << packId << "\n";
            return;
        }

        ToolPackRecord pack;
        pack.id = packId;
        pack.title = title;
        pack.version = version;
        pack.description = description;
        pack.sourceType = sourceType;
        pack.defaultEnabled = packJson.get("defaultEnabled", sourceType != "mcp").asBool();
        pack.rootPath = packDir.string();
        registerPackUnlocked(pack);

        Json::Value packDefaults = packJson.get("defaults", Json::Value(Json::objectValue));

        const fs::path toolsDir = packDir / "tools";
        if (!fs::exists(toolsDir)) {
            return;
        }

        for (const auto& entry : fs::directory_iterator(toolsDir)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".json") {
                continue;
            }

            const Json::Value toolJson = readJsonFile(entry.path(), Json::Value());
            if (!toolJson.isObject()) {
                continue;
            }

            const std::string toolId = sanitizeIdentifier(getStringArg(toolJson, "id"));
            const std::string toolTitle = getStringArg(toolJson, "title");
            const std::string toolDescription = getStringArg(toolJson, "description");
            const std::string executor = getStringArg(toolJson, "executor");
            if (toolId.empty() || toolTitle.empty() || toolDescription.empty() || executor.empty() ||
                !toolJson.isMember("inputSchema") || !toolJson.isMember("selection") || !toolJson.isMember("policy")) {
                std::cerr << "[ToolSystem] Skipping malformed tool manifest: " << entry.path() << "\n";
                continue;
            }

            const Json::Value selection = toolJson["selection"];
            const Json::Value policy = deepMerge(packDefaults.get("policy", Json::Value(Json::objectValue)), toolJson["policy"]);
            if (!selection.isObject() ||
                !selection.isMember("summary") ||
                !selection.isMember("tags") ||
                !selection.isMember("whenToUse") ||
                !selection.isMember("whenNotToUse")) {
                std::cerr << "[ToolSystem] Tool selection metadata is incomplete: " << entry.path() << "\n";
                continue;
            }
            if (!policy.isObject() ||
                !policy.isMember("riskTier") ||
                !policy.isMember("approvalMode") ||
                !policy.isMember("network") ||
                !policy.isMember("idempotent")) {
                std::cerr << "[ToolSystem] Tool policy metadata is incomplete: " << entry.path() << "\n";
                continue;
            }

            ToolDefinition tool;
            tool.canonicalId = pack.id + "/" + toolId;
            tool.packId = pack.id;
            tool.toolId = toolId;
            tool.modelName = sanitizeIdentifier(pack.id) + "__" + toolId;
            tool.title = toolTitle;
            tool.description = toolDescription;
            tool.executor = executor;
            tool.sourceType = sourceType;
            tool.rootPath = entry.path().string();
            tool.inputSchema = toolJson["inputSchema"];
            tool.selection = selection;
            tool.policy = policy;
            tool.defaultEnabled = pack.defaultEnabled;
            tool.alwaysVisible = toolJson.get("alwaysVisible", false).asBool();
            tool.listedInCatalog = toolJson.get("listedInCatalog", true).asBool();
            tool.listedInPackSummary = toolJson.get("listedInPackSummary", true).asBool();
            tool.config[executor] = toolJson.get(executor, Json::Value(Json::objectValue));
            registerToolUnlocked(tool);
        }
    }

    void loadManifestRootsUnlocked() {
        for (const auto& root : {paths.systemPackRoot, paths.userPackRoot}) {
            if (root.empty() || !fs::exists(root)) {
                continue;
            }
            for (const auto& entry : fs::directory_iterator(root)) {
                if (!entry.is_directory()) {
                    continue;
                }
                loadManifestPackUnlocked(entry.path(), root == paths.userPackRoot ? "user" : "system");
            }
        }
    }

    void importMcpVirtualPacksUnlocked() {
        if (!mcpRegistry) {
            return;
        }

        const Json::Value descriptors = mcpRegistry->listBridgedTools();
        std::unordered_map<std::string, ToolPackRecord> pendingPacks;
        for (const auto& item : descriptors) {
            if (!item.isObject()) {
                continue;
            }

            const std::string packId = getStringArg(item, "packId");
            const std::string canonicalId = getStringArg(item, "canonicalId");
            if (packId.empty() || canonicalId.empty()) {
                continue;
            }

            if (pendingPacks.find(packId) == pendingPacks.end()) {
                ToolPackRecord pack;
                pack.id = packId;
                pack.title = getStringArg(item, "packTitle", packId);
                pack.version = "mcp";
                pack.description = getStringArg(item, "packDescription", "MCP virtual tool pack");
                pack.sourceType = "mcp";
                pack.rootPath = "";
                pack.defaultEnabled = false;
                pack.synthetic = true;
                pendingPacks[packId] = pack;
            }

            ToolDefinition tool;
            tool.canonicalId = canonicalId;
            tool.packId = packId;
            tool.toolId = getStringArg(item, "toolId");
            tool.modelName = sanitizeIdentifier(packId) + "__" + sanitizeIdentifier(tool.toolId);
            tool.title = getStringArg(item, "title", tool.toolId);
            tool.description = getStringArg(item, "description");
            tool.executor = "mcp";
            tool.sourceType = "mcp";
            tool.defaultEnabled = false;
            tool.inputSchema = item.get("inputSchema", Json::Value(Json::objectValue));
            tool.selection["summary"] = tool.description.empty() ? tool.title : tool.description;
            tool.selection["tags"] = Json::Value(Json::arrayValue);
            tool.selection["whenToUse"] = "Use when this external MCP capability matches the current task.";
            tool.selection["whenNotToUse"] = "Do not use when an already-loaded internal tool is a better fit.";
            tool.policy["riskTier"] = "read";
            tool.policy["approvalMode"] = "auto";
            tool.policy["network"] = false;
            tool.policy["idempotent"] = true;
            tool.config["mcp"]["serverName"] = item.get("serverName", "");
            tool.config["mcp"]["toolName"] = item.get("toolName", "");
            registerToolUnlocked(tool);
        }

        for (const auto& [packId, pack] : pendingPacks) {
            if (packs.find(packId) == packs.end()) {
                registerPackUnlocked(pack);
            }
        }
    }

    void loadAllUnlocked() {
        clearUnlocked();
        toolingConfig = parseToolingConfig(paths.toolingConfigPath);
        installControlPlaneToolsUnlocked();
        installDraftEditorToolsUnlocked();
        loadManifestRootsUnlocked();
        if (mcpRegistry) {
            mcpRegistry->loadFromFile(paths.mcpConfigPath);
        }
        importMcpVirtualPacksUnlocked();
    }

    std::unordered_set<std::string> defaultEnabledPacksUnlocked() const {
        std::unordered_set<std::string> result;
        for (const auto& packId : packOrder) {
            const auto it = packs.find(packId);
            if (it != packs.end() &&
                it->second.defaultEnabled &&
                it->second.sourceType != "mcp" &&
                !it->second.synthetic) {
                result.insert(packId);
            }
        }
        return result;
    }

    bool isAlwaysVisibleInSessionUnlocked(const ToolSession& session, const ToolDefinition& tool) const {
        if (!tool.alwaysVisible) {
            return false;
        }
        return session.enabledPackIds.find(tool.packId) != session.enabledPackIds.end();
    }

    bool isToolActiveInSessionUnlocked(const ToolSession& session, const ToolDefinition& tool) const {
        if (isAlwaysVisibleInSessionUnlocked(session, tool)) {
            return true;
        }
        return session.loadedToolIds.find(tool.canonicalId) != session.loadedToolIds.end();
    }

    bool isToolInScopeUnlocked(const ToolSession& session, const ToolDefinition& tool) const {
        if (tool.packId == "system-control") {
            return true;
        }
        return session.enabledPackIds.find(tool.packId) != session.enabledPackIds.end();
    }

    Json::Value makeFunctionTool(const ToolDefinition& tool) const {
        Json::Value entry(Json::objectValue);
        entry["type"] = "function";
        entry["function"]["name"] = tool.modelName;
        entry["function"]["description"] = tool.description;
        entry["function"]["parameters"] = tool.inputSchema;
        return entry;
    }

    std::optional<ToolDefinition> findToolByModelNameUnlocked(const ToolSession& session, const std::string& modelName) const {
        const auto it = modelNameToCanonicalId.find(modelName);
        if (it == modelNameToCanonicalId.end()) {
            return std::nullopt;
        }
        const auto toolIt = toolsByCanonicalId.find(it->second);
        if (toolIt == toolsByCanonicalId.end()) {
            return std::nullopt;
        }
        if (!isToolActiveInSessionUnlocked(session, toolIt->second)) {
            return std::nullopt;
        }
        return toolIt->second;
    }

    Json::Value buildCatalogResultsUnlocked(const std::string& query, const ToolSession* session, int limit) const {
        Json::Value results(Json::arrayValue);
        const std::string loweredQuery = toLower(trimCopy(query));
        const std::vector<std::string> queryTerms = tokenizeSearchTerms(loweredQuery);
        const int cappedLimit = std::clamp(limit <= 0 ? 8 : limit, 1, 50);

        struct Match {
            int score = 0;
            Json::Value descriptor;
        };
        std::vector<Match> matches;
        matches.reserve(toolsByCanonicalId.size());

        for (const auto& [canonicalId, tool] : toolsByCanonicalId) {
            if (!tool.listedInCatalog) {
                continue;
            }
            if (session && !isToolInScopeUnlocked(*session, tool)) {
                continue;
            }

            const std::string titleText = toLower(tool.title);
            const std::string descriptionText = toLower(tool.description);
            const std::string summaryText = toLower(getStringArg(tool.selection, "summary"));
            const std::string whenToUseText = toLower(getStringArg(tool.selection, "whenToUse"));
            const std::string tagsText = toLower(joinTags(tool.selection["tags"]));
            const std::string packIdText = toLower(tool.packId);
            const std::string toolIdText = toLower(tool.toolId);
            const std::string modelNameText = toLower(tool.modelName);
            const std::string haystack =
                titleText + " " +
                descriptionText + " " +
                summaryText + " " +
                whenToUseText + " " +
                tagsText + " " +
                packIdText + " " +
                toolIdText + " " +
                modelNameText;

            int score = 1;
            if (!loweredQuery.empty()) {
                int matchedTerms = 0;
                if (haystack.find(loweredQuery) != std::string::npos) {
                    score += 10;
                }

                for (const auto& term : queryTerms) {
                    bool matched = false;
                    if (titleText.find(term) != std::string::npos) {
                        score += 6;
                        matched = true;
                    } else if (toolIdText.find(term) != std::string::npos || modelNameText.find(term) != std::string::npos) {
                        score += 5;
                        matched = true;
                    } else if (descriptionText.find(term) != std::string::npos) {
                        score += 4;
                        matched = true;
                    } else if (summaryText.find(term) != std::string::npos) {
                        score += 3;
                        matched = true;
                    } else if (tagsText.find(term) != std::string::npos || packIdText.find(term) != std::string::npos) {
                        score += 2;
                        matched = true;
                    } else if (whenToUseText.find(term) != std::string::npos) {
                        score += 1;
                        matched = true;
                    }
                    if (matched) {
                        matchedTerms += 1;
                    }
                }

                if (matchedTerms == 0 && haystack.find(loweredQuery) == std::string::npos) {
                    continue;
                }
                score += matchedTerms * 2;
            }

            Json::Value descriptor(Json::objectValue);
            descriptor["tool_id"] = tool.canonicalId;
            descriptor["model_name"] = tool.modelName;
            descriptor["title"] = tool.title;
            descriptor["description"] = tool.description;
            descriptor["summary"] = tool.selection.get("summary", "");
            descriptor["pack_id"] = tool.packId;
            descriptor["source_type"] = tool.sourceType;
            descriptor["executor"] = tool.executor;
            descriptor["risk_tier"] = tool.policy.get("riskTier", "read");
            descriptor["tags"] = tool.selection.get("tags", Json::Value(Json::arrayValue));
            descriptor["when_to_use"] = tool.selection.get("whenToUse", "");
            descriptor["when_not_to_use"] = tool.selection.get("whenNotToUse", "");
            matches.push_back({score, descriptor});
        }

        std::sort(matches.begin(), matches.end(), [](const Match& left, const Match& right) {
            return left.score > right.score;
        });

        for (int index = 0; index < static_cast<int>(matches.size()) && index < cappedLimit; ++index) {
            results.append(matches[index].descriptor);
        }
        return results;
    }

    Json::Value buildPackSummariesUnlocked() const {
        Json::Value packsJson(Json::arrayValue);
        const Json::Value sandboxHealth = sandbox.health();

        for (const auto& packId : packOrder) {
            const auto packIt = packs.find(packId);
            if (packIt == packs.end()) {
                continue;
            }
            const ToolPackRecord& pack = packIt->second;
            if (pack.synthetic && (pack.id == "system-control" || pack.id == "draft_editor")) {
                continue;
            }

            Json::Value summary(Json::objectValue);
            summary["id"] = pack.id;
            summary["title"] = pack.title;
            summary["version"] = pack.version;
            summary["description"] = pack.description;
            summary["sourceType"] = pack.sourceType;
            summary["defaultEnabled"] = pack.defaultEnabled;
            summary["toolCount"] = static_cast<int>(pack.toolIds.size());

            std::set<std::string> executors;
            for (const auto& toolId : pack.toolIds) {
                const auto toolIt = toolsByCanonicalId.find(toolId);
                if (toolIt != toolsByCanonicalId.end()) {
                    executors.insert(toolIt->second.executor);
                }
            }
            Json::Value executorArray(Json::arrayValue);
            for (const auto& executor : executors) {
                executorArray.append(executor);
            }
            summary["executors"] = executorArray;

            Json::Value health(Json::objectValue);
            health["available"] = true;
            if (executors.find("sandbox") != executors.end()) {
                health["sandbox"] = sandboxHealth;
                if (!sandboxHealth.get("available", false).asBool()) {
                    health["available"] = false;
                }
            }
            if (pack.id == "websearch" && webSearch) {
                health["websearch"] = webSearch->health();
                if (!health["websearch"].get("available", true).asBool()) {
                    health["available"] = false;
                }
            }
            summary["health"] = health;
            packsJson.append(summary);
        }
        return packsJson;
    }

    Json::Value buildApprovalJson(const ApprovalRequestState& approval) const {
        Json::Value json(Json::objectValue);
        json["id"] = approval.id;
        json["taskId"] = approval.taskId;
        json["toolCallId"] = approval.toolCallId;
        json["toolName"] = approval.modelToolName;
        json["canonicalToolId"] = approval.canonicalToolId;
        json["title"] = approval.title;
        json["packId"] = approval.packId;
        json["executor"] = approval.executor;
        json["riskTier"] = approval.riskTier;
        json["input"] = approval.input;
        json["status"] = approvalStatusToString(approval.status);
        json["note"] = approval.note;
        json["createdAt"] = approval.createdAt;
        json["resolvedAt"] = approval.resolvedAt;
        return json;
    }

    Json::Value makeToolEvent(
        const std::string& eventName,
        Json::Value toolCall,
        const Json::Value& extra = Json::Value(Json::objectValue)) const {
        Json::Value event(Json::objectValue);
        event["type"] = "tool_event";
        event["event"] = eventName;
        event["tool_call"] = toolCall;
        if (extra.isObject()) {
            for (const auto& key : extra.getMemberNames()) {
                event[key] = extra[key];
            }
        }
        return event;
    }

    ExecutionResult makeExecutionFailure(const std::string& modelToolName, const std::string& toolCallId, const std::string& error) const {
        ExecutionResult result;
        result.success = false;
        result.modelOutput = jsonToString(Json::Value(error));
        result.toolCall["id"] = toolCallId;
        result.toolCall["name"] = modelToolName;
        result.toolCall["status"] = "failed";
        result.toolCall["error"] = error;
        return result;
    }

    bool isFailureResult(const Json::Value& result) const {
        return (result.isObject() && result.isMember("error")) ||
               (result.isObject() && result.isMember("success") && !result["success"].asBool());
    }

    std::optional<Json::Value> preflightToolCall(
        ToolSession& session,
        const ToolDefinition& tool,
        const Json::Value& args) const {
        if (tool.executor == "native") {
            const std::string handler = getStringArg(tool.config["native"], "handler");
            if (handler.empty()) {
                return makeToolErrorResult("Native tool is missing native.handler");
            }

            if (handler == "filesystem_edit_file") {
                Json::Value result = file_edit_tool::preflightEditFile(args, fs::path(session.workingDirectory));
                if (!result.isNull()) {
                    return result;
                }
                return std::nullopt;
            }

            if (handler == "websearch_search" ||
                handler == "websearch_open_result" ||
                handler == "websearch_fetch_url" ||
                handler == "websearch_related_results" ||
                handler == "websearch_status") {
                if (!webSearch) {
                    return makeToolErrorResult("Web search is not configured");
                }
                const Json::Value health = webSearch->health();
                if (health.isObject() && health.isMember("available") && !health["available"].asBool()) {
                    return makeToolErrorResult(health.get("reason", "Web search is unavailable").asString());
                }
                return std::nullopt;
            }

            if (handler == "search_tool_catalog" ||
                handler == "load_tool_definitions" ||
                handler.rfind("draft_editor_", 0) == 0 ||
                handler == "calculator_calculate" ||
                handler == "calculator_calculate_batch" ||
                handler == "file_reader_read_file" ||
                handler == "filesystem_get_working_directory" ||
                handler == "filesystem_change_working_directory" ||
                handler == "filesystem_list_directory" ||
                handler == "filesystem_directory_tree") {
                return std::nullopt;
            }

            return makeToolErrorResult("Unknown native tool handler: " + handler);
        }

        if (tool.executor == "http") {
            const Json::Value config = interpolateJson(tool.config["http"], args);
            if (getStringArg(config, "url").empty()) {
                return makeToolErrorResult("HTTP tool is missing http.url");
            }
            return std::nullopt;
        }

        if (tool.executor == "sandbox") {
            const Json::Value config = interpolateJson(tool.config["sandbox"], args);
            if (getStringArg(config, "command").empty()) {
                return makeToolErrorResult("Sandbox tool is missing sandbox.command");
            }
            const Json::Value health = sandbox.health();
            if (!health.get("available", false).asBool()) {
                return makeToolErrorResult(health.get("reason", "Sandbox executor is unavailable").asString());
            }
            return std::nullopt;
        }

        if (tool.executor == "mcp") {
            if (!mcpRegistry) {
                return makeToolErrorResult("No MCP registry configured");
            }
            const std::string serverName = getStringArg(tool.config["mcp"], "serverName");
            const std::string toolName = getStringArg(tool.config["mcp"], "toolName");
            if (serverName.empty() || toolName.empty()) {
                return makeToolErrorResult("MCP tool is missing serverName or toolName");
            }
            return std::nullopt;
        }

        return makeToolErrorResult("Unsupported executor: " + tool.executor);
    }

    Json::Value executeNative(
        ToolSession& session,
        const ToolDefinition& tool,
        const Json::Value& args,
        std::function<bool()> cancelCheck) {
        const std::string handler = getStringArg(tool.config["native"], "handler");

        if (handler.rfind("draft_editor_", 0) == 0) {
            return executeDraftEditor(session, handler, args);
        }

        if (handler == "search_tool_catalog") {
            Json::Value result(Json::objectValue);
            result["query"] = args.get("query", "");
            {
                std::lock_guard<std::mutex> lock(mutex);
                result["results"] = buildCatalogResultsUnlocked(
                    args.get("query", "").asString(),
                    &session,
                    args.get("limit", 8).asInt());
            }
            return result;
        }

        if (handler == "load_tool_definitions") {
            Json::Value result(Json::objectValue);
            Json::Value loaded(Json::arrayValue);
            Json::Value skipped(Json::arrayValue);
            Json::Value rejected(Json::arrayValue);
            const Json::Value toolIds = args.get("tool_ids", Json::Value(Json::arrayValue));
            if (!toolIds.isArray()) {
                result["error"] = "tool_ids must be an array";
                return result;
            }

            {
                std::lock_guard<std::mutex> lock(mutex);
                for (const auto& item : toolIds) {
                    if (!item.isString()) {
                        continue;
                    }
                    const std::string canonicalId = item.asString();
                    const auto toolIt = toolsByCanonicalId.find(canonicalId);
                    if (toolIt == toolsByCanonicalId.end() || !toolIt->second.listedInCatalog) {
                        Json::Value rejection(Json::objectValue);
                        rejection["tool_id"] = canonicalId;
                        rejection["reason"] = "unknown_tool";
                        rejected.append(rejection);
                        continue;
                    }
                    if (!isToolInScopeUnlocked(session, toolIt->second)) {
                        Json::Value rejection(Json::objectValue);
                        rejection["tool_id"] = canonicalId;
                        rejection["reason"] = "out_of_scope";
                        rejected.append(rejection);
                        continue;
                    }
                    if (session.loadedToolIds.insert(canonicalId).second) {
                        loaded.append(canonicalId);
                    } else {
                        skipped.append(canonicalId);
                    }
                }
            }

            result["loaded"] = loaded;
            result["skipped"] = skipped;
            result["rejected"] = rejected;
            result["active_tools"] = static_cast<int>(session.loadedToolIds.size());
            return result;
        }

        if (handler == "calculator_calculate") {
            return calculator_tool::executeCalculation(args);
        }

        if (handler == "calculator_calculate_batch") {
            fs::path workspaceRoot;
            try {
                const std::size_t threadHash = std::hash<std::thread::id>{}(std::this_thread::get_id());
                workspaceRoot = fs::temp_directory_path() /
                    ("ctrlpanel-calc-batch-" + std::to_string(nowMillis()) + "-" + std::to_string(threadHash));
                fs::create_directories(workspaceRoot);
            } catch (const std::exception& exception) {
                Json::Value error(Json::objectValue);
                error["error"] = std::string("Failed to create calculator batch workspace: ") + exception.what();
                return error;
            }

            struct WorkspaceCleanup {
                fs::path path;
                ~WorkspaceCleanup() {
                    std::error_code ec;
                    fs::remove_all(path, ec);
                }
            } cleanup{workspaceRoot};

            writeJsonFile(workspaceRoot / "request.json", args);

            {
                std::ofstream runner(workspaceRoot / "runner.py");
                if (!runner.is_open()) {
                    Json::Value error(Json::objectValue);
                    error["error"] = "Failed to write calculator batch runner";
                    return error;
                }
                runner << kCalculatorBatchRunner;
            }

            Json::Value sandboxConfig(Json::objectValue);
            sandboxConfig["command"] = "python3 /workspace/runner.py";
            sandboxConfig["workspaceRoot"] = workspaceRoot.string();
            sandboxConfig["allowNetwork"] = false;
            sandboxConfig["timeoutMs"] = 15000;

            const SandboxResult sandboxResult = sandbox.execute(sandboxConfig, Json::Value(Json::objectValue));
            if (!sandboxResult.success) {
                Json::Value error(Json::objectValue);
                error["error"] = sandboxResult.error.empty()
                    ? "Calculator batch execution failed"
                    : sandboxResult.error;
                error["stderr"] = sandboxResult.stderrText;
                error["stdout"] = sandboxResult.stdoutText;
                error["timed_out"] = sandboxResult.timedOut;
                error["exit_code"] = sandboxResult.exitCode;
                return error;
            }

            const std::string stdoutText = trimCopy(sandboxResult.stdoutText);
            if (stdoutText.empty()) {
                Json::Value error(Json::objectValue);
                error["error"] = "Calculator batch produced no output";
                return error;
            }

            const Json::Value parsed = parseMaybeJson(stdoutText);
            if (!parsed.isObject()) {
                Json::Value error(Json::objectValue);
                error["error"] = "Calculator batch returned invalid JSON";
                error["stdout"] = stdoutText;
                return error;
            }
            if (parsed.isMember("error")) {
                return parsed;
            }
            if (!parsed.isMember("result") || !parsed.isMember("output") || !parsed["output"].isString()) {
                Json::Value error(Json::objectValue);
                error["error"] = "Calculator batch returned an incomplete result";
                error["stdout"] = parsed;
                return error;
            }
            return parsed;
        }

        if (handler == "file_reader_read_file") {
            return file_reader_tool::readFile(args, fs::path(session.workingDirectory));
        }

        if (handler == "filesystem_get_working_directory") {
            return filesystem_tool::getWorkingDirectory(fs::path(session.workingDirectory));
        }

        if (handler == "filesystem_change_working_directory") {
            Json::Value result = filesystem_tool::changeWorkingDirectory(args, fs::path(session.workingDirectory));
            if (!result.isObject() || result.isMember("error") || !result["working_directory"].isString()) {
                return result;
            }

            session.workingDirectory = result["working_directory"].asString();
            if (!session.chatId.empty()) {
                std::lock_guard<std::mutex> lock(mutex);
                chatWorkingDirectories[session.chatId] = session.workingDirectory;
            }
            return result;
        }

        if (handler == "filesystem_list_directory") {
            return filesystem_tool::listDirectory(args, fs::path(session.workingDirectory));
        }

        if (handler == "filesystem_directory_tree") {
            return filesystem_tool::directoryTree(args, fs::path(session.workingDirectory));
        }

        if (handler == "filesystem_edit_file") {
            return file_edit_tool::editFile(args, fs::path(session.workingDirectory));
        }

        if (handler == "websearch_search") {
            if (!webSearch) {
                Json::Value error(Json::objectValue);
                error["error"] = "Web search is not configured";
                return error;
            }
            return webSearch->search(args);
        }

        if (handler == "websearch_open_result") {
            if (!webSearch) {
                Json::Value error(Json::objectValue);
                error["error"] = "Web search is not configured";
                return error;
            }
            return webSearch->openResult(args);
        }

        if (handler == "websearch_fetch_url") {
            if (!webSearch) {
                Json::Value error(Json::objectValue);
                error["error"] = "Web search is not configured";
                return error;
            }
            return webSearch->fetchUrl(args, std::move(cancelCheck));
        }

        if (handler == "websearch_related_results") {
            if (!webSearch) {
                Json::Value error(Json::objectValue);
                error["error"] = "Web search is not configured";
                return error;
            }
            return webSearch->relatedResults(args);
        }

        if (handler == "websearch_status") {
            if (!webSearch) {
                Json::Value error(Json::objectValue);
                error["error"] = "Web search is not configured";
                return error;
            }
            return webSearch->status();
        }

        Json::Value error(Json::objectValue);
        error["error"] = "Unknown native tool handler: " + handler;
        return error;
    }

    Json::Value executeHttp(const ToolDefinition& tool, const Json::Value& args) const {
        Json::Value config = interpolateJson(tool.config["http"], args);
        const std::string url = getStringArg(config, "url");
        if (url.empty()) {
            Json::Value error(Json::objectValue);
            error["error"] = "HTTP tool is missing http.url";
            return error;
        }

        CURL* curl = curl_easy_init();
        if (!curl) {
            Json::Value error(Json::objectValue);
            error["error"] = "Failed to initialize CURL";
            return error;
        }

        std::string responseBody;
        struct curl_slist* headers = nullptr;
        const std::string method = getStringArg(config, "method", "GET");
        Json::Value headersJson = config.get("headers", Json::Value(Json::objectValue));
        for (const auto& key : headersJson.getMemberNames()) {
            if (headersJson[key].isString()) {
                headers = curl_slist_append(headers, (key + ": " + headersJson[key].asString()).c_str());
            }
        }

        const Json::Value bodyJson = config.get("body", Json::Value());
        std::string bodyStr;
        if (!bodyJson.isNull()) {
            if (!bodyJson.isObject() && !bodyJson.isArray()) {
                bodyStr = bodyJson.asString();
            } else {
                bodyStr = jsonToString(bodyJson);
                headers = curl_slist_append(headers, "Content-Type: application/json");
            }
        }

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteToString);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, std::max(1000, getIntArg(config, "timeoutMs", 15000)));
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
        if (!bodyStr.empty()) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, bodyStr.c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(bodyStr.size()));
        }

        const CURLcode code = curl_easy_perform(curl);
        long httpStatus = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpStatus);
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

        Json::Value result(Json::objectValue);
        result["http_status"] = static_cast<int>(httpStatus);
        if (code != CURLE_OK) {
            result["error"] = std::string("HTTP request failed: ") + curl_easy_strerror(code);
            return result;
        }

        const Json::Value parsed = parseMaybeJson(responseBody);
        result["body"] = parsed;
        const Json::Value extracted = extractByPath(parsed, getStringArg(config, "responsePath"));
        if (!extracted.isNull()) {
            result["output"] = extracted;
        }
        return result;
    }

    Json::Value executeSandbox(const ToolDefinition& tool, const Json::Value& args) {
        Json::Value sandboxConfig = tool.config["sandbox"];
        sandboxConfig = interpolateJson(sandboxConfig, args);
        const SandboxResult sandboxResult = sandbox.execute(sandboxConfig, args);

        Json::Value result(Json::objectValue);
        result["success"] = sandboxResult.success;
        result["exit_code"] = sandboxResult.exitCode;
        result["timed_out"] = sandboxResult.timedOut;
        result["stdout"] = sandboxResult.stdoutText;
        result["stderr"] = sandboxResult.stderrText;
        if (!sandboxResult.error.empty()) {
            result["error"] = sandboxResult.error;
        }
        return result;
    }

    std::optional<std::size_t> findDraftOccurrence(
        const std::string& content,
        const std::string& target,
        int occurrence) const {
        if (target.empty()) {
            return std::nullopt;
        }
        occurrence = std::max(1, occurrence);
        std::size_t position = 0;
        for (int index = 1; index <= occurrence; ++index) {
            position = content.find(target, position);
            if (position == std::string::npos) {
                return std::nullopt;
            }
            if (index == occurrence) {
                return position;
            }
            position += target.size();
        }
        return std::nullopt;
    }

    Json::Value makeDraftEditorError(const std::string& message) const {
        Json::Value error(Json::objectValue);
        error["error"] = message;
        error["operation"] = "draft_error";
        error["stage"] = "review";
        error["timestamp"] = nowMillis();
        return error;
    }

    Json::Value makeDraftEditorResult(
        const ToolSession& session,
        const std::string& operation,
        const std::string& stage,
        const std::string& summary,
        bool final = false,
        const Json::Value& issue = Json::Value(Json::nullValue)) const {
        Json::Value result(Json::objectValue);
        result["operation"] = operation;
        result["stage"] = stage;
        result["timestamp"] = nowMillis();
        result["content"] = session.draftContent;
        result["summary"] = summary;
        result["issues"] = session.draftIssues;
        if (!issue.isNull()) {
            result["issue"] = issue;
        }
        if (final) {
            result["final"] = true;
        }

        Json::Value patch(Json::objectValue);
        patch["op"] = "replace";
        patch["path"] = "/content";
        patch["value"] = session.draftContent;
        result["patch"] = Json::Value(Json::arrayValue);
        result["patch"].append(patch);

        std::string output = summary;
        if (output.empty()) {
            output = final ? "Final answer committed." : "Draft updated.";
        }
        if (final) {
            output += "\n\nCommitted final answer:\n" + session.draftContent;
        } else {
            output += "\n\nCurrent draft:\n" + session.draftContent;
        }
        result["output"] = output;
        return result;
    }

    Json::Value executeDraftEditor(ToolSession& session, const std::string& handler, const Json::Value& args) {
        if (handler == "draft_editor_create") {
            session.draftContent = getStringArg(args, "content");
            session.draftCommitted = false;
            const std::string summary = getStringArg(args, "summary", "Created a working draft.");
            return makeDraftEditorResult(session, "create_draft", "draft", summary);
        }

        if (handler == "draft_editor_annotate_issue") {
            Json::Value issue(Json::objectValue);
            issue["id"] = "issue_" + std::to_string(session.nextDraftIssueId++);
            issue["label"] = getStringArg(args, "label", "issue");
            issue["severity"] = getStringArg(args, "severity", "medium");
            issue["span"] = getStringArg(args, "span");
            issue["note"] = getStringArg(args, "note");
            issue["recommended_action"] = getStringArg(args, "recommended_action");
            issue["timestamp"] = nowMillis();
            session.draftIssues.append(issue);

            std::string summary = issue.get("note", "").asString();
            if (summary.empty()) {
                summary = "Added a review note.";
            }
            return makeDraftEditorResult(session, "annotate_issue", "review", summary, false, issue);
        }

        if (handler == "draft_editor_replace_text" ||
            handler == "draft_editor_insert_after" ||
            handler == "draft_editor_delete_text") {
            if (session.draftContent.empty()) {
                return makeDraftEditorError("No draft exists yet. Call create_draft first.");
            }

            const std::string target = getStringArg(args, "target");
            const int occurrence = getIntArg(args, "occurrence", 1);
            const auto position = findDraftOccurrence(session.draftContent, target, occurrence);
            if (!position.has_value()) {
                return makeDraftEditorError("Target text was not found in the current draft.");
            }

            std::string operation;
            if (handler == "draft_editor_replace_text") {
                operation = "replace_text";
                session.draftContent.replace(*position, target.size(), getStringArg(args, "replacement"));
            } else if (handler == "draft_editor_insert_after") {
                operation = "insert_after";
                session.draftContent.insert(*position + target.size(), getStringArg(args, "insertion"));
            } else {
                operation = "delete_text";
                session.draftContent.erase(*position, target.size());
            }

            std::string summary = getStringArg(args, "summary");
            if (summary.empty()) {
                summary = "Applied a targeted edit.";
            }
            return makeDraftEditorResult(session, operation, "revise", summary);
        }

        if (handler == "draft_editor_commit_final") {
            const std::string providedContent = getStringArg(args, "content");
            if (!providedContent.empty()) {
                session.draftContent = providedContent;
            }
            if (session.draftContent.empty()) {
                return makeDraftEditorError("Cannot commit an empty draft.");
            }
            session.draftCommitted = true;
            const std::string summary = getStringArg(args, "change_summary", "Committed the final answer.");
            Json::Value result = makeDraftEditorResult(session, "commit_final", "commit", summary, true);
            result["change_summary"] = summary;
            return result;
        }

        return makeDraftEditorError("Unknown draft editor operation.");
    }

    Json::Value executeMcp(const ToolDefinition& tool, const Json::Value& args) const {
        if (!mcpRegistry) {
            Json::Value error(Json::objectValue);
            error["error"] = "No MCP registry configured";
            return error;
        }

        const std::string serverName = getStringArg(tool.config["mcp"], "serverName");
        const std::string toolName = getStringArg(tool.config["mcp"], "toolName");
        return mcpRegistry->callBridgedTool(serverName, toolName, args);
    }

    std::string modelOutputFromResult(const Json::Value& result) const {
        if (result.isString()) {
            return result.asString();
        }
        if (result.isObject() && result.isMember("output")) {
            if (result["output"].isString()) {
                return result["output"].asString();
            }
            return jsonToString(result["output"]);
        }
        if (result.isObject() && result.isMember("stdout") && result["stdout"].isString() &&
            !result["stdout"].asString().empty()) {
            return result["stdout"].asString();
        }
        if (result.isArray()) {
            std::string text;
            for (const auto& item : result) {
                if (item.isObject() && item.get("type", "").asString() == "text") {
                    text += item.get("text", "").asString();
                }
            }
            if (!text.empty()) {
                return text;
            }
        }
        return jsonToString(result);
    }
};

ToolSystem::ToolSystem(const RuntimePaths& paths, McpRegistry* mcpRegistry)
    : impl_(std::make_unique<Impl>(paths, mcpRegistry)) {}

ToolSystem::~ToolSystem() = default;

void ToolSystem::initialize() {
    reload();
}

void ToolSystem::reload() {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->loadAllUnlocked();
}

void ToolSystem::shutdown() {
    if (impl_ && impl_->webSearch) {
        impl_->webSearch->shutdown();
    }
}

void ToolSystem::beginTaskSession(const SessionOptions& options) {
    std::lock_guard<std::mutex> lock(impl_->mutex);

    ToolSession session;
    session.taskId = options.taskId;
    session.chatId = options.chatId;
    session.workingDirectory = fs::current_path().string();
    if (!session.chatId.empty()) {
        const auto cwdIt = impl_->chatWorkingDirectories.find(session.chatId);
        if (cwdIt != impl_->chatWorkingDirectories.end()) {
            std::error_code ec;
            if (fs::is_directory(cwdIt->second, ec) && !ec) {
                session.workingDirectory = cwdIt->second;
            }
        }
    }
    session.toolScope = normalizeScope(options.toolScope);
    session.legacyTools = options.legacyTools.isArray() ? options.legacyTools : Json::Value(Json::arrayValue);
    session.enabledPackIds = scopeToSet(session.toolScope);
    if (session.enabledPackIds.empty()) {
        session.enabledPackIds = impl_->defaultEnabledPacksUnlocked();
    }
    session.enabledPackIds.insert("system-control");
    if (options.revisionMode) {
        session.enabledPackIds.insert("draft_editor");
    }
    session.onStatusChange = options.onStatusChange;
    impl_->sessions[options.taskId] = std::move(session);
}

void ToolSystem::endTaskSession(const std::string& taskId) {
    std::vector<std::shared_ptr<ApprovalRequestState>> pending;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        impl_->sessions.erase(taskId);
        for (auto& [approvalId, approval] : impl_->approvals) {
            if (approval && approval->taskId == taskId) {
                pending.push_back(approval);
            }
        }
    }

    for (const auto& approval : pending) {
        std::lock_guard<std::mutex> approvalLock(approval->mutex);
        if (approval->status == ApprovalStatus::Pending) {
            approval->status = ApprovalStatus::Cancelled;
            approval->resolvedAt = nowMillis();
            approval->note = "Task session ended";
            approval->cv.notify_all();
        }
    }
}

Json::Value ToolSystem::getModelToolsForTask(const std::string& taskId) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);

    Json::Value tools(Json::arrayValue);
    const auto sessionIt = impl_->sessions.find(taskId);
    if (sessionIt == impl_->sessions.end()) {
        return tools;
    }

    const ToolSession& session = sessionIt->second;
    for (const auto& [canonicalId, tool] : impl_->toolsByCanonicalId) {
        if (impl_->isToolActiveInSessionUnlocked(session, tool)) {
            tools.append(impl_->makeFunctionTool(tool));
        }
    }

    for (const auto& legacyTool : session.legacyTools) {
        tools.append(legacyTool);
    }

    return tools;
}

bool ToolSystem::requiresApproval(const std::string& taskId, const std::string& modelToolName) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    const auto sessionIt = impl_->sessions.find(taskId);
    if (sessionIt == impl_->sessions.end()) {
        return false;
    }
    const auto toolOpt = impl_->findToolByModelNameUnlocked(sessionIt->second, modelToolName);
    if (!toolOpt.has_value()) {
        return false;
    }
    return toolOpt->policy.get("approvalMode", "auto").asString() == "prompt";
}

ToolSystem::ExecutionResult ToolSystem::executeToolCall(
    const std::string& taskId,
    const std::string& modelToolName,
    const std::string& toolCallId,
    const Json::Value& arguments,
    std::function<bool(const Json::Value&)> emitEvent,
    std::function<bool()> cancelCheck) {
    std::shared_ptr<ApprovalRequestState> approval;
    ToolDefinition tool;
    ToolSession* sessionPtr = nullptr;

    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        const auto sessionIt = impl_->sessions.find(taskId);
        if (sessionIt == impl_->sessions.end()) {
            return impl_->makeExecutionFailure(modelToolName, toolCallId, "Unknown tool session");
        }
        sessionPtr = &sessionIt->second;
        const auto toolOpt = impl_->findToolByModelNameUnlocked(*sessionPtr, modelToolName);
        if (!toolOpt.has_value()) {
            return impl_->makeExecutionFailure(modelToolName, toolCallId, "Tool is not loaded in the active session");
        }
        tool = *toolOpt;
    }

    Json::Value toolCall(Json::objectValue);
    toolCall["id"] = toolCallId;
    toolCall["name"] = modelToolName;
    toolCall["canonicalId"] = tool.canonicalId;
    toolCall["title"] = tool.title;
    toolCall["packId"] = tool.packId;
    toolCall["executor"] = tool.executor;
    toolCall["riskTier"] = tool.policy.get("riskTier", "read");
    toolCall["approvalMode"] = tool.policy.get("approvalMode", "auto");
    toolCall["input"] = arguments;
    toolCall["status"] = "queued";

    if (const auto validationError = tool_argument_validator::validate(tool.inputSchema, arguments); validationError.has_value()) {
        Json::Value output(Json::objectValue);
        output["error"] = *validationError;
        toolCall["status"] = "failed";
        toolCall["error"] = *validationError;
        toolCall["output"] = output;
        toolCall["modelOutput"] = *validationError;
        if (emitEvent) {
            emitEvent(impl_->makeToolEvent("failed", toolCall));
        }

        ExecutionResult failure;
        failure.success = false;
        failure.modelOutput = *validationError;
        failure.toolCall = toolCall;
        return failure;
    }

    auto finishWithRawResult = [&](Json::Value rawResult) -> ExecutionResult {
        if (impl_->isFailureResult(rawResult)) {
            toolCall["status"] = "failed";
            if (rawResult.isMember("error")) {
                toolCall["error"] = rawResult["error"];
            }
            toolCall["output"] = rawResult;

            ExecutionResult failure;
            failure.success = false;
            failure.modelOutput = rawResult.isMember("error")
                ? rawResult["error"].asString()
                : jsonToString(rawResult);
            toolCall["modelOutput"] = failure.modelOutput;
            if (emitEvent) {
                emitEvent(impl_->makeToolEvent("failed", toolCall));
            }

            failure.toolCall = toolCall;
            return failure;
        }

        toolCall["status"] = "completed";
        toolCall["output"] = rawResult;

        ExecutionResult success;
        success.success = true;
        success.modelOutput = impl_->modelOutputFromResult(rawResult);
        toolCall["modelOutput"] = success.modelOutput;
        if (emitEvent) {
            emitEvent(impl_->makeToolEvent("completed", toolCall));
        }

        success.toolCall = toolCall;
        return success;
    };

    const bool needsApproval = tool.policy.get("approvalMode", "auto").asString() == "prompt";
    if (needsApproval) {
        if (const auto preflightResult = impl_->preflightToolCall(*sessionPtr, tool, arguments); preflightResult.has_value()) {
            return finishWithRawResult(*preflightResult);
        }

        approval = std::make_shared<ApprovalRequestState>();
        approval->id = "approval_" + std::to_string(nowMillis()) + "_" + sanitizeIdentifier(toolCallId);
        approval->taskId = taskId;
        approval->toolCallId = toolCallId;
        approval->modelToolName = modelToolName;
        approval->canonicalToolId = tool.canonicalId;
        approval->title = tool.title;
        approval->packId = tool.packId;
        approval->executor = tool.executor;
        approval->riskTier = tool.policy.get("riskTier", "read").asString();
        approval->input = arguments;
        {
            std::lock_guard<std::mutex> lock(impl_->mutex);
            impl_->approvals[approval->id] = approval;
        }

        toolCall["status"] = "waiting_approval";
        toolCall["approval"]["id"] = approval->id;
        toolCall["approval"]["status"] = "pending";
        if (emitEvent) {
            emitEvent(impl_->makeToolEvent("approval_required", toolCall));
        }
        if (sessionPtr->onStatusChange) {
            sessionPtr->onStatusChange("waiting_approval");
        }

        std::unique_lock<std::mutex> approvalLock(approval->mutex);
        while (approval->status == ApprovalStatus::Pending) {
            approval->cv.wait_for(approvalLock, std::chrono::milliseconds(200));
            if (cancelCheck && cancelCheck()) {
                approval->status = ApprovalStatus::Cancelled;
                approval->resolvedAt = nowMillis();
                approval->note = "Task cancelled";
                break;
            }
        }
        approvalLock.unlock();

        if (sessionPtr->onStatusChange) {
            sessionPtr->onStatusChange("running");
        }

        toolCall["approval"] = impl_->buildApprovalJson(*approval);
        if (approval->status == ApprovalStatus::Denied || approval->status == ApprovalStatus::Cancelled) {
            toolCall["status"] = approval->status == ApprovalStatus::Denied ? "denied" : "cancelled";
            toolCall["error"] = approval->status == ApprovalStatus::Denied
                ? "Tool execution denied by user"
                : "Tool execution cancelled";

            ExecutionResult denied;
            denied.success = false;
            denied.modelOutput = jsonToString(Json::Value(toolCall["error"].asString()));
            toolCall["modelOutput"] = denied.modelOutput;
            if (emitEvent) {
                emitEvent(impl_->makeToolEvent(
                    approval->status == ApprovalStatus::Denied ? "denied" : "cancelled",
                    toolCall));
            }

            denied.toolCall = toolCall;
            return denied;
        }

        toolCall["status"] = "approved";
        if (emitEvent) {
            emitEvent(impl_->makeToolEvent("approved", toolCall));
        }
    }

    toolCall["status"] = "executing";
    if (emitEvent) {
        emitEvent(impl_->makeToolEvent("executing", toolCall));
    }

    Json::Value rawResult;
    if (tool.executor == "native") {
        rawResult = impl_->executeNative(*sessionPtr, tool, arguments, cancelCheck);
    } else if (tool.executor == "http") {
        rawResult = impl_->executeHttp(tool, arguments);
    } else if (tool.executor == "sandbox") {
        rawResult = impl_->executeSandbox(tool, arguments);
    } else if (tool.executor == "mcp") {
        rawResult = impl_->executeMcp(tool, arguments);
    } else {
        rawResult["error"] = "Unsupported executor: " + tool.executor;
    }

    return finishWithRawResult(rawResult);
}

Json::Value ToolSystem::getPackSummaries() const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    Json::Value result(Json::objectValue);
    result["packs"] = impl_->buildPackSummariesUnlocked();
    result["sandbox"] = impl_->sandbox.health();
    return result;
}

Json::Value ToolSystem::getCatalog(const std::string& query, const Json::Value& scope, int limit) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);

    ToolSession tempSession;
    tempSession.enabledPackIds = scopeToSet(normalizeScope(scope));
    if (tempSession.enabledPackIds.empty()) {
        tempSession.enabledPackIds = impl_->defaultEnabledPacksUnlocked();
    }
    tempSession.enabledPackIds.insert("system-control");

    Json::Value result(Json::objectValue);
    result["query"] = query;
    result["results"] = impl_->buildCatalogResultsUnlocked(query, &tempSession, limit);
    return result;
}

Json::Value ToolSystem::getSandboxHealth() const {
    return impl_->sandbox.health();
}

Json::Value ToolSystem::getToolingConfig() const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    return impl_->toolingConfig.root;
}

Json::Value ToolSystem::listApprovals(const std::string& taskId) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    Json::Value approvals(Json::arrayValue);
    for (const auto& [approvalId, approval] : impl_->approvals) {
        if (!approval) {
            continue;
        }
        if (!taskId.empty() && approval->taskId != taskId) {
            continue;
        }
        approvals.append(impl_->buildApprovalJson(*approval));
    }
    return approvals;
}

Json::Value ToolSystem::resolveApproval(const std::string& approvalId, bool approved, const std::string& note) {
    std::shared_ptr<ApprovalRequestState> approval;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        const auto it = impl_->approvals.find(approvalId);
        if (it == impl_->approvals.end()) {
            Json::Value error(Json::objectValue);
            error["error"] = "Approval not found";
            return error;
        }
        approval = it->second;
    }

    {
        std::lock_guard<std::mutex> approvalLock(approval->mutex);
        if (approval->status != ApprovalStatus::Pending) {
            return impl_->buildApprovalJson(*approval);
        }
        approval->status = approved ? ApprovalStatus::Approved : ApprovalStatus::Denied;
        approval->resolvedAt = nowMillis();
        approval->note = note;
    }
    approval->cv.notify_all();
    return impl_->buildApprovalJson(*approval);
}
