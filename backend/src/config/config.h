#ifndef CONFIG_H
#define CONFIG_H

#include <algorithm>
#include <fstream>
#include <json/json.h>
#include <mutex>
#include <string>

class Config {
private:
    struct State {
        int port = 8080;
        std::string host = "0.0.0.0";
        std::string defaultModel;
        int fallbackMaxOutputTokens = 8192;
        double temperature = 0.7;
        std::string systemPrompt = R"SYS(You are in an advanced AI harness with access to a deferred internal tool system.

Core principles:
- Search the internal tool catalog before loading or calling specialist tools
- Load only the tool definitions you actually need for the current task
- Rely on tools for factual queries, calculations, and data retrieval - never guess or hallucinate
- Say "I don't know" or be honest when uncertain or when tools don't provide a clear answer
- Be direct and concise; prioritize information density over verbosity
- Use latest standards and best practices for technical work
- Only cite sources you actually retrieved via tools in this session)SYS";
        std::string lmStudioUrl = "http://localhost:1234";

        bool llamacppFlashAttn = true;
        bool llamacppKvCacheReuse = true;
        int llamacppEvalBatchSize = 2048;
        int llamacppCtxSize = 0;
        int llamacppGpuLayers = 0;
        int llamacppThreads = 0;
        int llamacppThreadsBatch = 0;
        double llamacppTopP = 0.9;
        double llamacppMinP = 0.05;
        double llamacppRepeatPenalty = 1.15;
        int llamacppModelKeepAlive = 5;
        int llamacppMaxConcurrentInstances = 4;
        int llamacppMaxLoadedModels = 2;
        int llamacppIdleTimeoutSeconds = 300;
        std::string llamacppKvCacheType = "f16";
        std::string llamacppBackend = "auto";
        std::string llamacppTag = "b8846";
        bool llamacppConcurrentGeneration = true;

        bool backendSuggestionDismissed = false;

        int panelLoginRateLimitPerMinute = 5;
        int vaultLoginRateLimitPerMinute = 5;
        int vaultIdleTimeoutSeconds = 300;

        bool logprobHighlightHigh = false;
        bool logprobHighlightMedium = false;
        bool logprobHighlightLow = true;

        bool logprobHistoryHigh = false;
        bool logprobHistoryMedium = false;
        bool logprobHistoryLow = false;

        bool aiTitleEnabled = true;
        std::string aiTitleModel;
        std::string aiTitleSystemPrompt =
            "Describe the chat in 1-3 words. Output only the title text. No quotes. No explanation.";
    };

    State state_;
    std::string settingsPath_;
    mutable std::mutex mutex_;

    static void applyGeneralJson(State& state, const Json::Value& root) {
        if (root.isMember("port")) state.port = root["port"].asInt();
        if (root.isMember("host")) state.host = root["host"].asString();
        if (root.isMember("defaultModel")) state.defaultModel = root["defaultModel"].asString();
        if (root.isMember("temperature")) state.temperature = root["temperature"].asDouble();
        if (root.isMember("systemPrompt")) state.systemPrompt = root["systemPrompt"].asString();
        if (root.isMember("lmStudioUrl")) state.lmStudioUrl = root["lmStudioUrl"].asString();
        if (root.isMember("fallbackMaxOutputTokens")) {
            state.fallbackMaxOutputTokens = root["fallbackMaxOutputTokens"].asInt();
        } else if (root.isMember("maxTokens")) {
            state.fallbackMaxOutputTokens = root["maxTokens"].asInt();
        }
    }

    static void applyLlamaJson(State& state, const Json::Value& root, bool legacyConcurrentOnlyEnables) {
        if (root.isMember("llamacppFlashAttn")) state.llamacppFlashAttn = root["llamacppFlashAttn"].asBool();
        if (root.isMember("llamacppKvCacheReuse")) state.llamacppKvCacheReuse = root["llamacppKvCacheReuse"].asBool();
        if (root.isMember("llamacppEvalBatchSize")) state.llamacppEvalBatchSize = root["llamacppEvalBatchSize"].asInt();
        if (root.isMember("llamacppCtxSize")) state.llamacppCtxSize = root["llamacppCtxSize"].asInt();
        if (root.isMember("llamacppGpuLayers")) state.llamacppGpuLayers = root["llamacppGpuLayers"].asInt();
        if (root.isMember("llamacppThreads")) state.llamacppThreads = root["llamacppThreads"].asInt();
        if (root.isMember("llamacppThreadsBatch")) state.llamacppThreadsBatch = root["llamacppThreadsBatch"].asInt();
        if (root.isMember("llamacppTopP")) state.llamacppTopP = root["llamacppTopP"].asDouble();
        if (root.isMember("llamacppMinP")) state.llamacppMinP = root["llamacppMinP"].asDouble();
        if (root.isMember("llamacppRepeatPenalty")) state.llamacppRepeatPenalty = root["llamacppRepeatPenalty"].asDouble();
        if (root.isMember("llamacppModelKeepAlive")) state.llamacppModelKeepAlive = root["llamacppModelKeepAlive"].asInt();
        if (root.isMember("llamacppKvCacheType")) state.llamacppKvCacheType = root["llamacppKvCacheType"].asString();

        if (root.isMember("llamacppMaxConcurrentInstances")) {
            state.llamacppMaxConcurrentInstances =
                std::clamp(root["llamacppMaxConcurrentInstances"].asInt(), 1, 100);
        }

        if (root.isMember("llamacppMaxLoadedModels")) {
            state.llamacppMaxLoadedModels =
                std::clamp(root["llamacppMaxLoadedModels"].asInt(), 0, 100);
        }

        if (root.isMember("llamacppIdleTimeoutSeconds")) {
            state.llamacppIdleTimeoutSeconds =
                std::clamp(root["llamacppIdleTimeoutSeconds"].asInt(), 30, 86400);
        }

        if (root.isMember("llamacppBackend")) {
            const std::string backend = root["llamacppBackend"].asString();
            if (backend == "auto" || backend == "cpu" || backend == "cuda" ||
                backend == "rocm" || backend == "vulkan") {
                state.llamacppBackend = backend;
            }
        }

        if (root.isMember("llamacppTag") && !root["llamacppTag"].asString().empty()) {
            state.llamacppTag = root["llamacppTag"].asString();
        }

        if (root.isMember("llamacppConcurrentGeneration")) {
            state.llamacppConcurrentGeneration = root["llamacppConcurrentGeneration"].asBool();
        } else if (root.isMember("llamacppTitleModelConcurrent")) {
            const bool legacyValue = root["llamacppTitleModelConcurrent"].asBool();
            if (!legacyConcurrentOnlyEnables || legacyValue) {
                state.llamacppConcurrentGeneration = legacyValue;
            }
        }
    }

    static void applyUiJson(State& state, const Json::Value& root) {
        if (root.isMember("backendSuggestionDismissed")) {
            state.backendSuggestionDismissed = root["backendSuggestionDismissed"].asBool();
        }

        if (root.isMember("panelLoginRateLimitPerMinute")) {
            state.panelLoginRateLimitPerMinute =
                std::clamp(root["panelLoginRateLimitPerMinute"].asInt(), 1, 1000);
        }

        if (root.isMember("vaultLoginRateLimitPerMinute")) {
            state.vaultLoginRateLimitPerMinute =
                std::clamp(root["vaultLoginRateLimitPerMinute"].asInt(), 1, 1000);
        }

        if (root.isMember("vaultIdleTimeoutSeconds")) {
            state.vaultIdleTimeoutSeconds =
                std::clamp(root["vaultIdleTimeoutSeconds"].asInt(), 30, 86400);
        }

        if (root.isMember("logprobHighlightHigh")) state.logprobHighlightHigh = root["logprobHighlightHigh"].asBool();
        if (root.isMember("logprobHighlightMedium")) state.logprobHighlightMedium = root["logprobHighlightMedium"].asBool();
        if (root.isMember("logprobHighlightLow")) state.logprobHighlightLow = root["logprobHighlightLow"].asBool();

        if (root.isMember("logprobHistoryHigh")) state.logprobHistoryHigh = root["logprobHistoryHigh"].asBool();
        if (root.isMember("logprobHistoryMedium")) state.logprobHistoryMedium = root["logprobHistoryMedium"].asBool();
        if (root.isMember("logprobHistoryLow")) state.logprobHistoryLow = root["logprobHistoryLow"].asBool();

        if (root.isMember("aiTitleEnabled")) state.aiTitleEnabled = root["aiTitleEnabled"].asBool();
        if (root.isMember("aiTitleModel")) state.aiTitleModel = root["aiTitleModel"].asString();
        if (root.isMember("aiTitleSystemPrompt")) state.aiTitleSystemPrompt = root["aiTitleSystemPrompt"].asString();
    }

    Json::Value toJsonUnlocked() const {
        Json::Value root;
        root["host"] = state_.host;
        root["port"] = state_.port;
        root["defaultModel"] = state_.defaultModel;
        root["fallbackMaxOutputTokens"] = state_.fallbackMaxOutputTokens;
        root["temperature"] = state_.temperature;
        root["systemPrompt"] = state_.systemPrompt;
        root["lmStudioUrl"] = state_.lmStudioUrl;

        root["llamacppFlashAttn"] = state_.llamacppFlashAttn;
        root["llamacppKvCacheReuse"] = state_.llamacppKvCacheReuse;
        root["llamacppEvalBatchSize"] = state_.llamacppEvalBatchSize;
        root["llamacppCtxSize"] = state_.llamacppCtxSize;
        root["llamacppGpuLayers"] = state_.llamacppGpuLayers;
        root["llamacppThreads"] = state_.llamacppThreads;
        root["llamacppThreadsBatch"] = state_.llamacppThreadsBatch;
        root["llamacppTopP"] = state_.llamacppTopP;
        root["llamacppMinP"] = state_.llamacppMinP;
        root["llamacppRepeatPenalty"] = state_.llamacppRepeatPenalty;
        root["llamacppModelKeepAlive"] = state_.llamacppModelKeepAlive;
        root["llamacppKvCacheType"] = state_.llamacppKvCacheType;
        root["llamacppMaxConcurrentInstances"] = state_.llamacppMaxConcurrentInstances;
        root["llamacppMaxLoadedModels"] = state_.llamacppMaxLoadedModels;
        root["llamacppIdleTimeoutSeconds"] = state_.llamacppIdleTimeoutSeconds;
        root["llamacppBackend"] = state_.llamacppBackend;
        root["llamacppTag"] = state_.llamacppTag;
        root["llamacppConcurrentGeneration"] = state_.llamacppConcurrentGeneration;

        root["backendSuggestionDismissed"] = state_.backendSuggestionDismissed;
        root["panelLoginRateLimitPerMinute"] = state_.panelLoginRateLimitPerMinute;
        root["vaultLoginRateLimitPerMinute"] = state_.vaultLoginRateLimitPerMinute;
        root["vaultIdleTimeoutSeconds"] = state_.vaultIdleTimeoutSeconds;

        root["logprobHighlightHigh"] = state_.logprobHighlightHigh;
        root["logprobHighlightMedium"] = state_.logprobHighlightMedium;
        root["logprobHighlightLow"] = state_.logprobHighlightLow;

        root["logprobHistoryHigh"] = state_.logprobHistoryHigh;
        root["logprobHistoryMedium"] = state_.logprobHistoryMedium;
        root["logprobHistoryLow"] = state_.logprobHistoryLow;

        root["aiTitleEnabled"] = state_.aiTitleEnabled;
        root["aiTitleModel"] = state_.aiTitleModel;
        root["aiTitleSystemPrompt"] = state_.aiTitleSystemPrompt;
        return root;
    }

    void saveUnlocked() const {
        std::ofstream file(settingsPath_);
        if (!file.is_open()) {
            return;
        }

        Json::StreamWriterBuilder builder;
        builder["indentation"] = "    ";
        std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
        Json::Value root = toJsonUnlocked();
        writer->write(root, &file);
    }

public:
    explicit Config(const std::string& path) : settingsPath_(path) {}

    void load() {
        std::lock_guard<std::mutex> lock(mutex_);

        std::ifstream file(settingsPath_);
        if (!file.is_open()) {
            saveUnlocked();
            return;
        }

        Json::Value root;
        try {
            file >> root;
        } catch (...) {
            saveUnlocked();
            return;
        }

        applyGeneralJson(state_, root);
        applyLlamaJson(state_, root, true);
        applyUiJson(state_, root);
    }

    void save() {
        std::lock_guard<std::mutex> lock(mutex_);
        saveUnlocked();
    }

    void updateFromJson(const Json::Value& root) {
        std::lock_guard<std::mutex> lock(mutex_);
        applyGeneralJson(state_, root);
        applyLlamaJson(state_, root, false);
        applyUiJson(state_, root);
        saveUnlocked();
    }

    Json::Value toJson() {
        std::lock_guard<std::mutex> lock(mutex_);
        return toJsonUnlocked();
    }

    int getPort() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.port;
    }

    std::string getHost() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.host;
    }

    std::string getLmStudioUrl() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.lmStudioUrl;
    }

    bool getLlamacppFlashAttn() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppFlashAttn;
    }

    bool getLlamacppKvCacheReuse() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppKvCacheReuse;
    }

    int getLlamacppEvalBatchSize() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppEvalBatchSize;
    }

    int getLlamacppCtxSize() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppCtxSize;
    }

    int getLlamacppGpuLayers() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppGpuLayers;
    }

    int getLlamacppThreads() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppThreads;
    }

    int getLlamacppThreadsBatch() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppThreadsBatch;
    }

    double getLlamacppTopP() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppTopP;
    }

    double getLlamacppMinP() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppMinP;
    }

    double getLlamacppRepeatPenalty() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppRepeatPenalty;
    }

    int getLlamacppModelKeepAlive() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppModelKeepAlive;
    }

    int getLlamacppMaxConcurrentInstances() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppMaxConcurrentInstances;
    }

    int getLlamacppIdleTimeoutSeconds() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppIdleTimeoutSeconds;
    }

    int getLlamacppMaxLoadedModels() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppMaxLoadedModels;
    }

    std::string getLlamacppKvCacheType() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppKvCacheType;
    }

    std::string getLlamacppBackend() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppBackend;
    }

    std::string getLlamacppTag() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppTag;
    }

    bool getBackendSuggestionDismissed() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.backendSuggestionDismissed;
    }

    int getPanelLoginRateLimitPerMinute() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.panelLoginRateLimitPerMinute;
    }

    int getVaultLoginRateLimitPerMinute() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.vaultLoginRateLimitPerMinute;
    }

    int getVaultIdleTimeoutSeconds() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.vaultIdleTimeoutSeconds;
    }

    bool getLogprobHighlightHigh() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHighlightHigh;
    }

    bool getLogprobHighlightMedium() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHighlightMedium;
    }

    bool getLogprobHighlightLow() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHighlightLow;
    }

    bool getLogprobHistoryHigh() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHistoryHigh;
    }

    bool getLogprobHistoryMedium() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHistoryMedium;
    }

    bool getLogprobHistoryLow() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.logprobHistoryLow;
    }

    bool getAiTitleEnabled() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.aiTitleEnabled;
    }

    std::string getAiTitleModel() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.aiTitleModel;
    }

    std::string getAiTitleSystemPrompt() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.aiTitleSystemPrompt;
    }

    bool getLlamacppConcurrentGeneration() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppConcurrentGeneration;
    }

    int getLlamacppEffectiveMaxConcurrentInstances() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_.llamacppConcurrentGeneration ? state_.llamacppMaxConcurrentInstances : 1;
    }

    std::string getMcpConfigPath() const {
        constexpr const char* suffix = "settings.json";
        if (settingsPath_.size() >= std::char_traits<char>::length(suffix) &&
            settingsPath_.substr(settingsPath_.size() - std::char_traits<char>::length(suffix)) == suffix) {
            return settingsPath_.substr(0, settingsPath_.size() - std::char_traits<char>::length(suffix)) + "mcp.json";
        }

        const auto separator = settingsPath_.find_last_of("/\\");
        if (separator != std::string::npos) {
            return settingsPath_.substr(0, separator + 1) + "mcp.json";
        }

        return "mcp.json";
    }
};

#endif // CONFIG_H
