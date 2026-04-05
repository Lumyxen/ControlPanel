#pragma once
// backend/include/services/llamacpp_service.h

#include <string>
#include <vector>
#include <functional>
#include <mutex>
#include <filesystem>
#include <json/json.h>

struct LlamaApi;
class Config;
class McpRegistry;

class LlamaCppService {
public:
    LlamaCppService(const std::string& modelsDir,
                    const std::string& libsDir,
                    Config& config);
    ~LlamaCppService();

    LlamaCppService(const LlamaCppService&)            = delete;
    LlamaCppService& operator=(const LlamaCppService&) = delete;

    // ── State ─────────────────────────────────────────────────────────────────

    // Defined in .cpp — LlamaApi is forward-declared here (incomplete type)
    bool        isReady()          const;
    std::string getLoadedModelId() const { return loadedModelId_; }
    std::string getActiveBackend() const { return activeBackend_; }

    // ── Backend management ────────────────────────────────────────────────────

    std::vector<std::string> availableBackends() const;
    static std::vector<std::string> detectHardwareBackends();
    std::string resolveBackend(const std::string& preference) const;

    // Load a different backend .so. Waits for any running inference,
    // unloads the current model, closes the old lib, opens the new one,
    // and re-loads the model if one was previously loaded.
    bool switchBackend(const std::string& backendName);

    // Unload the current library (public so the delete endpoint can call it
    // when the active backend is removed).
    void unloadLib();

    // ── Model lifecycle (public so the reload-model API endpoint can call them) ──

    // Unload the current model (keeps the backend .so loaded).
    void unloadModel();

    // Scan modelsDir for the first .gguf and load it.
    bool ensureModelLoaded();

    // ── Models ────────────────────────────────────────────────────────────────

    Json::Value getModels() const;
    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

    // ── Streaming ─────────────────────────────────────────────────────────────

    void streamingChatWithCallback(
        const std::string& model,
        const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = "",
        double temperature = -1.0,
        int numCtx = 0
    );

    void streamingChatWithTools(
        const std::string& model,
        Json::Value messages,
        const Json::Value& tools,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        McpRegistry* registry,
        double temperature = -1.0,
        int numCtx = 0
    );

private:
    std::string modelsDir_;
    std::string libsDir_;
    Config&     config_;

    void*       dlHandle_      = nullptr;
    LlamaApi*   api_           = nullptr;
    std::string activeBackend_;

    void*       model_         = nullptr;
    void*       ctx_           = nullptr;
    std::string loadedModelPath_;
    std::string loadedModelId_;
    bool        modelLoaded_   = false;
    int         n_ctx_         = 8192;
    int         n_batch_       = 2048;

    void*       clipCtx_       = nullptr;
    bool        visionEnabled_ = false;

    mutable std::mutex inferMutex_;

    bool loadLib(const std::string& backendName);
    bool loadModel(const std::string& path = "");

    std::filesystem::path libPath(const std::string& name) const;

    std::vector<std::pair<std::string, std::string>>
    parseMessages(const std::string& prompt,
                  const std::string& systemPrompt) const;

    void doInference(
        const std::vector<std::pair<std::string, std::string>>& messages,
        int maxTokens, double temperature,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError
    ) const;

    /**
     * Like doInference but collects and returns the full generated text
     * instead of streaming it.  Used by the tool-call loop so we can inspect
     * the model's output before deciding whether to forward it to the client.
     *
     * @param cancelCheck  Optional predicate polled each token; return true to abort.
     * @param onError      Called once on hard errors.
     * @return             The full generated text (decoded from tokens).
     */
    std::string doInferenceCollect(
        const std::vector<std::pair<std::string, std::string>>& messages,
        int maxTokens, double temperature,
        std::function<bool()> cancelCheck,
        std::function<void(const std::string&)> onError
    ) const;

    /**
     * Like doInferenceCollect but also streams tokens live to the client
     * via onChunk.  Used by the tool-call loop so the user sees real-time
     * streaming while we simultaneously buffer for tool-call detection.
     *
     * @param cancelCheck  Optional predicate polled each token; return true to abort.
     * @param onError      Called once on hard errors.
     * @return             The full generated text (decoded from tokens).
     */
    std::string doInferenceCollectWithStreaming(
        const std::vector<std::pair<std::string, std::string>>& messages,
        int maxTokens, double temperature,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        std::function<bool()> cancelCheck
    ) const;

    static std::string makeContentChunk(const std::string& text);
    static std::vector<uint8_t> decodeBase64Image(const std::string& dataUrl);
};