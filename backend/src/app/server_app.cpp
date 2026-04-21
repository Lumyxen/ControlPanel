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
#include <sstream>
#include <streambuf>
#include <thread>

#include <curl/curl.h>
#include <httplib.h>

#include "config/config.h"
#include "controllers/auth_controller.h"
#include "controllers/chat_controller.h"
#include "controllers/generation_task_manager.h"
#include "controllers/lmstudio_controller.h"
#include "embedded_frontend.h"
#include "server/api_routes.h"
#include "server/http_utils.h"
#include "services/huggingface_service.h"
#include "services/llamacpp_service.h"
#include "services/lmstudio_service.h"
#include "services/mcp_registry.h"
#include "services/mcp_service.h"
#include "services/tools/tool_system.h"

#ifndef _WIN32
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
BuildState gBuildState;

fs::path getExecutableDir() {
    try {
        return fs::canonical("/proc/self/exe").parent_path();
    } catch (...) {
        return fs::current_path();
    }
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
        res.status = 200;
    });

    server.set_pre_routing_handler([&authStore](const httplib::Request& req, httplib::Response& res) {
        if (req.method == "OPTIONS") {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        const bool isApiRoute = req.path.rfind("/api/", 0) == 0;
        const bool isMcpRoute = req.path.rfind("/mcp", 0) == 0;
        if (!isApiRoute && !isMcpRoute) {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        const bool isPublicRoute =
            req.path == "/api/auth" ||
            req.path == "/api/auth/setup" ||
            req.path == "/api/auth/login" ||
            req.path == "/api/auth/validate";
        if (isPublicRoute) {
            return httplib::Server::HandlerResponse::Unhandled;
        }

        addSecurityHeaders(res);
        addCorsHeaders(res, req);
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
    if (!server.bind_to_port(host.c_str(), port)) {
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

int ServerApp::run() {
    const RuntimePaths paths = buildRuntimePaths();
    ensureRuntimeDirectories(paths);
    ensureDefaultMcpConfig(paths);
    ensureDefaultToolingConfig(paths);
    initializeLogging(paths);
    installSignalHandlers();

    curl_global_init(CURL_GLOBAL_DEFAULT);

    Config config(paths.settingsPath.string());
    config.load();

    LmStudioService lmstudioService;
    lmstudioService.setLmStudioUrl(config.getLmStudioUrl());

    McpService mcpService(config);
    McpRegistry registry;
    registry.loadFromFile(paths.mcpConfigPath.string());
    ToolSystem toolSystem(
        {
            paths.systemToolpacksDir.string(),
            paths.userToolpacksDir.string(),
            paths.toolingConfigPath.string(),
            paths.mcpConfigPath.string(),
        },
        &registry);
    toolSystem.initialize();

    LlamaCppService llamaService(paths.modelsDir.string(), paths.libsDir.string(), config);

    startStreamCleanupLoop();
    printStartupBanner(paths, config, llamaService);

    gServerError.store(false);
    setenv("CTRLPANEL_MODELS_DIR", paths.modelsDir.string().c_str(), 0);

    std::thread serverThread(
        runHttpServer,
        std::ref(config),
        std::ref(lmstudioService),
        std::ref(mcpService),
        std::ref(registry),
        std::ref(toolSystem),
        std::cref(paths),
        std::ref(llamaService));

    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    if (gServerError.load()) {
        gStopConfigWatcher.store(true);
        stopStreamCleanupLoop();
        serverThread.join();
        curl_global_cleanup();
        return 1;
    }

    std::thread configWatcherThread(
        runConfigWatcher,
        std::ref(config),
        std::ref(registry),
        std::ref(toolSystem),
        std::ref(lmstudioService),
        std::ref(llamaService),
        paths.settingsPath.string(),
        paths.mcpConfigPath.string(),
        paths.toolingConfigPath.string(),
        paths.systemToolpacksDir.string(),
        paths.userToolpacksDir.string());

    std::cout << "=== Server ready — Press Ctrl+C to stop ===\n\n";

    while (!gShutdownRequested.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    gStopConfigWatcher.store(true);
    TaskManager::instance().cancelAllTasks();
    {
        std::lock_guard<std::mutex> lock(gServerMutex);
        if (gServer) {
            gServer->stop();
        }
    }

    serverThread.join();
    configWatcherThread.join();
    stopStreamCleanupLoop();
    curl_global_cleanup();
    std::cout << "\n=== Server stopped ===\n";
    return 0;
}
