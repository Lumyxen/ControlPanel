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
#include <curl/curl.h>
#include <httplib.h>
#include "config/config.h"
#include "services/openrouter_service.h"
#include "controllers/openrouter_controller.h"
#include "controllers/config_controller.h"
#include "controllers/auth_controller.h"
#include "utils/encryption.h"

namespace fs = std::filesystem;

// Server ports
const int BACKEND_PORT = 1024;
const int FRONTEND_PORT = 1025;

// OpenRouter health status
std::atomic<bool> openRouterHealthy{false};
std::mutex openRouterHealthMutex;
std::chrono::steady_clock::time_point lastOpenRouterCheck;

// Global atomic flags to track server status
std::atomic<bool> backendRunning{false};
std::atomic<bool> frontendRunning{false};
std::atomic<bool> backendError{false};
std::atomic<bool> frontendError{false};

// Global flag to stop health check thread gracefully
std::atomic<bool> shouldStopHealthCheck{false};

// Global server pointers for signal handler to stop them
httplib::Server* g_backendServer = nullptr;
httplib::Server* g_frontendServer = nullptr;
std::mutex g_serverMutex;

// Get the directory where the executable is located
fs::path getExecutableDir() {
    try {
        return fs::canonical("/proc/self/exe").parent_path();
    } catch (...) {
        return fs::current_path();
    }
}

// Get the project root directory (parent of backend/)
fs::path getProjectRoot() {
    fs::path exeDir = getExecutableDir();
    // exeDir is backend/build/, so go up two levels to get project root
    return exeDir.parent_path().parent_path();
}

// Get the backend directory
fs::path getBackendDir() {
    fs::path exeDir = getExecutableDir();
    // exeDir is backend/build/, so go up one level to get backend/
    return exeDir.parent_path();
}

// Add security headers to response
void addSecurityHeaders(httplib::Response& res) {
    // Prevent clickjacking
    res.set_header("X-Frame-Options", "DENY");
    
    // Prevent MIME type sniffing
    res.set_header("X-Content-Type-Options", "nosniff");
    
    // Content Security Policy
    res.set_header("Content-Security-Policy", 
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self'; "
        "connect-src 'self' http://localhost:1024 http://127.0.0.1:1024 https://api.openrouter.ai; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self';");
    
    // XSS Protection
    res.set_header("X-XSS-Protection", "1; mode=block");
    
    // Referrer Policy
    res.set_header("Referrer-Policy", "strict-origin-when-cross-origin");
}

// Helper to add CORS headers to response - allows localhost for development
void addCorsHeaders(httplib::Response& res, const httplib::Request& req) {
    // Get the Origin header from the request
    std::string origin = req.get_header_value("Origin");
    
    // Allow localhost origins for development - including different ports
    if (origin.empty() || 
        origin.find("http://localhost") == 0 || 
        origin.find("http://127.0.0.1") == 0) {
        // If no origin (e.g., direct curl), use wildcard
        // If localhost/127.0.0.1, use the actual origin
        res.set_header("Access-Control-Allow-Origin", origin.empty() ? "*" : origin);
        res.set_header("Access-Control-Allow-Credentials", "true");
    }
    
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
    res.set_header("Access-Control-Max-Age", "86400"); // 24 hours
}

// Curl write callback for health check responses
size_t HealthCheckWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

// Check if OpenRouter API is accessible
bool checkOpenRouterHealth() {
    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "[HealthCheck] Failed to initialize CURL" << std::endl;
        return false;
    }
    
    std::string response;
    
    // Use OpenRouter's models endpoint for a simple health check
    curl_easy_setopt(curl, CURLOPT_URL, "https://openrouter.ai/api/v1/models");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, HealthCheckWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L); // 20 second timeout
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 3L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);  // Prevent SIGPIPE crashes
    
    // Set a user agent
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "ControlPanel-Backend/1.0");
    
    CURLcode res = curl_easy_perform(curl);
    
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    
    curl_easy_cleanup(curl);
    
    if (res != CURLE_OK) {
        std::cerr << "[HealthCheck] OpenRouter check failed: " << curl_easy_strerror(res) << std::endl;
        return false;
    }
    
    if (httpCode != 200) {
        std::cerr << "[HealthCheck] OpenRouter returned HTTP " << httpCode << std::endl;
        return false;
    }
    
    // Try to parse the response to ensure it's valid JSON
    Json::Value root;
    Json::CharReaderBuilder builder;
    std::string errors;
    
    std::istringstream responseStream(response);
    if (!Json::parseFromStream(builder, responseStream, &root, &errors)) {
        std::cerr << "[HealthCheck] OpenRouter response parse error: " << errors << std::endl;
        return false;
    }
    
    return true;
}

// OpenRouter health check thread function
void runOpenRouterHealthCheck() {
    std::cout << "[HealthCheck] Starting OpenRouter health check thread" << std::endl;
    
    bool firstCheck = true;
    int consecutiveFailures = 0;
    const int MAX_FAILURES = 2; // Require 2 consecutive failures before marking unhealthy
    
    // Run health checks in an infinite loop until stop flag is set
    while (!shouldStopHealthCheck.load()) {
        bool healthy = false;
        
        try {
            // Perform the health check
            healthy = checkOpenRouterHealth();
            bool wasHealthy = openRouterHealthy.load();
            
            // Apply retry logic: require 2 consecutive failures before marking unhealthy
            if (healthy) {
                // Reset failure counter on success
                if (consecutiveFailures > 0) {
                    consecutiveFailures = 0;
                }
            } else {
                // Increment failure counter on failure
                consecutiveFailures++;
                std::cerr << "[HealthCheck] OpenRouter check failed (consecutive failures: "
                          << consecutiveFailures << ")" << std::endl;
                // Only mark as unhealthy after MAX_FAILURES consecutive failures
                if (consecutiveFailures < MAX_FAILURES) {
                    healthy = true; // Pretend healthy until we hit threshold
                }
            }
            
            // Update the global health status
            openRouterHealthy.store(healthy);
            
            {
                std::lock_guard<std::mutex> lock(openRouterHealthMutex);
                lastOpenRouterCheck = std::chrono::steady_clock::now();
            }
            
            // Log status on first check or when status changes
            if (firstCheck) {
                std::cout << "[HealthCheck] Initial OpenRouter status: "
                          << (healthy ? "healthy" : "unhealthy") << std::endl;
                firstCheck = false;
            } else if (healthy != wasHealthy) {
                std::cout << "[HealthCheck] OpenRouter status changed: "
                          << (healthy ? "healthy" : "unhealthy") << std::endl;
            }
        } catch (const std::exception& e) {
            std::cerr << "[HealthCheck] Exception during health check: " << e.what() << std::endl;
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_FAILURES) {
                openRouterHealthy.store(false);
            }
        } catch (...) {
            std::cerr << "[HealthCheck] Unknown exception during health check" << std::endl;
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_FAILURES) {
                openRouterHealthy.store(false);
            }
        }
        
        // Sleep for 60 seconds, but check stop flag periodically to allow quick shutdown
        for (int i = 0; i < 60 && !shouldStopHealthCheck.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
    
    std::cout << "[HealthCheck] OpenRouter health check thread stopped" << std::endl;
}

// Run the backend API server
void runBackendServer(Config& config, OpenRouterService& openrouterService) {
    std::string host = config.getHost();

    std::cout << "[Backend] Starting HTTP API server on " << host << ":" << BACKEND_PORT << std::endl;

    httplib::Server svr;
    
    // Store pointer so signal handler can stop the server
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_backendServer = &svr;
    }

    // Explicitly add OPTIONS handlers for CORS preflight
    auto optionsHandler =[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        res.status = 200;
    };

    svr.Options("/health", optionsHandler);
    svr.Options("/api/health/external", optionsHandler);
    svr.Options("/api/auth/verify", optionsHandler);
    svr.Options("/api/chat", optionsHandler);
    svr.Options("/api/chat/stream", optionsHandler);
    svr.Options("/api/models", optionsHandler);
    svr.Options("/api/pricing", optionsHandler);
    svr.Options("/api/config/prompt-templates", optionsHandler);
    svr.Options("/api/config/settings", optionsHandler);

    // Regex matches for paths with parameters
    svr.Options(R"(/api/config/prompt-templates/(\d+))", optionsHandler);
    svr.Options(".*", optionsHandler); // Catch-all for regex-enabled builds

    // Health check
    svr.Get("/health",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        res.set_content("{\"status\": \"ok\"}", "application/json");
    });

    // External health check - OpenRouter status
    svr.Get("/api/health/external", [](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        
        Json::Value response;
        response["openrouter"] = openRouterHealthy.load();
        
        // Get last check time
        std::chrono::steady_clock::time_point lastCheck;
        {
            std::lock_guard<std::mutex> lock(openRouterHealthMutex);
            lastCheck = lastOpenRouterCheck;
        }
        
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - lastCheck).count();
        response["lastCheckSecondsAgo"] = static_cast<Json::Int64>(elapsed);
        
        Json::StreamWriterBuilder builder;
        std::string jsonStr = Json::writeString(builder, response);
        res.set_content(jsonStr, "application/json");
    });

    // Auth - verify API key
    svr.Post("/api/auth/verify", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleAuthVerify(req, res, config);
    });

    // OpenRouter API
    svr.Post("/api/chat", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleChat(req, res, openrouterService);
    });

    // Changed to Post to support large request bodies containing the chat history context
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

    // Config API - Prompt templates
    svr.Get("/api/config/prompt-templates",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleGetPromptTemplates(req, res);
    });

    svr.Post("/api/config/prompt-templates",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleCreatePromptTemplate(req, res);
    });

    svr.Put(R"(/api/config/prompt-templates/(\d+))",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleUpdatePromptTemplate(req, res);
    });

    svr.Delete(R"(/api/config/prompt-templates/(\d+))",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleDeletePromptTemplate(req, res);
    });

    // Config API - Settings
    svr.Get("/api/config/settings",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleGetSettings(req, res);
    });

    svr.Put("/api/config/settings",[](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        addCorsHeaders(res, req);
        handleUpdateSettings(req, res);
    });

    std::cout << "[Backend] API Server ready. Endpoints:" << std::endl;
    std::cout << "  GET  /health" << std::endl;
    std::cout << "  GET  /api/health/external" << std::endl;
    std::cout << "  POST /api/auth/verify" << std::endl;
    std::cout << "  POST /api/chat" << std::endl;
    std::cout << "  POST /api/chat/stream" << std::endl;
    std::cout << "  GET  /api/models" << std::endl;
    std::cout << "  GET  /api/pricing" << std::endl;
    std::cout << "  GET  /api/config/prompt-templates" << std::endl;
    std::cout << "  POST /api/config/prompt-templates" << std::endl;
    std::cout << "  PUT  /api/config/prompt-templates/:id" << std::endl;
    std::cout << "  DELETE /api/config/prompt-templates/:id" << std::endl;
    std::cout << "  GET  /api/config/settings" << std::endl;
    std::cout << "  PUT  /api/config/settings" << std::endl;

    // Bind to the address first
    std::cout << "[Backend] Attempting to listen on " << host << ":" << BACKEND_PORT << std::endl;
    if (!svr.bind_to_port(host.c_str(), BACKEND_PORT)) {
        std::cerr << "[Backend] ERROR: Failed to bind to " << host << ":" << BACKEND_PORT << std::endl;
        std::cerr << "[Backend] Possible causes: port in use, insufficient permissions" << std::endl;
        backendError = true;
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            g_backendServer = nullptr;
        }
        return;
    }
    
    // Mark as running BEFORE starting the listen loop
    backendRunning = true;
    
    // Start listening (this blocks until server is stopped)
    svr.listen_after_bind();
    
    // Server has stopped
    backendRunning = false;
    
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_backendServer = nullptr;
    }
}

// Run the frontend static file server
void runFrontendServer(Config& config) {
    std::string host = config.getHost();

    // Resolve frontend directory relative to project root
    fs::path projectRoot = getProjectRoot();
    fs::path frontendDir = projectRoot / "ctrlpanel";

    std::cout << "[Frontend] Starting HTTP static file server on " << host << ":" << FRONTEND_PORT << std::endl;
    std::cout << "[Frontend] Serving files from: " << frontendDir << std::endl;

    httplib::Server svr;
    
    // Store pointer so signal handler can stop the server
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_frontendServer = &svr;
    }

    // Mount the frontend directory to serve static files
    auto ret = svr.set_mount_point("/", frontendDir.string());
    if (!ret) {
        std::cerr << "[Frontend] ERROR: Failed to mount directory: " << frontendDir << std::endl;
        frontendError = true;
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            g_frontendServer = nullptr;
        }
        return;
    }

    // Catch-all handler to support client-side routing (SPA)
    // Serve index.html for any path that doesn't match a file
    svr.Get(".*", [&](const httplib::Request& req, httplib::Response& res) {
        addSecurityHeaders(res);
        
        // If the request is for a file with an extension, return 404
        if (req.path.find('.') != std::string::npos) {
            res.status = 404;
            return;
        }
        // Otherwise, serve index.html for client-side routing
        res.set_file_content((frontendDir / "index.html").string());
    });

    std::cout << "[Frontend] Static file server ready" << std::endl;

    // Bind to the address first
    std::cout << "[Frontend] Attempting to listen on " << host << ":" << FRONTEND_PORT << std::endl;
    if (!svr.bind_to_port(host.c_str(), FRONTEND_PORT)) {
        std::cerr << "[Frontend] ERROR: Failed to bind to " << host << ":" << FRONTEND_PORT << std::endl;
        std::cerr << "[Frontend] Possible causes: port in use, insufficient permissions" << std::endl;
        frontendError = true;
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            g_frontendServer = nullptr;
        }
        return;
    }
    
    // Mark as running BEFORE starting the listen loop
    frontendRunning = true;
    
    // Start listening (this blocks until server is stopped)
    svr.listen_after_bind();
    
    // Server has stopped
    frontendRunning = false;
    
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        g_frontendServer = nullptr;
    }
}

// Signal handler for graceful shutdown
void signalHandler(int signal) {
    std::cout << "\n[Signal] Received signal " << signal << ", initiating graceful shutdown..." << std::endl;
    shouldStopHealthCheck.store(true);
    
    // Stop the HTTP servers
    {
        std::lock_guard<std::mutex> lock(g_serverMutex);
        if (g_backendServer) {
            std::cout << "[Signal] Stopping backend server..." << std::endl;
            g_backendServer->stop();
        }
        if (g_frontendServer) {
            std::cout << "[Signal] Stopping frontend server..." << std::endl;
            g_frontendServer->stop();
        }
    }
}

int main() {
    // Register signal handlers for graceful shutdown
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    
    // Initialize CURL globally
    curl_global_init(CURL_GLOBAL_DEFAULT);

    // Determine config file path relative to executable location
    fs::path configPath = getExecutableDir().parent_path() / "config.json";

    Config config;
    bool configLoaded = config.loadFromFile(configPath.string());

    std::cout << "Config loaded: " << (configLoaded ? "yes" : "no");
    if (configLoaded) {
        std::cout << " (from " << configPath << ")";
    }
    std::cout << std::endl;

    // Get API key from environment variable only
    std::string apiKey;
    const char* envApiKey = std::getenv("OPENROUTER_API_KEY");
    if (envApiKey != nullptr && std::string(envApiKey).length() > 0) {
        apiKey = envApiKey;
        std::cout << "API key source: environment variable" << std::endl;
    } else {
        std::cout << "API key source: none (set OPENROUTER_API_KEY environment variable)" << std::endl;
    }
    std::cout << "API key status: " << (apiKey.empty() ? "EMPTY" : "present") << std::endl;

    // Use a default encryption key (can be overridden via environment variable if needed)
    std::string encryptionKey = "default-32-byte-encryption-key!!";
    Encryption encryption(encryptionKey);

    OpenRouterService openrouterService(apiKey, encryption);

    std::cout << "\n=== Control Panel Server ===" << std::endl;
    std::cout << "Backend API:  HTTP on port " << BACKEND_PORT << std::endl;
    std::cout << "Frontend:     HTTP on port " << FRONTEND_PORT << std::endl;
    std::cout << "===========================\n" << std::endl;

    // Reset error flags
    backendError = false;
    frontendError = false;

    // Start HTTP servers in separate threads
    std::thread backendThread(runBackendServer, std::ref(config), std::ref(openrouterService));
    std::thread frontendThread(runFrontendServer, std::ref(config));

    // Wait a moment for servers to start binding
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    // Check if servers failed to bind
    if (backendError.load()) {
        std::cerr << "\n[FATAL] Backend HTTP server failed to start. Exiting." << std::endl;
        shouldStopHealthCheck.store(true);
        // Signal the other thread to stop if it started
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            if (g_frontendServer) {
                g_frontendServer->stop();
            }
        }
        frontendThread.join();
        curl_global_cleanup();
        return 1;
    }
    
    if (frontendError.load()) {
        std::cerr << "\n[FATAL] Frontend HTTP server failed to start. Exiting." << std::endl;
        shouldStopHealthCheck.store(true);
        // Signal the other thread to stop if it started
        {
            std::lock_guard<std::mutex> lock(g_serverMutex);
            if (g_backendServer) {
                g_backendServer->stop();
            }
        }
        backendThread.join();
        curl_global_cleanup();
        return 1;
    }

    // Start OpenRouter health check thread (only if backend started successfully)
    std::thread healthCheckThread;
    if (!backendError.load()) {
        healthCheckThread = std::thread(runOpenRouterHealthCheck);
    }

    std::cout << "\n=== Both HTTP servers started successfully ===" << std::endl;
    std::cout << "Press Ctrl+C to stop the servers\n" << std::endl;

    // Wait for threads to complete (they run until signal handler stops them)
    backendThread.join();
    frontendThread.join();
    
    // Signal health check thread to stop and wait for it to finish
    shouldStopHealthCheck.store(true);
    if (healthCheckThread.joinable()) {
        std::cout << "[Shutdown] Stopping health check thread..." << std::endl;
        healthCheckThread.join();
        std::cout << "[Shutdown] Health check thread stopped" << std::endl;
    }

    // Cleanup CURL
    curl_global_cleanup();

    // Keep-alive loop with error status reporting
    std::cout << "\n=== One or more servers have stopped ===" << std::endl;
    bool anyError = false;
    if (backendError) {
        std::cerr << "[Status] Backend server exited with error" << std::endl;
        anyError = true;
    } else {
        std::cout << "[Status] Backend server stopped" << std::endl;
    }
    if (frontendError) {
        std::cerr << "[Status] Frontend server exited with error" << std::endl;
        anyError = true;
    } else {
        std::cout << "[Status] Frontend server stopped" << std::endl;
    }

    return anyError ? 1 : 0;
}
