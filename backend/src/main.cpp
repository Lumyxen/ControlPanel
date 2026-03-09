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
#include "services/openrouter_service.h"
#include "services/mcp_service.h"
#include "services/mcp_registry.h"
#include "controllers/openrouter_controller.h"
#include "controllers/config_controller.h"
#include "controllers/auth_controller.h"
#include "controllers/mcp_controller.h"
#include "utils/encryption.h"
#include "controllers/chat_controller.h"
#include "embedded_frontend.h"

namespace fs = std::filesystem;

httplib::Server* g_server = nullptr;
std::mutex g_serverMutex;

std::atomic<bool> openRouterHealthy{false};
std::mutex openRouterHealthMutex;
std::chrono::steady_clock::time_point lastOpenRouterCheck;

std::atomic<bool> serverRunning{false};
std::atomic<bool> serverError{false};
std::atomic<bool> shouldStopHealthCheck{false};
std::atomic<bool> shouldStopConfigWatch{false};

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
        "connect-src 'self' https://api.openrouter.ai; "
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
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
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

// ── OpenRouter health check ───────────────────────────────────────────────────
size_t HealthCheckWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

bool checkOpenRouterHealth() {
    CURL* curl = curl_easy_init();
    if (!curl) return false;
    std::string response;
    curl_easy_setopt(curl, CURLOPT_URL, "https://openrouter.ai/api/v1/models");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, HealthCheckWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 3L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "ControlPanel-Backend/1.0");
    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);
    if (res != CURLE_OK || httpCode != 200) return false;
    Json::Value root; Json::CharReaderBuilder builder; std::string errors;
    std::istringstream ss(response);
    return Json::parseFromStream(builder, ss, &root, &errors);
}

void runOpenRouterHealthCheck() {
    std::cout << "[HealthCheck] Starting OpenRouter health check thread\n";
    bool firstCheck = true;
    int consecutiveFailures = 0;
    const int MAX_FAILURES = 2;
    while (!shouldStopHealthCheck.load()) {
        bool healthy = false;
        try {
            healthy = checkOpenRouterHealth();
            bool wasHealthy = openRouterHealthy.load();
            if (healthy) consecutiveFailures = 0;
            else {
                consecutiveFailures++;
                if (consecutiveFailures < MAX_FAILURES) healthy = true;
            }
            openRouterHealthy.store(healthy);
            { std::lock_guard<std::mutex> lock(openRouterHealthMutex);
              lastOpenRouterCheck = std::chrono::steady_clock::now(); }
            if (firstCheck) {
                std::cout << "[HealthCheck] Initial OpenRouter status: "
                          << (healthy ? "healthy" : "unhealthy") << "\n";
                firstCheck = false;
            } else if (healthy != wasHealthy) {
                std::cout << "[HealthCheck] OpenRouter status changed: "
                          << (healthy ? "healthy" : "unhealthy") << "\n";
            }
        } catch (...) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_FAILURES) openRouterHealthy.store(false);
        }
        for (int i = 0; i < 60 && !shouldStopHealthCheck.load(); ++i)
            std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}

// ── Config + mcp.json file watcher ───────────────────────────────────────────
void runConfigFileWatch(Config& config, McpRegistry& registry,
                        const std::string& settingsPath,
                        const std::string& mcpJsonPath) {
    std::cout << "[ConfigWatch] Watching: " << settingsPath << "\n";
    std::cout << "[ConfigWatch] Watching: " << mcpJsonPath  << "\n";

    fs::file_time_type lastSettingsTime{};
    fs::file_time_type lastMcpTime{};

    auto safeModTime = [](const std::string& p) -> fs::file_time_type {
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
void signalHandler(int signal) {
    std::cout << "\n[Signal] Received signal " << signal << ", shutting down...\n";
    shouldStopHealthCheck.store(true);
    shouldStopConfigWatch.store(true);
    std::lock_guard<std::mutex> lock(g_serverMutex);
    if (g_server) g_server->stop();
}

// ── Server ────────────────────────────────────────────────────────────────────
void runServer(Config& config, OpenRouterService& openrouterService,
               McpService& mcpService, McpRegistry& registry,
               const std::string& dataDir) {

    std::string host = config.getHost();
    int port         = config.getPort();
    std::cout << "[Server] Starting HTTP server on " << host << ":" << port << "\n";

    httplib::Server svr;
    { std::lock_guard<std::mutex> lock(g_serverMutex); g_server = &svr; }

    svr.Options(".*", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req); res.status = 200;
    });

    svr.Get("/health", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        res.set_content("{\"status\": \"ok\"}", "application/json");
    });

    svr.Get("/api/health/external", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value response;
        response["openrouter"] = openRouterHealthy.load();
        std::chrono::steady_clock::time_point lastCheck;
        { std::lock_guard<std::mutex> lock(openRouterHealthMutex); lastCheck = lastOpenRouterCheck; }
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - lastCheck).count();
        response["lastCheckSecondsAgo"] = static_cast<Json::Int64>(elapsed);
        Json::StreamWriterBuilder builder;
        res.set_content(Json::writeString(builder, response), "application/json");
    });

    svr.Post("/api/auth/verify", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleAuthVerify(req, res, config);
    });

    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleChat(req, res, openrouterService);
    });

    svr.Post("/api/chat/stream", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleStreaming(req, res, openrouterService, &registry);
    });

    svr.Get("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleModels(req, res, openrouterService);
    });

    svr.Get("/api/pricing", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handlePricing(req, res, openrouterService);
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
    svr.Get("/mcp", [](const httplib::Request& req, httplib::Response& res) {
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
    fs::path dataDir = getExecutableDir() / "data";
    if (!fs::exists(dataDir)) fs::create_directories(dataDir);

    TeeStream teeCout(std::cout, (dataDir / "backend.log").string());
    TeeStream teeCerr(std::cerr, (dataDir / "backend.log").string());

    std::signal(SIGINT,  signalHandler);
    std::signal(SIGTERM, signalHandler);
    curl_global_init(CURL_GLOBAL_DEFAULT);

    const std::string settingsPath = (dataDir / "settings.json").string();
    const std::string mcpJsonPath  = (dataDir / "mcp.json").string();

    Config config(settingsPath);
    config.load();

    std::string apiKey;
    if (const char* env = std::getenv("OPENROUTER_API_KEY");
            env && std::string(env).length() > 0) {
        apiKey = env;
        std::cout << "API key source: environment variable\n";
    } else {
        std::cout << "API key source: none (set OPENROUTER_API_KEY)\n";
    }
    std::cout << "API key status: " << (apiKey.empty() ? "EMPTY" : "present") << "\n";

    Encryption        encryption("default-32-byte-encryption-key!!");
    OpenRouterService openrouterService(apiKey, encryption);
    McpService        mcpService(config);
    McpRegistry       registry;

    // Load MCP clients from data/mcp.json
    registry.loadFromFile(mcpJsonPath);

    std::cout << "\n=== Control Panel Server ===\n";
    std::cout << "Server:       HTTP on port " << config.getPort()  << "\n";
    std::cout << "MCP server:   POST/GET /mcp\n";
    std::cout << "MCP clients:  " << registry.liveCount()           << " live"
              << "  (config: " << mcpJsonPath << ")\n";
    std::cout << "Data Dir:     " << dataDir.string()               << "\n";
    std::cout << "===========================\n\n";

    serverError = false;
    std::thread serverThread(runServer,
        std::ref(config), std::ref(openrouterService),
        std::ref(mcpService), std::ref(registry),
        dataDir.string());

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    if (serverError.load()) {
        std::cerr << "\n[FATAL] Server failed to start. Exiting.\n";
        shouldStopConfigWatch.store(true);
        serverThread.join();
        curl_global_cleanup();
        return 1;
    }

    std::thread healthCheckThread(runOpenRouterHealthCheck);
    std::thread configWatchThread(runConfigFileWatch,
        std::ref(config), std::ref(registry), settingsPath, mcpJsonPath);

    std::cout << "\n=== Server started successfully ===\n";
    std::cout << "Press Ctrl+C to stop the server\n\n";

    serverThread.join();
    shouldStopHealthCheck.store(true);
    shouldStopConfigWatch.store(true);
    healthCheckThread.join();
    configWatchThread.join();

    curl_global_cleanup();
    std::cout << "\n=== Server has stopped ===\n";
    return 0;
}