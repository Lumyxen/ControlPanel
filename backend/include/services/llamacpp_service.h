#pragma once

#include <functional>
#include <json/json.h>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <tuple>
#include <vector>

class Config;
class ToolSystem;
struct LlamaApi;
struct llama_model;

struct ModelInfo {
    std::string id;
    std::string name;
    std::string directory;
    std::string ggufPath;
    std::string mmprojPath;
    std::string tokenizerPath;
    int contextLength = 65536;
    int maxTokens = 8192;
    bool loaded = false;
    bool usesMrope = false;
};

struct LlamaServerStatus {
    bool running = false;
    bool ready = false;
    std::string activeBackend;
    int pid = 0;
    int parallelSlots = 1;
    int maxLoadedModels = 1;
    int loadedModels = 0;
    Json::Value loadedModelIds = Json::Value(Json::arrayValue);
};

class LlamaCppService {
public:
    LlamaCppService(const std::string& modelsDir,
                    const std::string& libsDir,
                    Config& config);
    ~LlamaCppService();

    LlamaCppService(const LlamaCppService&) = delete;
    LlamaCppService& operator=(const LlamaCppService&) = delete;

    bool isReady() const;
    std::string getLoadedModelId() const;
    std::string getActiveBackend() const;
    LlamaServerStatus getServerStatus() const;
    void markConfigDirty();

    std::vector<std::string> availableBackends() const;
    static std::vector<std::string> listAvailableBackends(const std::string& libsDir);
    static std::vector<std::string> detectHardwareBackends();
    static std::string resolveBackendPreference(const std::string& preference,
                                                const std::vector<std::string>& availableBackends);
    std::string resolveBackend(const std::string& preference) const;

    bool switchBackend(const std::string& backendName);
    void unloadLib();
    bool reloadModel();
    void unloadModel();
    bool unloadModel(const std::string& modelId);
    bool ensureModelLoaded(const std::string& modelId = "");

    std::vector<ModelInfo> scanModels() const;
    static std::vector<ModelInfo> scanModelDirectory(const std::string& modelsDir,
                                                     int contextLength = 65536,
                                                     const std::string& loadedModelPath = "");
    Json::Value getModels() const;
    int countTokens(
        const std::string& model,
        const Json::Value& messages
    );
    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

    std::string generateTitle(const std::string& model,
                              const std::string& userMessage,
                              const std::string& systemPrompt = "");

    void streamingChatWithCallback(
        const std::string& model,
        const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = "",
        double temperature = -1.0,
        int numCtx = 0,
        std::function<bool()> cancelCheck = nullptr,
        bool emitLogprobs = false
    );

    void streamingChatWithTools(
        const std::string& model,
        Json::Value messages,
        const Json::Value& tools,
        const std::string& taskId,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        ToolSystem* toolSystem,
        double temperature = -1.0,
        int numCtx = 0,
        std::function<bool()> cancelCheck = nullptr,
        bool emitLogprobs = false
    );

private:
    struct StartupConfig {
        std::string backend;
        int parallelSlots = 1;
        int maxLoadedModels = 1;
        int ctxSize = 0;
        int batchSize = 2048;
        int gpuLayers = 0;
        int threads = 0;
        int threadsBatch = 0;
        int sleepIdleSeconds = -1;
        bool flashAttn = true;
        bool cachePrompt = true;
        std::string kvCacheType = "f16";

        bool operator==(const StartupConfig& other) const;
        bool operator!=(const StartupConfig& other) const;
    };

    std::string modelsDir_;
    std::string libsDir_;
    Config& config_;

    mutable std::mutex stateMutex_;
    mutable std::mutex tokenizerMutex_;
    StartupConfig activeConfig_;
    std::string activeBackend_;
    std::string activePresetSignature_;
    std::string loadedModelId_;
    Json::Value loadedModelIds_ = Json::Value(Json::arrayValue);
    std::string serverBaseUrl_;
    int serverPort_ = 0;
    int serverPid_ = 0;
    int serverProcessGroupId_ = 0;
    bool serverRunning_ = false;
    bool configDirty_ = true;
    std::string tokenizerBackend_;
    void* tokenizerLibHandle_ = nullptr;
    std::unique_ptr<LlamaApi> tokenizerApi_;
    std::map<std::string, llama_model*> tokenizerModels_;

    std::string normalizeModelId(const std::string& modelId) const;
    std::string normalizeLoadedModelPath(const std::string& ggufPath) const;
    std::string findGgufInDirectory(const std::string& dir) const;
    std::string resolveTokenizerBackend() const;
    void clearTokenizerCacheLocked();
    bool ensureTokenizerBackendLocked(const std::string& backend, std::string* error = nullptr);
    llama_model* ensureTokenizerModelLocked(const std::string& backend,
                                            const ModelInfo& model,
                                            std::string* error = nullptr);

    StartupConfig buildStartupConfigLocked(const std::string& preferenceOverride = "") const;
    bool isServerProcessGroupAliveLocked() const;
    bool ensureServerRunning();
    bool ensureServerRunningLocked();
    bool startServerLocked(const StartupConfig& desired);
    void stopServerLocked();
    bool isServerProcessAliveLocked();
    bool waitForRouterLocked(int timeoutMs);

    std::string buildRouterPresetLocked() const;
    std::string presetPath() const;
    std::string logsDir() const;
    std::string backendInstallDir(const std::string& backend) const;
    std::string backendBinaryPath(const std::string& backend) const;

    bool refreshLoadedModelStateLocked();
    Json::Value routerModelsJson() const;
    Json::Value getJson(const std::string& endpoint, long timeoutSeconds = 5) const;
    Json::Value postJson(const std::string& endpoint,
                         const Json::Value& body,
                         long timeoutSeconds = 60) const;

    Json::Value parseConversationHistory(const std::string& prompt) const;
    std::string streamOneRound(
        const Json::Value& requestBody,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::vector<std::tuple<std::string, std::string, std::string>>& toolCallsOut,
        std::string* apiErrorOut = nullptr
    ) const;
};
