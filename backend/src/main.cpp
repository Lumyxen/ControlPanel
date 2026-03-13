#include <iostream>
#include <memory>
#include <thread>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <chrono>
#include <atomic>
#include <cstdlib>
#include <array>
#include <mutex>
#include <csignal>
#include <streambuf>
#include <curl/curl.h>
#include <httplib.h>
#include "config/config.h"
#include "services/lmstudio_service.h"
#include "services/llamacpp_service.h"
#include "services/mcp_service.h"
#include "services/mcp_registry.h"
#include "controllers/lmstudio_controller.h"
#include "controllers/config_controller.h"
#include "controllers/mcp_controller.h"
#include "controllers/chat_controller.h"
#include "embedded_frontend.h"

#ifndef _WIN32
#include <unistd.h>   // write(), STDOUT_FILENO
#endif

namespace fs = std::filesystem;

httplib::Server* g_server = nullptr;
std::mutex g_serverMutex;

std::atomic<bool> serverRunning{false};
std::atomic<bool> serverError{false};
std::atomic<bool> shouldStopConfigWatch{false};
// Set by signal handler; acted upon by the main thread — keeps the handler
// async-signal-safe (no mutexes, no stdio, no heap allocations).
std::atomic<bool> g_shutdownRequested{false};

fs::path getExecutableDir() {
    try { return fs::canonical("/proc/self/exe").parent_path(); }
    catch (...) { return fs::current_path(); }
}

// ── Logger ────────────────────────────────────────────────────────────────────
class LoggerBuffer : public std::streambuf {
    std::streambuf* original;
    std::ofstream   logFile;
    std::mutex      mutex;
public:
    LoggerBuffer(std::streambuf* orig, const std::string& logPath) : original(orig) {
        logFile.open(logPath, std::ios::app);
    }
    ~LoggerBuffer() { if (logFile.is_open()) logFile.close(); }
protected:
    int_type overflow(int_type c) override {
        std::lock_guard<std::mutex> lock(mutex);
        if (c != EOF) {
            char ch = static_cast<char>(c);
            original->sputc(ch);
            if (logFile.is_open()) { logFile.put(ch); if (ch == '\n') logFile.flush(); }
        }
        return c;
    }
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        std::lock_guard<std::mutex> lock(mutex);
        original->sputn(s, n);
        if (logFile.is_open()) {
            logFile.write(s, n);
            if (std::string_view(s, n).find('\n') != std::string_view::npos) logFile.flush();
        }
        return n;
    }
};

class TeeStream {
public:
    TeeStream(std::ostream& stream, const std::string& logPath)
        : stream(stream), oldBuf(stream.rdbuf()), teeBuf(oldBuf, logPath) {
        stream.rdbuf(&teeBuf);
    }
    ~TeeStream() { stream.rdbuf(oldBuf); }
private:
    std::ostream&   stream;
    std::streambuf* oldBuf;
    LoggerBuffer    teeBuf;
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
void addSecurityHeaders(httplib::Response& res) {
    res.set_header("X-Frame-Options", "DENY");
    res.set_header("X-Content-Type-Options", "nosniff");
    res.set_header("Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob:; "
        "font-src 'self' https://cdn.jsdelivr.net; "
        "connect-src 'self' http://localhost:* http://127.0.0.1:*; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
    res.set_header("X-XSS-Protection", "1; mode=block");
    res.set_header("Referrer-Policy", "strict-origin-when-cross-origin");
}

void addCorsHeaders(httplib::Response& res, const httplib::Request& req) {
    std::string origin = req.get_header_value("Origin");
    if (origin.empty() || origin.find("http://localhost") == 0
                       || origin.find("http://127.0.0.1") == 0) {
        res.set_header("Access-Control-Allow-Origin",
                        origin.empty() ? "*" : origin);
        res.set_header("Access-Control-Allow-Credentials", "true");
    }
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
    res.set_header("Access-Control-Max-Age", "86400");
}

std::string get_mime_type(const std::string& path) {
    if (path.ends_with(".html")) return "text/html";
    if (path.ends_with(".css"))  return "text/css";
    if (path.ends_with(".js"))   return "application/javascript";
    if (path.ends_with(".json")) return "application/json";
    if (path.ends_with(".png"))  return "image/png";
    if (path.ends_with(".jpg") || path.ends_with(".jpeg")) return "image/jpeg";
    if (path.ends_with(".svg"))  return "image/svg+xml";
    return "application/octet-stream";
}

// ── Config + mcp.json file watcher ───────────────────────────────────────────
void runConfigFileWatch(Config& config, McpRegistry& registry,
                        LmStudioService& service,
                        const std::string& settingsPath,
                        const std::string& mcpJsonPath) {
    std::cout << "[ConfigWatch] Watching: " << settingsPath << "\n";
    std::cout << "[ConfigWatch] Watching: " << mcpJsonPath  << "\n";

    fs::file_time_type lastSettingsTime{};
    fs::file_time_type lastMcpTime{};

    auto safeModTime =[](const std::string& p) -> fs::file_time_type {
        try {
            if (fs::exists(p)) return fs::last_write_time(p);
        } catch (...) {}
        return {};
    };

    lastSettingsTime = safeModTime(settingsPath);
    lastMcpTime      = safeModTime(mcpJsonPath);

    while (!shouldStopConfigWatch.load()) {
        for (int i = 0; i < 5 && !shouldStopConfigWatch.load(); ++i)
            std::this_thread::sleep_for(std::chrono::seconds(1));

        try {
            auto st = safeModTime(settingsPath);
            if (st != lastSettingsTime) {
                lastSettingsTime = st;
                config.load();
                service.setLmStudioUrl(config.getLmStudioUrl());
                std::cout << "[ConfigWatch] settings.json changed – config reloaded\n";
            }

            auto mt = safeModTime(mcpJsonPath);
            if (mt != lastMcpTime) {
                lastMcpTime = mt;
                std::cout << "[ConfigWatch] mcp.json changed – reloading MCP registry\n";
                registry.loadFromFile(mcpJsonPath);
            }
        } catch (const std::exception& e) {
            std::cerr << "[ConfigWatch] Error: " << e.what() << "\n";
        } catch (...) {
            std::cerr << "[ConfigWatch] Unknown error\n";
        }
    }
    std::cout << "[ConfigWatch] Config file watcher stopped\n";
}

// ── Signal handler ────────────────────────────────────────────────────────────
// IMPORTANT: This handler must be async-signal-safe. That means:
//   - No heap allocation, no stdio (printf/cout), no mutex locks.
//   - Only async-signal-safe functions (write(), atomic stores).
// The actual shutdown work (stopping the server) is done by the main thread
// which polls g_shutdownRequested.
void signalHandler(int sig) {
    // async-signal-safe: write() is on the POSIX async-signal-safe list.
    const char msg[] = "\n[Signal] Shutdown requested, stopping server...\n";
    (void)write(STDOUT_FILENO, msg, sizeof(msg) - 1);
    (void)sig;
    g_shutdownRequested.store(true, std::memory_order_relaxed);
}

// ── Server ────────────────────────────────────────────────────────────────────
void runServer(Config& config, LmStudioService& lmstudioService,
               McpService& mcpService, McpRegistry& registry,
               const std::string& dataDir,
               LlamaCppService* llamaCppService) {

    std::string host = config.getHost();
    int port         = config.getPort();
    std::cout << "[Server] Starting HTTP server on " << host << ":" << port << "\n";

    httplib::Server svr;
    { std::lock_guard<std::mutex> lock(g_serverMutex); g_server = &svr; }

    svr.Options(".*",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req); res.status = 200;
    });

    svr.Get("/health",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        res.set_content("{\"status\": \"ok\"}", "application/json");
    });

    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleChat(req, res, lmstudioService);
    });

    svr.Post("/api/chat/stream", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleStreaming(req, res, lmstudioService, &registry, llamaCppService);
    });

    svr.Post("/api/chat/stop", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleStopStream(req, res);
    });

    svr.Get("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleModels(req, res, lmstudioService, llamaCppService);
    });

    svr.Get("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleGetSettings(req, res, config);
    });

    svr.Put("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleUpdateSettings(req, res, config);
    });

    // List aggregated MCP tools
    svr.Get("/api/mcp/tools", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value result;
        result["tools"] = registry.getAggregatedTools();
        Json::StreamWriterBuilder wb;
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // Force-reload the MCP registry from mcp.json
    svr.Post("/api/mcp/reload", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        registry.loadFromFile(config.getMcpConfigPath());
        Json::Value result;
        result["liveClients"] = static_cast<int>(registry.liveCount());
        result["tools"]       = registry.getAggregatedTools();
        Json::StreamWriterBuilder wb;
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    ChatStore chatStore((fs::path(dataDir) / "chats.json").string());

    svr.Get("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleGetChats(req, res, chatStore);
    });

    svr.Put("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleSaveChats(req, res, chatStore);
    });

    // MCP server endpoint
    svr.Post("/mcp", [&](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req);
        handleMcpPost(req, res, mcpService);
    });
    svr.Get("/mcp",[](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req);
        handleMcpGet(req, res);
    });

    // Embedded frontend
    svr.Get(".*", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        std::string path = req.path;
        if (path == "/") path = "/index.html";
        auto it = embedded_files.find(path);
        if (it != embedded_files.end()) {
            res.set_content(it->second.data(), it->second.size(),
                            get_mime_type(path).c_str());
        } else {
            if (path.find('.') == std::string::npos) {
                auto idx = embedded_files.find("/index.html");
                if (idx != embedded_files.end()) {
                    res.set_content(idx->second.data(), idx->second.size(), "text/html");
                    return;
                }
            }
            res.status = 404;
            res.set_content("Not found", "text/plain");
        }
    });

    if (!svr.bind_to_port(host.c_str(), port)) {
        std::cerr << "[Server] ERROR: Failed to bind to " << host << ":" << port << "\n";
        serverError = true;
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_server = nullptr;
        return;
    }

    serverRunning = true;
    svr.listen_after_bind();
    serverRunning = false;
    { std::lock_guard<std::mutex> lock(g_serverMutex); g_server = nullptr; }
}

// ── main ──────────────────────────────────────────────────────────────────────
int main() {
    // ── Data directory ────────────────────────────────────────────────────────
    fs::path dataDir = getExecutableDir() / "data";
    if (!fs::exists(dataDir)) {
        fs::create_directories(dataDir);
    }

    // ── Models directory (create immediately so it always exists) ─────────────
    fs::path modelsDir = dataDir / "models";
    if (!fs::exists(modelsDir)) {
        fs::create_directories(modelsDir);
        std::cout << "[Startup] Created models directory: " << modelsDir.string() << "\n";
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    TeeStream teeCout(std::cout, (dataDir / "backend.log").string());
    TeeStream teeCerr(std::cerr, (dataDir / "backend.log").string());

    // ── Signal handling ───────────────────────────────────────────────────────
    // Ignore SIGPIPE globally: if an MCP child dies while we're writing to its
    // stdin pipe, write() will return -1/EPIPE instead of killing the process.
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
    // Install lightweight async-signal-safe handlers for SIGINT / SIGTERM.
    // They only set a flag; the main thread acts on it below.
    std::signal(SIGINT,  signalHandler);
    std::signal(SIGTERM, signalHandler);

    curl_global_init(CURL_GLOBAL_DEFAULT);

    const std::string settingsPath = (dataDir / "settings.json").string();
    const std::string mcpJsonPath  = (dataDir / "mcp.json").string();

    // ── mcp.json: create immediately so it always exists on disk ─────────────
    if (!fs::exists(mcpJsonPath)) {
        std::ofstream mcpFile(mcpJsonPath);
        if (mcpFile.is_open()) {
            mcpFile << "{\n    \"mcpServers\": {}\n}\n";
            mcpFile.close();
            std::cout << "[Startup] Created empty mcp.json: " << mcpJsonPath << "\n";
        } else {
            std::cerr << "[Startup] Warning: could not create mcp.json at: " << mcpJsonPath << "\n";
        }
    }

    // ── Config ────────────────────────────────────────────────────────────────
    Config config(settingsPath);
    config.load();

    // ── Services ──────────────────────────────────────────────────────────────
    LmStudioService lmstudioService;
    lmstudioService.setLmStudioUrl(config.getLmStudioUrl());

    McpService  mcpService(config);
    McpRegistry registry;

    // Load MCP clients from data/mcp.json
    registry.loadFromFile(mcpJsonPath);

    // ── llama.cpp local inference service ─────────────────────────────────────
    LlamaCppService llamaCppService(modelsDir.string(), config);

    // ── Startup banner ────────────────────────────────────────────────────────
    std::cout << "\n=== Control Panel Server ===\n";
    std::cout << "Server:       HTTP on port " << config.getPort()  << "\n";
    std::cout << "MCP server:   POST/GET /mcp\n";
    std::cout << "MCP clients:  " << registry.liveCount()           << " live"
              << "  (config: " << mcpJsonPath << ")\n";
    std::cout << "Data Dir:     " << dataDir.string()               << "\n";
    std::cout << "Models Dir:   " << modelsDir.string()             << "\n";
    if (llamaCppService.isReady())
        std::cout << "Local model:  " << llamaCppService.getLoadedModelId() << "\n";
    else
        std::cout << "Local model:  none loaded (place a .gguf in " << modelsDir.string() << ")\n";
    std::cout << "===========================\n\n";

    serverError = false;
    std::thread serverThread(runServer,
        std::ref(config), std::ref(lmstudioService),
        std::ref(mcpService), std::ref(registry),
        dataDir.string(), &llamaCppService);

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    if (serverError.load()) {
        std::cerr << "\n[FATAL] Server failed to start. Exiting.\n";
        shouldStopConfigWatch.store(true);
        serverThread.join();
        curl_global_cleanup();
        return 1;
    }

    std::thread configWatchThread(runConfigFileWatch,
        std::ref(config), std::ref(registry), std::ref(lmstudioService),
        settingsPath, mcpJsonPath);

    std::cout << "\n=== Server started successfully ===\n";
    std::cout << "Press Ctrl+C to stop the server\n\n";

    // ── Main thread: wait for shutdown signal ─────────────────────────────────
    // Polling here is intentional: the signal handler only sets a flag (which
    // is async-signal-safe), and we do the actual work from this thread where
    // it is safe to acquire mutexes and call library functions.
    while (!g_shutdownRequested.load(std::memory_order_relaxed)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    std::cout << "\n[Signal] Received shutdown signal, stopping server...\n";
    shouldStopConfigWatch.store(true);

    // Stop the HTTP server from the main thread (safe to do here).
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        if (g_server) g_server->stop();
    }

    serverThread.join();
    configWatchThread.join();

    curl_global_cleanup();
    std::cout << "\n=== Server has stopped ===\n";
    return 0;
}