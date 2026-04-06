#include <iostream>
#include <thread>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <chrono>
#include <atomic>
#include <mutex>
#include <csignal>
#include <streambuf>
#include <deque>
#include <ctime>
#include <curl/curl.h>
#include <httplib.h>
#include "config/config.h"
#include "services/lmstudio_service.h"
#include "services/llamacpp_service.h"
#include "services/backend_builder.h"
#include "services/mcp_service.h"
#include "services/mcp_registry.h"
#include "controllers/lmstudio_controller.h"
#include "controllers/config_controller.h"
#include "controllers/mcp_controller.h"
#include "controllers/chat_controller.h"
#include "controllers/auth_controller.h"
#include "embedded_frontend.h"

#ifndef _WIN32
#include <unistd.h>
#include <sys/wait.h>
#endif

namespace fs = std::filesystem;

httplib::Server* g_server = nullptr;
std::mutex g_serverMutex;
std::atomic<bool> serverRunning{false};
std::atomic<bool> serverError{false};
std::atomic<bool> shouldStopConfigWatch{false};
std::atomic<bool> g_shutdownRequested{false};

fs::path getExecutableDir() {
    try { return fs::canonical("/proc/self/exe").parent_path(); }
    catch (...) { return fs::current_path(); }
}

// ── Multi-file logger ─────────────────────────────────────────────────────────
// Writes to stdout/stderr AND two log files:
//   data/logs/latest.log        — truncated on startup
//   data/logs/DD-MM-YYYY_HH_MM_SS.log — new per session

class MultiLoggerBuffer : public std::streambuf {
    std::streambuf* orig_;
    std::ofstream   latest_;
    std::ofstream   session_;
    std::mutex      mu_;
public:
    MultiLoggerBuffer(std::streambuf* orig,
                      const std::string& latestPath,
                      const std::string& sessionPath) : orig_(orig) {
        latest_.open(latestPath,  std::ios::trunc);
        session_.open(sessionPath, std::ios::out);
    }
    ~MultiLoggerBuffer() {
        if (latest_.is_open())  latest_.close();
        if (session_.is_open()) session_.close();
    }
protected:
    int_type overflow(int_type c) override {
        std::lock_guard<std::mutex> lk(mu_);
        if (c != EOF) {
            char ch = static_cast<char>(c);
            orig_->sputc(ch);
            auto w = [&](std::ofstream& f){ if (f.is_open()){ f.put(ch); if(ch=='\n') f.flush(); }};
            w(latest_); w(session_);
        }
        return c;
    }
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        std::lock_guard<std::mutex> lk(mu_);
        orig_->sputn(s, n);
        auto w = [&](std::ofstream& f){
            if (f.is_open()){
                f.write(s, n);
                if (std::string_view(s,n).find('\n') != std::string_view::npos) f.flush();
            }
        };
        w(latest_); w(session_);
        return n;
    }
};

class MultiTeeStream {
public:
    MultiTeeStream(std::ostream& s, const std::string& lat, const std::string& sess)
        : s_(s), old_(s.rdbuf()), buf_(old_, lat, sess) { s_.rdbuf(&buf_); }
    ~MultiTeeStream() { s_.rdbuf(old_); }
private:
    std::ostream& s_; std::streambuf* old_; MultiLoggerBuffer buf_;
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

void addSecurityHeaders(httplib::Response& res) {
    res.set_header("X-Frame-Options", "DENY");
    res.set_header("X-Content-Type-Options", "nosniff");
    res.set_header("Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob: https:; "
        "font-src 'self' https://cdn.jsdelivr.net; "
        "connect-src 'self' http://localhost:* http://127.0.0.1:*; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
    res.set_header("X-XSS-Protection", "1; mode=block");
    res.set_header("Referrer-Policy", "strict-origin-when-cross-origin");
}

void addCorsHeaders(httplib::Response& res, const httplib::Request& req) {
    std::string origin = req.get_header_value("Origin");
    if (origin.empty() || origin.find("http://localhost") == 0 ||
                          origin.find("http://127.0.0.1") == 0) {
        res.set_header("Access-Control-Allow-Origin", origin.empty() ? "*" : origin);
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

// ── Background build state ────────────────────────────────────────────────────
struct BuildState {
    std::mutex  mutex;
    bool        running = false;
    bool        done    = false;
    bool        success = false;
    std::string backend;
    std::string logPath;
};
static BuildState g_buildState;

// ── Config + mcp file watcher ─────────────────────────────────────────────────
void runConfigFileWatch(Config& config, McpRegistry& registry,
                        LmStudioService& service,
                        const std::string& settingsPath,
                        const std::string& mcpJsonPath) {
    fs::file_time_type lastSt{}, lastMt{};
    auto safeTime =[](const std::string& p) -> fs::file_time_type {
        try { if (fs::exists(p)) return fs::last_write_time(p); } catch(...) {}
        return {};
    };
    lastSt = safeTime(settingsPath);
    lastMt = safeTime(mcpJsonPath);

    while (!shouldStopConfigWatch.load()) {
        for (int i = 0; i < 5 && !shouldStopConfigWatch.load(); ++i)
            std::this_thread::sleep_for(std::chrono::seconds(1));
        try {
            auto st = safeTime(settingsPath);
            if (st != lastSt) {
                lastSt = st; config.load();
                service.setLmStudioUrl(config.getLmStudioUrl());
                std::cout << "[ConfigWatch] settings.json reloaded\n";
            }
            auto mt = safeTime(mcpJsonPath);
            if (mt != lastMt) {
                lastMt = mt; registry.loadFromFile(mcpJsonPath);
                std::cout << "[ConfigWatch] mcp.json reloaded\n";
            }
        } catch (...) {}
    }
}

// ── Signal handler ────────────────────────────────────────────────────────────
void signalHandler(int sig) {
    const char msg[] = "\n[Signal] Shutdown requested...\n";
    (void)write(STDOUT_FILENO, msg, sizeof(msg) - 1);
    (void)sig;
    g_shutdownRequested.store(true, std::memory_order_relaxed);
}

// ── JSON parse helper ─────────────────────────────────────────────────────────
static bool parseJsonBody(const std::string& body, Json::Value& out, httplib::Response& res) {
    Json::CharReaderBuilder rb;
    std::string errs;
    std::istringstream ss(body);
    if (!Json::parseFromStream(rb, ss, &out, &errs)) {
        res.status = 400;
        res.set_content("{\"error\":\"Invalid JSON\"}", "application/json");
        return false;
    }
    return true;
}

// ── Server ────────────────────────────────────────────────────────────────────
void runServer(Config& config, LmStudioService& lmstudioService,
               McpService& mcpService, McpRegistry& registry,
               const std::string& dataDir,
               LlamaCppService* svc,
               const std::string& libsDir,
               const std::string& buildCacheDir) {

    httplib::Server svr;
    { std::lock_guard<std::mutex> lk(g_serverMutex); g_server = &svr; }

    svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
        if (req.path == "/health" ||
            req.path == "/api/llamacpp/build/status" ||
            req.path == "/api/llamacpp/build/log" ||
            req.path == "/api/config/settings") {
            return;
        }
        std::cout << "[HTTP] " << req.method << " " << req.path << " - " << res.status << "\n";
    });

    svr.Options(".*",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req); res.status = 200;
    });
    svr.Get("/health",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        res.set_content("{\"status\":\"ok\"}", "application/json");
    });

    // ── GET /api/llamacpp/backend ─────────────────────────────────────────────
    svr.Get("/api/llamacpp/backend", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);

        Json::Value result;
        result["active"]    = svc ? svc->getActiveBackend() : "none";
        result["setting"]   = config.getLlamacppBackend();
        result["dismissed"] = config.getBackendSuggestionDismissed();
        result["modelReady"]= svc ? svc->isReady() : false;
        result["tag"]       = config.getLlamacppTag();

        Json::Value allArr(Json::arrayValue);
        for (const char* b : {"cpu","cuda","rocm","vulkan"}) allArr.append(b);
        result["all"] = allArr;

        Json::Value availArr(Json::arrayValue);
        if (svc) for (const auto& b : svc->availableBackends()) availArr.append(b);
        result["available"] = availArr;

        // Check if the current setting points to a backend that doesn't exist
        const std::string setting = config.getLlamacppBackend();
        if (setting != "auto" && svc) {
            const auto avail = svc->availableBackends();
            if (std::find(avail.begin(), avail.end(), setting) == avail.end()) {
                result["settingValid"] = false;
                result["setting"] = "auto"; // Override to auto since the setting is invalid
            } else {
                result["settingValid"] = true;
            }
        } else {
            result["settingValid"] = true;
        }

        Json::Value hwArr(Json::arrayValue);
        for (const auto& b : LlamaCppService::detectHardwareBackends()) hwArr.append(b);
        result["hardware"] = hwArr;

        // Suggest backends with hardware but no .so, suppressing vulkan when
        // a vendor-specific GPU backend (cuda/rocm) is already built.
        Json::Value suggest(Json::arrayValue);
        if (!config.getBackendSuggestionDismissed()) {
            std::vector<std::string> avail;
            for (const auto& b : availArr) avail.push_back(b.asString());
            const bool hasVendor =
                std::find(avail.begin(), avail.end(), "cuda") != avail.end() ||
                std::find(avail.begin(), avail.end(), "rocm") != avail.end();
            for (const auto& h : hwArr) {
                const std::string b = h.asString();
                if (b == "cpu") continue;
                if (std::find(avail.begin(), avail.end(), b) != avail.end()) continue;
                if (b == "vulkan" && hasVendor) continue;
                suggest.append(b);
            }
        }
        result["suggest"] = suggest;

        // For each non-cpu backend, run checkPrerequisites() so the UI can
        // display a warning before the user even tries to click Build.
        Json::Value prereqs(Json::objectValue);
        for (const char* b : {"cuda", "rocm", "vulkan"}) {
            const std::string err = BackendBuilder::checkPrerequisites(b);
            if (!err.empty()) prereqs[b] = err;
        }
        result["prereqs"] = prereqs;

        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── POST /api/llamacpp/backend — switch to a different backend ────────────
    svr.Post("/api/llamacpp/backend", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value body;
        if (!parseJsonBody(req.body, body, res)) return;

        const std::string backend = body.get("backend", "auto").asString();

        if (!svc) {
            res.status = 503;
            res.set_content("{\"error\":\"llama.cpp service unavailable\"}", "application/json");
            return;
        }

        // Validate that the requested backend is actually available (has .so file)
        // For "auto", resolveBackend will pick the best available
        if (backend != "auto") {
            const auto avail = svc->availableBackends();
            if (std::find(avail.begin(), avail.end(), backend) == avail.end()) {
                res.status = 404;
                res.set_content("{\"error\":\"Backend '" + backend + "' is not built/available\"}", "application/json");
                return;
            }
        }

        Json::Value patch; patch["llamacppBackend"] = backend;
        config.updateFromJson(patch);

        const std::string resolved = svc->resolveBackend(backend);
        std::cout << "[Backend] Switch requested: " << backend << " → " << resolved << "\n";
        const bool ok = svc->switchBackend(resolved);

        Json::Value result;
        result["success"] = ok;
        result["active"]  = svc->getActiveBackend();
        if (!ok) result["error"] = "Backend switch failed — check logs";
        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── DELETE /api/llamacpp/backend/<name> — remove a built backend ──────────
    svr.Delete(R"(/api/llamacpp/backend/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);

        const std::string backend = req.matches[1];
        if (backend != "cpu" && backend != "cuda" && backend != "rocm" && backend != "vulkan") {
            res.status = 400;
            res.set_content("{\"error\":\"backend must be cpu|cuda|rocm|vulkan\"}", "application/json");
            return;
        }

        const std::string libPath = (fs::path(libsDir) / ("libllama_" + backend + ".so")).string();
        if (!fs::exists(libPath)) {
            res.status = 404;
            res.set_content("{\"error\":\"Backend library not found\"}", "application/json");
            return;
        }

        // If this is the currently active backend, unload and switch to cpu
        if (svc && svc->getActiveBackend() == backend) {
            std::cout << "[Backend] Removing active backend '" << backend << "' — switching to cpu\n";
            svc->switchBackend("cpu");
        }

        // Remove the backend library
        std::vector<std::string> removed;
        fs::remove(fs::path(libPath));
        removed.push_back("libllama_" + backend + ".so");

        // If the removed backend was the setting, fall back to auto
        if (config.getLlamacppBackend() == backend) {
            Json::Value patch; patch["llamacppBackend"] = "auto";
            config.updateFromJson(patch);
            if (svc) {
                const std::string resolved = svc->resolveBackend("auto");
                svc->switchBackend(resolved);
            }
        }

        std::cout << "[Backend] Removed: " << backend << " (" << removed.size() << " files)\n";

        Json::Value result;
        result["success"] = true;
        result["removed"] = Json::Value(Json::arrayValue);
        for (const auto& f : removed) result["removed"].append(f);
        result["active"] = svc ? svc->getActiveBackend() : "none";
        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── POST /api/llamacpp/reload-model ───────────────────────────────────────
    // Unloads and reloads the model, picking up any config changes.
    // Called automatically after saving llama.cpp settings or after a build.
    svr.Post("/api/llamacpp/reload-model", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        if (!svc) {
            res.status = 503;
            res.set_content("{\"error\":\"llama.cpp service unavailable\"}", "application/json");
            return;
        }
        config.load(); // pick up any saved changes
        const bool ok = svc->reloadModel();
        Json::Value result;
        result["success"] = ok;
        result["modelId"] = svc->getLoadedModelId();
        result["backend"] = svc->getActiveBackend();
        result["ready"]   = svc->isReady();
        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── POST /api/llamacpp/build ──────────────────────────────────────────────
    svr.Post("/api/llamacpp/build", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value body;
        if (!parseJsonBody(req.body, body, res)) return;

        const std::string backend = body.get("backend", "").asString();
        if (backend != "cpu" && backend != "cuda" && backend != "rocm" && backend != "vulkan") {
            res.status = 400;
            res.set_content("{\"error\":\"backend must be cpu|cuda|rocm|vulkan\"}", "application/json");
            return;
        }

        const std::string tag = (body.isMember("tag") && !body["tag"].asString().empty())
            ? body["tag"].asString() : config.getLlamacppTag();

        const std::string prereqErr = BackendBuilder::checkPrerequisites(backend);
        if (!prereqErr.empty()) {
            Json::Value r; r["error"] = prereqErr; res.status = 422;
            Json::StreamWriterBuilder wb; wb["indentation"] = "";
            res.set_content(Json::writeString(wb, r), "application/json");
            return;
        }

        {
            std::lock_guard<std::mutex> lk(g_buildState.mutex);
            if (g_buildState.running) {
                Json::Value r; r["error"] = "A build is already running for: " + g_buildState.backend;
                res.status = 409;
                Json::StreamWriterBuilder wb; wb["indentation"] = "";
                res.set_content(Json::writeString(wb, r), "application/json");
                return;
            }
            g_buildState.running = true;
            g_buildState.done    = false;
            g_buildState.success = false;
            g_buildState.backend = backend;
            g_buildState.logPath = (fs::path(dataDir) / "logs" / ("build_" + backend + ".log")).string();
        }

        std::thread([backend, tag, libsDir, buildCacheDir, dataDir]() {
            fs::create_directories(fs::path(dataDir) / "logs");
            const std::string logPath = (fs::path(dataDir) / "logs" / ("build_" + backend + ".log")).string();
            std::cout << "[BackendBuild] Starting: " << backend << " (tag " << tag << ")\n";
            const int ret = BackendBuilder::build(backend, libsDir, buildCacheDir, logPath, tag);
            std::lock_guard<std::mutex> lk(g_buildState.mutex);
            g_buildState.running = false;
            g_buildState.done    = true;
            g_buildState.success = (ret == 0);
            std::cout << "[BackendBuild] " << backend << (ret == 0 ? " succeeded" : " FAILED") << "\n";
        }).detach();

        Json::Value result;
        result["started"] = true;
        result["backend"] = backend;
        result["tag"]     = tag;
        result["logPath"] = g_buildState.logPath;
        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── GET /api/llamacpp/build/status ────────────────────────────────────────
    svr.Get("/api/llamacpp/build/status", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        std::lock_guard<std::mutex> lk(g_buildState.mutex);
        Json::Value r;
        r["running"] = g_buildState.running;
        r["done"]    = g_buildState.done;
        r["success"] = g_buildState.success;
        r["backend"] = g_buildState.backend;
        r["logPath"] = g_buildState.logPath;
        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, r), "application/json");
    });

    // ── GET /api/llamacpp/build/log ───────────────────────────────────────────
    // Returns the last N lines of the build log + the highest cmake % found.
    svr.Get("/api/llamacpp/build/log", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);

        std::string logPath;
        { std::lock_guard<std::mutex> lk(g_buildState.mutex); logPath = g_buildState.logPath; }

        int nLines = 80;
        if (req.has_param("lines")) {
            try { nLines = std::min(500, std::stoi(req.get_param_value("lines"))); } catch (...) {}
        }

        Json::Value result;
        result["logPath"] = logPath;

        if (logPath.empty() || !fs::exists(logPath)) {
            result["lines"]   = Json::Value(Json::arrayValue);
            result["percent"] = -1;
            Json::StreamWriterBuilder wb; wb["indentation"] = "";
            res.set_content(Json::writeString(wb, result), "application/json");
            return;
        }

        std::ifstream f(logPath);
        std::deque<std::string> window;
        std::string line;
        int percent = -1;
        
        while (std::getline(f, line)) {
            window.push_back(line);
            if (static_cast<int>(window.size()) > nLines) window.pop_front();

            // cmake progress: "[  5%] Building CXX..."
            auto br = line.find('['), pct = line.find('%');
            if (br != std::string::npos && pct != std::string::npos && pct > br) {
                try {
                    int p = std::stoi(line.substr(br + 1, pct - br - 1));
                    if (p >= 0 && p <= 100) percent = p;
                } catch (...) {}
            }
        }

        Json::Value lines(Json::arrayValue);
        for (const auto& l : window) {
            lines.append(l);
        }
        
        result["lines"]   = lines;
        result["percent"] = percent;

        Json::StreamWriterBuilder wb; wb["indentation"] = "";
        res.set_content(Json::writeString(wb, result), "application/json");
    });

    // ── POST /api/llamacpp/backend/dismiss ────────────────────────────────────
    svr.Post("/api/llamacpp/backend/dismiss", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value patch; patch["backendSuggestionDismissed"] = true;
        config.updateFromJson(patch);
        res.set_content("{\"ok\":true}", "application/json");
    });

    // ── Chat / Models / Settings / MCP ────────────────────────────────────────
    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleChat(req, res, lmstudioService);
    });
    svr.Post("/api/chat/stream", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleStreaming(req, res, lmstudioService, &registry, svc);
    });
    svr.Post("/api/chat/stop", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleStopStream(req, res);
    });
    svr.Get("/api/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleModels(req, res, lmstudioService, svc);
    });
    svr.Get("/api/lmstudio/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleLmStudioModels(req, res, lmstudioService);
    });
    svr.Get("/api/lmstudio/models", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleLmStudioModels(req, res, lmstudioService);
    });
    svr.Get("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleGetSettings(req, res, config);
    });
    svr.Put("/api/config/settings", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleUpdateSettings(req, res, config);
    });
    svr.Get("/api/mcp/tools", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        Json::Value r; r["tools"] = registry.getAggregatedTools();
        Json::StreamWriterBuilder wb;
        res.set_content(Json::writeString(wb, r), "application/json");
    });
    svr.Post("/api/mcp/reload", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        registry.loadFromFile(config.getMcpConfigPath());
        Json::Value r;
        r["liveClients"] = static_cast<int>(registry.liveCount());
        r["tools"]       = registry.getAggregatedTools();
        Json::StreamWriterBuilder wb;
        res.set_content(Json::writeString(wb, r), "application/json");
    });

    ChatStore chatStore((fs::path(dataDir) / "chats.json").string());
    AuthStore authStore((fs::path(dataDir) / "auth.json").string());
    svr.Get("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleGetChats(req, res, chatStore);
    });
    svr.Put("/api/chats", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleSaveChats(req, res, chatStore);
    });
    // ── Auth (password salt + sentinel — stored server-side) ─────────────────
    svr.Get("/api/auth", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleGetAuth(req, res, authStore);
    });
    svr.Post("/api/auth", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res); addCorsHeaders(res, req);
        handleSetAuth(req, res, authStore);
    });

    svr.Post("/mcp", [&](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req); handleMcpPost(req, res, mcpService);
    });
    svr.Get("/mcp",[](const httplib::Request& req, httplib::Response& res) {
        addCorsHeaders(res, req); handleMcpGet(req, res);
    });

    // ── Embedded frontend ─────────────────────────────────────────────────────
    svr.Get(".*", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        std::string path = req.path;
        if (path == "/") path = "/index.html";
        auto it = embedded_files.find(path);
        if (it != embedded_files.end()) {
            res.set_content(it->second.data(), it->second.size(), get_mime_type(path).c_str());
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

    const std::string host = config.getHost();
    const int port         = config.getPort();

    if (!svr.bind_to_port(host.c_str(), port)) {
        std::cerr << "[Server] ERROR: Failed to bind to " << host << ":" << port << "\n";
        serverError = true;
        std::lock_guard<std::mutex> lk(g_serverMutex); g_server = nullptr;
        return;
    }
    serverRunning = true;
    svr.listen_after_bind();
    serverRunning = false;
    { std::lock_guard<std::mutex> lk(g_serverMutex); g_server = nullptr; }
}

// ── main ──────────────────────────────────────────────────────────────────────
int main() {
    fs::path execDir    = getExecutableDir();
    fs::path dataDir    = execDir / "data";
    fs::path libsDir    = dataDir / "libs";
    fs::path logsDir    = dataDir / "logs";
    fs::path buildCache = dataDir / "build-cache";  // temp; deleted after each build
    fs::path modelsDir  = dataDir / "models";

    for (auto& d : {dataDir, libsDir, logsDir, modelsDir})
        if (!fs::exists(d)) fs::create_directories(d);
    // build-cache is created on demand by BackendBuilder, not pre-created

    // ── Multi-file logging ────────────────────────────────────────────────────
    {
        std::time_t t  = std::time(nullptr);
        std::tm*    tm = std::localtime(&t);
        char buf[32];
        std::strftime(buf, sizeof(buf), "%d-%m-%Y_%H_%M_%S", tm);
        static MultiTeeStream* teeOut = nullptr;
        static MultiTeeStream* teeErr = nullptr;
        teeOut = new MultiTeeStream(std::cout,
                     (logsDir / "latest.log").string(),
                     (logsDir / (std::string(buf) + ".log")).string());
        teeErr = new MultiTeeStream(std::cerr,
                     (logsDir / "latest.log").string(),
                     (logsDir / (std::string(buf) + ".log")).string());
    }

#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
    std::signal(SIGINT,  signalHandler);
    std::signal(SIGTERM, signalHandler);

    curl_global_init(CURL_GLOBAL_DEFAULT);

    const std::string settingsPath = (dataDir / "settings.json").string();
    const std::string mcpJsonPath  = (dataDir / "mcp.json").string();

    if (!fs::exists(mcpJsonPath)) {
        std::ofstream f(mcpJsonPath);
        if (f.is_open()) f << "{\n    \"mcpServers\": {}\n}\n";
    }

    Config config(settingsPath);
    config.load();

    LmStudioService lmstudioService;
    lmstudioService.setLmStudioUrl(config.getLmStudioUrl());

    McpService  mcpService(config);
    McpRegistry registry;
    registry.loadFromFile(mcpJsonPath);

    LlamaCppService llamaCppService(modelsDir.string(), libsDir.string(), config);

    // ── Startup banner ────────────────────────────────────────────────────────
    const auto available = llamaCppService.availableBackends();
    const auto hardware  = LlamaCppService::detectHardwareBackends();
    std::string availStr, hwStr;
    for (const auto& b : available) { if (!availStr.empty()) availStr += ", "; availStr += b; }
    for (const auto& b : hardware)  { if (!hwStr.empty())   hwStr   += ", "; hwStr   += b; }

    std::cout << "\n=== Control Panel Server ===\n";
    std::cout << "Server:         " << config.getHost() << ":" << config.getPort() << "\n";
    std::cout << "Data Dir:       " << dataDir.string()    << "\n";
    std::cout << "Logs Dir:       " << logsDir.string()    << "\n";
    std::cout << "Libs Dir:       " << libsDir.string()    << "\n";
    std::cout << "Hardware:       " << (hwStr.empty() ? "cpu only" : hwStr) << "\n";
    std::cout << "Backends (.so): " << (availStr.empty() ? "none" : availStr) << "\n";
    std::cout << "Active backend: " << llamaCppService.getActiveBackend() << "\n";
    std::cout << "llama.cpp tag:  " << config.getLlamacppTag() << "\n";
    if (llamaCppService.isReady())
        std::cout << "Local model:    " << llamaCppService.getLoadedModelId() << "\n";
    else
        std::cout << "Local model:    none\n";
    std::cout << "===========================\n\n";

    serverError = false;
    std::thread serverThread(runServer,
        std::ref(config), std::ref(lmstudioService),
        std::ref(mcpService), std::ref(registry),
        dataDir.string(), &llamaCppService,
        libsDir.string(), buildCache.string());

    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    if (serverError.load()) {
        std::cerr << "\n[FATAL] Server failed to start.\n";
        shouldStopConfigWatch.store(true);
        serverThread.join();
        curl_global_cleanup();
        return 1;
    }

    std::thread configWatchThread(runConfigFileWatch,
        std::ref(config), std::ref(registry), std::ref(lmstudioService),
        settingsPath, mcpJsonPath);

    std::cout << "=== Server ready — Press Ctrl+C to stop ===\n\n";

    while (!g_shutdownRequested.load(std::memory_order_relaxed))
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

    shouldStopConfigWatch.store(true);
    { std::lock_guard<std::mutex> lk(g_serverMutex); if (g_server) g_server->stop(); }
    serverThread.join();
    configWatchThread.join();
    curl_global_cleanup();
    std::cout << "\n=== Server stopped ===\n";
    return 0;
}
