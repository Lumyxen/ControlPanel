#include "services/llamacpp_service.h"
#include "services/mcp_registry.h"
#include <filesystem>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cstring>
#include <thread>

namespace fs = std::filesystem;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

static std::string stemFromPath(const std::string& path) {
    fs::path p(path);
    return p.stem().string();
}

static std::string modelIdFromPath(const std::string& path) {
    return "llamacpp::" + stemFromPath(path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor / Destructor
// ─────────────────────────────────────────────────────────────────────────────

LlamaCppService::LlamaCppService(const std::string& modelsDir)
    : modelsDir_(modelsDir)
{
#ifdef LLAMA_CPP_AVAILABLE
    llama_backend_init();

    // Suppress llama.cpp's extremely verbose stdout/stderr logging.
    // Only actual errors are forwarded; all info/debug noise is dropped.
    llama_log_set([](ggml_log_level level, const char* text, void*) {
        if (level == GGML_LOG_LEVEL_ERROR) {
            std::cerr << "[LlamaCpp] " << text;
        }
    }, nullptr);

    std::cout << "[LlamaCpp] Backend initialised\n";
#else
    std::cout << "[LlamaCpp] Built without LLAMA_CPP_AVAILABLE — inference disabled\n";
    return;
#endif

    if (!fs::exists(modelsDir_)) {
        std::cout << "[LlamaCpp] Models directory does not exist: " << modelsDir_ << "\n";
        return;
    }

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() == ".gguf") {
            if (loadModel(entry.path().string())) break;
        }
    }

    if (!modelLoaded_)
        std::cout << "[LlamaCpp] No .gguf models found in: " << modelsDir_ << "\n";
}

LlamaCppService::~LlamaCppService() {
#ifdef LLAMA_CPP_AVAILABLE
    if (ctx_)   { llama_free(ctx_);         ctx_   = nullptr; }
    if (model_) { llama_model_free(model_); model_ = nullptr; }
    llama_backend_free();
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
// loadModel
// ─────────────────────────────────────────────────────────────────────────────

bool LlamaCppService::loadModel(const std::string& path) {
#ifndef LLAMA_CPP_AVAILABLE
    (void)path;
    return false;
#else
    std::cout << "[LlamaCpp] Loading model: " << path << "\n";

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0;

    llama_model* m = llama_model_load_from_file(path.c_str(), mparams);
    if (!m) {
        std::cerr << "[LlamaCpp] Failed to load model: " << path << "\n";
        return false;
    }

    // Capture model's native context window
    uint32_t model_n_ctx = llama_model_n_ctx_train(m);
    
    // Cap at a reasonable limit like 64k to prevent automatic CPU OOMs
    uint32_t ctx_size = model_n_ctx > 0 ? std::min(model_n_ctx, (uint32_t)65536) : 32768;

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx    = ctx_size;
    cparams.n_batch  = static_cast<uint32_t>(n_batch_);
    cparams.n_ubatch = static_cast<uint32_t>(n_batch_);
    
    // Use the latest enum parameter for flash attention 
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;

    // Optimize CPU threads (approximating physical cores over logical)
    unsigned int hw_threads = std::thread::hardware_concurrency();
    cparams.n_threads       = hw_threads > 0 ? std::max(1u, hw_threads / 2) : 4;
    cparams.n_threads_batch = hw_threads > 0 ? hw_threads : 4;

    llama_context* c = llama_init_from_model(m, cparams);
    if (!c) {
        std::cerr << "[LlamaCpp] Failed to create context for: " << path << "\n";
        llama_model_free(m);
        return false;
    }

    if (ctx_)   { llama_free(ctx_);         ctx_   = nullptr; }
    if (model_) { llama_model_free(model_); model_ = nullptr; }

    model_           = m;
    ctx_             = c;
    n_ctx_           = ctx_size;
    loadedModelPath_ = path;
    loadedModelId_   = modelIdFromPath(path);
    modelLoaded_     = true;

    std::cout << "[LlamaCpp] Model ready: " << loadedModelId_
              << "  (ctx=" << n_ctx_ << ", batch=" << n_batch_ << ")\n";
    return true;
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
// getModels  — lists ALL .gguf files in modelsDir_
// ─────────────────────────────────────────────────────────────────────────────

Json::Value LlamaCppService::getModels() const {
    Json::Value out;
    out["data"] = Json::Value(Json::arrayValue);

#ifdef LLAMA_CPP_AVAILABLE
    if (!fs::exists(modelsDir_)) return out;

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() != ".gguf") continue;

        const std::string path = entry.path().string();
        const std::string id   = modelIdFromPath(path);

        Json::Value m;
        m["id"]             = id;
        m["name"]           = stemFromPath(path);
        m["source"]         = "llamacpp";
        m["context_length"] = n_ctx_;
        m["max_tokens"]     = 8192; // FIX: Fallback accurately to 8192 output tokens
        m["loaded"]         = (modelLoaded_ && loadedModelPath_ == path);
        out["data"].append(m);
    }
#endif
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildMessages
// ─────────────────────────────────────────────────────────────────────────────

Json::Value LlamaCppService::buildMessages(const std::string& prompt,
                                            const std::string& systemPrompt) const {
    Json::Value messages(Json::arrayValue);

    if (!systemPrompt.empty()) {
        Json::Value sys;
        sys["role"]    = "system";
        sys["content"] = systemPrompt;
        messages.append(sys);
    }

    auto pairs = parseMessages(prompt, "");
    for (const auto&[role, content] : pairs) {
        Json::Value msg;
        msg["role"]    = role;
        msg["content"] = content;
        messages.append(msg);
    }
    return messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseMessages
// ─────────────────────────────────────────────────────────────────────────────

std::vector<std::pair<std::string, std::string>>
LlamaCppService::parseMessages(const std::string& prompt,
                                const std::string& systemPrompt) const {
    std::vector<std::pair<std::string, std::string>> result;

    if (!systemPrompt.empty())
        result.push_back({"system", systemPrompt});

    std::istringstream stream(prompt);
    std::string line, current;

    auto flush = [&]() {
        if (current.empty()) return;
        size_t s = current.find_first_not_of(" \t\n\r");
        if (s != std::string::npos) current = current.substr(s);

        if (current.find("User:") == 0) {
            std::string c = current.substr(5);
            size_t cs = c.find_first_not_of(" \t");
            result.push_back({"user", cs != std::string::npos ? c.substr(cs) : c});
        } else if (current.find("Assistant:") == 0) {
            std::string c = current.substr(10);
            size_t cs = c.find_first_not_of(" \t");
            result.push_back({"assistant", cs != std::string::npos ? c.substr(cs) : c});
        } else if (!current.empty()) {
            result.push_back({"user", current});
        }
        current.clear();
    };

    while (std::getline(stream, line)) {
        if ((line.find("User:") == 0 || line.find("Assistant:") == 0) && !current.empty()) {
            flush();
            current = line;
        } else {
            if (!current.empty()) current += "\n";
            current += line;
        }
    }
    flush();

    if (result.empty() && !prompt.empty())
        result.push_back({"user", prompt});

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// makeContentChunk
// ─────────────────────────────────────────────────────────────────────────────

std::string LlamaCppService::makeContentChunk(const std::string& text) {
    std::string escaped;
    escaped.reserve(text.size() + 4);
    for (unsigned char c : text) {
        switch (c) {
            case '"':  escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\n': escaped += "\\n";  break;
            case '\r': escaped += "\\r";  break;
            case '\t': escaped += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    escaped += buf;
                } else {
                    escaped += static_cast<char>(c);
                }
        }
    }
    return "data: {\"choices\":[{\"delta\":{\"content\":\"" + escaped + "\"}}]}\n\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// doInference
// ─────────────────────────────────────────────────────────────────────────────

void LlamaCppService::doInference(
    const std::vector<std::pair<std::string, std::string>>& messages,
    int maxTokens,
    double temperature,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError
) const {
#ifndef LLAMA_CPP_AVAILABLE
    (void)messages; (void)maxTokens; (void)temperature; (void)onChunk;
    onError("llama.cpp support not compiled in");
    return;
#else
    if (!model_ || !ctx_) {
        onError("No model loaded");
        return;
    }

    // FIX: Set a safe minimum bound, but remove the n_ctx / 2 clamp to allow huge responses on short prompts
    if (maxTokens <= 0) {
        maxTokens = 8192;
    }

    const llama_vocab* vocab = llama_model_get_vocab(model_);

    int maxInputTokens = n_ctx_ - 4; // Always ensure a few tokens of breathing room
    if (maxInputTokens <= 0) {
        onError("Context too small for inference");
        return;
    }

    std::string formattedPrompt;
    std::vector<llama_token> inputTokens;
    std::vector<std::pair<std::string, std::string>> currentMessages = messages;

    // Find our first true non-system prompt
    size_t firstNonSystem = 0;
    while (firstNonSystem < currentMessages.size() && currentMessages[firstNonSystem].first == "system") {
        firstNonSystem++;
    }

    // Gracefully handle context overflow by popping old messages recursively instead of brutally truncating the tail
    while (true) {
        std::vector<std::string> contentStore;
        contentStore.reserve(currentMessages.size());
        std::vector<llama_chat_message> chatMsgs;
        chatMsgs.reserve(currentMessages.size());

        for (const auto&[role, content] : currentMessages) {
            contentStore.push_back(content);
            chatMsgs.push_back({role.c_str(), contentStore.back().c_str()});
        }

        int tmplLen = llama_chat_apply_template(
            nullptr,
            chatMsgs.data(), chatMsgs.size(),
            /* add_ass */ true,
            nullptr, 0
        );

        if (tmplLen < 0) {
            onError("llama_chat_apply_template failed (unsupported template?)");
            return;
        }

        std::vector<char> tmplBuf(static_cast<size_t>(tmplLen) + 1, '\0');
        llama_chat_apply_template(
            nullptr,
            chatMsgs.data(), chatMsgs.size(),
            /* add_ass */ true,
            tmplBuf.data(), static_cast<int32_t>(tmplBuf.size())
        );
        formattedPrompt = std::string(tmplBuf.data(), static_cast<size_t>(tmplLen));

        // Determine exact token length size needed
        int reqTokens = llama_tokenize(
            vocab,
            formattedPrompt.c_str(),
            static_cast<int32_t>(formattedPrompt.size()),
            nullptr,
            0,
            /* add_special */  true,
            /* parse_special */ true
        );
        if (reqTokens < 0) reqTokens = -reqTokens;

        if (reqTokens <= maxInputTokens || currentMessages.size() <= firstNonSystem + 1) {
            inputTokens.resize(reqTokens);
            int nTokens = llama_tokenize(
                vocab,
                formattedPrompt.c_str(),
                static_cast<int32_t>(formattedPrompt.size()),
                inputTokens.data(),
                static_cast<int32_t>(inputTokens.size()),
                /* add_special */  true,
                /* parse_special */ true
            );

            if (nTokens < 0) nTokens = -nTokens;
            inputTokens.resize(static_cast<size_t>(nTokens));
            
            // As a final absolute fallback edge case, trim the head to safeguard if one single message was impossibly huge
            if (nTokens > maxInputTokens) {
                size_t excess = nTokens - maxInputTokens;
                inputTokens.erase(inputTokens.begin(), inputTokens.begin() + excess);
                std::cerr << "[LlamaCpp] Warning: prompt forcefully truncated by " << excess << " tokens from the beginning\n";
            }
            break;
        }

        // Drop the oldest non-system message and attempt to fit again
        currentMessages.erase(currentMessages.begin() + firstNonSystem);
    }

    int remainingCtx = n_ctx_ - inputTokens.size() - 1;
    if (maxTokens > remainingCtx) maxTokens = remainingCtx; // Dynamically clamp based on exact remaining room
    if (maxTokens <= 0) {
        onError("Prompt fills the entire context window");
        return;
    }

    // ── Clear context ─────────────────────────────────────────────────────────
    llama_memory_seq_rm(llama_get_memory(ctx_), 0, -1, -1);

    // ── Prefill in n_batch_-sized chunks ──────────────────────────────────────
    llama_batch batch = llama_batch_init(n_batch_, 0, 1);

    int nProcessed = 0;
    while (nProcessed < static_cast<int>(inputTokens.size())) {
        int chunkSize = std::min(n_batch_, static_cast<int>(inputTokens.size()) - nProcessed);
        
        batch.n_tokens = chunkSize;
        for (int i = 0; i < chunkSize; ++i) {
            batch.token[i]     = inputTokens[nProcessed + i];
            batch.pos[i]       = nProcessed + i;
            batch.n_seq_id[i]  = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i]    = 0; // false
        }
        
        // Only calculate logits for the absolute final token of the entire prompt
        if (nProcessed + chunkSize == static_cast<int>(inputTokens.size())) {
            batch.logits[chunkSize - 1] = 1; // true
        }

        if (llama_decode(ctx_, batch) != 0) {
            onError("llama_decode (prefill) failed");
            llama_batch_free(batch);
            return;
        }
        nProcessed += chunkSize;
    }

    // ── Sampler ───────────────────────────────────────────────────────────────
    float temp           = (temperature > 0.0) ? static_cast<float>(temperature) : 0.7f;
    int   penaltyLastN   = 64;
    float penaltyRepeat  = 1.15f;
    float penaltyFreq    = 0.0f;
    float penaltyPresent = 0.0f;

    llama_sampler* sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(
        penaltyLastN, penaltyRepeat, penaltyFreq, penaltyPresent));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9f, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_min_p(0.05f, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    // ── Generation loop ───────────────────────────────────────────────────────
    int  nGenerated = 0;
    bool cancelled  = false;

    while (nGenerated < maxTokens && !cancelled) {
        llama_token token = llama_sampler_sample(sampler, ctx_, -1);

        if (llama_vocab_is_eog(vocab, token)) break;

        char piece[256];
        int  nPiece = llama_token_to_piece(vocab, token, piece, sizeof(piece) - 1, 0, false);
        if (nPiece < 0) nPiece = 0;

        if (nPiece > 0) {
            piece[nPiece] = '\0';
            std::string text(piece, static_cast<size_t>(nPiece));
            if (!onChunk(makeContentChunk(text))) {
                cancelled = true;
                break;
            }
        }

        batch.n_tokens = 1;
        batch.token[0] = token;
        batch.pos[0] = inputTokens.size() + nGenerated;
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0] = 1; // Need logits for the next iteration

        if (llama_decode(ctx_, batch) != 0) {
            onError("llama_decode (generation) failed");
            break;
        }

        ++nGenerated;
    }

    llama_sampler_free(sampler);
    llama_batch_free(batch);
    llama_memory_seq_rm(llama_get_memory(ctx_), 0, -1, -1);

    if (!cancelled)
        onChunk("data: [DONE]\n\n");
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
// streamingChatWithCallback
// ─────────────────────────────────────────────────────────────────────────────

void LlamaCppService::streamingChatWithCallback(
    const std::string& /*model*/,
    const std::string& prompt,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    const std::string& systemPrompt,
    double temperature,
    int /*numCtx*/
) const {
    if (!modelLoaded_) {
        onError("No llama.cpp model loaded");
        return;
    }

    auto messages = parseMessages(prompt, systemPrompt);

    std::unique_lock<std::mutex> lock(inferMutex_);
    doInference(messages, maxTokens, temperature, onChunk, onError);
}

// ─────────────────────────────────────────────────────────────────────────────
// streamingChatWithTools  (tool support not yet implemented — falls back)
// ─────────────────────────────────────────────────────────────────────────────

void LlamaCppService::streamingChatWithTools(
    const std::string& model,
    Json::Value messages,
    const Json::Value& /*tools*/,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    McpRegistry* /*registry*/,
    double temperature,
    int numCtx
) const {
    std::cout << "[LlamaCpp] Tool calls not yet supported — running without tools\n";

    std::string prompt;
    std::string sysPrompt;

    for (const auto& msg : messages) {
        const std::string role    = msg.get("role",    "user").asString();
        const std::string content = msg.get("content", "").asString();

        if (role == "system") {
            sysPrompt = content;
        } else if (role == "user") {
            if (!prompt.empty()) prompt += "\n";
            prompt += "User: " + content;
        } else if (role == "assistant") {
            if (!prompt.empty()) prompt += "\n";
            prompt += "Assistant: " + content;
        }
    }

    streamingChatWithCallback(model, prompt, maxTokens,
                              onChunk, onError, sysPrompt, temperature, numCtx);
}