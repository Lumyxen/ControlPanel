#pragma once

#include <string>
#include <vector>
#include <functional>
#include <mutex>
#include <json/json.h>

class McpRegistry;

#ifdef LLAMA_CPP_AVAILABLE
#include "llama.h"
#endif

/**
 * LlamaCppService — local inference via llama.cpp.
 *
 * On construction it scans modelsDir for the first .gguf file it finds and
 * loads it.  All inference requests are serialised through a mutex so the
 * llama_context (which is not thread-safe) is always accessed from one thread
 * at a time.
 *
 * Model IDs are returned as  "llamacpp::<stem>"  where <stem> is the filename
 * without the .gguf extension (e.g. "llamacpp::Qwen3.5-2B-Q6_K").
 *
 * When LLAMA_CPP_AVAILABLE is not defined every method is a safe no-op stub.
 */
class LlamaCppService {
public:
    explicit LlamaCppService(const std::string& modelsDir);
    ~LlamaCppService();

    // Non-copyable / non-movable (owns raw llama pointers)
    LlamaCppService(const LlamaCppService&)            = delete;
    LlamaCppService& operator=(const LlamaCppService&) = delete;

    // ── Status ────────────────────────────────────────────────────────────────

    /** True if a model has been loaded and is ready for inference. */
    bool        isReady()         const { return modelLoaded_; }
    std::string getLoadedModelId() const { return loadedModelId_; }

    // ── Models API ────────────────────────────────────────────────────────────

    /**
     * Scan modelsDir for .gguf files and return them in the standard
     * { "data":[ { "id", "name", "source", "context_length", "max_tokens" }, … ] }
     * format.  Only includes the currently-loaded model (to avoid surfacing
     * files that can't be used without a restart).
     */
    Json::Value getModels() const;

    // ── Inference ─────────────────────────────────────────────────────────────

    /**
     * Convert the legacy "User: …\nAssistant: …" prompt string + systemPrompt
     * into a JSON messages array (same format as LmStudioService::buildMessages).
     */
    Json::Value buildMessages(const std::string& prompt,
                              const std::string& systemPrompt) const;

    /**
     * Stream a single-turn or multi-turn completion.
     * Emits SSE chunks in exactly the same format as LmStudioService so the
     * frontend requires no changes.
     */
    void streamingChatWithCallback(
        const std::string& model,
        const std::string& prompt,
        int maxTokens,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError,
        const std::string& systemPrompt = "",
        double temperature = -1.0,
        int numCtx = 0
    ) const;

    /**
     * Tool-augmented streaming (not yet implemented for llama.cpp).
     * Falls back to streamingChatWithCallback without tools and logs a notice.
     */
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
    ) const;

private:
    std::string modelsDir_;
    std::string loadedModelPath_;
    std::string loadedModelId_;
    bool        modelLoaded_ = false;

    mutable std::mutex inferMutex_;

#ifdef LLAMA_CPP_AVAILABLE
    llama_model*   model_ = nullptr;
    llama_context* ctx_   = nullptr;
    int            n_ctx_ = 8192;
    int            n_batch_ = 2048; // Increased batch size for faster processing
#endif

    // ── Helpers ───────────────────────────────────────────────────────────────

    bool loadModel(const std::string& path);

    /** Parse "User: …\nAssistant: …" into { role, content } pairs. */
    std::vector<std::pair<std::string, std::string>>
    parseMessages(const std::string& prompt,
                  const std::string& systemPrompt) const;

    /**
     * Core generation loop — must be called while inferMutex_ is held.
     * Applies the model's chat template, tokenises, decodes, samples, and
     * calls onChunk for each decoded piece.
     */
    void doInference(
        const std::vector<std::pair<std::string, std::string>>& messages,
        int maxTokens,
        double temperature,
        std::function<bool(const std::string&)> onChunk,
        std::function<void(const std::string&)> onError
    ) const;

    /** Build an SSE data chunk in the same format as lmstudio_service.cpp. */
    static std::string makeContentChunk(const std::string& text);
};