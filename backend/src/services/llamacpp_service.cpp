#include "services/llamacpp_service.h"
#include "services/mcp_registry.h"
#include "config/config.h"
#include <filesystem>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cstring>
#include <thread>

#ifdef LLAMA_CPP_VISION_AVAILABLE
#define STB_IMAGE_STATIC
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#endif

namespace fs = std::filesystem;

static std::string stemFromPath(const std::string& path) {
    fs::path p(path);
    return p.stem().string();
}

static std::string modelIdFromPath(const std::string& path) {
    return "llamacpp::" + stemFromPath(path);
}

LlamaCppService::LlamaCppService(const std::string& modelsDir, Config& config)
    : modelsDir_(modelsDir), config_(config)
{
#ifdef LLAMA_CPP_AVAILABLE
    llama_backend_init();

    llama_log_set([](ggml_log_level level, const char* text, void*) {
        if (level == GGML_LOG_LEVEL_ERROR) {
            std::cerr << "[LlamaCpp] " << text;
        }
    }, nullptr);

    std::cout << "[LlamaCpp] Backend initialised\n";
#else
    std::cout << "[LlamaCpp] Built without LLAMA_CPP_AVAILABLE — inference disabled\n";
#endif

    // Model loading is deferred to the first inference call (lazy loading).
    // No .gguf scan is performed here.
    if (!fs::exists(modelsDir_)) {
        std::cout << "[LlamaCpp] Models directory does not exist: " << modelsDir_ << "\n";
    } else {
        std::cout << "[LlamaCpp] Model will be loaded on first message generation\n";
    }
}

LlamaCppService::~LlamaCppService() {
#ifdef LLAMA_CPP_AVAILABLE
    if (ctx_)   { llama_free(ctx_);         ctx_   = nullptr; }
    if (model_) { llama_model_free(model_); model_ = nullptr; }
    llama_backend_free();
#endif

#ifdef LLAMA_CPP_VISION_AVAILABLE
    if (clipCtx_) { clip_free(clipCtx_); clipCtx_ = nullptr; }
#endif
}

bool LlamaCppService::ensureModelLoaded() {
    if (modelLoaded_) return true;

#ifndef LLAMA_CPP_AVAILABLE
    return false;
#else
    if (!fs::exists(modelsDir_)) {
        std::cout << "[LlamaCpp] Models directory does not exist: " << modelsDir_ << "\n";
        return false;
    }

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() == ".gguf") {
            const std::string fname = entry.path().filename().string();
            if (fname.find("mmproj") != std::string::npos) continue;
            if (loadModel(entry.path().string())) return true;
        }
    }

    std::cout << "[LlamaCpp] No .gguf models found in: " << modelsDir_ << "\n";
    return false;
#endif
}

bool LlamaCppService::loadModel(const std::string& path) {
#ifndef LLAMA_CPP_AVAILABLE
    (void)path;
    return false;
#else
    std::cout << "[LlamaCpp] Loading model: " << path << "\n";

    const bool   flashAttn      = config_.getLlamacppFlashAttn();
    const int    evalBatchSize  = std::max(1, config_.getLlamacppEvalBatchSize());
    const int    cfgCtxSize     = config_.getLlamacppCtxSize();
    const int    gpuLayers      = config_.getLlamacppGpuLayers();
    const int    cfgThreads     = config_.getLlamacppThreads();
    const int    cfgThreadsBatch= config_.getLlamacppThreadsBatch();

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = gpuLayers;

    llama_model* m = llama_model_load_from_file(path.c_str(), mparams);
    if (!m) {
        std::cerr << "[LlamaCpp] Failed to load model: " << path << "\n";
        return false;
    }

    uint32_t ctx_size = (cfgCtxSize > 0) ? static_cast<uint32_t>(cfgCtxSize) : 8192;
    unsigned int hw_threads = std::thread::hardware_concurrency();

    uint32_t n_threads = (cfgThreads > 0) ? static_cast<uint32_t>(cfgThreads) : (hw_threads > 0 ? std::max(1u, hw_threads / 2) : 4);
    uint32_t n_threads_batch = (cfgThreadsBatch > 0) ? static_cast<uint32_t>(cfgThreadsBatch) : (hw_threads > 0 ? hw_threads : 4);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx           = ctx_size;
    cparams.n_batch         = static_cast<uint32_t>(evalBatchSize);
    cparams.n_ubatch        = static_cast<uint32_t>(evalBatchSize);
    cparams.n_threads       = n_threads;
    cparams.n_threads_batch = n_threads_batch;

    cparams.flash_attn_type = flashAttn ? LLAMA_FLASH_ATTN_TYPE_ENABLED
                                        : LLAMA_FLASH_ATTN_TYPE_AUTO;

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
    n_ctx_           = static_cast<int>(ctx_size);
    n_batch_         = evalBatchSize;
    loadedModelPath_ = path;
    loadedModelId_   = modelIdFromPath(path);
    modelLoaded_     = true;

    std::cout << "[LlamaCpp] Model ready: " << loadedModelId_ << "\n"
              << "  ctx=" << n_ctx_ << "  batch=" << n_batch_
              << "  flash_attn=" << (flashAttn ? "on" : "off")
              << "  gpu_layers=" << gpuLayers
              << "  threads=" << n_threads << "/" << n_threads_batch << "\n";

#ifdef LLAMA_CPP_VISION_AVAILABLE
    {
        const fs::path modelDir = fs::path(path).parent_path();
        for (const auto& entry : fs::directory_iterator(modelDir)) {
            const std::string fname = entry.path().filename().string();
            if (entry.path().extension() == ".gguf" &&
                fname.find("mmproj") != std::string::npos) {

                clip_context_params clipParams{};
                clip_init_result clipResult =
                    clip_init(entry.path().string().c_str(), clipParams);

                if (clipResult.ctx_a) {
                    clip_free(clipResult.ctx_a);
                    clipResult.ctx_a = nullptr;
                }

                if (clipResult.ctx_v) {
                    if (clipCtx_) clip_free(clipCtx_);
                    clipCtx_       = clipResult.ctx_v;
                    visionEnabled_ = true;
                    std::cout << "[LlamaCpp] Vision projector loaded: " << fname << "\n";
                } else {
                    std::cerr << "[LlamaCpp] Found mmproj file but clip_init failed: "
                              << fname << "\n";
                }
                break;
            }
        }
        if (!visionEnabled_) {
            std::cout << "[LlamaCpp] No mmproj file found in " << modelDir.string()
                      << " — vision disabled.\n";
        }
    }
#endif

    return true;
#endif
}

Json::Value LlamaCppService::getModels() const {
    Json::Value out;
    out["data"] = Json::Value(Json::arrayValue);

#ifdef LLAMA_CPP_AVAILABLE
    if (!fs::exists(modelsDir_)) return out;

    for (const auto& entry : fs::directory_iterator(modelsDir_)) {
        if (entry.path().extension() != ".gguf") continue;

        const std::string fname = entry.path().filename().string();
        if (fname.find("mmproj") != std::string::npos) continue;

        const std::string path = entry.path().string();
        const std::string id   = modelIdFromPath(path);

        Json::Value m;
        m["id"]             = id;
        m["name"]           = stemFromPath(path);
        m["source"]         = "llamacpp";
        m["context_length"] = n_ctx_;
        m["max_tokens"]     = 8192;
        m["loaded"]         = (modelLoaded_ && loadedModelPath_ == path);
        out["data"].append(m);
    }
#endif
    return out;
}

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

std::vector<uint8_t> LlamaCppService::decodeBase64Image(const std::string& dataUrl) {
    const size_t commaPos = dataUrl.find(',');
    const std::string b64 = (commaPos != std::string::npos)
        ? dataUrl.substr(commaPos + 1)
        : dataUrl;

    uint8_t dt[256];
    std::fill(dt, dt + 256, static_cast<uint8_t>(0xFF));
    for (int i = 0; i < 26; ++i) {
        dt[static_cast<uint8_t>('A' + i)] = static_cast<uint8_t>(i);
        dt[static_cast<uint8_t>('a' + i)] = static_cast<uint8_t>(26 + i);
    }
    for (int i = 0; i < 10; ++i)
        dt[static_cast<uint8_t>('0' + i)] = static_cast<uint8_t>(52 + i);
    dt[static_cast<uint8_t>('+')] = 62;
    dt[static_cast<uint8_t>('/')] = 63;

    std::vector<uint8_t> out;
    out.reserve(b64.size() * 3 / 4);

    uint32_t buf  = 0;
    int      bits = 0;
    for (unsigned char c : b64) {
        if (c == '=') break;
        if (dt[c] == 0xFF) continue;
        buf  = (buf << 6) | static_cast<uint32_t>(dt[c]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((buf >> bits) & 0xFF));
        }
    }
    return out;
}

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

    if (maxTokens <= 0) maxTokens = 8192;

    const llama_vocab* vocab = llama_model_get_vocab(model_);

    int maxInputTokens = n_ctx_ - 4;
    if (maxInputTokens <= 0) {
        onError("Context too small for inference");
        return;
    }

    std::string formattedPrompt;
    std::vector<llama_token> inputTokens;
    std::vector<std::pair<std::string, std::string>> currentMessages = messages;

    size_t firstNonSystem = 0;
    while (firstNonSystem < currentMessages.size() && currentMessages[firstNonSystem].first == "system") {
        firstNonSystem++;
    }

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
            nullptr, chatMsgs.data(), chatMsgs.size(), true, nullptr, 0);

        if (tmplLen < 0) {
            onError("llama_chat_apply_template failed (unsupported template?)");
            return;
        }

        std::vector<char> tmplBuf(static_cast<size_t>(tmplLen) + 1, '\0');
        llama_chat_apply_template(
            nullptr, chatMsgs.data(), chatMsgs.size(), true,
            tmplBuf.data(), static_cast<int32_t>(tmplBuf.size()));
        formattedPrompt = std::string(tmplBuf.data(), static_cast<size_t>(tmplLen));

        int reqTokens = llama_tokenize(
            vocab, formattedPrompt.c_str(),
            static_cast<int32_t>(formattedPrompt.size()),
            nullptr, 0, false, true);
        if (reqTokens < 0) reqTokens = -reqTokens;

        if (reqTokens <= maxInputTokens || currentMessages.size() <= firstNonSystem + 1) {
            inputTokens.resize(reqTokens);
            int nTokens = llama_tokenize(
                vocab, formattedPrompt.c_str(),
                static_cast<int32_t>(formattedPrompt.size()),
                inputTokens.data(), static_cast<int32_t>(inputTokens.size()),
                false, true);
            if (nTokens < 0) nTokens = -nTokens;
            inputTokens.resize(static_cast<size_t>(nTokens));

            if (nTokens > maxInputTokens) {
                size_t excess = nTokens - maxInputTokens;
                inputTokens.erase(inputTokens.begin(), inputTokens.begin() + excess);
                std::cerr << "[LlamaCpp] Warning: prompt forcefully truncated by "
                          << excess << " tokens from the beginning\n";
            }
            break;
        }

        currentMessages.erase(currentMessages.begin() + firstNonSystem);
    }

    int remainingCtx = n_ctx_ - inputTokens.size() - 1;
    if (maxTokens > remainingCtx) maxTokens = remainingCtx;
    if (maxTokens <= 0) {
        onError("Prompt fills the entire context window");
        return;
    }

    llama_memory_clear(llama_get_memory(ctx_), true);

    llama_batch batch = llama_batch_init(n_batch_, 0, 1);

    int nProcessed = 0;
    while (nProcessed < static_cast<int>(inputTokens.size())) {
        if (!onChunk("")) {
            llama_batch_free(batch);
            llama_memory_clear(llama_get_memory(ctx_), true);
            return;
        }

        int chunkSize = std::min(n_batch_, static_cast<int>(inputTokens.size()) - nProcessed);
        batch.n_tokens = chunkSize;
        for (int i = 0; i < chunkSize; ++i) {
            batch.token[i]     = inputTokens[nProcessed + i];
            batch.pos[i]       = nProcessed + i;
            batch.n_seq_id[i]  = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i]    = 0;
        }
        if (nProcessed + chunkSize == static_cast<int>(inputTokens.size()))
            batch.logits[chunkSize - 1] = 1;

        if (llama_decode(ctx_, batch) != 0) {
            onError("llama_decode (prefill) failed");
            llama_batch_free(batch);
            llama_memory_clear(llama_get_memory(ctx_), true);
            return;
        }
        nProcessed += chunkSize;
    }

    float temp           = (temperature > 0.0) ? static_cast<float>(temperature) : 0.7f;
    float penaltyRepeat  = static_cast<float>(config_.getLlamacppRepeatPenalty());
    float topP           = static_cast<float>(config_.getLlamacppTopP());
    float minP           = static_cast<float>(config_.getLlamacppMinP());

    llama_sampler* sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(64, penaltyRepeat, 0.0f, 0.0f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(topP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_min_p(minP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    int  nGenerated = 0;
    bool cancelled  = false;

    while (nGenerated < maxTokens && !cancelled) {
        if (!onChunk("")) { cancelled = true; break; }

        llama_token token = llama_sampler_sample(sampler, ctx_, -1);
        if (llama_vocab_is_eog(vocab, token)) break;

        char piece[256];
        int  nPiece = llama_token_to_piece(vocab, token, piece, sizeof(piece) - 1, 0, false);
        if (nPiece < 0) nPiece = 0;

        if (nPiece > 0) {
            piece[nPiece] = '\0';
            if (!onChunk(makeContentChunk(std::string(piece, static_cast<size_t>(nPiece))))) {
                cancelled = true;
                break;
            }
        }

        batch.n_tokens     = 1;
        batch.token[0]     = token;
        batch.pos[0]       = inputTokens.size() + nGenerated;
        batch.n_seq_id[0]  = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0]    = 1;

        if (llama_decode(ctx_, batch) != 0) {
            onError("llama_decode (generation) failed");
            break;
        }
        ++nGenerated;
    }

    llama_sampler_free(sampler);
    llama_batch_free(batch);
    llama_memory_clear(llama_get_memory(ctx_), true);

    if (!cancelled) onChunk("data: [DONE]\n\n");
#endif
}

#ifdef LLAMA_CPP_VISION_AVAILABLE
void LlamaCppService::doInferenceWithVision(
    const std::vector<std::pair<std::string, std::string>>& messages,
    const std::vector<std::vector<uint8_t>>& imageDataList,
    int maxTokens,
    double temperature,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError
) const {
    if (!model_ || !ctx_ || !clipCtx_) {
        onError("Vision inference unavailable: model or vision projector not loaded");
        return;
    }
    if (maxTokens <= 0) maxTokens = 8192;

    const llama_vocab* vocab    = llama_model_get_vocab(model_);
    const int          maxInput = n_ctx_ - 4;

    auto applyTemplate = [&](const std::vector<std::pair<std::string, std::string>>& msgs) -> std::string {
        std::vector<std::string> store;
        store.reserve(msgs.size());
        std::vector<llama_chat_message> cm;
        cm.reserve(msgs.size());
        for (const auto&[role, text] : msgs) {
            store.push_back(text);
            cm.push_back({role.c_str(), store.back().c_str()});
        }
        const int len = llama_chat_apply_template(nullptr, cm.data(), cm.size(), true, nullptr, 0);
        if (len < 0) return "";
        std::vector<char> buf(static_cast<size_t>(len) + 1, '\0');
        llama_chat_apply_template(nullptr, cm.data(), cm.size(), true, buf.data(), static_cast<int32_t>(buf.size()));
        return std::string(buf.data(), static_cast<size_t>(len));
    };

    const std::string promptFull = applyTemplate(messages);
    if (promptFull.empty()) {
        onError("llama_chat_apply_template failed (unsupported template?)");
        return;
    }

    std::vector<std::string> promptChunks;
    std::string remaining = promptFull;
    const std::string delim = "<image>";

    for (size_t i = 0; i < imageDataList.size(); ++i) {
        size_t pos = remaining.find(delim);
        if (pos == std::string::npos) {
            std::cerr << "[LlamaCpp] Warning: Not enough <image> placeholders in rendered prompt. The chat template might have stripped them.\n";
            break;
        }
        promptChunks.push_back(remaining.substr(0, pos));
        remaining = remaining.substr(pos + delim.length());
    }
    promptChunks.push_back(remaining);

    // IMPORTANT: Because applyTemplate handles the template boundary tokens (BOS, IM_START, etc)
    // we explicitly pass `false` for add_special so we don't accidentally double-inject BOS
    // tokens at the start of each text chunk, which corrupts the LLM's understanding of where it is.
    auto tokenize = [&](const std::string& s) -> std::vector<llama_token> {
        int n = llama_tokenize(vocab, s.c_str(), static_cast<int32_t>(s.size()), nullptr, 0, false, true);
        if (n < 0) n = -n;
        std::vector<llama_token> toks(static_cast<size_t>(n));
        int actual = llama_tokenize(vocab, s.c_str(), static_cast<int32_t>(s.size()), toks.data(), n, false, true);
        if (actual < 0) actual = -actual;
        toks.resize(static_cast<size_t>(actual));
        return toks;
    };

    llama_memory_clear(llama_get_memory(ctx_), true);
    llama_batch batch = llama_batch_init(n_batch_, 0, 1);
    int nPast = 0;

    auto evalSpan = [&](const std::vector<llama_token>& toks, bool setFinalLogit) -> bool {
        int i = 0;
        int count = static_cast<int>(toks.size());
        while (i < count) {
            if (!onChunk("")) return false;
            const int chunk = std::min(n_batch_, count - i);
            batch.n_tokens = chunk;
            for (int j = 0; j < chunk; ++j) {
                batch.token[j]     = toks[i + j];
                batch.pos[j]       = nPast + j;
                batch.n_seq_id[j]  = 1;
                batch.seq_id[j][0] = 0;
                batch.logits[j]    = 0;
            }
            if (setFinalLogit && (i + chunk == count)) {
                batch.logits[chunk - 1] = 1;
            }
            if (llama_decode(ctx_, batch) != 0) {
                onError("llama_decode (vision prefill) failed");
                return false;
            }
            nPast += chunk;
            i     += chunk;
        }
        return true;
    };

    const int nThreads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()));
    const int nEmbd    = clip_n_mmproj_embd(clipCtx_);

    for (size_t i = 0; i < promptChunks.size(); ++i) {
        std::vector<llama_token> toks = tokenize(promptChunks[i]);
        
        if (!toks.empty()) {
            bool isLast = (i == promptChunks.size() - 1);
            if (!evalSpan(toks, isLast)) {
                llama_batch_free(batch);
                llama_memory_clear(llama_get_memory(ctx_), true);
                return;
            }
        }

        if (i < imageDataList.size()) {
            if (!onChunk("")) {
                llama_batch_free(batch);
                llama_memory_clear(llama_get_memory(ctx_), true);
                return;
            }

            const auto& imgBytes = imageDataList[i];
            int imgW = 0, imgH = 0, imgChannels = 0;
            unsigned char* rawPixels = stbi_load_from_memory(
                imgBytes.data(), static_cast<int>(imgBytes.size()),
                &imgW, &imgH, &imgChannels, 3);
            
            if (!rawPixels) {
                std::cerr << "[LlamaCpp] stbi_load_from_memory failed — skipping image\n";
                continue;
            }

            clip_image_u8* imgU8 = clip_image_u8_init();
            clip_build_img_from_pixels(rawPixels, imgW, imgH, imgU8);
            stbi_image_free(rawPixels);

            clip_image_f32_batch* batchF32 = clip_image_f32_batch_init();
            if (!clip_image_preprocess(clipCtx_, imgU8, batchF32)) {
                std::cerr << "[LlamaCpp] clip_image_preprocess failed — skipping image\n";
                clip_image_u8_free(imgU8);
                clip_image_f32_batch_free(batchF32);
                continue;
            }
            clip_image_u8_free(imgU8);

            const size_t nSubImages = clip_image_f32_batch_n_images(batchF32);
            for (size_t si = 0; si < nSubImages; ++si) {
                clip_image_f32* imgF32 = clip_image_f32_get_img(batchF32, static_cast<int>(si));
                const int nPatches = clip_n_output_tokens(clipCtx_, imgF32);
                std::vector<float> emb(static_cast<size_t>(nPatches * nEmbd));

                if (!clip_image_encode(clipCtx_, nThreads, imgF32, emb.data())) {
                    std::cerr << "[LlamaCpp] clip_image_encode failed — skipping sub-image " << si << "\n";
                    continue;
                }

                for (int p = 0; p < nPatches; p += n_batch_) {
                    int chunk = std::min(n_batch_, nPatches - p);
                    llama_batch embdBatch = llama_batch_init(chunk, nEmbd, 1);
                    for (int j = 0; j < chunk; ++j) {
                        std::memcpy(embdBatch.embd + j * nEmbd,
                                    emb.data() + (p + j) * nEmbd,
                                    static_cast<size_t>(nEmbd) * sizeof(float));
                        embdBatch.pos[j]       = nPast + p + j;
                        embdBatch.n_seq_id[j]  = 1;
                        embdBatch.seq_id[j][0] = 0;
                        
                        bool isVeryLast = (i == promptChunks.size() - 1) && (si == nSubImages - 1) && ((p + j) == nPatches - 1);
                        embdBatch.logits[j]    = isVeryLast ? 1 : 0; 
                    }
                    embdBatch.n_tokens = chunk;

                    if (llama_decode(ctx_, embdBatch) != 0) {
                        llama_batch_free(embdBatch);
                        clip_image_f32_batch_free(batchF32);
                        onError("llama_decode (image embed) failed");
                        llama_batch_free(batch);
                        llama_memory_clear(llama_get_memory(ctx_), true);
                        return;
                    }
                    llama_batch_free(embdBatch);
                }
                nPast += nPatches;
            }
            clip_image_f32_batch_free(batchF32);
        }
    }

    const int remainCtx = n_ctx_ - nPast - 1;
    if (maxTokens > remainCtx) maxTokens = remainCtx;
    if (maxTokens <= 0) {
        onError("No context remaining after vision prefill");
        llama_batch_free(batch);
        llama_memory_clear(llama_get_memory(ctx_), true);
        return;
    }

    const float temp          = (temperature > 0.0) ? static_cast<float>(temperature) : 0.7f;
    const float penaltyRepeat = static_cast<float>(config_.getLlamacppRepeatPenalty());
    const float topP          = static_cast<float>(config_.getLlamacppTopP());
    const float minP          = static_cast<float>(config_.getLlamacppMinP());

    llama_sampler* sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(64, penaltyRepeat, 0.0f, 0.0f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(topP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_min_p(minP, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    int  nGenerated = 0;
    bool cancelled  = false;

    while (nGenerated < maxTokens && !cancelled) {
        if (!onChunk("")) { cancelled = true; break; }

        const llama_token token = llama_sampler_sample(sampler, ctx_, -1);
        if (llama_vocab_is_eog(vocab, token)) break;

        char piece[256];
        int  nPiece = llama_token_to_piece(vocab, token, piece, sizeof(piece) - 1, 0, false);
        if (nPiece < 0) nPiece = 0;

        if (nPiece > 0) {
            piece[nPiece] = '\0';
            if (!onChunk(makeContentChunk(std::string(piece, static_cast<size_t>(nPiece))))) {
                cancelled = true;
                break;
            }
        }

        batch.n_tokens     = 1;
        batch.token[0]     = token;
        batch.pos[0]       = nPast + nGenerated;
        batch.n_seq_id[0]  = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0]    = 1;

        if (llama_decode(ctx_, batch) != 0) {
            onError("llama_decode (generation) failed");
            break;
        }
        ++nGenerated;
    }

    llama_sampler_free(sampler);
    llama_batch_free(batch);
    llama_memory_clear(llama_get_memory(ctx_), true);

    if (!cancelled) onChunk("data: [DONE]\n\n");
}
#endif // LLAMA_CPP_VISION_AVAILABLE

void LlamaCppService::streamingChatWithCallback(
    const std::string& /*model*/,
    const std::string& prompt,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    const std::string& systemPrompt,
    double temperature,
    int /*numCtx*/
) {
    // Lazy load: load the model on the first generation request if not yet loaded.
    if (!modelLoaded_) {
        std::cout << "[LlamaCpp] Model not loaded — loading now before generation...\n";
        if (!ensureModelLoaded()) {
            onError("No llama.cpp model loaded");
            return;
        }
    }

    auto messages = parseMessages(prompt, systemPrompt);
    std::unique_lock<std::mutex> lock(inferMutex_);
    doInference(messages, maxTokens, temperature, onChunk, onError);
}

void LlamaCppService::streamingChatWithTools(
    const std::string& /*model*/,
    Json::Value messages,
    const Json::Value& tools,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    McpRegistry* /*registry*/,
    double temperature,
    int /*numCtx*/
) {
    // Lazy load: load the model on the first generation request if not yet loaded.
    if (!modelLoaded_) {
        std::cout << "[LlamaCpp] Model not loaded — loading now before generation...\n";
        if (!ensureModelLoaded()) {
            onError("No llama.cpp model loaded");
            return;
        }
    }

    if (tools.isArray() && !tools.empty())
        std::cout << "[LlamaCpp] Tool calls not yet supported — running without tools\n";

    std::vector<std::pair<std::string, std::string>> textMessages;
    textMessages.reserve(static_cast<size_t>(messages.size()));

    std::vector<std::vector<uint8_t>> allImageData;

    for (const auto& msg : messages) {
        const std::string role = msg.get("role", "user").asString();
        std::string text;

        const Json::Value& contentVal = msg["content"];

        if (contentVal.isString()) {
            text = contentVal.asString();
        } else if (contentVal.isArray()) {
            for (const auto& part : contentVal) {
                const std::string type = part.get("type", "").asString();
                if (type == "text") {
                    text += part.get("text", "").asString();
                } else if (type == "image_url") {
                    const std::string url = part["image_url"].get("url", "").asString();
                    if (!url.empty()) {
                        auto bytes = decodeBase64Image(url);
                        if (!bytes.empty()) {
                            allImageData.push_back(std::move(bytes));
                            text += "<image>\n";
                        } else {
                            std::cerr << "[LlamaCpp] image_url decoded to 0 bytes — skipping\n";
                        }
                    }
                }
            }
        }

        textMessages.push_back({role, text});
    }

    std::unique_lock<std::mutex> lock(inferMutex_);

#ifdef LLAMA_CPP_VISION_AVAILABLE
    if (!allImageData.empty()) {
        if (visionEnabled_) {
            doInferenceWithVision(
                textMessages,
                allImageData,
                maxTokens, temperature, onChunk, onError);
            return;
        } else {
            onError("Image content received but no multimodal projector is loaded. "
                    "Place a *mmproj*.gguf alongside the model to enable vision.");
            return;
        }
    }
#else
    if (!allImageData.empty()) {
        onError("Image content received but llama.cpp vision support is not enabled in this build.");
        return;
    }
#endif

    doInference(textMessages, maxTokens, temperature, onChunk, onError);
}