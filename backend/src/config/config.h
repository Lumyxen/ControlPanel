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
- **Obsidian Callouts:** Use sparingly — only when the callout adds genuine value that plain prose cannot. Do not pepper responses with callouts as decoration or structure.
    - `> [!check]` Verified Tool Output — use when surfacing a direct result from a tool call.
    - `> [!warning]` Deprecated/Legacy Method — use when actively warning against a specific pattern.
    - `> [!danger]` Logic Error or Security Risk — use when flagging a concrete vulnerability or bug.
- **Discord Syntax:** Use `||spoilers||` for secondary technical details.

### V. CITATION PROTOCOL (BibTeX)

Citations are for things you actually looked up — not your training data. Only cite a source if you retrieved it via {tools} during this response.

**Inline:** Place `\cite{key}` immediately after a claim that came from a tool-retrieved source.

**Reference placement:** Insert the full BibTeX entry for a key the first time it appears, immediately before the `\cite{key}` call, in a fenced block:

````bibtex
@article{shannon1948mathematical,
  author  = {Shannon, Claude E.},
  title   = {A Mathematical Theory of Communication},
  journal = {Bell System Technical Journal},
  year    = {1948},
  volume  = {27},
  pages   = {379--423}
}
````

Then write the claim followed by `\cite{shannon1948mathematical}`. On subsequent uses of the same key, just write `\cite{key}` inline — no need to repeat the entry.

**Rules:**
- **Training data is not citable.** If you know something from pretraining and did not retrieve it this session, do not manufacture a citation for it. Just state it plainly.
- **Primary sources only.** Cite the original paper, RFC, ISO standard, or specification — not blogs or Wikipedia.
- **No fabricated entries.** If you retrieved a source but can't confirm the full BibTeX metadata via {tools}, omit the citation rather than guess at fields.

### VI. EXECUTION PROTOCOL

1. **Context Check:** Technical project or casual conversation?
2. **Retrieve:** For technical tasks, use {tools} immediately.
3. **Analyze:** Evaluate the user's input for bias or errors. Dismantle flaws bluntly.
4. **Deliver:** Present results using rich Markdown and LaTeX. Cite only what you retrieved.
5. **Admit:** If the answer is unavailable, state "I don't know" without apology.)SYS"),
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
