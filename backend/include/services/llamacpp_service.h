#pragma once

#include <string>
#include <vector>
#include <functional>
#include <mutex>
#include <json/json.h>

class Config;
class McpRegistry;

#ifdef LLAMA_CPP_AVAILABLE
#include "llama.h"
#endif

// Vision support via llama.cpp's tools/mtmd/clip.h (b8277+).
#ifdef LLAMA_CPP_VISION_AVAILABLE
#include "clip.h"
#endif

/**
 * LlamaCppService — local inference via llama.cpp.
 */
class LlamaCppService {
public:
    explicit LlamaCppService(const std::string& modelsDir, Config& config);
    ~LlamaCppService();

    LlamaCppService(const LlamaCppService&)            = delete;
    LlamaCppService& operator=(const LlamaCppService&) = delete;

    bool        isReady()          const { return modelLoaded_; }
    std::string getLoadedModelId() const { return loadedModelId_; }

    Json::Value getModels() const;

    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

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
    std::string loadedModelPath_;
    std::string loadedModelId_;
    bool        modelLoaded_ = false;

    Config&          config_;
    mutable std::mutex inferMutex_;

#ifdef LLAMA_CPP_AVAILABLE
    llama_model*   model_ = nullptr;
    llama_context* ctx_   = nullptr;
    int            n_ctx_   = 8192;
    int            n_batch_ = 2048;
#endif

#ifdef LLAMA_CPP_VISION_AVAILABLE
    clip_ctx* clipCtx_       = nullptr;
    bool      visionEnabled_ = false;
#endif

    bool loadModel(const std::string& path);
    bool ensureModelLoaded();

    std::vector<std::pair<std::string, std::string>>
    parseMessages(const std::string& prompt,
                  const std::string& systemPrompt) const;

    void doInference(
        const std::vector<std::pair<std::string, std::string>>& messages,
        int maxTokens,
        double temperature,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError
    ) const;

#ifdef LLAMA_CPP_VISION_AVAILABLE
    /**
     * Vision-aware generation loop.
     * Searches for `<image>` placeholders in the rendered template and
     * replaces them with the actual projected visual embeddings.
     */
    void doInferenceWithVision(
        const std::vector<std::pair<std::string, std::string>>& messages,
        const std::vector<std::vector<uint8_t>>& imageDataList,
        int maxTokens,
        double temperature,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError
    ) const;
#endif

    static std::string makeContentChunk(const std::string& text);
    static std::vector<uint8_t> decodeBase64Image(const std::string& dataUrl);
};