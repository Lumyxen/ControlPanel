// backend/src/services/llamacpp_service.cpp
#include "services/llamacpp_service.h"
#include "services/llama_api.h"
#include "services/mcp_registry.h"
#include "config/config.h"

#include <filesystem>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cstring>
#include <thread>
#include <unistd.h>

#ifndef _WIN32
#  include <dlfcn.h>
#else
#  define RTLD_NOW   0
#  define RTLD_LOCAL 0
inline void* dlopen(const char*, int)  { return nullptr; }
inline void* dlsym(void*, const char*) { return nullptr; }
inline int   dlclose(void*)            { return 0; }
inline const char* dlerror()           { return "dlopen not supported on Windows"; }
#endif

namespace fs = std::filesystem;

#define RESOLVE(field, sym)                                             \
    do {                                                                \
        void* _p = dlsym(dlHandle_, sym);                              \
        if (!_p) {                                                      \
            std::cerr << "[LlamaCpp] dlsym(\"" sym "\") failed: "      \
                      << dlerror() << "\n";                            \
            return false;                                               \
        }                                                               \
        std::memcpy(&api_->field, &_p, sizeof(_p));                    \
    } while (0)

static std::string stemFromPath(const std::string& path) {
    return fs::path(path).stem().string();
}
static std::string modelIdFromPath(const std::string& path) {
    return "llamacpp::" + stemFromPath(path);
}

fs::path LlamaCppService::libPath(const std::string& name) const {
    return fs::path(libsDir_) / ("libllama_" + name + ".so");
}

// =============================================================================
// isReady
// =============================================================================

bool LlamaCppService::isReady() const {
    return modelLoaded_ && api_ && api_->loaded;
}

// =============================================================================
// Constructor / Destructor
// =============================================================================

LlamaCppService::LlamaCppService(const std::string& modelsDir,
                                 const std::string& libsDir,
                                 Config& config)
    : modelsDir_(modelsDir), libsDir_(libsDir), config_(config)
{
    api_ = new LlamaApi();
    fs::create_directories(libsDir_);

    const std::string pref     = config_.getLlamacppBackend();
    const std::string resolved = resolveBackend(pref);

    if (!loadLib(resolved) && resolved != "cpu") {
        std::cerr << "[LlamaCpp] Failed to load '" << resolved << "' — trying cpu\n";
        loadLib("cpu");
    }
}

LlamaCppService::~LlamaCppService() {
    unloadLib();
    delete api_;
    api_ = nullptr;
}

// =============================================================================
// Backend management
// =============================================================================

std::vector<std::string> LlamaCppService::availableBackends() const {
    std::vector<std::string> out;
    for (const char* b : {"cpu", "cuda", "rocm", "vulkan"})
        if (fs::exists(libPath(b))) out.push_back(b);
    return out;
}

std::vector<std::string> LlamaCppService::detectHardwareBackends() {
    std::vector<std::string> out;
#ifndef _WIN32
    bool hasCuda = false;
    for (int i = 0; i < 8; ++i)
        if (access(("/dev/nvidia" + std::to_string(i)).c_str(), F_OK) == 0) { hasCuda = true; break; }
    if (!hasCuda)
        hasCuda = (system("nvidia-smi --query-gpu=name --format=csv,noheader > /dev/null 2>&1") == 0);
    if (hasCuda) out.push_back("cuda");

    bool hasAmdDiscreteGpu = false;
    if (access("/dev/kfd", F_OK) == 0) {
        FILE* fp = popen("lspci | grep -i 'VGA.*\\[AMD/ATI\\]' | grep -iE 'RX|Radeon Pro|Radeon VII|Radeon Instinct' | grep -v 'Vega Graphics'", "r");
        if (fp) {
            char buffer[256];
            if (fgets(buffer, sizeof(buffer), fp) != nullptr) {
                hasAmdDiscreteGpu = true;
            }
            pclose(fp);
        }
    }
    if (hasAmdDiscreteGpu) out.push_back("rocm");

    {
        void* vk = dlopen("libvulkan.so.1", RTLD_LAZY | RTLD_LOCAL);
        if (!vk) vk = dlopen("libvulkan.so", RTLD_LAZY | RTLD_LOCAL);
        if (vk) { out.push_back("vulkan"); dlclose(vk); }
    }
#endif
    return out;
}

std::string LlamaCppService::resolveBackend(const std::string& preference) const {
    auto avail = availableBackends();
    auto has   = [&](const std::string& b) {
        return std::find(avail.begin(), avail.end(), b) != avail.end();
    };
    if (preference == "cpu") return "cpu";
    if (preference != "auto") {
        if (has(preference)) return preference;
        std::cerr << "[LlamaCpp] Preferred backend '" << preference
                  << "' not available — falling back to auto\n";
    }
    for (const char* b : {"cuda", "rocm", "vulkan"})
        if (has(b)) return b;
    return "cpu";
}

// =============================================================================
// dlopen / dlclose
// =============================================================================

bool LlamaCppService::loadLib(const std::string& backendName) {
    const fs::path so = libPath(backendName);
    if (!fs::exists(so)) {
        std::cerr << "[LlamaCpp] Library not found: " << so.string() << "\n";
        return false;
    }

    void* handle = dlopen(so.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        std::cerr << "[LlamaCpp] dlopen('" << so.string() << "') failed: "
                  << dlerror() << "\n";
        return false;
    }

    *api_ = LlamaApi{};
    dlHandle_ = handle;

    RESOLVE(backend_init,                 "llama_backend_init");
    RESOLVE(backend_free,                 "llama_backend_free");
    RESOLVE(log_set,                      "llama_log_set");
    RESOLVE(model_default_params,         "llama_model_default_params");
    RESOLVE(model_load_from_file,         "llama_model_load_from_file");
    RESOLVE(model_free,                   "llama_model_free");
    RESOLVE(model_get_vocab,              "llama_model_get_vocab");
    RESOLVE(context_default_params,       "llama_context_default_params");
    RESOLVE(init_from_model,              "llama_init_from_model");
    RESOLVE(free,                         "llama_free");
    RESOLVE(batch_init,                   "llama_batch_init");
    RESOLVE(batch_free,                   "llama_batch_free");
    RESOLVE(decode,                       "llama_decode");
    RESOLVE(get_memory,                   "llama_get_memory");
    RESOLVE(memory_clear,                 "llama_memory_clear");
    RESOLVE(tokenize,                     "llama_tokenize");
    RESOLVE(token_to_piece,               "llama_token_to_piece");
    RESOLVE(vocab_is_eog,                 "llama_vocab_is_eog");
    RESOLVE(chat_apply_template,          "llama_chat_apply_template");
    RESOLVE(sampler_chain_default_params, "llama_sampler_chain_default_params");
    RESOLVE(sampler_chain_init,           "llama_sampler_chain_init");
    RESOLVE(sampler_chain_add,            "llama_sampler_chain_add");
    RESOLVE(sampler_init_penalties,       "llama_sampler_init_penalties");
    RESOLVE(sampler_init_top_p,           "llama_sampler_init_top_p");
    RESOLVE(sampler_init_min_p,           "llama_sampler_init_min_p");
    RESOLVE(sampler_init_temp,            "llama_sampler_init_temp");
    RESOLVE(sampler_init_dist,            "llama_sampler_init_dist");
    RESOLVE(sampler_sample,               "llama_sampler_sample");
    RESOLVE(sampler_free,                 "llama_sampler_free");

    {
        void* p;
        p = dlsym(handle, "ggml_backend_reg_count");
        if (p) std::memcpy(&api_->ggml_backend_reg_count, &p, sizeof(p));
        p = dlsym(handle, "ggml_backend_reg_get");
        if (p) std::memcpy(&api_->ggml_backend_reg_get,   &p, sizeof(p));
        p = dlsym(handle, "ggml_backend_reg_name");
        if (p) std::memcpy(&api_->ggml_backend_reg_name,  &p, sizeof(p));
    }

    api_->loaded   = true;
    activeBackend_ = backendName;

    api_->log_set([](ggml_log_level level, const char* text, void*) {
        if (level == GGML_LOG_LEVEL_ERROR) std::cerr << "[LlamaCpp] " << text;
    }, nullptr);

    api_->backend_init();

    std::cout << "[LlamaCpp] Loaded backend: " << backendName
              << " (" << so.filename().string() << ")\n";
    return true;
}

void LlamaCppService::unloadLib() {
    unloadModel();
    if (api_) {
        if (api_->loaded && api_->log_set) api_->log_set(nullptr, nullptr);
        if (api_->loaded && api_->backend_free) api_->backend_free();
        *api_ = LlamaApi{};
    }
    if (dlHandle_) { dlclose(dlHandle_); dlHandle_ = nullptr; }
    activeBackend_.clear();
}

// =============================================================================
// Backend switch
// =============================================================================

bool LlamaCppService::switchBackend(const std::string& backendName) {
    std::cout << "[LlamaCpp] Switching backend to: " << backendName << "\n";

    std::unique_lock<std::mutex> lock(inferMutex_);

    const std::string prevPath = loadedModelPath_;

    unloadLib();

    if (!loadLib(backendName)) {
        std::cerr << "[LlamaCpp] Failed to load '" << backendName << "'\n";
        if (backendName != "cpu") {
            std::cerr << "[LlamaCpp] Falling back to cpu\n";
            loadLib("cpu");
        }
    }

    if (!api_->loaded) return false;

    if (!prevPath.empty()) {
        return loadModel(prevPath);
    }
    return true;
}

// =============================================================================
// Model loading
// =============================================================================

bool LlamaCppService::ensureModelLoaded() {
    if (modelLoaded_) return true;
    if (!api_->loaded) return false;

    if (!fs::exists(modelsDir_)) {
        return false;
    }

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() == ".gguf") {
            const std::string fname = entry.path().filename().string();
            if (fname.find("mmproj") != std::string::npos) continue;
            if (loadModel(entry.path().string())) return true;
        }
    }
    return false;
}

void LlamaCppService::unloadModel() {
    if (ctx_ && api_->loaded && api_->free) {
        api_->free(static_cast<llama_context*>(ctx_));
        ctx_ = nullptr;
    }
    if (model_ && api_->loaded && api_->model_free) {
        api_->model_free(static_cast<llama_model*>(model_));
        model_ = nullptr;
    }
    modelLoaded_ = false;
    loadedModelId_.clear();
}

bool LlamaCppService::loadModel(const std::string& path) {
    if (!api_->loaded) return false;

    std::cout << "[LlamaCpp] Loading model: " << path << "\n";

    int gpuLayers = config_.getLlamacppGpuLayers();
    if (activeBackend_ == "cpu" && gpuLayers > 0) {
        gpuLayers = 0;
    }

    llama_model_params mparams = api_->model_default_params();
    mparams.n_gpu_layers       = gpuLayers;

    auto* m = api_->model_load_from_file(path.c_str(), mparams);
    if (!m) {
        std::cerr << "[LlamaCpp] Failed to load model: " << path << "\n";
        return false;
    }

    const int    cfgCtxSize      = config_.getLlamacppCtxSize();
    const int    evalBatchSize   = std::max(1, config_.getLlamacppEvalBatchSize());
    const bool   flashAttn       = config_.getLlamacppFlashAttn();
    const unsigned int hwThreads = std::thread::hardware_concurrency();

    uint32_t n_threads = config_.getLlamacppThreads() > 0
        ? static_cast<uint32_t>(config_.getLlamacppThreads())
        : std::max(1u, hwThreads / 2);
    uint32_t n_threads_batch = config_.getLlamacppThreadsBatch() > 0
        ? static_cast<uint32_t>(config_.getLlamacppThreadsBatch())
        : hwThreads;
    uint32_t ctx_size = cfgCtxSize > 0 ? static_cast<uint32_t>(cfgCtxSize) : 8192;

    llama_context_params cparams = api_->context_default_params();
    cparams.n_ctx           = ctx_size;
    cparams.n_batch         = static_cast<uint32_t>(evalBatchSize);
    cparams.n_ubatch        = static_cast<uint32_t>(evalBatchSize);
    cparams.n_threads       = n_threads;
    cparams.n_threads_batch = n_threads_batch;
    cparams.flash_attn_type = flashAttn ? LLAMA_FLASH_ATTN_TYPE_ENABLED
                                        : LLAMA_FLASH_ATTN_TYPE_AUTO;

    auto* c = api_->init_from_model(m, cparams);
    if (!c) {
        std::cerr << "[LlamaCpp] Failed to create context\n";
        api_->model_free(m);
        return false;
    }

    unloadModel();

    model_           = m;
    ctx_             = c;
    n_ctx_           = static_cast<int>(ctx_size);
    n_batch_         = evalBatchSize;
    loadedModelPath_ = path;
    loadedModelId_   = modelIdFromPath(path);
    modelLoaded_     = true;

    return true;
}

// =============================================================================
// getModels / buildMessages / parseMessages
// =============================================================================

Json::Value LlamaCppService::getModels() const {
    Json::Value out;
    out["data"] = Json::Value(Json::arrayValue);
    if (!fs::exists(modelsDir_)) return out;

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() != ".gguf") continue;
        const std::string fname = entry.path().filename().string();
        if (fname.find("mmproj") != std::string::npos) continue;
        const std::string path = entry.path().string();

        Json::Value m;
        m["id"]             = modelIdFromPath(path);
        m["name"]           = stemFromPath(path);
        m["source"]         = "llamacpp";
        m["context_length"] = n_ctx_;
        m["max_tokens"]     = 8192;
        m["loaded"]         = (modelLoaded_ && loadedModelPath_ == path);
        out["data"].append(m);
    }
    return out;
}

Json::Value LlamaCppService::buildMessages(const std::string& prompt,
                                            const std::string& systemPrompt) const {
    Json::Value messages(Json::arrayValue);
    if (!systemPrompt.empty()) {
        Json::Value sys; sys["role"] = "system"; sys["content"] = systemPrompt;
        messages.append(sys);
    }
    for (const auto&[role, content] : parseMessages(prompt, "")) {
        Json::Value msg; msg["role"] = role; msg["content"] = content;
        messages.append(msg);
    }
    return messages;
}

std::vector<std::pair<std::string, std::string>>
LlamaCppService::parseMessages(const std::string& prompt,
                                const std::string& systemPrompt) const {
    std::vector<std::pair<std::string, std::string>> result;
    if (!systemPrompt.empty()) result.push_back({"system", systemPrompt});

    std::istringstream stream(prompt);
    std::string line, current;
    std::string currentRole;

    auto flush = [&]() {
        if (current.empty()) return;
        size_t s = current.find_first_not_of(" \t\n\r");
        if (s != std::string::npos) current = current.substr(s);
        size_t e = current.find_last_not_of(" \t\n\r");
        if (e != std::string::npos) current = current.substr(0, e + 1);
        if (!current.empty() && !currentRole.empty())
            result.push_back({currentRole, current});
        current.clear();
        currentRole.clear();
    };

    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.find("User:") == 0) {
            flush();
            currentRole = "user";
            current = line.substr(5);
        } else if (line.find("Assistant:") == 0) {
            flush();
            currentRole = "assistant";
            current = line.substr(10);
        } else {
            if (!currentRole.empty()) current += "\n" + line;
        }
    }
    flush();

    if (result.empty() && !prompt.empty()) {
        std::string trimmed = prompt;
        size_t s = trimmed.find_first_not_of(" \t\n\r");
        if (s != std::string::npos) trimmed = trimmed.substr(s);
        if (!trimmed.empty()) result.push_back({"user", trimmed});
    }
    return result;
}

// =============================================================================
// Chunk helpers
// =============================================================================

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
                if (c < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", c); escaped += buf; }
                else escaped += static_cast<char>(c);
        }
    }
    return "data: {\"choices\":[{\"delta\":{\"content\":\"" + escaped + "\"}}]}\n\n";
}

std::vector<uint8_t> LlamaCppService::decodeBase64Image(const std::string& dataUrl) {
    const size_t commaPos = dataUrl.find(',');
    const std::string b64 = (commaPos != std::string::npos) ? dataUrl.substr(commaPos + 1) : dataUrl;
    uint8_t dt[256]; std::fill(dt, dt + 256, uint8_t(0xFF));
    for (int i = 0; i < 26; ++i) { dt[uint8_t('A'+i)] = uint8_t(i); dt[uint8_t('a'+i)] = uint8_t(26+i); }
    for (int i = 0; i < 10; ++i)   dt[uint8_t('0'+i)] = uint8_t(52+i);
    dt[uint8_t('+')] = 62; dt[uint8_t('/')] = 63;
    std::vector<uint8_t> out; out.reserve(b64.size() * 3 / 4);
    uint32_t buf = 0; int bits = 0;
    for (unsigned char c : b64) {
        if (c == '=') break;
        if (dt[c] == 0xFF) continue;
        buf = (buf << 6) | uint32_t(dt[c]); bits += 6;
        if (bits >= 8) { bits -= 8; out.push_back(uint8_t((buf >> bits) & 0xFF)); }
    }
    return out;
}

// =============================================================================
// Tool-call helpers
// =============================================================================

static std::string buildToolSystemPromptAppendix(const Json::Value& tools) {
    if (!tools.isArray() || tools.empty()) return "";

    std::string out;
    out += "\n\n## Available Tools\n\n";
    out += "You have access to the following tools. To call a tool, respond with a "
           "JSON object on its own line in this exact format:\n"
           "{\"tool_call\": {\"name\": \"<tool_name>\", \"arguments\": {<args>}}}\n\n"
           "After you emit a tool_call JSON object, stop generating. "
           "The tool result will be provided and you can continue.\n\n"
           "### Tool Definitions\n\n";

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";

    for (const auto& tool : tools) {
        if (!tool.isMember("function")) continue;
        const Json::Value& fn = tool["function"];
        out += "- **" + fn.get("name", "").asString() + "**: "
             + fn.get("description", "").asString() + "\n";
        if (fn.isMember("parameters")) {
            out += "  Parameters: " + Json::writeString(wb, fn["parameters"]) + "\n";
        }
        out += "\n";
    }
    return out;
}

static bool extractToolCall(const std::string& text,
                             std::string& nameOut,
                             std::string& argsJsonOut) {
    const std::string marker = "\"tool_call\"";
    size_t pos = text.find(marker);
    while (pos != std::string::npos) {
        size_t braceStart = text.rfind('{', pos);
        if (braceStart == std::string::npos) {
            pos = text.find(marker, pos + 1);
            continue;
        }
        int depth = 0;
        size_t braceEnd = std::string::npos;
        for (size_t i = braceStart; i < text.size(); ++i) {
            if (text[i] == '{') ++depth;
            else if (text[i] == '}') {
                --depth;
                if (depth == 0) { braceEnd = i; break; }
            }
        }
        if (braceEnd == std::string::npos) {
            pos = text.find(marker, pos + 1);
            continue;
        }

        std::string candidate = text.substr(braceStart, braceEnd - braceStart + 1);
        Json::Value parsed;
        Json::CharReaderBuilder rb;
        std::string errs;
        std::istringstream ss(candidate);
        if (Json::parseFromStream(rb, ss, &parsed, &errs) && parsed.isMember("tool_call")) {
            const Json::Value& tc = parsed["tool_call"];
            nameOut = tc.get("name", "").asString();
            if (!nameOut.empty()) {
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                argsJsonOut = tc.isMember("arguments")
                    ? Json::writeString(wb, tc["arguments"])
                    : "{}";
                return true;
            }
        }
        pos = text.find(marker, pos + 1);
    }
    return false;
}

// =============================================================================
// doInference
// =============================================================================

void LlamaCppService::doInference(
    const std::vector<std::pair<std::string, std::string>>& messages,
    int maxTokens, double temperature,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError
) const {
    if (!api_->loaded || !model_ || !ctx_) { onError("No backend or model loaded"); return; }
    if (maxTokens <= 0) maxTokens = 8192;

    const llama_vocab* vocab = api_->model_get_vocab(static_cast<llama_model*>(model_));
    auto* ctx = static_cast<llama_context*>(ctx_);
    const int maxInput = n_ctx_ - 4;
    if (maxInput <= 0) { onError("Context too small"); return; }

    auto curMsgs = messages;
    size_t firstNonSystem = 0;
    while (firstNonSystem < curMsgs.size() && curMsgs[firstNonSystem].first == "system")
        firstNonSystem++;

    std::string formattedPrompt;
    std::vector<llama_token> inputTokens;

    while (true) {
        std::vector<std::string> store; store.reserve(curMsgs.size());
        std::vector<llama_chat_message> chatMsgs; chatMsgs.reserve(curMsgs.size());
        for (const auto&[role, content] : curMsgs) {
            store.push_back(content);
            chatMsgs.push_back({role.c_str(), store.back().c_str()});
        }
        int tl = api_->chat_apply_template(nullptr, chatMsgs.data(), chatMsgs.size(), true, nullptr, 0);
        if (tl < 0) { onError("llama_chat_apply_template failed"); return; }
        std::vector<char> buf(static_cast<size_t>(tl) + 1, '\0');
        api_->chat_apply_template(nullptr, chatMsgs.data(), chatMsgs.size(), true,
                                  buf.data(), static_cast<int32_t>(buf.size()));
        formattedPrompt = std::string(buf.data(), static_cast<size_t>(tl));

        int reqTok = api_->tokenize(vocab, formattedPrompt.c_str(),
                                    static_cast<int32_t>(formattedPrompt.size()),
                                    nullptr, 0, false, true);
        if (reqTok < 0) reqTok = -reqTok;
        if (reqTok <= maxInput || curMsgs.size() <= firstNonSystem + 1) {
            inputTokens.resize(reqTok);
            int n = api_->tokenize(vocab, formattedPrompt.c_str(),
                                   static_cast<int32_t>(formattedPrompt.size()),
                                   inputTokens.data(), static_cast<int32_t>(inputTokens.size()),
                                   false, true);
            if (n < 0) n = -n;
            inputTokens.resize(static_cast<size_t>(n));
            if (n > maxInput) inputTokens.erase(inputTokens.begin(), inputTokens.begin() + (n - maxInput));
            break;
        }
        curMsgs.erase(curMsgs.begin() + firstNonSystem);
    }

    int remainCtx = n_ctx_ - static_cast<int>(inputTokens.size()) - 1;
    if (maxTokens > remainCtx) maxTokens = remainCtx;
    if (maxTokens <= 0) { onError("Prompt fills entire context window"); return; }

    std::cout << "[LlamaCpp] Inference started (input tokens: " << inputTokens.size() << ")\n";

    api_->memory_clear(api_->get_memory(ctx), true);
    llama_batch batch = api_->batch_init(n_batch_, 0, 1);
    int nProcessed = 0;

    while (nProcessed < static_cast<int>(inputTokens.size())) {
        if (!onChunk("")) { api_->batch_free(batch); api_->memory_clear(api_->get_memory(ctx), true); return; }
        int cs = std::min(n_batch_, static_cast<int>(inputTokens.size()) - nProcessed);
        batch.n_tokens = cs;
        for (int i = 0; i < cs; ++i) {
            batch.token[i]     = inputTokens[nProcessed + i];
            batch.pos[i]       = nProcessed + i;
            batch.n_seq_id[i]  = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i]    = 0;
        }
        if (nProcessed + cs == static_cast<int>(inputTokens.size())) batch.logits[cs-1] = 1;
        if (api_->decode(ctx, batch) != 0) {
            onError("llama_decode (prefill) failed");
            api_->batch_free(batch); api_->memory_clear(api_->get_memory(ctx), true);
            return;
        }
        nProcessed += cs;
    }

    const float temp = temperature > 0.0 ? static_cast<float>(temperature) : 0.7f;
    const float pr   = static_cast<float>(config_.getLlamacppRepeatPenalty());
    const float topP = static_cast<float>(config_.getLlamacppTopP());
    const float minP = static_cast<float>(config_.getLlamacppMinP());

    llama_sampler* sampler = api_->sampler_chain_init(api_->sampler_chain_default_params());
    api_->sampler_chain_add(sampler, api_->sampler_init_penalties(64, pr,   0.0f, 0.0f));
    api_->sampler_chain_add(sampler, api_->sampler_init_top_p(topP, 1));
    api_->sampler_chain_add(sampler, api_->sampler_init_min_p(minP, 1));
    api_->sampler_chain_add(sampler, api_->sampler_init_temp(temp));
    api_->sampler_chain_add(sampler, api_->sampler_init_dist(LLAMA_DEFAULT_SEED));

    int nGen = 0; bool cancelled = false;
    while (nGen < maxTokens && !cancelled) {
        if (!onChunk("")) { cancelled = true; break; }
        llama_token tok = api_->sampler_sample(sampler, ctx, -1);
        if (api_->vocab_is_eog(vocab, tok)) break;
        char piece[256];
        int np = api_->token_to_piece(vocab, tok, piece, sizeof(piece)-1, 0, false);
        if (np < 0) np = 0;
        if (np > 0) {
            piece[np] = '\0';
            if (!onChunk(makeContentChunk(std::string(piece, static_cast<size_t>(np))))) { cancelled = true; break; }
        }
        batch.n_tokens = 1; batch.token[0] = tok;
        batch.pos[0]   = static_cast<int>(inputTokens.size()) + nGen;
        batch.n_seq_id[0] = 1; batch.seq_id[0][0] = 0; batch.logits[0] = 1;
        if (api_->decode(ctx, batch) != 0) { onError("llama_decode (generation) failed"); break; }
        ++nGen;
    }

    api_->sampler_free(sampler);
    api_->batch_free(batch);
    api_->memory_clear(api_->get_memory(ctx), true);
    if (!cancelled) onChunk("data: [DONE]\n\n");

    std::cout << "[LlamaCpp] Inference completed (generated " << nGen << " tokens)\n";
}

// =============================================================================
// doInferenceCollect — runs inference and returns the full generated text.
// Used ONLY for intermediate tool-detection rounds, never the final round.
// =============================================================================

std::string LlamaCppService::doInferenceCollect(
    const std::vector<std::pair<std::string, std::string>>& messages,
    int maxTokens, double temperature,
    std::function<bool()> cancelCheck,
    std::function<void(const std::string&)> onError
) const {
    std::string collected;

    auto onChunk = [&](const std::string& chunk) -> bool {
        if (cancelCheck && cancelCheck()) return false;
        if (!chunk.empty() && chunk != "data: [DONE]\n\n") {
            const std::string prefix = "data: ";
            if (chunk.size() > prefix.size() && chunk.substr(0, prefix.size()) == prefix) {
                std::string jsonStr = chunk.substr(prefix.size());
                while (!jsonStr.empty() && (jsonStr.back() == '\n' || jsonStr.back() == '\r'))
                    jsonStr.pop_back();
                Json::Value parsed;
                Json::CharReaderBuilder rb;
                std::string errs;
                std::istringstream ss(jsonStr);
                if (Json::parseFromStream(rb, ss, &parsed, &errs)) {
                    if (parsed.isMember("choices") && parsed["choices"].isArray()
                            && !parsed["choices"].empty()) {
                        const auto& delta = parsed["choices"][0]["delta"];
                        if (delta.isMember("content") && delta["content"].isString())
                            collected += delta["content"].asString();
                    }
                }
            }
        }
        return true;
    };

    doInference(messages, maxTokens, temperature, onChunk, onError);
    return collected;
}

// =============================================================================
// Public streaming entry points
// =============================================================================

void LlamaCppService::streamingChatWithCallback(
    const std::string&, const std::string& prompt, int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    const std::string& systemPrompt, double temperature, int)
{
    std::unique_lock<std::mutex> lock(inferMutex_);
    if (!modelLoaded_) {
        if (!ensureModelLoaded()) { onError("No llama.cpp model loaded"); return; }
    }
    doInference(parseMessages(prompt, systemPrompt), maxTokens, temperature, onChunk, onError);
}

// =============================================================================
// streamingChatWithTools — MCP tool-call loop for llama.cpp
//
// Key design principle for streaming correctness:
//   • Only INTERMEDIATE rounds (where a tool call was detected) use
//     doInferenceCollect — the output is never forwarded to the client,
//     only tool-execution events and reasoning annotations are sent.
//   • The FINAL round (when no tool call is detected, or no tools exist)
//     always calls doInference directly so every token is streamed live
//     to the client as it is generated. No buffering, no re-emission.
//
// This means the client always sees real token-by-token streaming on the
// response the user actually reads.
// =============================================================================

void LlamaCppService::streamingChatWithTools(
    const std::string&, Json::Value messages, const Json::Value& tools, int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    McpRegistry* registry, double temperature, int)
{
    std::unique_lock<std::mutex> lock(inferMutex_);
    if (!modelLoaded_) {
        if (!ensureModelLoaded()) { onError("No llama.cpp model loaded"); return; }
    }

    const bool hasTools = tools.isArray() && !tools.empty() && registry;

    // ── Convert OpenAI messages JSON array to (role, content) pairs ──────────
    // chat_apply_template only understands simple role+content pairs, so:
    //   • "tool" role messages are re-labelled as "user" with a result prefix.
    //   • Multi-part content arrays are concatenated to a single string.
    auto buildPairs = [](const Json::Value& msgs) {
        std::vector<std::pair<std::string, std::string>> pairs;
        for (const auto& msg : msgs) {
            const std::string role = msg.get("role", "user").asString();
            std::string text;
            const Json::Value& cv = msg["content"];
            if (cv.isString()) {
                text = cv.asString();
            } else if (cv.isArray()) {
                for (const auto& part : cv) {
                    if (part.get("type", "").asString() == "text")
                        text += part.get("text", "").asString();
                }
            }
            if (role == "tool") {
                if (!text.empty())
                    pairs.push_back({"user", "[Tool result]\n" + text});
            } else {
                pairs.push_back({role, text});
            }
        }
        return pairs;
    };

    // ── No tools (or no registry): stream directly, live ─────────────────────
    if (!hasTools) {
        std::vector<std::pair<std::string,std::string>> textMessages;
        std::vector<std::vector<uint8_t>> allImageData;

        for (const auto& msg : messages) {
            const std::string role = msg.get("role", "user").asString();
            std::string text;
            const Json::Value& cv = msg["content"];
            if (cv.isString()) {
                text = cv.asString();
            } else if (cv.isArray()) {
                for (const auto& part : cv) {
                    const std::string type = part.get("type","").asString();
                    if (type == "text") { text += part.get("text","").asString(); }
                    else if (type == "image_url") {
                        const std::string url = part["image_url"].get("url","").asString();
                        if (!url.empty()) {
                            auto bytes = decodeBase64Image(url);
                            if (!bytes.empty()) { allImageData.push_back(std::move(bytes)); text += "<image>\n"; }
                        }
                    }
                }
            }
            textMessages.push_back({role, text});
        }

        if (!allImageData.empty()) {
            onError("Image content received but vision support is not available in the dlopen backend.");
            return;
        }

        doInference(textMessages, maxTokens, temperature, onChunk, onError);
        return;
    }

    // ── Augment system prompt with tool schemas ───────────────────────────────
    const std::string toolAppendix = buildToolSystemPromptAppendix(tools);

    Json::Value augmentedMessages = messages;
    bool foundSystem = false;
    for (auto& msg : augmentedMessages) {
        if (msg.get("role", "").asString() == "system") {
            msg["content"] = msg.get("content", "").asString() + toolAppendix;
            foundSystem = true;
            break;
        }
    }
    if (!foundSystem) {
        Json::Value sysMsg;
        sysMsg["role"]    = "system";
        sysMsg["content"] = "You are a helpful assistant." + toolAppendix;
        Json::Value newMessages(Json::arrayValue);
        newMessages.append(sysMsg);
        for (const auto& m : augmentedMessages)
            newMessages.append(m);
        augmentedMessages = newMessages;
    }

    // ── Tool-call loop ────────────────────────────────────────────────────────
    static constexpr int kMaxToolRounds = 10;

    for (int round = 0; round < kMaxToolRounds; ++round) {
        auto pairs = buildPairs(augmentedMessages);

        // Collect this round's output so we can inspect for a tool call.
        // The collected text is NOT forwarded to the client here.
        std::string errorMsg;
        std::string response = doInferenceCollect(
            pairs, maxTokens, temperature, nullptr,
            [&](const std::string& err) { errorMsg = err; });

        if (!errorMsg.empty()) { onError(errorMsg); return; }

        std::string toolName, toolArgsJson;
        if (extractToolCall(response, toolName, toolArgsJson)) {
        	// ── Tool call: execute, emit events, loop ─────────────────────────
        	std::cout << "[LlamaCpp] Tool call detected: " << toolName << "\n";
      
        	// Reasoning annotation visible in the UI
        	if (onChunk) {
        		Json::Value fakeChoice;
        		fakeChoice["delta"]["reasoning"] = "\n*Executing tool: " + toolName + "*\n";
        		Json::Value fakeJson;
        		fakeJson["choices"].append(fakeChoice);
        		Json::StreamWriterBuilder wb;
        		wb["indentation"] = "";
        		if (!onChunk("data: " + Json::writeString(wb, fakeJson) + "\n\n")) return;
        	}
      
        	// Send tool call event to UI immediately (before execution)
        	if (onChunk) {
        		Json::Value toolCallEvent;
        		toolCallEvent["type"] = "tool_execution";
        		toolCallEvent["tool_call"]["id"]        = "llamacpp_" + std::to_string(round);
        		toolCallEvent["tool_call"]["name"]      = toolName;
        		toolCallEvent["tool_call"]["arguments"] = toolArgsJson;
        		toolCallEvent["tool_call"]["output"]    = ""; // Empty output initially
        		Json::StreamWriterBuilder wb;
        		wb["indentation"] = "";
        		if (!onChunk("data: " + Json::writeString(wb, toolCallEvent) + "\n\n")) return;
        	}
      
        	// Parse arguments
        	Json::Value args(Json::objectValue);
        	if (!toolArgsJson.empty()) {
        		Json::CharReaderBuilder rb;
        		std::string errs;
        		std::istringstream ss(toolArgsJson);
        		Json::parseFromStream(rb, ss, &args, &errs);
        	}
      
        	// Execute
        	Json::Value result = registry->callTool(toolName, args);
        	std::string resultStr;
        	if (result.isArray()) {
        		for (const auto& item : result) {
        			if (item.get("type", "").asString() == "text")
        				resultStr += item.get("text", "").asString();
        		}
        	} else {
        		Json::StreamWriterBuilder wb;
        		wb["indentation"] = "";
        		resultStr = Json::writeString(wb, result);
        	}
      
        	// Update tool_execution event with output for the UI
        	if (onChunk) {
        		Json::Value toolEvent;
        		toolEvent["type"] = "tool_execution";
        		toolEvent["tool_call"]["id"]        = "llamacpp_" + std::to_string(round);
        		toolEvent["tool_call"]["name"]      = toolName;
        		toolEvent["tool_call"]["arguments"] = toolArgsJson;
        		toolEvent["tool_call"]["output"]    = resultStr;
        		Json::StreamWriterBuilder wb;
        		wb["indentation"] = "";
        		if (!onChunk("data: " + Json::writeString(wb, toolEvent) + "\n\n")) return;
        	}

            // Append assistant + tool result, then loop
            Json::Value assistantMsg;
            assistantMsg["role"]    = "assistant";
            assistantMsg["content"] = response;
            augmentedMessages.append(assistantMsg);

            Json::Value toolResultMsg;
            toolResultMsg["role"]         = "tool";
            toolResultMsg["tool_call_id"] = "llamacpp_" + std::to_string(round);
            toolResultMsg["content"]      = resultStr;
            augmentedMessages.append(toolResultMsg);

            continue; // next round
        }

        // ── No tool call found: stream this answer LIVE ───────────────────────
        // We discard the collected text and re-run doInference so every token
        // flows directly to the client in real time. The KV cache is cleared at
        // the start of each doInference call, so this is a clean re-run.
        std::cout << "[LlamaCpp] No tool call — streaming final response live\n";
        doInference(pairs, maxTokens, temperature, onChunk, onError);
        return;
    }

    // Safety: max rounds hit — stream one last live pass
    doInference(buildPairs(augmentedMessages), maxTokens, temperature, onChunk, onError);
}