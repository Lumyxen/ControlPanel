#ifndef SERVER_API_ROUTES_H
#define SERVER_API_ROUTES_H

#include <memory>
#include <mutex>
#include <string>
#include "httplib.h"

class Config;
class McpRegistry;
class McpService;
class LlamaCppService;
class AuthStore;
class ChatStore;
class VaultStore;
class HuggingFaceService;
struct LmStudioService;
class ToolSystem;

struct BuildState {
    std::mutex  mutex;
    bool        running = false;
    bool        done = false;
    bool        success = false;
    std::string backend;
    std::string logPath;
    std::string stage;
    std::string stageLabel;
    int         stageIndex = 0;
    int         stageCount = 0;
    int         stagePercent = -1;
    int         overallPercent = 0;
    bool        stageDeterminate = false;
};

struct ApiRouteContext {
    Config& config;
    LmStudioService& lmstudioService;
    McpService& mcpService;
    McpRegistry& registry;
    ToolSystem& toolSystem;
    AuthStore& authStore;
    ChatStore& chatStore;
    VaultStore& vaultStore;
    std::shared_ptr<HuggingFaceService> huggingFaceService;
    LlamaCppService* llamaCppService;
    BuildState& buildState;
    std::string dataDir;
    std::string modelsDir;
    std::string libsDir;
    std::string buildCacheDir;
};

void registerApiRoutes(httplib::Server& svr, ApiRouteContext& ctx);

#endif // SERVER_API_ROUTES_H
