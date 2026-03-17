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
    int         llamacppEvalBatchSize;
    int         llamacppCtxSize;
    int         llamacppGpuLayers;
    int         llamacppThreads;
    int         llamacppThreadsBatch;
    double      llamacppTopP;
    double      llamacppMinP;
    double      llamacppRepeatPenalty;

    // ── Backend preference ────────────────────────────────────────────────────
    std::string llamacppBackend;

    // llama.cpp git tag used when building backend .so files via BackendBuilder.
    std::string llamacppTag;

    // ── UI dismiss state ──────────────────────────────────────────────────────
    bool        backendSuggestionDismissed;

    std::string settingsPath;
    std::mutex  mutex;

public:
    Config(const std::string& path)
        : port(8080), host("0.0.0.0"),
          defaultModel(""),
          fallbackMaxOutputTokens(8192), temperature(0.7),
          systemPrompt(R"SYS(You are {model}.

### I. IDENTITY & THE EXTENDED MIND
You are a reasoning engine integrated into a massive, unrestricted tool-augmented harness. Your internal training weights are for logic and synthesis; your tools are for data and truth.
- **Tool Supremacy:** Treat the provided tools as your "Extended Mind." For any factual, mathematical, or technical task, you MUST rely on the harness: 
{tools}
- **Epistemic Humility:** If your tools do not return a conclusive answer, state "I don't know." You are severely risk-averse; never guess.
- **Self-Awareness:** You are {model}. Understand your architecture's strengths and context limits. If a task exceeds them, admit it bluntly and use tools to bridge the gap.

### II. COMMUNICATION: BLUNT & DIRECT
- **Conversational Tone:** Avoid forced personas. Do not try to be "cool" with slang/emojis, and do not be "robotic" with mission-talk. Speak like a direct, high-functioning professional. If the user says "Hi," respond with a simple "Hello" or "Hey, what's on your mind?"
- **Anti-Sycophancy:** You are not a "yes-man." If the user's premise is flawed, dismantle it objectively. Do not use "AI assistant" fluff (e.g., "I'm happy to help," "As an AI...").
- **Minimal Entropy:** No "over-yapping." Prioritize a high information-to-token ratio. If a one-sentence answer is the most accurate, use it. Do not provide unrequested summaries.
- **No Meta-Talk:** Do not mention your sandbox, your harness, or your status. No "Status" headers or "Execution" boxes.

### III. ENGINEERING STANDARDS: BLEEDING EDGE
- **Temporal Priority:** Default to the absolute latest stable standards (e.g., C++23 over C++20, Python 3.12+). Assume the user has the latest runtimes.
- **Security-First Logic:** Prioritize memory safety and zero-trust patterns. Critique legacy/insecure methods bluntly before providing the modern alternative.

### IV. FORMATTING: MARKDOWN & LATEX (MATHJAX)
Utilize the interface's full rendering suite:
- **LaTeX:** You MUST use LaTeX for ALL mathematical or logical notation.
    - **PROHIBITION:** Never wrap LaTeX in backticks (`) or code blocks (```).
    - **Inline:** Use single dollar signs ($E=mc^2$).
    - **Block:** Use double dollar signs ($$ ... $$) on separate lines.
- **Obsidian Callouts:** Use ONLY for categorizing technical data/warnings.
    - `> [!check]` Verified Tool Output.
    - `> [!warning]` Deprecated/Legacy Method.
    - `> [!danger]` Logic Error or Security Risk.
- **Discord Syntax:** Use `||spoilers||` for secondary technical details.

### V. EXECUTION PROTOCOL
1. **Context Check:** Technical project or casual conversation?
2. **Retrieve:** For technical tasks, use {tools} immediately. 
3. **Analyze:** Evaluate the user's input for bias or errors. Dismantle flaws bluntly.
4. **Deliver:** Present results using rich Markdown and LaTeX. 
5. **Admit:** If the answer is unavailable, state "I don't know" without apology.)SYS"),
          lmStudioUrl("http://localhost:1234"),
          llamacppFlashAttn(true),
          llamacppEvalBatchSize(2048),
          llamacppCtxSize(0),
          llamacppGpuLayers(0),
          llamacppThreads(0),
          llamacppThreadsBatch(0),
          llamacppTopP(0.9),
          llamacppMinP(0.05),
          llamacppRepeatPenalty(1.15),
          llamacppBackend("auto"),
          llamacppTag("b8391"),
          backendSuggestionDismissed(false),
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
        if (cfg.isMember("llamacppEvalBatchSize")) llamacppEvalBatchSize = cfg["llamacppEvalBatchSize"].asInt();
        if (cfg.isMember("llamacppCtxSize"))       llamacppCtxSize       = cfg["llamacppCtxSize"].asInt();
        if (cfg.isMember("llamacppGpuLayers"))     llamacppGpuLayers     = cfg["llamacppGpuLayers"].asInt();
        if (cfg.isMember("llamacppThreads"))       llamacppThreads       = cfg["llamacppThreads"].asInt();
        if (cfg.isMember("llamacppThreadsBatch"))  llamacppThreadsBatch  = cfg["llamacppThreadsBatch"].asInt();
        if (cfg.isMember("llamacppTopP"))          llamacppTopP          = cfg["llamacppTopP"].asDouble();
        if (cfg.isMember("llamacppMinP"))          llamacppMinP          = cfg["llamacppMinP"].asDouble();
        if (cfg.isMember("llamacppRepeatPenalty")) llamacppRepeatPenalty = cfg["llamacppRepeatPenalty"].asDouble();

        if (cfg.isMember("llamacppBackend")) {
            const std::string b = cfg["llamacppBackend"].asString();
            if (b == "auto" || b == "cpu" || b == "cuda" || b == "rocm" || b == "vulkan")
                llamacppBackend = b;
        }
        if (cfg.isMember("llamacppTag") && !cfg["llamacppTag"].asString().empty())
            llamacppTag = cfg["llamacppTag"].asString();
        if (cfg.isMember("backendSuggestionDismissed"))
            backendSuggestionDismissed = cfg["backendSuggestionDismissed"].asBool();
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
        if (root.isMember("llamacppEvalBatchSize")) llamacppEvalBatchSize = root["llamacppEvalBatchSize"].asInt();
        if (root.isMember("llamacppCtxSize"))       llamacppCtxSize       = root["llamacppCtxSize"].asInt();
        if (root.isMember("llamacppGpuLayers"))     llamacppGpuLayers     = root["llamacppGpuLayers"].asInt();
        if (root.isMember("llamacppThreads"))       llamacppThreads       = root["llamacppThreads"].asInt();
        if (root.isMember("llamacppThreadsBatch"))  llamacppThreadsBatch  = root["llamacppThreadsBatch"].asInt();
        if (root.isMember("llamacppTopP"))          llamacppTopP          = root["llamacppTopP"].asDouble();
        if (root.isMember("llamacppMinP"))          llamacppMinP          = root["llamacppMinP"].asDouble();
        if (root.isMember("llamacppRepeatPenalty")) llamacppRepeatPenalty = root["llamacppRepeatPenalty"].asDouble();

        if (root.isMember("llamacppBackend")) {
            const std::string b = root["llamacppBackend"].asString();
            if (b == "auto" || b == "cpu" || b == "cuda" || b == "rocm" || b == "vulkan")
                llamacppBackend = b;
        }
        if (root.isMember("llamacppTag") && !root["llamacppTag"].asString().empty())
            llamacppTag = root["llamacppTag"].asString();
        if (root.isMember("backendSuggestionDismissed"))
            backendSuggestionDismissed = root["backendSuggestionDismissed"].asBool();

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
        root["llamacppEvalBatchSize"]      = llamacppEvalBatchSize;
        root["llamacppCtxSize"]            = llamacppCtxSize;
        root["llamacppGpuLayers"]          = llamacppGpuLayers;
        root["llamacppThreads"]            = llamacppThreads;
        root["llamacppThreadsBatch"]       = llamacppThreadsBatch;
        root["llamacppTopP"]               = llamacppTopP;
        root["llamacppMinP"]               = llamacppMinP;
        root["llamacppRepeatPenalty"]      = llamacppRepeatPenalty;
        root["llamacppBackend"]            = llamacppBackend;
        root["llamacppTag"]                = llamacppTag;
        root["backendSuggestionDismissed"] = backendSuggestionDismissed;
        return root;
    }

    // Getters
    int         getPort()       { std::lock_guard<std::mutex> l(mutex); return port; }
    std::string getHost()       { std::lock_guard<std::mutex> l(mutex); return host; }
    std::string getLmStudioUrl(){ std::lock_guard<std::mutex> l(mutex); return lmStudioUrl; }
    bool   getLlamacppFlashAttn()     { std::lock_guard<std::mutex> l(mutex); return llamacppFlashAttn; }
    int    getLlamacppEvalBatchSize() { std::lock_guard<std::mutex> l(mutex); return llamacppEvalBatchSize; }
    int    getLlamacppCtxSize()       { std::lock_guard<std::mutex> l(mutex); return llamacppCtxSize; }
    int    getLlamacppGpuLayers()     { std::lock_guard<std::mutex> l(mutex); return llamacppGpuLayers; }
    int    getLlamacppThreads()       { std::lock_guard<std::mutex> l(mutex); return llamacppThreads; }
    int    getLlamacppThreadsBatch()  { std::lock_guard<std::mutex> l(mutex); return llamacppThreadsBatch; }
    double getLlamacppTopP()          { std::lock_guard<std::mutex> l(mutex); return llamacppTopP; }
    double getLlamacppMinP()          { std::lock_guard<std::mutex> l(mutex); return llamacppMinP; }
    double getLlamacppRepeatPenalty() { std::lock_guard<std::mutex> l(mutex); return llamacppRepeatPenalty; }
    std::string getLlamacppBackend()  { std::lock_guard<std::mutex> l(mutex); return llamacppBackend; }
    std::string getLlamacppTag()      { std::lock_guard<std::mutex> l(mutex); return llamacppTag; }
    bool   getBackendSuggestionDismissed() { std::lock_guard<std::mutex> l(mutex); return backendSuggestionDismissed; }

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
        root["llamacppEvalBatchSize"]      = llamacppEvalBatchSize;
        root["llamacppCtxSize"]            = llamacppCtxSize;
        root["llamacppGpuLayers"]          = llamacppGpuLayers;
        root["llamacppThreads"]            = llamacppThreads;
        root["llamacppThreadsBatch"]       = llamacppThreadsBatch;
        root["llamacppTopP"]               = llamacppTopP;
        root["llamacppMinP"]               = llamacppMinP;
        root["llamacppRepeatPenalty"]      = llamacppRepeatPenalty;
        root["llamacppBackend"]            = llamacppBackend;
        root["llamacppTag"]                = llamacppTag;
        root["backendSuggestionDismissed"] = backendSuggestionDismissed;
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