#include "app/server_app.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <sstream>
#include <streambuf>
#include <thread>
#include <vector>

#include <curl/curl.h>
#include <httplib.h>

#include "config/config.h"
#include "controllers/auth_controller.h"
#include "controllers/chat_controller.h"
#include "controllers/generation_task_manager.h"
#include "controllers/lmstudio_controller.h"
#include "controllers/vault_controller.h"
#include "embedded_frontend.h"
#include "embedded_toolpacks.h"
#include "server/api_routes.h"
#include "server/http_utils.h"
#include "services/huggingface_service.h"
#include "services/llamacpp_service.h"
#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include "services/mcp_service.h"
#include "services/tools/tool_system.h"

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {

httplib::Server* gServer = nullptr;
std::mutex gServerMutex;
std::atomic<bool> gServerRunning{false};
std::atomic<bool> gServerError{false};
std::atomic<bool> gStopConfigWatcher{false};
std::atomic<bool> gShutdownRequested{false};
std::atomic<bool> gRestartPending{false};
BuildState gBuildState;
fs::path gExecutablePath;

fs::path getExecutablePath() {
#ifdef _WIN32
    std::vector<char> buffer(MAX_PATH);
    for (;;) {
        const DWORD length = GetModuleFileNameA(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (length == 0) {
            break;
        }
        if (length < buffer.size() - 1) {
            return fs::path(std::string(buffer.data(), length));
        }
        buffer.resize(buffer.size() * 2);
    }
#elif defined(__APPLE__)
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    if (size > 0) {
        std::vector<char> buffer(size + 1, '\0');
        if (_NSGetExecutablePath(buffer.data(), &size) == 0) {
            try {
                return fs::canonical(fs::path(buffer.data()));
            } catch (...) {
                return fs::absolute(fs::path(buffer.data()));
            }
        }
    }
#else
    try {
        return fs::canonical("/proc/self/exe");
    } catch (...) {
    }
#endif
    return fs::current_path();
}

fs::path getExecutableDir() {
    const fs::path executablePath = getExecutablePath();
    if (executablePath.has_parent_path()) {
        return executablePath.parent_path();
    }
    return fs::current_path();
}

int getCurrentProcessIdValue() {
#ifdef _WIN32
    return static_cast<int>(GetCurrentProcessId());
#else
    return static_cast<int>(::getpid());
#endif
}

void sleepForMs(int delayMs) {
    if (delayMs <= 0) {
        return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
}

void clearRestartDelayEnv() {
#ifdef _WIN32
    SetEnvironmentVariableA("CTRLPANEL_RESTART_DELAY_MS", nullptr);
#else
    unsetenv("CTRLPANEL_RESTART_DELAY_MS");
#endif
}

void setProcessEnvVar(const char* name, const std::string& value) {
#ifdef _WIN32
    SetEnvironmentVariableA(name, value.c_str());
#else
    setenv(name, value.c_str(), 0);
#endif
}

int consumeRestartDelayMsFromEnv() {
    const char* value = std::getenv("CTRLPANEL_RESTART_DELAY_MS");
    if (!value || !*value) {
        return 0;
    }

    int delayMs = 0;
    try {
        delayMs = std::stoi(value);
    } catch (...) {
        delayMs = 0;
    }

    clearRestartDelayEnv();
    return std::clamp(delayMs, 0, 30000);
}

bool hasRestartableExecutable() {
    if (gExecutablePath.empty()) {
        return false;
    }
    std::error_code ec;
    return fs::is_regular_file(gExecutablePath, ec) && !ec;
}

bool spawnRestartProcess(int startupDelayMs) {
    if (!hasRestartableExecutable()) {
        return false;
    }

    const std::string delayValue = std::to_string(std::clamp(startupDelayMs, 0, 30000));

#ifdef _WIN32
    SetEnvironmentVariableA("CTRLPANEL_RESTART_DELAY_MS", delayValue.c_str());

    STARTUPINFOA startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    PROCESS_INFORMATION processInfo{};
    std::string commandLine = "\"" + gExecutablePath.string() + "\"";

    const BOOL ok = CreateProcessA(
        gExecutablePath.string().c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_NEW_PROCESS_GROUP,
        nullptr,
        gExecutablePath.parent_path().string().c_str(),
        &startupInfo,
        &processInfo);

    clearRestartDelayEnv();
    if (!ok) {
        return false;
    }

    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);
    return true;
#else
    const pid_t childPid = ::fork();
    if (childPid < 0) {
        return false;
    }

    if (childPid == 0) {
        ::setsid();
        ::setenv("CTRLPANEL_RESTART_DELAY_MS", delayValue.c_str(), 1);
        ::chdir(gExecutablePath.parent_path().c_str());

        std::string executable = gExecutablePath.string();
        char* argv[] = { executable.data(), nullptr };
        ::execv(executable.c_str(), argv);
        _exit(127);
    }

    return true;
#endif
}

void stopHttpServer() {
    std::lock_guard<std::mutex> lock(gServerMutex);
    if (gServer) {
        gServer->stop();
    }
}

void requestAppShutdownNow() {
    gShutdownRequested.store(true, std::memory_order_relaxed);
    gStopConfigWatcher.store(true);
    stopHttpServer();
}

struct RuntimePaths {
    fs::path execDir;
    fs::path dataDir;
    fs::path libsDir;
    fs::path logsDir;
    fs::path buildCacheDir;
    fs::path modelsDir;
    fs::path settingsPath;
    fs::path mcpConfigPath;
    fs::path toolingConfigPath;
    fs::path systemToolpacksDir;
    fs::path userToolpacksDir;
};

RuntimePaths buildRuntimePaths() {
    RuntimePaths paths;
    paths.execDir = getExecutableDir();
    paths.dataDir = paths.execDir / "data";
    paths.libsDir = paths.dataDir / "libs";
    paths.logsDir = paths.dataDir / "logs";
    paths.buildCacheDir = paths.dataDir / "build-cache";
    paths.modelsDir = paths.dataDir / "models";
    paths.settingsPath = paths.dataDir / "settings.json";
    paths.mcpConfigPath = paths.dataDir / "mcp.json";
    paths.toolingConfigPath = paths.dataDir / "tooling.json";
    paths.systemToolpacksDir = paths.execDir / "toolpacks";
    paths.userToolpacksDir = paths.dataDir / "toolpacks";
    return paths;
}

constexpr const char* kBundledToolpackIndexFile = ".ctrlpanel-bundled-toolpack-files";

bool isSafeBundledToolpackPath(const fs::path& relativePath) {
    if (relativePath.empty() || relativePath.is_absolute()) {
        return false;
    }

    for (const auto& component : relativePath) {
        const std::string part = component.string();
        if (part.empty() || part == "." || part == "..") {
            return false;
        }
    }

    return true;
}

std::set<std::string> readBundledToolpackIndex(const fs::path& indexPath) {
    std::set<std::string> entries;
    std::ifstream file(indexPath);
    if (!file.is_open()) {
        return entries;
    }

    std::string line;
    while (std::getline(file, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
            line.pop_back();
        }
        if (!line.empty()) {
            entries.insert(line);
        }
    }

    return entries;
}

void writeBundledToolpackIndex(const fs::path& indexPath, const std::set<std::string>& entries) {
    std::ofstream file(indexPath, std::ios::trunc);
    if (!file.is_open()) {
        std::cerr << "[Toolpacks] Failed to write bundled toolpack index: " << indexPath << "\n";
        return;
    }

    for (const auto& entry : entries) {
        file << entry << "\n";
    }
}

bool fileContentMatches(const fs::path& path, std::string_view expected) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return false;
    }

    std::ostringstream buffer;
    buffer << file.rdbuf();
    const std::string content = buffer.str();
    return content.size() == expected.size() &&
           content.compare(0, content.size(), expected.data(), expected.size()) == 0;
}

bool writeBundledToolpackFile(const fs::path& path, std::string_view content) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file.is_open()) {
        return false;
    }

    file.write(content.data(), static_cast<std::streamsize>(content.size()));
    return static_cast<bool>(file);
}

void pruneEmptyToolpackDirectories(const fs::path& root, fs::path current) {
    std::error_code ec;
    while (!current.empty() && current != root) {
        if (!fs::exists(current, ec) || ec) {
            return;
        }
        if (!fs::is_directory(current, ec) || ec) {
            return;
        }
        if (!fs::is_empty(current, ec) || ec) {
            return;
        }
        fs::remove(current, ec);
        if (ec) {
            return;
        }
        current = current.parent_path();
    }
}

void syncBundledToolpacks(const RuntimePaths& paths) {
    std::error_code ec;
    fs::create_directories(paths.systemToolpacksDir, ec);
    if (ec) {
        std::cerr << "[Toolpacks] Failed to create system toolpacks directory "
                  << paths.systemToolpacksDir << ": " << ec.message() << "\n";
        return;
    }

    const fs::path indexPath = paths.systemToolpacksDir / kBundledToolpackIndexFile;
    const std::set<std::string> previousFiles = readBundledToolpackIndex(indexPath);
    std::set<std::string> currentFiles;

    for (const auto& [relativePathView, content] : embedded_toolpack_files) {
        const fs::path relativePath = fs::path(std::string(relativePathView)).lexically_normal();
        if (!isSafeBundledToolpackPath(relativePath)) {
            std::cerr << "[Toolpacks] Skipping unsafe bundled toolpack path: " << relativePathView << "\n";
            continue;
        }

        const std::string relativeKey = relativePath.generic_string();
        currentFiles.insert(relativeKey);

        const fs::path targetPath = paths.systemToolpacksDir / relativePath;
        if (fileContentMatches(targetPath, content)) {
            continue;
        }

        std::error_code dirEc;
        fs::create_directories(targetPath.parent_path(), dirEc);
        if (dirEc) {
            std::cerr << "[Toolpacks] Failed to create directory for " << targetPath
                      << ": " << dirEc.message() << "\n";
            continue;
        }

        dirEc.clear();
        if (fs::is_directory(targetPath, dirEc) && !dirEc) {
            std::cerr << "[Toolpacks] Expected file but found directory at " << targetPath << "\n";
            continue;
        }

        if (!writeBundledToolpackFile(targetPath, content)) {
            std::cerr << "[Toolpacks] Failed to write bundled toolpack file " << targetPath << "\n";
        }
    }

    for (const auto& relativeKey : previousFiles) {
        if (currentFiles.find(relativeKey) != currentFiles.end()) {
            continue;
        }

        const fs::path relativePath = fs::path(relativeKey).lexically_normal();
        if (!isSafeBundledToolpackPath(relativePath)) {
            continue;
        }

        const fs::path targetPath = paths.systemToolpacksDir / relativePath;
        std::error_code removeEc;
        if (!fs::is_regular_file(targetPath, removeEc) || removeEc) {
            continue;
        }

        removeEc.clear();
        fs::remove(targetPath, removeEc);
        if (removeEc) {
            std::cerr << "[Toolpacks] Failed to remove stale bundled toolpack file " << targetPath
                      << ": " << removeEc.message() << "\n";
            continue;
        }

        pruneEmptyToolpackDirectories(paths.systemToolpacksDir, targetPath.parent_path());
    }

    writeBundledToolpackIndex(indexPath, currentFiles);
}

void ensureRuntimeDirectories(const RuntimePaths& paths) {
    for (const auto& directory : {
             paths.dataDir,
             paths.libsDir,
             paths.logsDir,
             paths.modelsDir,
             paths.systemToolpacksDir,
             paths.userToolpacksDir}) {
        if (!fs::exists(directory)) {
            fs::create_directories(directory);
        }
    }
}

void ensureDefaultMcpConfig(const RuntimePaths& paths) {
    if (fs::exists(paths.mcpConfigPath)) {
        return;
    }

    std::ofstream file(paths.mcpConfigPath);
    if (file.is_open()) {
        file << "{\n    \"mcpServers\": {}\n}\n";
    }
}

void ensureDefaultToolingConfig(const RuntimePaths& paths) {
    if (fs::exists(paths.toolingConfigPath)) {
        return;
    }

    Json::Value tooling(Json::objectValue);
    tooling["disabledPackIds"] = Json::Value(Json::arrayValue);
    tooling["notes"] = "ControlPanel internal tool-system config.";
    std::ofstream file(paths.toolingConfigPath);
    if (file.is_open()) {
        file << writeJson(tooling);
    }
}

class MultiLoggerBuffer : public std::streambuf {
public:
    MultiLoggerBuffer(std::streambuf* original, const std::string& latestPath, const std::string& sessionPath)
        : original_(original) {
        latest_.open(latestPath, std::ios::trunc);
        session_.open(sessionPath, std::ios::out);
    }

    ~MultiLoggerBuffer() override {
        if (latest_.is_open()) {
            latest_.close();
        }
        if (session_.is_open()) {
            session_.close();
        }
    }

protected:
    int_type overflow(int_type ch) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (ch != EOF) {
            const char value = static_cast<char>(ch);
            original_->sputc(value);
            auto writeChar = [&](std::ofstream& stream) {
                if (stream.is_open()) {
                    stream.put(value);
                    if (value == '\n') {
                        stream.flush();
                    }
                }
            };
            writeChar(latest_);
            writeChar(session_);
        }
        return ch;
    }

    std::streamsize xsputn(const char* data, std::streamsize size) override {
        std::lock_guard<std::mutex> lock(mutex_);
        original_->sputn(data, size);
        auto writeBlock = [&](std::ofstream& stream) {
            if (stream.is_open()) {
                stream.write(data, size);
                if (std::string_view(data, static_cast<std::size_t>(size)).find('\n') != std::string_view::npos) {
                    stream.flush();
                }
            }
        };
        writeBlock(latest_);
        writeBlock(session_);
        return size;
    }

private:
    std::streambuf* original_;
    std::ofstream latest_;
    std::ofstream session_;
    std::mutex mutex_;
};

class TeeStream {
public:
    TeeStream(std::ostream& stream, const std::string& latestPath, const std::string& sessionPath)
        : stream_(stream), original_(stream.rdbuf()), buffer_(original_, latestPath, sessionPath) {
        stream_.rdbuf(&buffer_);
    }

    ~TeeStream() {
        stream_.rdbuf(original_);
    }

private:
    std::ostream& stream_;
    std::streambuf* original_;
    MultiLoggerBuffer buffer_;
};

void initializeLogging(const RuntimePaths& paths) {
    const std::time_t now = std::time(nullptr);
    const std::tm* local = std::localtime(&now);
    char timestamp[32];
    std::strftime(timestamp, sizeof(timestamp), "%d-%m-%Y_%H_%M_%S", local);

    static TeeStream* stdoutTee = nullptr;
    static TeeStream* stderrTee = nullptr;
    stdoutTee = new TeeStream(
        std::cout,
        (paths.logsDir / "latest.log").string(),
        (paths.logsDir / (std::string(timestamp) + ".log")).string());
    stderrTee = new TeeStream(
        std::cerr,
        (paths.logsDir / "latest.log").string(),
        (paths.logsDir / (std::string(timestamp) + ".log")).string());
}

void signalHandler(int) {
#ifndef _WIN32
    constexpr char message[] = "\n[Signal] Shutdown requested...\n";
    (void)write(STDOUT_FILENO, message, sizeof(message) - 1);
#endif
    gShutdownRequested.store(true, std::memory_order_relaxed);
    gStopConfigWatcher.store(true);
}

void installSignalHandlers() {
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
}

void runConfigWatcher(
    Config& config,
    McpRegistry& registry,
    ToolSystem& toolSystem,
    LmStudioService& lmstudioService,
    LlamaCppService& llamaService,
    const std::string& settingsPath,
    const std::string& mcpConfigPath,
    const std::string& toolingConfigPath,
    const std::string& systemToolpacksDir,
    const std::string& userToolpacksDir) {
    auto readWriteTime = [](const std::string& path) -> fs::file_time_type {
        try {
            if (fs::exists(path)) {
                return fs::last_write_time(path);
            }
        } catch (...) {
        }
        return {};
    };

    auto debounceSleep = [](int millis) {
        for (int waited = 0; waited < millis && !gStopConfigWatcher.load(); waited += 50) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    };

    auto readDirectorySignature = [](const std::string& rootPath) -> std::string {
        if (rootPath.empty() || !fs::exists(rootPath)) {
            return "";
        }

        std::vector<std::string> entries;
        for (const auto& entry : fs::recursive_directory_iterator(rootPath)) {
            if (!entry.is_regular_file()) {
                continue;
            }
            const std::string ext = entry.path().extension().string();
            if (ext != ".json") {
                continue;
            }

            std::error_code ec;
            const auto writeTime = fs::last_write_time(entry.path(), ec);
            const auto relative = fs::relative(entry.path(), rootPath, ec);
            entries.push_back((ec ? entry.path().string() : relative.string()) + ":" +
                              std::to_string(writeTime.time_since_epoch().count()));
        }
        std::sort(entries.begin(), entries.end());
        std::string signature;
        for (const auto& entry : entries) {
            signature += entry;
            signature.push_back('\n');
        }
        return signature;
    };

    fs::file_time_type lastSettingsTime = readWriteTime(settingsPath);
    fs::file_time_type lastMcpTime = readWriteTime(mcpConfigPath);
    fs::file_time_type lastToolingTime = readWriteTime(toolingConfigPath);
    std::string lastSystemToolpacksSignature = readDirectorySignature(systemToolpacksDir);
    std::string lastUserToolpacksSignature = readDirectorySignature(userToolpacksDir);
    fs::file_time_type pendingSettingsTime = lastSettingsTime;
    fs::file_time_type pendingMcpTime = lastMcpTime;
    fs::file_time_type pendingToolingTime = lastToolingTime;
    std::string pendingSystemToolpacksSignature = lastSystemToolpacksSignature;
    std::string pendingUserToolpacksSignature = lastUserToolpacksSignature;

    while (!gStopConfigWatcher.load()) {
        for (int index = 0; index < 5 && !gStopConfigWatcher.load(); ++index) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }

        try {
            auto currentSettingsTime = readWriteTime(settingsPath);
            if (currentSettingsTime != lastSettingsTime && currentSettingsTime != pendingSettingsTime) {
                pendingSettingsTime = currentSettingsTime;
            }
            if (pendingSettingsTime != lastSettingsTime) {
                debounceSleep(500);
                currentSettingsTime = readWriteTime(settingsPath);
                if (currentSettingsTime == pendingSettingsTime) {
                    lastSettingsTime = currentSettingsTime;
                    config.load();
                    lmstudioService.setLmStudioUrl(config.getLmStudioUrl());
                    llamaService.markConfigDirty();
                } else {
                    pendingSettingsTime = currentSettingsTime;
                }
            }

            auto currentMcpTime = readWriteTime(mcpConfigPath);
            if (currentMcpTime != lastMcpTime && currentMcpTime != pendingMcpTime) {
                pendingMcpTime = currentMcpTime;
            }
            if (pendingMcpTime != lastMcpTime) {
                debounceSleep(500);
                currentMcpTime = readWriteTime(mcpConfigPath);
                if (currentMcpTime == pendingMcpTime) {
                    lastMcpTime = currentMcpTime;
                    registry.loadFromFile(mcpConfigPath);
                    toolSystem.reload();
                } else {
                    pendingMcpTime = currentMcpTime;
                }
            }

            auto currentToolingTime = readWriteTime(toolingConfigPath);
            if (currentToolingTime != lastToolingTime && currentToolingTime != pendingToolingTime) {
                pendingToolingTime = currentToolingTime;
            }
            if (pendingToolingTime != lastToolingTime) {
                debounceSleep(500);
                currentToolingTime = readWriteTime(toolingConfigPath);
                if (currentToolingTime == pendingToolingTime) {
                    lastToolingTime = currentToolingTime;
                    toolSystem.reload();
                } else {
                    pendingToolingTime = currentToolingTime;
                }
            }

            const std::string currentSystemToolpacksSignature = readDirectorySignature(systemToolpacksDir);
            const std::string currentUserToolpacksSignature = readDirectorySignature(userToolpacksDir);
            if (currentSystemToolpacksSignature != lastSystemToolpacksSignature &&
                currentSystemToolpacksSignature != pendingSystemToolpacksSignature) {
                pendingSystemToolpacksSignature = currentSystemToolpacksSignature;
            }
            if (currentUserToolpacksSignature != lastUserToolpacksSignature &&
                currentUserToolpacksSignature != pendingUserToolpacksSignature) {
                pendingUserToolpacksSignature = currentUserToolpacksSignature;
            }
            if (pendingSystemToolpacksSignature != lastSystemToolpacksSignature ||
                pendingUserToolpacksSignature != lastUserToolpacksSignature) {
                debounceSleep(500);
                const std::string settledSystemToolpacksSignature = readDirectorySignature(systemToolpacksDir);
                const std::string settledUserToolpacksSignature = readDirectorySignature(userToolpacksDir);
                if (settledSystemToolpacksSignature == pendingSystemToolpacksSignature &&
                    settledUserToolpacksSignature == pendingUserToolpacksSignature) {
                    lastSystemToolpacksSignature = settledSystemToolpacksSignature;
                    lastUserToolpacksSignature = settledUserToolpacksSignature;
                    toolSystem.reload();
                } else {
                    pendingSystemToolpacksSignature = settledSystemToolpacksSignature;
                    pendingUserToolpacksSignature = settledUserToolpacksSignature;
                }
            }
        } catch (...) {
        }
    }
}

void printStartupBanner(const RuntimePaths& paths, Config& config, LlamaCppService& llamaService) {
    const auto availableBackends = llamaService.availableBackends();
    const auto hardwareBackends = LlamaCppService::detectHardwareBackends();
    const auto serverStatus = llamaService.getServerStatus();

    std::string available;
    for (const auto& backend : availableBackends) {
        if (!available.empty()) {
            available += ", ";
        }
        available += backend;
    }

    std::string hardware;
    for (const auto& backend : hardwareBackends) {
        if (!hardware.empty()) {
            hardware += ", ";
        }
        hardware += backend;
    }

    std::cout << "\n=== Control Panel Server ===\n";
    std::cout << "Server:         " << config.getHost() << ":" << config.getPort() << "\n";
    std::cout << "Data Dir:       " << paths.dataDir << "\n";
    std::cout << "Logs Dir:       " << paths.logsDir << "\n";
    std::cout << "Libs Dir:       " << paths.libsDir << "\n";
    std::cout << "Hardware:       " << (hardware.empty() ? "cpu only" : hardware) << "\n";
    std::cout << "Backends:       " << (available.empty() ? "none" : available) << "\n";
    std::cout << "Active backend: " << (serverStatus.activeBackend.empty() ? "none" : serverStatus.activeBackend) << "\n";
    std::cout << "llama.cpp tag:  " << config.getLlamacppTag() << "\n";
    std::cout << "Router:         " << (serverStatus.running ? "running" : "stopped")
              << " (slots: " << serverStatus.parallelSlots
              << ", max loaded: " << serverStatus.maxLoadedModels << ")\n";
    std::cout << "Local model:    " << (serverStatus.ready ? llamaService.getLoadedModelId() : "none") << "\n";
    std::cout << "===========================\n\n";
}

void runHttpServer(
    Config& config,
    LmStudioService& lmstudioService,
    McpService& mcpService,
    McpRegistry& registry,
    ToolSystem& toolSystem,
    const RuntimePaths& paths,
    LlamaCppService& llamaService) {
    httplib::Server server;
    {
        std::lock_guard<std::mutex> lock(gServerMutex);
        gServer = &server;
    }

    AuthStore authStore((paths.dataDir / "auth.json").string());
    ChatStore chatStore(
        (paths.dataDir / "chats").string(),
        &authStore,
        (paths.dataDir / "chats.json").string());
    VaultStore vaultStore((paths.dataDir / "password-vault.json").string());
    auto huggingFaceService = HuggingFaceService::create();

    server.set_logger([](const httplib::Request& req, const httplib::Response& res) {
        if (req.path == "/health" ||
            req.path == "/api/llamacpp/build/status" ||
            req.path == "/api/llamacpp/build/log" ||
            req.path == "/api/config/settings") {
            return;
        }
        std::cout << "[HTTP] " << req.method << " " << req.path << " - " << res.status << "\n";
    });

    server.Options(".*", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        const bool allowedExtensionRoute = isExtensionApiPath(req.path) && isAllowedExtensionRequest(req);
        if (isProtectedApiPath(req.path) && !isAllowedFrontendRequest(req) && !allowedExtensionRoute) {
            res.status = 403;
            return;
        }
        res.status = 200;
    });

    server.set_pre_routing_handler([&authStore](const httplib::Request& req, httplib::Response& res) {
        if (req.method == "OPTIONS") {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        if (!isProtectedApiPath(req.path)) {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        if (isExtensionApiPath(req.path)) {
            if (!isAllowedExtensionRequest(req)) {
                setJsonError(res, 403, "Blocked by extension origin policy");
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        }

        if (!isAllowedFrontendRequest(req)) {
            setJsonError(res, 403, "Blocked by frontend origin policy");
            return httplib::Server::HandlerResponse::Handled;
        }

        const bool isPublicRoute =
            req.path == "/api/auth" ||
            req.path == "/api/auth/setup" ||
            req.path == "/api/auth/login" ||
            req.path == "/api/auth/validate";
        if (isPublicRoute) {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        if (!requireValidSession(req, res, &authStore)) {
            return httplib::Server::HandlerResponse::Handled;
        }

        return httplib::Server::HandlerResponse::Unhandled;
    });

    server.Get("/health", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        Json::Value health(Json::objectValue);
        health["status"] = "ok";
        setJson(res, health);
    });

    ApiRouteContext routeContext{
        config,
        lmstudioService,
        mcpService,
        registry,
        toolSystem,
        authStore,
        chatStore,
        vaultStore,
        huggingFaceService,
        &llamaService,
        gBuildState,
        paths.dataDir.string(),
        paths.modelsDir.string(),
        paths.libsDir.string(),
        paths.buildCacheDir.string(),
    };
    registerApiRoutes(server, routeContext);

    server.Get(".*", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        std::string path = req.path;
        if (path == "/") {
            path = "/index.html";
        }

        const auto it = embedded_files.find(path);
        if (it != embedded_files.end()) {
            res.set_content(it->second.data(), it->second.size(), getMimeType(path).c_str());
            return;
        }

        if (path.find('.') == std::string::npos) {
            const auto index = embedded_files.find("/index.html");
            if (index != embedded_files.end()) {
                res.set_content(index->second.data(), index->second.size(), "text/html");
                return;
            }
        }

        res.status = 404;
        res.set_content("Not found", "text/plain");
    });

    const std::string host = config.getHost();
    const int port = config.getPort();
    bool bound = false;
    for (int attempt = 0; attempt < 20; ++attempt) {
        if (server.bind_to_port(host.c_str(), port)) {
            bound = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }

    if (!bound) {
        std::cerr << "[Server] ERROR: Failed to bind to " << host << ":" << port << "\n";
        gServerError.store(true);
        std::lock_guard<std::mutex> lock(gServerMutex);
        gServer = nullptr;
        return;
    }

    gServerRunning.store(true);
    server.listen_after_bind();
    gServerRunning.store(false);
    {
        std::lock_guard<std::mutex> lock(gServerMutex);
        gServer = nullptr;
    }
}

} // namespace

AppLifecycleStatus getAppLifecycleStatus() {
    AppLifecycleStatus status;
    status.running = gServerRunning.load();
    status.shutdownRequested = gShutdownRequested.load(std::memory_order_relaxed);
    status.restartPending = gRestartPending.load();
    status.restartSupported = hasRestartableExecutable();
    status.pid = getCurrentProcessIdValue();
    status.executablePath = gExecutablePath.string();
    return status;
}

bool isAppShutdownRequested() {
    return gShutdownRequested.load(std::memory_order_relaxed);
}

void scheduleAppShutdown(int delayMs) {
    std::thread([delayMs]() {
        sleepForMs(delayMs);
        requestAppShutdownNow();
    }).detach();
}

bool scheduleAppRestart(int shutdownDelayMs, int startupDelayMs) {
    if (!spawnRestartProcess(startupDelayMs)) {
        return false;
    }

    gRestartPending.store(true);
    scheduleAppShutdown(shutdownDelayMs);
    return true;
}

int ServerApp::run() {
    sleepForMs(consumeRestartDelayMsFromEnv());

    gExecutablePath = getExecutablePath();
    gServerRunning.store(false);
    gServerError.store(false);
    gStopConfigWatcher.store(false);
    gShutdownRequested.store(false, std::memory_order_relaxed);
    gRestartPending.store(false);

    const RuntimePaths paths = buildRuntimePaths();
    ensureRuntimeDirectories(paths);
    syncBundledToolpacks(paths);
    ensureDefaultMcpConfig(paths);
    ensureDefaultToolingConfig(paths);
    initializeLogging(paths);
    installSignalHandlers();

    curl_global_init(CURL_GLOBAL_DEFAULT);
    int exitCode = 0;
    {
        Config config(paths.settingsPath.string());
        config.load();

        LmStudioService lmstudioService;
        lmstudioService.setLmStudioUrl(config.getLmStudioUrl());

        McpService mcpService(config);
        McpRegistry registry;
        registry.loadFromFile(paths.mcpConfigPath.string());
        auto toolSystem = std::make_unique<ToolSystem>(
            ToolSystem::RuntimePaths{
                paths.systemToolpacksDir.string(),
                paths.userToolpacksDir.string(),
                paths.toolingConfigPath.string(),
                paths.mcpConfigPath.string(),
                (paths.dataDir / "web-search").string(),
            },
            &registry,
            &config);
        toolSystem->initialize();

        auto llamaService = std::make_unique<LlamaCppService>(paths.modelsDir.string(), paths.libsDir.string(), config);

        startStreamCleanupLoop();
        printStartupBanner(paths, config, *llamaService);

        setProcessEnvVar("CTRLPANEL_MODELS_DIR", paths.modelsDir.string());

        std::thread serverThread(
            runHttpServer,
            std::ref(config),
            std::ref(lmstudioService),
            std::ref(mcpService),
            std::ref(registry),
            std::ref(*toolSystem),
            std::cref(paths),
            std::ref(*llamaService));

        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        if (gServerError.load()) {
            gStopConfigWatcher.store(true);
            stopStreamCleanupLoop();
            serverThread.join();
            exitCode = 1;
        } else {
            std::thread configWatcherThread(
                runConfigWatcher,
                std::ref(config),
                std::ref(registry),
                std::ref(*toolSystem),
                std::ref(lmstudioService),
                std::ref(*llamaService),
                paths.settingsPath.string(),
                paths.mcpConfigPath.string(),
                paths.toolingConfigPath.string(),
                paths.systemToolpacksDir.string(),
                paths.userToolpacksDir.string());

            std::cout << "=== Server ready — Press Ctrl+C to stop ===\n\n";

            while (!gShutdownRequested.load(std::memory_order_relaxed)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }

            cancelAllStreams();
            stopHttpServer();
            toolSystem->shutdown();
            TaskManager::instance().cancelAllTasks();
            TaskManager::instance().waitForAllTasks();
            llamaService->unloadLib();
            serverThread.join();
            configWatcherThread.join();
            stopStreamCleanupLoop();
        }
    }

    curl_global_cleanup();
    std::cout << "\n=== Server stopped ===\n";
    return exitCode;
}
