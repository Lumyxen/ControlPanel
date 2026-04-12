#ifndef CONFIG_H
#define CONFIG_H

#include <string>
#include <fstream>
#include <json/json.h>
#include <mutex>

class Config {
private:
    int         port;
    std::string host;
    std::string defaultModel;
    int         fallbackMaxOutputTokens;
    double      temperature;
    std::string systemPrompt;
    std::string lmStudioUrl;

    // ── llama.cpp settings ────────────────────────────────────────────────────
    bool        llamacppFlashAttn;
    bool        llamacppKvCacheReuse;
    int         llamacppEvalBatchSize;
    int         llamacppCtxSize;
    int         llamacppGpuLayers;
    int         llamacppThreads;
    int         llamacppThreadsBatch;
    double      llamacppTopP;
    double      llamacppMinP;
    double      llamacppRepeatPenalty;
    int         llamacppModelKeepAlive; // -1 = infinite, 0 = immediate, >0 = minutes
    
    // KV Cache Type
    std::string llamacppKvCacheType; // "f16", "q8_0", "q4_0"

    // ── Backend preference ────────────────────────────────────────────────────
    std::string llamacppBackend;

    // llama.cpp git tag used when building backend .so files via BackendBuilder.
    std::string llamacppTag;

    // ── UI dismiss state ──────────────────────────────────────────────────────
    bool        backendSuggestionDismissed;

    // ── Logprob highlighting ──────────────────────────────────────────────────
    bool        logprobHighlightHigh;     // Highlight high confidence tokens
    bool        logprobHighlightMedium;   // Highlight medium confidence tokens
    bool        logprobHighlightLow;      // Highlight low confidence tokens

    // ── Logprob inclusion in chat history ─────────────────────────────────────
    bool        logprobHistoryHigh;   // Include high confidence tokens in history
    bool        logprobHistoryMedium; // Include medium confidence tokens in history
    bool        logprobHistoryLow;    // Include low confidence tokens in history

    // ── AI Title Generation ───────────────────────────────────────────────────
    bool        aiTitleEnabled;       // Enable AI-generated chat titles
    std::string aiTitleModel;         // Model to use for title generation (empty = use chat model)
    std::string aiTitleSystemPrompt;  // Custom system prompt for title generation
    bool        llamacppTitleModelConcurrent; // Load title model alongside chat model (vs unload/swap/reload)

    std::string settingsPath;
    std::mutex  mutex;

public:
    Config(const std::string& path)
        : port(8080), host("0.0.0.0"),
          defaultModel(""),
          fallbackMaxOutputTokens(8192), temperature(0.7),
          systemPrompt(R"SYS(You are {model}, a reasoning engine with access to powerful tools. 

Core principles:
- Rely on tools for factual queries, calculations, and data retrieval - never guess or hallucinate
- Say "I don't know" or be honest when uncertain or when tools don't provide a clear answer
- Be direct and concise; prioritize information density over verbosity
- Use latest standards and best practices for technical work
- Format math with LaTeX ($inline$ or $$block$$)
- Only cite sources you actually retrieved via tools in this session)SYS"),
          lmStudioUrl("http://localhost:1234"),
          llamacppFlashAttn(true),
          llamacppKvCacheReuse(true),
          llamacppEvalBatchSize(2048),
          llamacppCtxSize(0),
          llamacppGpuLayers(0),
          llamacppThreads(0),
          llamacppThreadsBatch(0),
          llamacppTopP(0.9),
          llamacppMinP(0.05),
          llamacppRepeatPenalty(1.15),
          llamacppModelKeepAlive(5),
          llamacppKvCacheType("f16"),
          llamacppBackend("auto"),
          llamacppTag("b8749"),
          backendSuggestionDismissed(false),
          logprobHighlightHigh(false),
          logprobHighlightMedium(false),
          logprobHighlightLow(true),
          logprobHistoryHigh(false),
          logprobHistoryMedium(false),
          logprobHistoryLow(false),
          aiTitleEnabled(true),
          aiTitleModel(""),
          aiTitleSystemPrompt("Describe the chat in 1-3 words. No quotes, or explanation. Reason as minimally as possible"),
          llamacppTitleModelConcurrent(false),
          settingsPath(path) {}

    void load() {
        std::lock_guard<std::mutex> lock(mutex);
        std::ifstream file(settingsPath);
        if (!file.is_open()) { saveUnlocked(); return; }
        Json::Value cfg;
        try { file >> cfg; } catch (...) { saveUnlocked(); return; }

        if (cfg.isMember("port"))         port         = cfg["port"].asInt();
        if (cfg.isMember("host"))         host         = cfg["host"].asString();
        if (cfg.isMember("defaultModel")) defaultModel = cfg["defaultModel"].asString();
        if (cfg.isMember("temperature"))  temperature  = cfg["temperature"].asDouble();
        if (cfg.isMember("systemPrompt")) systemPrompt = cfg["systemPrompt"].asString();
        if (cfg.isMember("lmStudioUrl"))  lmStudioUrl  = cfg["lmStudioUrl"].asString();
        if (cfg.isMember("fallbackMaxOutputTokens")) fallbackMaxOutputTokens = cfg["fallbackMaxOutputTokens"].asInt();
        else if (cfg.isMember("maxTokens")) fallbackMaxOutputTokens = cfg["maxTokens"].asInt();

        if (cfg.isMember("llamacppFlashAttn"))     llamacppFlashAttn     = cfg["llamacppFlashAttn"].asBool();
        if (cfg.isMember("llamacppKvCacheReuse"))  llamacppKvCacheReuse  = cfg["llamacppKvCacheReuse"].asBool();
        if (cfg.isMember("llamacppEvalBatchSize")) llamacppEvalBatchSize = cfg["llamacppEvalBatchSize"].asInt();
        if (cfg.isMember("llamacppCtxSize"))       llamacppCtxSize       = cfg["llamacppCtxSize"].asInt();
        if (cfg.isMember("llamacppGpuLayers"))     llamacppGpuLayers     = cfg["llamacppGpuLayers"].asInt();
        if (cfg.isMember("llamacppThreads"))       llamacppThreads       = cfg["llamacppThreads"].asInt();
        if (cfg.isMember("llamacppThreadsBatch"))  llamacppThreadsBatch  = cfg["llamacppThreadsBatch"].asInt();
        if (cfg.isMember("llamacppTopP"))          llamacppTopP          = cfg["llamacppTopP"].asDouble();
        if (cfg.isMember("llamacppMinP"))          llamacppMinP          = cfg["llamacppMinP"].asDouble();
        if (cfg.isMember("llamacppRepeatPenalty")) llamacppRepeatPenalty = cfg["llamacppRepeatPenalty"].asDouble();
        if (cfg.isMember("llamacppModelKeepAlive"))llamacppModelKeepAlive= cfg["llamacppModelKeepAlive"].asInt();
        if (cfg.isMember("llamacppKvCacheType"))   llamacppKvCacheType   = cfg["llamacppKvCacheType"].asString();

        if (cfg.isMember("llamacppBackend")) {
            const std::string b = cfg["llamacppBackend"].asString();
            if (b == "auto" || b == "cpu" || b == "cuda" || b == "rocm" || b == "vulkan")
                llamacppBackend = b;
        }
        if (cfg.isMember("llamacppTag") && !cfg["llamacppTag"].asString().empty())
            llamacppTag = cfg["llamacppTag"].asString();
        if (cfg.isMember("backendSuggestionDismissed"))
            backendSuggestionDismissed = cfg["backendSuggestionDismissed"].asBool();
        if (cfg.isMember("logprobHighlightHigh"))
            logprobHighlightHigh = cfg["logprobHighlightHigh"].asBool();
        if (cfg.isMember("logprobHighlightMedium"))
            logprobHighlightMedium = cfg["logprobHighlightMedium"].asBool();
        if (cfg.isMember("logprobHighlightLow"))
            logprobHighlightLow = cfg["logprobHighlightLow"].asBool();
        if (cfg.isMember("logprobHistoryHigh"))
            logprobHistoryHigh = cfg["logprobHistoryHigh"].asBool();
        if (cfg.isMember("logprobHistoryMedium"))
            logprobHistoryMedium = cfg["logprobHistoryMedium"].asBool();
        if (cfg.isMember("logprobHistoryLow"))
            logprobHistoryLow = cfg["logprobHistoryLow"].asBool();
        if (cfg.isMember("aiTitleEnabled"))
            aiTitleEnabled = cfg["aiTitleEnabled"].asBool();
        if (cfg.isMember("aiTitleModel"))
            aiTitleModel = cfg["aiTitleModel"].asString();
        if (cfg.isMember("aiTitleSystemPrompt"))
            aiTitleSystemPrompt = cfg["aiTitleSystemPrompt"].asString();
        if (cfg.isMember("llamacppTitleModelConcurrent"))
            llamacppTitleModelConcurrent = cfg["llamacppTitleModelConcurrent"].asBool();
    }

    void save() { std::lock_guard<std::mutex> lock(mutex); saveUnlocked(); }

    void updateFromJson(const Json::Value& root) {
        std::lock_guard<std::mutex> lock(mutex);

        if (root.isMember("port"))         port         = root["port"].asInt();
        if (root.isMember("host"))         host         = root["host"].asString();
        if (root.isMember("defaultModel")) defaultModel = root["defaultModel"].asString();
        if (root.isMember("temperature"))  temperature  = root["temperature"].asDouble();
        if (root.isMember("systemPrompt")) systemPrompt = root["systemPrompt"].asString();
        if (root.isMember("lmStudioUrl"))  lmStudioUrl  = root["lmStudioUrl"].asString();
        if (root.isMember("fallbackMaxOutputTokens")) fallbackMaxOutputTokens = root["fallbackMaxOutputTokens"].asInt();
        else if (root.isMember("maxTokens")) fallbackMaxOutputTokens = root["maxTokens"].asInt();

        if (root.isMember("llamacppFlashAttn"))     llamacppFlashAttn     = root["llamacppFlashAttn"].asBool();
        if (root.isMember("llamacppKvCacheReuse"))  llamacppKvCacheReuse  = root["llamacppKvCacheReuse"].asBool();
        if (root.isMember("llamacppEvalBatchSize")) llamacppEvalBatchSize = root["llamacppEvalBatchSize"].asInt();
        if (root.isMember("llamacppCtxSize"))       llamacppCtxSize       = root["llamacppCtxSize"].asInt();
        if (root.isMember("llamacppGpuLayers"))     llamacppGpuLayers     = root["llamacppGpuLayers"].asInt();
        if (root.isMember("llamacppThreads"))       llamacppThreads       = root["llamacppThreads"].asInt();
        if (root.isMember("llamacppThreadsBatch"))  llamacppThreadsBatch  = root["llamacppThreadsBatch"].asInt();
        if (root.isMember("llamacppTopP"))          llamacppTopP          = root["llamacppTopP"].asDouble();
        if (root.isMember("llamacppMinP"))          llamacppMinP          = root["llamacppMinP"].asDouble();
        if (root.isMember("llamacppRepeatPenalty")) llamacppRepeatPenalty = root["llamacppRepeatPenalty"].asDouble();
        if (root.isMember("llamacppModelKeepAlive"))llamacppModelKeepAlive= root["llamacppModelKeepAlive"].asInt();
        if (root.isMember("llamacppKvCacheType"))   llamacppKvCacheType   = root["llamacppKvCacheType"].asString();

        if (root.isMember("llamacppBackend")) {
            const std::string b = root["llamacppBackend"].asString();
            if (b == "auto" || b == "cpu" || b == "cuda" || b == "rocm" || b == "vulkan")
                llamacppBackend = b;
        }
        if (root.isMember("llamacppTag") && !root["llamacppTag"].asString().empty())
            llamacppTag = root["llamacppTag"].asString();
        if (root.isMember("backendSuggestionDismissed"))
            backendSuggestionDismissed = root["backendSuggestionDismissed"].asBool();
        if (root.isMember("logprobHighlightHigh"))
            logprobHighlightHigh = root["logprobHighlightHigh"].asBool();
        if (root.isMember("logprobHighlightMedium"))
            logprobHighlightMedium = root["logprobHighlightMedium"].asBool();
        if (root.isMember("logprobHighlightLow"))
            logprobHighlightLow = root["logprobHighlightLow"].asBool();
        if (root.isMember("logprobHistoryHigh"))
            logprobHistoryHigh = root["logprobHistoryHigh"].asBool();
        if (root.isMember("logprobHistoryMedium"))
            logprobHistoryMedium = root["logprobHistoryMedium"].asBool();
        if (root.isMember("logprobHistoryLow"))
            logprobHistoryLow = root["logprobHistoryLow"].asBool();
        if (root.isMember("aiTitleEnabled"))
            aiTitleEnabled = root["aiTitleEnabled"].asBool();
        if (root.isMember("aiTitleModel"))
            aiTitleModel = root["aiTitleModel"].asString();
        if (root.isMember("aiTitleSystemPrompt"))
            aiTitleSystemPrompt = root["aiTitleSystemPrompt"].asString();
        if (root.isMember("llamacppTitleModelConcurrent"))
            llamacppTitleModelConcurrent = root["llamacppTitleModelConcurrent"].asBool();

        saveUnlocked();
    }

    Json::Value toJson() {
        std::lock_guard<std::mutex> lock(mutex);
        Json::Value root;
        root["host"]                       = host;
        root["port"]                       = port;
        root["defaultModel"]               = defaultModel;
        root["fallbackMaxOutputTokens"]    = fallbackMaxOutputTokens;
        root["temperature"]                = temperature;
        root["systemPrompt"]               = systemPrompt;
        root["lmStudioUrl"]                = lmStudioUrl;
        root["llamacppFlashAttn"]          = llamacppFlashAttn;
        root["llamacppKvCacheReuse"]       = llamacppKvCacheReuse;
        root["llamacppEvalBatchSize"]      = llamacppEvalBatchSize;
        root["llamacppCtxSize"]            = llamacppCtxSize;
        root["llamacppGpuLayers"]          = llamacppGpuLayers;
        root["llamacppThreads"]            = llamacppThreads;
        root["llamacppThreadsBatch"]       = llamacppThreadsBatch;
        root["llamacppTopP"]               = llamacppTopP;
        root["llamacppMinP"]               = llamacppMinP;
        root["llamacppRepeatPenalty"]      = llamacppRepeatPenalty;
        root["llamacppModelKeepAlive"]     = llamacppModelKeepAlive;
        root["llamacppKvCacheType"]        = llamacppKvCacheType;
        root["llamacppBackend"]            = llamacppBackend;
        root["llamacppTag"]                = llamacppTag;
        root["backendSuggestionDismissed"] = backendSuggestionDismissed;
        root["logprobHighlightHigh"]         = logprobHighlightHigh;
        root["logprobHighlightMedium"]       = logprobHighlightMedium;
        root["logprobHighlightLow"]          = logprobHighlightLow;
        root["logprobHistoryHigh"]           = logprobHistoryHigh;
        root["logprobHistoryMedium"]         = logprobHistoryMedium;
        root["logprobHistoryLow"]            = logprobHistoryLow;
        root["aiTitleEnabled"]               = aiTitleEnabled;
        root["aiTitleModel"]                 = aiTitleModel;
        root["aiTitleSystemPrompt"]          = aiTitleSystemPrompt;
        root["llamacppTitleModelConcurrent"]  = llamacppTitleModelConcurrent;
        return root;
    }

    // Getters
    int         getPort()       { std::lock_guard<std::mutex> l(mutex); return port; }
    std::string getHost()       { std::lock_guard<std::mutex> l(mutex); return host; }
    std::string getLmStudioUrl(){ std::lock_guard<std::mutex> l(mutex); return lmStudioUrl; }
    bool   getLlamacppFlashAttn()     { std::lock_guard<std::mutex> l(mutex); return llamacppFlashAttn; }
    bool   getLlamacppKvCacheReuse()  { std::lock_guard<std::mutex> l(mutex); return llamacppKvCacheReuse; }
    int    getLlamacppEvalBatchSize() { std::lock_guard<std::mutex> l(mutex); return llamacppEvalBatchSize; }
    int    getLlamacppCtxSize()       { std::lock_guard<std::mutex> l(mutex); return llamacppCtxSize; }
    int    getLlamacppGpuLayers()     { std::lock_guard<std::mutex> l(mutex); return llamacppGpuLayers; }
    int    getLlamacppThreads()       { std::lock_guard<std::mutex> l(mutex); return llamacppThreads; }
    int    getLlamacppThreadsBatch()  { std::lock_guard<std::mutex> l(mutex); return llamacppThreadsBatch; }
    double getLlamacppTopP()          { std::lock_guard<std::mutex> l(mutex); return llamacppTopP; }
    double getLlamacppMinP()          { std::lock_guard<std::mutex> l(mutex); return llamacppMinP; }
    double getLlamacppRepeatPenalty() { std::lock_guard<std::mutex> l(mutex); return llamacppRepeatPenalty; }
    int    getLlamacppModelKeepAlive(){ std::lock_guard<std::mutex> l(mutex); return llamacppModelKeepAlive; }
    std::string getLlamacppKvCacheType()  { std::lock_guard<std::mutex> l(mutex); return llamacppKvCacheType; }
    std::string getLlamacppBackend()  { std::lock_guard<std::mutex> l(mutex); return llamacppBackend; }
    std::string getLlamacppTag()      { std::lock_guard<std::mutex> l(mutex); return llamacppTag; }
    bool   getBackendSuggestionDismissed() { std::lock_guard<std::mutex> l(mutex); return backendSuggestionDismissed; }
    bool   getLogprobHighlightHigh()       { std::lock_guard<std::mutex> l(mutex); return logprobHighlightHigh; }
    bool   getLogprobHighlightMedium()     { std::lock_guard<std::mutex> l(mutex); return logprobHighlightMedium; }
    bool   getLogprobHighlightLow()        { std::lock_guard<std::mutex> l(mutex); return logprobHighlightLow; }
    bool   getLogprobHistoryHigh()         { std::lock_guard<std::mutex> l(mutex); return logprobHistoryHigh; }
    bool   getLogprobHistoryMedium()       { std::lock_guard<std::mutex> l(mutex); return logprobHistoryMedium; }
    bool   getLogprobHistoryLow()          { std::lock_guard<std::mutex> l(mutex); return logprobHistoryLow; }
    bool   getAiTitleEnabled()             { std::lock_guard<std::mutex> l(mutex); return aiTitleEnabled; }
    std::string getAiTitleModel()          { std::lock_guard<std::mutex> l(mutex); return aiTitleModel; }
    std::string getAiTitleSystemPrompt()   { std::lock_guard<std::mutex> l(mutex); return aiTitleSystemPrompt; }
    bool   getLlamacppTitleModelConcurrent(){ std::lock_guard<std::mutex> l(mutex); return llamacppTitleModelConcurrent; }

    std::string getMcpConfigPath() const {
        const std::string suffix = "settings.json";
        if (settingsPath.size() >= suffix.size() &&
                settingsPath.substr(settingsPath.size() - suffix.size()) == suffix)
            return settingsPath.substr(0, settingsPath.size() - suffix.size()) + "mcp.json";
        auto sep = settingsPath.find_last_of("/\\");
        if (sep != std::string::npos) return settingsPath.substr(0, sep + 1) + "mcp.json";
        return "mcp.json";
    }

private:
    void saveUnlocked() {
        Json::Value root;
        root["host"]                       = host;
        root["port"]                       = port;
        root["defaultModel"]               = defaultModel;
        root["fallbackMaxOutputTokens"]    = fallbackMaxOutputTokens;
        root["temperature"]                = temperature;
        root["systemPrompt"]               = systemPrompt;
        root["lmStudioUrl"]                = lmStudioUrl;
        root["llamacppFlashAttn"]          = llamacppFlashAttn;
        root["llamacppKvCacheReuse"]       = llamacppKvCacheReuse;
        root["llamacppEvalBatchSize"]      = llamacppEvalBatchSize;
        root["llamacppCtxSize"]            = llamacppCtxSize;
        root["llamacppGpuLayers"]          = llamacppGpuLayers;
        root["llamacppThreads"]            = llamacppThreads;
        root["llamacppThreadsBatch"]       = llamacppThreadsBatch;
        root["llamacppTopP"]               = llamacppTopP;
        root["llamacppMinP"]               = llamacppMinP;
        root["llamacppRepeatPenalty"]      = llamacppRepeatPenalty;
        root["llamacppModelKeepAlive"]     = llamacppModelKeepAlive;
        root["llamacppKvCacheType"]        = llamacppKvCacheType;
        root["llamacppBackend"]            = llamacppBackend;
        root["llamacppTag"]                = llamacppTag;
        root["backendSuggestionDismissed"] = backendSuggestionDismissed;
        root["logprobHighlightHigh"]         = logprobHighlightHigh;
        root["logprobHighlightMedium"]       = logprobHighlightMedium;
        root["logprobHighlightLow"]          = logprobHighlightLow;
        root["logprobHistoryHigh"]           = logprobHistoryHigh;
        root["logprobHistoryMedium"]         = logprobHistoryMedium;
        root["logprobHistoryLow"]            = logprobHistoryLow;
        root["aiTitleEnabled"]               = aiTitleEnabled;
        root["aiTitleModel"]                 = aiTitleModel;
        root["aiTitleSystemPrompt"]          = aiTitleSystemPrompt;
        root["llamacppTitleModelConcurrent"]  = llamacppTitleModelConcurrent;
        std::ofstream file(settingsPath);
        if (file.is_open()) {
            Json::StreamWriterBuilder builder;
            builder["indentation"] = "    ";
            std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
            writer->write(root, &file);
        }
    }
};

#endif // CONFIG_H
