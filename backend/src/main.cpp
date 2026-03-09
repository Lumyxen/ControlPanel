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
#include "controllers/openrouter_controller.h"
#include "controllers/config_controller.h"
#include "controllers/auth_controller.h"
#include "utils/encryption.h"
#include "controllers/chat_controller.h"
#include "embedded_frontend.h"

namespace fs = std::filesystem;

// Global server pointers for signal handler to stop them
httplib::Server* g_server = nullptr;
std::mutex g_serverMutex;

// OpenRouter health status
std::atomic<bool> openRouterHealthy{false};
std::mutex openRouterHealthMutex;
std::chrono::steady_clock::time_point lastOpenRouterCheck;

std::atomic<bool> serverRunning{false};
std::atomic<bool> serverError{false};
std::atomic<bool> shouldStopHealthCheck{false};
std::atomic<bool> shouldStopConfigWatch{false};

fs::path getExecutableDir() {
    try {
        return fs::canonical("/proc/self/exe").parent_path();
    } catch (...) {
        return fs::current_path();
    }
}

// Logger to duplicate output to file inside the data folder
class LoggerBuffer : public std::streambuf {
private:
    std::streambuf* original;
    std::ofstream logFile;
    std::mutex mutex;

public:
    LoggerBuffer(std::streambuf* orig, const std::string& logPath) 
        : original(orig) {
        logFile.open(logPath, std::ios::app);
    }

    ~LoggerBuffer() {
        if (logFile.is_open()) logFile.close();
    }

protected:
    virtual int_type overflow(int_type c) override {
        std::lock_guard<std::mutex> lock(mutex);
        if (c != EOF) {
            char ch = static_cast<char>(c);
            original->sputc(ch);
            if (logFile.is_open()) {
                logFile.put(ch);
                if (ch == '\n') logFile.flush();
            }
        }
        return c;
    }

    virtual std::streamsize xsputn(const char* s, std::streamsize n) override {
        std::lock_guard<std::mutex> lock(mutex);
        original->sputn(s, n);
        if (logFile.is_open()) {
            logFile.write(s, n);
            if (std::string_view(s, n).find('\n') != std::string_view::npos) {
                logFile.flush();
            }
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
    ~TeeStream() {
        stream.rdbuf(oldBuf);
    }
private:
    std::ostream& stream;
    std::streambuf* oldBuf;
    LoggerBuffer teeBuf;
};

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
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self';");
    res.set_header("X-XSS-Protection", "1; mode=block");
    res.set_header("Referrer-Policy", "strict-origin-when-cross-origin");
}

void addCorsHeaders(httplib::Response& res, const httplib::Request& req) {
    std::string origin = req.get_header_value("Origin");
    if (origin.empty() || origin.find("http://localhost") == 0 || origin.find("http://127.0.0.1") == 0) {
        res.set_header("Access-Control-Allow-Origin", origin.empty() ? "*" : origin);
        res.set_header("Access-Control-Allow-Credentials", "true");
    }
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
    res.set_header("Access-Control-Max-Age", "86400");
}

std::string get_mime_type(const std::string& path) {
    if (path.ends_with(".html")) return "text/html";
    if (path.ends_with(".css")) return "text/css";
    if (path.ends_with(".js")) return "application/javascript";
    if (path.ends_with(".json")) return "application/json";
    if (path.ends_with(".png")) return "image/png";
    if (path.ends_with(".jpg") || path.ends_with(".jpeg")) return "image/jpeg";
    if (path.ends_with(".svg")) return "image/svg+xml";
    return "application/octet-stream";
}

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
    
    Json::Value root;
    Json::CharReaderBuilder builder;
    std::string errors;
    std::istringstream responseStream(response);
    if (!Json::parseFromStream(builder, responseStream, &root, &errors)) return false;
    return true;
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
            
            {
                std::lock_guard<std::mutex> lock(openRouterHealthMutex);
                lastOpenRouterCheck = std::chrono::steady_clock::now();
            }
            
            if (firstCheck) {
                std::cout << "[HealthCheck] Initial OpenRouter status: " << (healthy ? "healthy" : "unhealthy") << "\n";
                firstCheck = false;
            } else if (healthy != wasHealthy) {
                std::cout << "[HealthCheck] OpenRouter status changed: " << (healthy ? "healthy" : "unhealthy") << "\n";
            }
        } catch (...) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_FAILURES) openRouterHealthy.store(false);
        }
        for (int i = 0; i < 60 && !shouldStopHealthCheck.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
}

/**
 * Watch settings.json for external edits and reload Config when the file changes.
 *
 * Uses std::filesystem::last_write_time polled every second – no platform-specific
 * APIs required, works on both Linux and Windows.
 */
void runConfigFileWatch(Config& config, const std::string& settingsPath) {
    std::cout << "[ConfigWatch] Starting config file watcher for: " << settingsPath << "\n";

    fs::file_time_type lastWriteTime{};

    // Capture the initial mtime so we don't reload immediately on startup.
    try {
        if (fs::exists(settingsPath)) {
            lastWriteTime = fs::last_write_time(settingsPath);
        }
    } catch (...) {}

    while (!shouldStopConfigWatch.load()) {
        // Sleep in 1-second increments so the stop flag is checked promptly.
        std::this_thread::sleep_for(std::chrono::seconds(1));
        if (shouldStopConfigWatch.load()) break;

        try {
            if (!fs::exists(settingsPath)) continue;

            const auto mtime = fs::last_write_time(settingsPath);
            if (mtime != lastWriteTime) {
                lastWriteTime = mtime;
                // Brief additional delay: give the writing process time to finish
                // flushing so we don't read a half-written file.
                std::this_thread::sleep_for(std::chrono::milliseconds(150));
                config.load();
                std::cout << "[ConfigWatch] Detected change in settings.json – config reloaded\n";
            }
        } catch (const std::exception& e) {
            std::cerr << "[ConfigWatch] Error watching config file: " << e.what() << "\n";
        } catch (...) {
            std::cerr << "[ConfigWatch] Unknown error watching config file\n";
        }
    }

    std::cout << "[ConfigWatch] Config file watcher stopped\n";
}

void signalHandler(int signal) {
    std::cout << "\n[Signal] Received signal " << signal << ", initiating graceful shutdown...\n";
    shouldStopHealthCheck.store(true);
    shouldStopConfigWatch.store(true);
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        if (g_server) g_server->stop();
    }
}

void runServer(Config& config, OpenRouterService& openrouterService, const std::string& dataDir) {
    std::string host = config.getHost();
    int port = config.getPort();

    std::cout << "[Server] Starting HTTP server on " << host << ":" << port << "\n";

    httplib::Server svr;
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_server = &svr;
    }

    auto optionsHandler =[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        res.status = 200;
    };

    svr.Options(".*", optionsHandler);

    svr.Get("/health",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        res.set_content("{\"status\": \"ok\"}", "application/json");
    });

    svr.Get("/api/health/external",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        Json::Value response;
        response["openrouter"] = openRouterHealthy.load();
        std::chrono::steady_clock::time_point lastCheck;
        {
            std::lock_guard<std::mutex> lock(openRouterHealthMutex);
            lastCheck = lastOpenRouterCheck;
        }
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - lastCheck).count();
        response["lastCheckSecondsAgo"] = static_cast<Json::Int64>(elapsed);
        Json::StreamWriterBuilder builder;
        res.set_content(Json::writeString(builder, response), "application/json");
    });

    svr.Post("/api/auth/verify", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleAuthVerify(req, res, config);
    });

    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleChat(req, res, openrouterService);
    });

    svr.Post("/api/chat/stream", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleStreaming(req, res, openrouterService);
    });

    svr.Get("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleModels(req, res, openrouterService);
    });

    svr.Get("/api/pricing", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handlePricing(req, res, openrouterService);
    });

    svr.Get("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleGetSettings(req, res, config);
    });

    svr.Put("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleUpdateSettings(req, res, config);
    });

    ChatStore chatStore((fs::path(dataDir) / "chats.json").string());

    svr.Get("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleGetChats(req, res, chatStore);
    });

    svr.Put("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleSaveChats(req, res, chatStore);
    });

    // Embedded frontend files catch-all
    svr.Get(".*", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        std::string path = req.path;
        if (path == "/") path = "/index.html";
        
        auto it = embedded_files.find(path);
        if (it != embedded_files.end()) {
            std::string mime = get_mime_type(path);
            res.set_content(it->second.data(), it->second.size(), mime.c_str());
        } else {
            // SPA routing fallback
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
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            g_server = nullptr;
        }
        return;
    }
    
    serverRunning = true;
    svr.listen_after_bind();
    serverRunning = false;
    
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_server = nullptr;
    }
}

int main() {
    // 1. Determine data directory and create it
    fs::path dataDir = getExecutableDir() / "data";
    if (!fs::exists(dataDir)) {
        fs::create_directories(dataDir);
    }

    // 3. Set up logging to both console and file inside the data folder
    TeeStream teeCout(std::cout, (dataDir / "backend.log").string());
    TeeStream teeCerr(std::cerr, (dataDir / "backend.log").string());

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    curl_global_init(CURL_GLOBAL_DEFAULT);

    // 2 & 4. Initialize Config pointing to the data folder
    const std::string settingsPath = (dataDir / "settings.json").string();
    Config config(settingsPath);
    config.load(); // Will auto-create default if it doesn't exist

    std::string apiKey;
    const char* envApiKey = std::getenv("OPENROUTER_API_KEY");
    if (envApiKey != nullptr && std::string(envApiKey).length() > 0) {
        apiKey = envApiKey;
        std::cout << "API key source: environment variable\n";
    } else {
        std::cout << "API key source: none (set OPENROUTER_API_KEY environment variable)\n";
    }
    std::cout << "API key status: " << (apiKey.empty() ? "EMPTY" : "present") << "\n";

    std::string encryptionKey = "default-32-byte-encryption-key!!";
    Encryption encryption(encryptionKey);
    OpenRouterService openrouterService(apiKey, encryption);

    std::cout << "\n=== Control Panel Server ===\n";
    std::cout << "Server:       HTTP on port " << config.getPort() << "\n";
    std::cout << "Data Dir:     " << dataDir.string() << "\n";
    std::cout << "===========================\n\n";

    serverError = false;
    std::thread serverThread(runServer, std::ref(config), std::ref(openrouterService), dataDir.string());

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    if (serverError.load()) {
        std::cerr << "\n[FATAL] Server failed to start. Exiting.\n";
        shouldStopConfigWatch.store(true);
        serverThread.join();
        curl_global_cleanup();
        return 1;
    }

    std::thread healthCheckThread(runOpenRouterHealthCheck);
    std::thread configWatchThread(runConfigFileWatch, std::ref(config), settingsPath);

    std::cout << "\n=== Server started successfully ===\n";
    std::cout << "Press Ctrl+C to stop the server\n\n";

    serverThread.join();
    
    shouldStopHealthCheck.store(true);
    shouldStopConfigWatch.store(true);

    if (healthCheckThread.joinable()) {
        std::cout << "[Shutdown] Stopping health check thread...\n";
        healthCheckThread.join();
        std::cout << "[Shutdown] Health check thread stopped\n";
    }

    if (configWatchThread.joinable()) {
        std::cout << "[Shutdown] Stopping config watch thread...\n";
        configWatchThread.join();
        std::cout << "[Shutdown] Config watch thread stopped\n";
    }

    curl_global_cleanup();

    std::cout << "\n=== Server has stopped ===\n";
    return 0;
}