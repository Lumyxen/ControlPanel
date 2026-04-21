#include "services/llamacpp_service.h"
#include "services/tools/tool_system.h"

#include "config/config.h"
#include "server/http_utils.h"
#include "services/mcp_registry.h"

#include <curl/curl.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <thread>
#include <tuple>

#ifndef _WIN32
#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {

constexpr int kTitleGenerationMaxTokens = 24;
constexpr std::string_view kMropeMetadataSuffix = ".rope.dimension_sections";

struct StreamContext {
    std::function<bool(const std::string&)> onChunk;
    std::string buffer;

    struct ToolCallAccum {
        std::string id;
        std::string name;
        std::string argumentsJson;
    };

    std::vector<ToolCallAccum> toolCalls;
    std::string finishReason;
};

std::vector<Json::Value> buildNormalizedContentDeltas(
    const Json::Value& choice,
    const Json::Value& delta) {
    std::vector<Json::Value> normalized;

    const std::string deltaContent =
        delta.isMember("content") && delta["content"].isString()
            ? delta["content"].asString()
            : "";

    if (deltaContent.empty()) {
        return normalized;
    }

    const Json::Value* logprobEntries = nullptr;
    if (choice.isMember("logprobs") && choice["logprobs"].isObject() &&
        choice["logprobs"].isMember("content") && choice["logprobs"]["content"].isArray()) {
        logprobEntries = &choice["logprobs"]["content"];
    }

    if (logprobEntries && !logprobEntries->empty()) {
        std::string reconstructed;
        bool appended = false;

        for (const auto& entry : *logprobEntries) {
            if (!entry.isObject()) {
                continue;
            }

            const std::string token = entry.get("token", "").asString();
            if (token.empty()) {
                continue;
            }

            Json::Value normalizedDelta(Json::objectValue);
            normalizedDelta["content"] = token;
            if (entry.isMember("logprob")) {
                normalizedDelta["logprob"] = entry["logprob"];
            }
            normalized.push_back(normalizedDelta);
            reconstructed += token;
            appended = true;
        }

        if (appended && (deltaContent.empty() || reconstructed == deltaContent)) {
            return normalized;
        }

        normalized.clear();
    }

    if (!deltaContent.empty()) {
        Json::Value normalizedDelta(Json::objectValue);
        normalizedDelta["content"] = deltaContent;
        if (delta.isMember("logprob")) {
            normalizedDelta["logprob"] = delta["logprob"];
        } else if (logprobEntries && logprobEntries->size() == 1 &&
                   (*logprobEntries)[0].isObject() &&
                   (*logprobEntries)[0].isMember("logprob")) {
            normalizedDelta["logprob"] = (*logprobEntries)[0]["logprob"];
        }
        normalized.push_back(normalizedDelta);
    }

    return normalized;
}

bool emitNormalizedDelta(StreamContext* ctx, const Json::Value& normalizedDelta) {
    if (normalizedDelta.empty()) {
        return true;
    }

    Json::Value normalizedChoice(Json::objectValue);
    normalizedChoice["delta"] = normalizedDelta;

    Json::Value normalizedJson(Json::objectValue);
    normalizedJson["choices"].append(normalizedChoice);

    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    return !ctx->onChunk ||
        ctx->onChunk("data: " + Json::writeString(writer, normalizedJson) + "\n\n");
}

size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    static_cast<std::string*>(userp)->append(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

bool readExact(std::ifstream& stream, void* buffer, std::size_t size) {
    if (size == 0) {
        return true;
    }
    stream.read(static_cast<char*>(buffer), static_cast<std::streamsize>(size));
    return static_cast<std::size_t>(stream.gcount()) == size;
}

template <typename T>
bool readExact(std::ifstream& stream, T& value) {
    static_assert(std::is_trivially_copyable_v<T>);
    return readExact(stream, &value, sizeof(T));
}

bool skipBytes(std::ifstream& stream, std::uint64_t size) {
    if (size > static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max())) {
        return false;
    }
    stream.seekg(static_cast<std::streamoff>(size), std::ios::cur);
    return static_cast<bool>(stream);
}

bool readGgufString(std::ifstream& stream, std::string& out) {
    std::uint64_t size = 0;
    if (!readExact(stream, size)) {
        return false;
    }
    if (size > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return false;
    }
    out.resize(static_cast<std::size_t>(size));
    return readExact(stream, out.data(), out.size());
}

bool skipGgufString(std::ifstream& stream) {
    std::uint64_t size = 0;
    return readExact(stream, size) && skipBytes(stream, size);
}

std::size_t ggufPrimitiveSize(std::int32_t type) {
    switch (type) {
        case 0:  // GGUF_TYPE_UINT8
        case 1:  // GGUF_TYPE_INT8
        case 7:  // GGUF_TYPE_BOOL
            return 1;
        case 2:  // GGUF_TYPE_UINT16
        case 3:  // GGUF_TYPE_INT16
            return 2;
        case 4:  // GGUF_TYPE_UINT32
        case 5:  // GGUF_TYPE_INT32
        case 6:  // GGUF_TYPE_FLOAT32
            return 4;
        case 10: // GGUF_TYPE_UINT64
        case 11: // GGUF_TYPE_INT64
        case 12: // GGUF_TYPE_FLOAT64
            return 8;
        default:
            return 0;
    }
}

bool skipGgufValue(std::ifstream& stream, std::int32_t type) {
    if (type == 8) { // GGUF_TYPE_STRING
        return skipGgufString(stream);
    }

    if (type == 9) { // GGUF_TYPE_ARRAY
        std::int32_t elementType = -1;
        std::uint64_t count = 0;
        if (!readExact(stream, elementType) || !readExact(stream, count)) {
            return false;
        }

        if (elementType == 8) { // GGUF_TYPE_STRING
            for (std::uint64_t index = 0; index < count; ++index) {
                if (!skipGgufString(stream)) {
                    return false;
                }
            }
            return true;
        }

        if (elementType == 9) { // GGUF_TYPE_ARRAY
            for (std::uint64_t index = 0; index < count; ++index) {
                if (!skipGgufValue(stream, 9)) {
                    return false;
                }
            }
            return true;
        }

        const std::size_t elementSize = ggufPrimitiveSize(elementType);
        if (elementSize == 0) {
            return false;
        }
        if (count > std::numeric_limits<std::uint64_t>::max() / elementSize) {
            return false;
        }
        return skipBytes(stream, count * elementSize);
    }

    const std::size_t primitiveSize = ggufPrimitiveSize(type);
    return primitiveSize != 0 && skipBytes(stream, primitiveSize);
}

bool ggufUsesMrope(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) {
        return false;
    }

    std::array<char, 4> magic{};
    if (!readExact(stream, magic.data(), magic.size()) ||
        magic[0] != 'G' || magic[1] != 'G' || magic[2] != 'U' || magic[3] != 'F') {
        return false;
    }

    std::uint32_t version = 0;
    std::int64_t tensorCount = 0;
    std::int64_t kvCount = 0;
    if (!readExact(stream, version) ||
        !readExact(stream, tensorCount) ||
        !readExact(stream, kvCount)) {
        return false;
    }

    if (version == 0 || version > 3 || tensorCount < 0 || kvCount < 0) {
        return false;
    }

    for (std::int64_t index = 0; index < kvCount; ++index) {
        std::string key;
        std::int32_t type = -1;
        if (!readGgufString(stream, key) || !readExact(stream, type)) {
            return false;
        }
        if (std::string_view(key).ends_with(kMropeMetadataSuffix)) {
            return true;
        }
        if (!skipGgufValue(stream, type)) {
            return false;
        }
    }

    return false;
}

std::size_t countMropeModels(const std::vector<ModelInfo>& models) {
    return static_cast<std::size_t>(std::count_if(
        models.begin(),
        models.end(),
        [](const ModelInfo& model) { return model.usesMrope; }));
}

bool isShardFile(const fs::path& path) {
    const std::string stem = path.stem().string();
    return stem.find("-00001-of-") != std::string::npos || stem.find("-00002-of-") != std::string::npos;
}

std::string shardBaseName(const fs::path& path) {
    std::string stem = path.stem().string();
    const std::size_t marker = stem.find("-00001-of-");
    if (marker != std::string::npos) {
        return stem.substr(0, marker);
    }
    const std::size_t altMarker = stem.find("-00002-of-");
    if (altMarker != std::string::npos) {
        return stem.substr(0, altMarker);
    }
    return stem;
}

bool isMmprojFile(const fs::path& path) {
    if (path.extension() != ".gguf") {
        return false;
    }
    const std::string name = path.filename().string();
    return name.find("mmproj") != std::string::npos;
}

std::optional<std::string> findTokenizerPath(const fs::path& dir) {
    if (!fs::exists(dir) || !fs::is_directory(dir)) {
        return std::nullopt;
    }

    for (const auto& entry : fs::directory_iterator(dir)) {
        if (!entry.is_regular_file()) {
            continue;
        }

        const std::string name = entry.path().filename().string();
        if (name == "tokenizer.json" || name == "tokenizer_config.json" ||
            name == "vocab.json" || name == "special_tokens_map.json" ||
            name.find(".tiktoken") != std::string::npos) {
            return entry.path().string();
        }
    }

    return std::nullopt;
}

std::optional<std::string> findMmprojPath(const fs::path& dir) {
    if (!fs::exists(dir) || !fs::is_directory(dir)) {
        return std::nullopt;
    }

    for (const auto& entry : fs::directory_iterator(dir)) {
        if (entry.is_regular_file() && isMmprojFile(entry.path())) {
            return entry.path().string();
        }
    }

    return std::nullopt;
}

void trimWhitespace(std::string& value) {
    const std::size_t start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        value.clear();
        return;
    }

    const std::size_t end = value.find_last_not_of(" \t\r\n");
    value = value.substr(start, end - start + 1);
}

size_t writeCallbackStream(char* contents, size_t size, size_t nmemb, void* userp) {
    StreamContext* ctx = static_cast<StreamContext*>(userp);
    const size_t realSize = size * nmemb;
    ctx->buffer.append(contents, realSize);

    size_t pos = 0;
    while ((pos = ctx->buffer.find('\n')) != std::string::npos) {
        std::string line = ctx->buffer.substr(0, pos);
        ctx->buffer.erase(0, pos + 1);

        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (line.rfind("data: ", 0) != 0) {
            continue;
        }

        const std::string data = line.substr(6);
        if (data == "[DONE]") {
            continue;
        }

        Json::Value parsed;
        Json::CharReaderBuilder reader;
        std::string errors;
        std::istringstream stream(data);
        if (!Json::parseFromStream(reader, stream, &parsed, &errors)) {
            if (ctx->onChunk && !ctx->onChunk(line + "\n\n")) {
                return 0;
            }
            continue;
        }

        if (parsed.isMember("error")) {
            Json::StreamWriterBuilder writer;
            writer["indentation"] = "";
            if (ctx->onChunk &&
                !ctx->onChunk("data: " + Json::writeString(writer, parsed) + "\n\n")) {
                return 0;
            }
            ctx->finishReason = "_api_error_";
            continue;
        }

        if (!parsed.isMember("choices") || !parsed["choices"].isArray() || parsed["choices"].empty()) {
            continue;
        }

        const Json::Value& choice = parsed["choices"][0];
        if (choice.isMember("finish_reason") && !choice["finish_reason"].isNull()) {
            ctx->finishReason = choice["finish_reason"].asString();
        }
        if (!choice.isMember("delta")) {
            continue;
        }

        const Json::Value& delta = choice["delta"];
        if (delta.isMember("tool_calls") && delta["tool_calls"].isArray()) {
            for (const auto& toolCall : delta["tool_calls"]) {
                const int index = toolCall.get("index", 0).asInt();
                while (static_cast<int>(ctx->toolCalls.size()) <= index) {
                    ctx->toolCalls.push_back({});
                }

                auto& accum = ctx->toolCalls[index];
                if (toolCall.isMember("id") && toolCall["id"].isString()) {
                    accum.id = toolCall["id"].asString();
                }
                if (toolCall.isMember("function")) {
                    const Json::Value& function = toolCall["function"];
                    if (function.isMember("name") && function["name"].isString()) {
                        accum.name += function["name"].asString();
                    }
                    if (function.isMember("arguments") && function["arguments"].isString()) {
                        accum.argumentsJson += function["arguments"].asString();
                    }
                }
            }
            continue;
        }

        const std::string reasoningField =
            delta.isMember("reasoning_content") ? "reasoning_content" :
            delta.isMember("reasoning") ? "reasoning" : "";
        if (!reasoningField.empty() && delta[reasoningField].isString() &&
            !delta[reasoningField].asString().empty()) {
            Json::Value reasoningDelta(Json::objectValue);
            reasoningDelta["reasoning"] = delta[reasoningField].asString();
            if (!emitNormalizedDelta(ctx, reasoningDelta)) {
                return 0;
            }
        }

        for (const auto& normalizedDelta : buildNormalizedContentDeltas(choice, delta)) {
            if (!emitNormalizedDelta(ctx, normalizedDelta)) {
                return 0;
            }
        }
    }

    return realSize;
}

int progressCallback(void* clientp,
                     curl_off_t,
                     curl_off_t,
                     curl_off_t,
                     curl_off_t) {
    StreamContext* ctx = static_cast<StreamContext*>(clientp);
    if (ctx->onChunk && !ctx->onChunk("")) {
        return 1;
    }
    return 0;
}

#ifndef _WIN32
int chooseFreePort() {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return 18080;
    }

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;

    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return 18080;
    }

    socklen_t len = sizeof(addr);
    if (::getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
        ::close(fd);
        return 18080;
    }

    const int port = ntohs(addr.sin_port);
    ::close(fd);
    return port > 0 ? port : 18080;
}
#else
int chooseFreePort() {
    return 18080;
}
#endif

} // namespace

bool LlamaCppService::StartupConfig::operator==(const StartupConfig& other) const {
    return backend == other.backend &&
           parallelSlots == other.parallelSlots &&
           maxLoadedModels == other.maxLoadedModels &&
           ctxSize == other.ctxSize &&
           batchSize == other.batchSize &&
           gpuLayers == other.gpuLayers &&
           threads == other.threads &&
           threadsBatch == other.threadsBatch &&
           sleepIdleSeconds == other.sleepIdleSeconds &&
           flashAttn == other.flashAttn &&
           cachePrompt == other.cachePrompt &&
           kvCacheType == other.kvCacheType;
}

bool LlamaCppService::StartupConfig::operator!=(const StartupConfig& other) const {
    return !(*this == other);
}

LlamaCppService::LlamaCppService(const std::string& modelsDir,
                                 const std::string& libsDir,
                                 Config& config)
    : modelsDir_(modelsDir),
      libsDir_(libsDir),
      config_(config) {
    fs::create_directories(libsDir_);
    fs::create_directories(logsDir());

    std::lock_guard<std::mutex> lock(stateMutex_);
    const StartupConfig desired = buildStartupConfigLocked();
    if (desired.backend != "none") {
        startServerLocked(desired);
    }
}

LlamaCppService::~LlamaCppService() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    stopServerLocked();
}

std::string LlamaCppService::normalizeModelId(const std::string& modelId) const {
    if (modelId.rfind("llamacpp::", 0) == 0) {
        return modelId.substr(10);
    }
    return modelId;
}

std::string LlamaCppService::normalizeLoadedModelPath(const std::string& ggufPath) const {
    if (ggufPath.empty()) {
        return "";
    }
    const fs::path path(ggufPath);
    const fs::path parent = path.parent_path();
    if (parent == fs::path(modelsDir_)) {
        return "llamacpp::" + path.stem().string();
    }
    return "llamacpp::" + fs::relative(parent, modelsDir_).generic_string();
}

std::string LlamaCppService::findGgufInDirectory(const std::string& dir) const {
    const fs::path dirPath(dir);
    if (!fs::exists(dirPath) || !fs::is_directory(dirPath)) {
        return "";
    }

    for (const auto& entry : fs::directory_iterator(dirPath)) {
        if (entry.is_regular_file() && entry.path().extension() == ".gguf" && !isMmprojFile(entry.path())) {
            return entry.path().string();
        }
    }

    return "";
}

std::vector<ModelInfo> LlamaCppService::scanModelDirectory(const std::string& modelsDir,
                                                           int contextLength,
                                                           const std::string& loadedModelPath) {
    std::vector<ModelInfo> models;
    const fs::path root(modelsDir);
    if (!fs::exists(root) || !fs::is_directory(root)) {
        return models;
    }

    std::set<std::string> seenIds;
    auto addModel = [&](const std::string& relId,
                        const fs::path& ggufPath,
                        const std::optional<std::string>& mmprojPath,
                        const std::optional<std::string>& tokenizerPath) {
        if (relId.empty() || !seenIds.insert(relId).second) {
            return;
        }

        ModelInfo info;
        info.id = "llamacpp::" + relId;
        info.name = relId;
        info.directory = ggufPath.parent_path().string();
        info.ggufPath = ggufPath.string();
        info.mmprojPath = mmprojPath.value_or("");
        info.tokenizerPath = tokenizerPath.value_or("");
        info.contextLength = contextLength > 0 ? contextLength : 8192;
        info.maxTokens = 8192;
        info.loaded = !loadedModelPath.empty() && loadedModelPath == info.ggufPath;
        info.usesMrope = ggufUsesMrope(ggufPath);
        models.push_back(std::move(info));
    };

    for (const auto& entry : fs::directory_iterator(root)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".gguf" || isMmprojFile(entry.path())) {
            continue;
        }

        const std::string relId = isShardFile(entry.path())
            ? shardBaseName(entry.path())
            : entry.path().stem().string();
        addModel(relId, entry.path(), std::nullopt, findTokenizerPath(root));
    }

    std::error_code ec;
    for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec);
         !ec && it != fs::recursive_directory_iterator();
         it.increment(ec)) {
        if (ec || !it->is_directory()) {
            continue;
        }

        const fs::path dir = it->path();
        if (dir == root) {
            continue;
        }

        std::vector<fs::path> ggufs;
        for (const auto& file : fs::directory_iterator(dir)) {
            if (file.is_regular_file() && file.path().extension() == ".gguf" && !isMmprojFile(file.path())) {
                ggufs.push_back(file.path());
            }
        }
        if (ggufs.empty()) {
            continue;
        }

        std::sort(ggufs.begin(), ggufs.end());
        const std::string relDir = fs::relative(dir, root).generic_string();
        const auto mmprojPath = findMmprojPath(dir);
        const auto tokenizerPath = findTokenizerPath(dir);

        const bool looksSharded =
            ggufs.size() > 1 &&
            std::all_of(ggufs.begin(), ggufs.end(), [](const fs::path& path) { return isShardFile(path); });

        if (ggufs.size() == 1 || looksSharded) {
            addModel(relDir, ggufs.front(), mmprojPath, tokenizerPath);
            it.disable_recursion_pending();
            continue;
        }

        for (const auto& gguf : ggufs) {
            addModel((fs::path(relDir) / gguf.stem()).generic_string(), gguf, std::nullopt, tokenizerPath);
        }
    }

    std::sort(models.begin(), models.end(), [](const ModelInfo& a, const ModelInfo& b) {
        return a.id < b.id;
    });
    return models;
}

std::vector<ModelInfo> LlamaCppService::scanModels() const {
    return scanModelDirectory(
        modelsDir_,
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 8192);
}

std::vector<std::string> LlamaCppService::availableBackends() const {
    return listAvailableBackends(libsDir_);
}

std::vector<std::string> LlamaCppService::listAvailableBackends(const std::string& libsDir) {
    std::vector<std::string> out;
    for (const char* backend : {"cpu", "cuda", "rocm", "vulkan"}) {
        const fs::path baseDir = fs::path(libsDir) / backend;
        if (fs::exists(baseDir / "llama-server") || fs::exists(baseDir / "llama-server.exe")) {
            out.push_back(backend);
        }
    }
    return out;
}

std::vector<std::string> LlamaCppService::detectHardwareBackends() {
    std::vector<std::string> out;
#ifndef _WIN32
    bool hasCuda = false;
    for (int i = 0; i < 8; ++i) {
        if (access(("/dev/nvidia" + std::to_string(i)).c_str(), F_OK) == 0) {
            hasCuda = true;
            break;
        }
    }
    if (!hasCuda) {
        hasCuda = (system("nvidia-smi --query-gpu=name --format=csv,noheader > /dev/null 2>&1") == 0);
    }
    if (hasCuda) {
        out.push_back("cuda");
    }

    bool hasAmdDiscreteGpu = false;
    if (access("/dev/kfd", F_OK) == 0) {
        FILE* fp = popen(
            "lspci | grep -i 'VGA.*\\[AMD/ATI\\]' | grep -iE 'RX|Radeon Pro|Radeon VII|Radeon Instinct' | grep -v 'Vega Graphics'",
            "r");
        if (fp) {
            char buffer[256];
            if (fgets(buffer, sizeof(buffer), fp) != nullptr) {
                hasAmdDiscreteGpu = true;
            }
            pclose(fp);
        }
    }
    if (hasAmdDiscreteGpu) {
        out.push_back("rocm");
    }

    void* vk = dlopen("libvulkan.so.1", RTLD_LAZY | RTLD_LOCAL);
    if (!vk) {
        vk = dlopen("libvulkan.so", RTLD_LAZY | RTLD_LOCAL);
    }
    if (vk) {
        out.push_back("vulkan");
        dlclose(vk);
    }
#endif
    return out;
}

std::string LlamaCppService::resolveBackendPreference(
    const std::string& preference,
    const std::vector<std::string>& availableBackends) {
    const auto has = [&](const std::string& backend) {
        return std::find(availableBackends.begin(), availableBackends.end(), backend) != availableBackends.end();
    };

    if (preference == "cpu") {
        return has("cpu") ? "cpu" : "none";
    }
    if (preference != "auto" && has(preference)) {
        return preference;
    }
    for (const char* backend : {"cuda", "rocm", "vulkan"}) {
        if (has(backend)) {
            return backend;
        }
    }
    return has("cpu") ? "cpu" : "none";
}

std::string LlamaCppService::resolveBackend(const std::string& preference) const {
    return resolveBackendPreference(preference, availableBackends());
}

bool LlamaCppService::isServerProcessAliveLocked() {
#ifdef _WIN32
    return false;
#else
    if (serverPid_ <= 0) {
        return false;
    }

    int status = 0;
    const pid_t result = waitpid(serverPid_, &status, WNOHANG);
    if (result == 0) {
        return kill(serverPid_, 0) == 0;
    }

    serverPid_ = 0;
    serverRunning_ = false;
    loadedModelId_.clear();
    loadedModelIds_ = Json::Value(Json::arrayValue);
    return false;
#endif
}

LlamaCppService::StartupConfig LlamaCppService::buildStartupConfigLocked(
    const std::string& preferenceOverride) const {
    StartupConfig cfg;
    cfg.backend = resolveBackendPreference(
        preferenceOverride.empty() ? config_.getLlamacppBackend() : preferenceOverride,
        availableBackends());
    cfg.parallelSlots = std::max(1, config_.getLlamacppEffectiveMaxConcurrentInstances());
    cfg.maxLoadedModels = std::clamp(config_.getLlamacppMaxLoadedModels(), 0, 100);
    cfg.ctxSize = config_.getLlamacppCtxSize();
    cfg.batchSize = std::max(1, config_.getLlamacppEvalBatchSize());
    cfg.gpuLayers = std::max(0, config_.getLlamacppGpuLayers());
    cfg.threads = std::max(0, config_.getLlamacppThreads());
    cfg.threadsBatch = std::max(0, config_.getLlamacppThreadsBatch());
    cfg.flashAttn = config_.getLlamacppFlashAttn();
    cfg.cachePrompt = config_.getLlamacppKvCacheReuse();
    if (cfg.cachePrompt) {
        const auto models = scanModelDirectory(
            modelsDir_,
            config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 8192);
        if (countMropeModels(models) > 0) {
            cfg.cachePrompt = false;
        }
    }
    cfg.kvCacheType = config_.getLlamacppKvCacheType();

    const int keepAliveMinutes = config_.getLlamacppModelKeepAlive();
    cfg.sleepIdleSeconds = keepAliveMinutes < 0 ? -1 : keepAliveMinutes * 60;
    return cfg;
}

std::string LlamaCppService::presetPath() const {
    return (fs::path(modelsDir_).parent_path() / "llamacpp-router-models.ini").string();
}

std::string LlamaCppService::logsDir() const {
    return (fs::path(libsDir_).parent_path() / "logs").string();
}

std::string LlamaCppService::backendInstallDir(const std::string& backend) const {
    return (fs::path(libsDir_) / backend).string();
}

std::string LlamaCppService::backendBinaryPath(const std::string& backend) const {
    const fs::path dir = fs::path(backendInstallDir(backend));
#ifdef _WIN32
    return (dir / "llama-server.exe").string();
#else
    return (dir / "llama-server").string();
#endif
}

std::string LlamaCppService::buildRouterPresetLocked() const {
    const auto models = scanModelDirectory(
        modelsDir_,
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 8192);

    std::ostringstream preset;
    std::ostringstream signature;
    preset << "version = 1\n\n";

    for (const auto& model : models) {
        const std::string modelId = normalizeModelId(model.id);
        preset << "[" << modelId << "]\n";
        preset << "model = " << model.ggufPath << "\n";
        if (!model.mmprojPath.empty()) {
            preset << "mmproj = " << model.mmprojPath << "\n";
        }
        preset << "\n";

        signature << modelId << "|" << model.ggufPath << "|" << model.mmprojPath << "\n";
    }

    std::ofstream file(presetPath(), std::ios::trunc);
    if (file.is_open()) {
        file << preset.str();
    }

    return signature.str();
}

bool LlamaCppService::waitForRouterLocked(int timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!isServerProcessAliveLocked()) {
            return false;
        }

        const Json::Value result = getJson("/models", 2);
        if (!result.isMember("error")) {
            return true;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(150));
    }
    return false;
}

bool LlamaCppService::startServerLocked(const StartupConfig& desired) {
#ifdef _WIN32
    (void)desired;
    serverRunning_ = false;
    return false;
#else
    if (desired.backend == "none") {
        return false;
    }

    const std::string binary = backendBinaryPath(desired.backend);
    if (!fs::exists(binary)) {
        std::cerr << "[LlamaCpp] Missing backend runtime: " << binary << "\n";
        return false;
    }

    activePresetSignature_ = buildRouterPresetLocked();
    serverPort_ = chooseFreePort();
    serverBaseUrl_ = "http://127.0.0.1:" + std::to_string(serverPort_);

    if (config_.getLlamacppKvCacheReuse() && !desired.cachePrompt) {
        const auto models = scanModelDirectory(
            modelsDir_,
            config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 8192);
        const std::size_t mropeModelCount = countMropeModels(models);
        if (mropeModelCount > 0) {
            std::cout << "[LlamaCpp] Disabling KV cache reuse for "
                      << mropeModelCount
                      << " M-RoPE model(s); llama-server prompt-cache reuse is not safe for them\n";
        }
    }

    fs::create_directories(logsDir());
    const std::string logPath =
        (fs::path(logsDir()) / ("llama-server-" + desired.backend + ".log")).string();
    const int logFd = ::open(logPath.c_str(), O_CREAT | O_WRONLY | O_APPEND, 0644);
    if (logFd < 0) {
        std::cerr << "[LlamaCpp] Failed to open log file: " << logPath << "\n";
        return false;
    }

    std::vector<std::string> args{
        binary,
        "--host", "127.0.0.1",
        "--port", std::to_string(serverPort_),
        "--models-preset", presetPath(),
        "--no-webui",
        "--parallel", std::to_string(desired.parallelSlots),
        "--models-max", std::to_string(desired.maxLoadedModels),
        "--reasoning-format", "deepseek",
        "--slots",
    };

    if (desired.ctxSize > 0) {
        args.insert(args.end(), {"--ctx-size", std::to_string(desired.ctxSize)});
    }
    if (desired.batchSize > 0) {
        args.insert(args.end(), {"--batch-size", std::to_string(desired.batchSize)});
    }
    if (desired.gpuLayers > 0) {
        args.insert(args.end(), {"--n-gpu-layers", std::to_string(desired.gpuLayers)});
    }
    if (desired.threads > 0) {
        args.insert(args.end(), {"--threads", std::to_string(desired.threads)});
    }
    if (desired.threadsBatch > 0) {
        args.insert(args.end(), {"--threads-batch", std::to_string(desired.threadsBatch)});
    }
    if (!desired.kvCacheType.empty()) {
        args.insert(args.end(), {"--cache-type-k", desired.kvCacheType});
        args.insert(args.end(), {"--cache-type-v", desired.kvCacheType});
    }

    args.insert(args.end(), {"--flash-attn", desired.flashAttn ? "on" : "off"});
    args.push_back(desired.cachePrompt ? "--cache-prompt" : "--no-cache-prompt");
    if (desired.sleepIdleSeconds >= 0) {
        args.insert(args.end(), {"--sleep-idle-seconds", std::to_string(desired.sleepIdleSeconds)});
    }

    std::vector<char*> argv;
    argv.reserve(args.size() + 1);
    for (auto& arg : args) {
        argv.push_back(arg.data());
    }
    argv.push_back(nullptr);

    const pid_t pid = fork();
    if (pid < 0) {
        ::close(logFd);
        std::cerr << "[LlamaCpp] fork() failed\n";
        return false;
    }

    if (pid == 0) {
        ::dup2(logFd, STDOUT_FILENO);
        ::dup2(logFd, STDERR_FILENO);
        ::close(logFd);
        ::chdir(backendInstallDir(desired.backend).c_str());
        ::setsid();
        ::execv(binary.c_str(), argv.data());
        std::perror("execv llama-server");
        _exit(127);
    }

    ::close(logFd);

    serverPid_ = static_cast<int>(pid);
    serverRunning_ = true;
    configDirty_ = false;
    activeBackend_ = desired.backend;
    activeConfig_ = desired;
    loadedModelId_.clear();
    loadedModelIds_ = Json::Value(Json::arrayValue);

    if (!waitForRouterLocked(10000)) {
        std::cerr << "[LlamaCpp] llama-server failed to become ready (" << desired.backend << ")\n";
        stopServerLocked();
        return false;
    }

    refreshLoadedModelStateLocked();
    std::cout << "[LlamaCpp] Started router on " << serverBaseUrl_ << " using backend " << activeBackend_ << "\n";
    return true;
#endif
}

void LlamaCppService::stopServerLocked() {
#ifndef _WIN32
    if (!isServerProcessAliveLocked()) {
        serverRunning_ = false;
        return;
    }

    const pid_t pid = static_cast<pid_t>(serverPid_);
    kill(pid, SIGTERM);
    for (int attempt = 0; attempt < 50; ++attempt) {
        int status = 0;
        const pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    int status = 0;
    if (waitpid(pid, &status, WNOHANG) == 0) {
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
    }
#endif

    serverPid_ = 0;
    serverRunning_ = false;
    loadedModelId_.clear();
    loadedModelIds_ = Json::Value(Json::arrayValue);
}

bool LlamaCppService::ensureServerRunningLocked() {
    const StartupConfig desired = buildStartupConfigLocked();
    const std::string presetSignature = buildRouterPresetLocked();

    const bool processAlive = isServerProcessAliveLocked();
    const bool needsRestart =
        !processAlive ||
        configDirty_ ||
        desired != activeConfig_ ||
        presetSignature != activePresetSignature_;

    if (!needsRestart) {
        activePresetSignature_ = presetSignature;
        return true;
    }

    stopServerLocked();
    activePresetSignature_ = presetSignature;
    return startServerLocked(desired);
}

bool LlamaCppService::ensureServerRunning() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return ensureServerRunningLocked();
}

void LlamaCppService::markConfigDirty() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    configDirty_ = true;
}

Json::Value LlamaCppService::getJson(const std::string& endpoint, long timeoutSeconds) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
        Json::Value error(Json::objectValue);
        error["error"] = "Failed to init CURL";
        return error;
    }

    std::string response;
    const std::string url = serverBaseUrl_ + endpoint;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeoutSeconds);
    curl_easy_setopt(curl, CURLOPT_FAILONERROR, 0L);

    const CURLcode result = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);

    Json::Value parsed;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(response);

    if (result != CURLE_OK) {
        parsed["error"] = std::string("Connection error: ") + curl_easy_strerror(result);
        return parsed;
    }
    if (httpCode != 200) {
        if (Json::parseFromStream(reader, stream, &parsed, &errors) && parsed.isMember("error")) {
            return parsed;
        }
        parsed["error"] = "HTTP " + std::to_string(httpCode);
        return parsed;
    }
    if (!Json::parseFromStream(reader, stream, &parsed, &errors)) {
        parsed["error"] = "Failed to parse response";
        parsed["raw"] = response;
    }
    return parsed;
}

Json::Value LlamaCppService::postJson(const std::string& endpoint,
                                      const Json::Value& body,
                                      long timeoutSeconds) const {
    CURL* curl = curl_easy_init();
    if (!curl) {
        Json::Value error(Json::objectValue);
        error["error"] = "Failed to init CURL";
        return error;
    }

    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    const std::string jsonBody = Json::writeString(writer, body);

    std::string response;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Expect:");

    const std::string url = serverBaseUrl_ + endpoint;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(jsonBody.size()));
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeoutSeconds);
    curl_easy_setopt(curl, CURLOPT_FAILONERROR, 0L);

    const CURLcode result = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    Json::Value parsed;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(response);

    if (result != CURLE_OK) {
        parsed["error"] = std::string("Connection error: ") + curl_easy_strerror(result);
        return parsed;
    }
    if (httpCode != 200) {
        if (Json::parseFromStream(reader, stream, &parsed, &errors) && parsed.isMember("error")) {
            return parsed;
        }
        parsed["error"] = "HTTP " + std::to_string(httpCode);
        parsed["raw"] = response;
        return parsed;
    }
    if (!Json::parseFromStream(reader, stream, &parsed, &errors)) {
        parsed["error"] = "Failed to parse response";
        parsed["raw"] = response;
    }
    return parsed;
}

Json::Value LlamaCppService::routerModelsJson() const {
    auto* self = const_cast<LlamaCppService*>(this);
    if (!self->ensureServerRunning()) {
        Json::Value error(Json::objectValue);
        error["error"] = "llama-server unavailable";
        return error;
    }
    return getJson("/models", 5);
}

bool LlamaCppService::refreshLoadedModelStateLocked() {
    if (!serverRunning_ || !isServerProcessAliveLocked()) {
        loadedModelId_.clear();
        loadedModelIds_ = Json::Value(Json::arrayValue);
        return false;
    }

    const Json::Value result = getJson("/models", 5);
    if (result.isMember("error")) {
        loadedModelId_.clear();
        loadedModelIds_ = Json::Value(Json::arrayValue);
        return false;
    }

    Json::Value loadedIds(Json::arrayValue);
    std::string primary;
    if (result.isMember("data") && result["data"].isArray()) {
        for (const auto& model : result["data"]) {
            if (!model.isObject() || !model.isMember("id")) {
                continue;
            }

            const std::string status =
                model.isMember("status") && model["status"].isObject()
                    ? model["status"].get("value", "").asString()
                    : "";
            if (status == "loaded") {
                const std::string modelId = "llamacpp::" + model["id"].asString();
                loadedIds.append(modelId);
                if (primary.empty()) {
                    primary = modelId;
                }
            }
        }
    }

    loadedModelIds_ = loadedIds;
    loadedModelId_ = primary;
    return !primary.empty();
}

bool LlamaCppService::isReady() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto* self = const_cast<LlamaCppService*>(this);
    if (!self->ensureServerRunningLocked()) {
        return false;
    }
    return self->refreshLoadedModelStateLocked();
}

std::string LlamaCppService::getLoadedModelId() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return loadedModelId_;
}

std::string LlamaCppService::getActiveBackend() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    return activeBackend_.empty() ? resolveBackend(config_.getLlamacppBackend()) : activeBackend_;
}

LlamaServerStatus LlamaCppService::getServerStatus() const {
    std::lock_guard<std::mutex> lock(stateMutex_);
    auto* self = const_cast<LlamaCppService*>(this);
    self->ensureServerRunningLocked();
    self->refreshLoadedModelStateLocked();

    LlamaServerStatus status;
    status.running = self->serverRunning_ && self->isServerProcessAliveLocked();
    status.ready = !self->loadedModelId_.empty();
    status.activeBackend = self->activeBackend_;
    status.pid = self->serverPid_;
    status.parallelSlots = self->activeConfig_.parallelSlots > 0 ? self->activeConfig_.parallelSlots : 1;
    status.maxLoadedModels = self->activeConfig_.maxLoadedModels;
    status.loadedModels = static_cast<int>(self->loadedModelIds_.size());
    status.loadedModelIds = self->loadedModelIds_;
    return status;
}

bool LlamaCppService::switchBackend(const std::string& backendName) {
    std::lock_guard<std::mutex> lock(stateMutex_);
    configDirty_ = true;
    const StartupConfig desired = buildStartupConfigLocked(backendName);
    if (desired.backend == "none") {
        return false;
    }

    stopServerLocked();
    if (startServerLocked(desired)) {
        return true;
    }

    if (backendName != "cpu") {
        const StartupConfig fallback = buildStartupConfigLocked("cpu");
        if (fallback.backend != "none") {
            return startServerLocked(fallback);
        }
    }
    return false;
}

void LlamaCppService::unloadLib() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    stopServerLocked();
}

bool LlamaCppService::reloadModel() {
    std::lock_guard<std::mutex> lock(stateMutex_);
    configDirty_ = true;
    stopServerLocked();
    return ensureServerRunningLocked();
}

bool LlamaCppService::ensureModelLoaded(const std::string& modelId) {
    if (!ensureServerRunning()) {
        return false;
    }

    std::string target = normalizeModelId(modelId);
    if (target.empty()) {
        const auto models = scanModels();
        if (models.empty()) {
            return false;
        }
        target = normalizeModelId(models.front().id);
    }

    Json::Value body(Json::objectValue);
    body["model"] = target;
    const Json::Value response = postJson("/models/load", body, 120);
    if (response.isMember("error")) {
        return false;
    }

    std::lock_guard<std::mutex> lock(stateMutex_);
    return refreshLoadedModelStateLocked();
}

void LlamaCppService::unloadModel() {
    const Json::Value models = routerModelsJson();
    if (!models.isMember("data") || !models["data"].isArray()) {
        return;
    }

    for (const auto& model : models["data"]) {
        const std::string status =
            model.isMember("status") && model["status"].isObject()
                ? model["status"].get("value", "").asString()
                : "";
        if (status == "loaded" || status == "loading" || status == "sleeping") {
            unloadModel("llamacpp::" + model.get("id", "").asString());
        }
    }
}

bool LlamaCppService::unloadModel(const std::string& modelId) {
    if (!ensureServerRunning()) {
        return false;
    }

    Json::Value body(Json::objectValue);
    body["model"] = normalizeModelId(modelId);
    const Json::Value response = postJson("/models/unload", body, 120);
    if (response.isMember("error")) {
        return false;
    }

    std::lock_guard<std::mutex> lock(stateMutex_);
    return refreshLoadedModelStateLocked();
}

Json::Value LlamaCppService::getModels() const {
    std::vector<ModelInfo> localModels = scanModelDirectory(
        modelsDir_,
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 8192);

    Json::Value routerModels = routerModelsJson();
    std::map<std::string, std::string> statusById;
    if (routerModels.isMember("data") && routerModels["data"].isArray()) {
        for (const auto& model : routerModels["data"]) {
            if (!model.isObject() || !model.isMember("id")) {
                continue;
            }
            statusById[model["id"].asString()] =
                model.isMember("status") && model["status"].isObject()
                    ? model["status"].get("value", "").asString()
                    : "";
        }
    }

    Json::Value result(Json::objectValue);
    result["data"] = Json::Value(Json::arrayValue);
    for (auto& model : localModels) {
        const auto it = statusById.find(normalizeModelId(model.id));
        if (it != statusById.end()) {
            model.loaded = it->second == "loaded";
        }

        Json::Value entry(Json::objectValue);
        entry["id"] = model.id;
        entry["name"] = model.name;
        entry["source"] = "llamacpp";
        entry["context_length"] = model.contextLength;
        entry["max_tokens"] = model.maxTokens;
        entry["loaded"] = model.loaded;
        entry["has_tokenizer"] = !model.tokenizerPath.empty();
        entry["has_mmproj"] = !model.mmprojPath.empty();
        entry["uses_mrope"] = model.usesMrope;
        result["data"].append(entry);
    }
    return result;
}

Json::Value LlamaCppService::parseConversationHistory(const std::string& prompt) const {
    Json::Value messages(Json::arrayValue);
    std::vector<std::string> lines;
    std::string current;
    std::istringstream stream(prompt);
    std::string line;

    while (std::getline(stream, line)) {
        if ((line.find("User:") == 0 || line.find("Assistant:") == 0) && !current.empty()) {
            lines.push_back(current);
            current = line;
        } else {
            if (!current.empty()) {
                current += "\n";
            }
            current += line;
        }
    }
    if (!current.empty()) {
        lines.push_back(current);
    }

    if (lines.empty() && !prompt.empty()) {
        Json::Value message(Json::objectValue);
        message["role"] = "user";
        message["content"] = prompt;
        messages.append(message);
        return messages;
    }

    for (const std::string& rawLine : lines) {
        std::string trimmed = rawLine;
        trimWhitespace(trimmed);
        if (trimmed.empty()) {
            continue;
        }

        Json::Value message(Json::objectValue);
        if (trimmed.rfind("User:", 0) == 0) {
            message["role"] = "user";
            std::string content = trimmed.substr(5);
            trimWhitespace(content);
            message["content"] = content;
        } else if (trimmed.rfind("Assistant:", 0) == 0) {
            message["role"] = "assistant";
            std::string content = trimmed.substr(10);
            trimWhitespace(content);
            message["content"] = content;
        } else {
            message["role"] = "user";
            message["content"] = trimmed;
        }
        messages.append(message);
    }

    return messages;
}

Json::Value LlamaCppService::buildMessages(const std::string& prompt,
                                           const std::string& systemPrompt) const {
    Json::Value messages(Json::arrayValue);
    if (!systemPrompt.empty()) {
        Json::Value system(Json::objectValue);
        system["role"] = "system";
        system["content"] = systemPrompt;
        messages.append(system);
    }
    const Json::Value conversation = parseConversationHistory(prompt);
    for (const auto& message : conversation) {
        messages.append(message);
    }
    return messages;
}

std::string LlamaCppService::generateTitle(const std::string& model,
                                           const std::string& userMessage,
                                           const std::string& systemPrompt) {
    if (!ensureServerRunning()) {
        return "";
    }

    Json::Value messages(Json::arrayValue);
    if (!systemPrompt.empty()) {
        Json::Value system(Json::objectValue);
        system["role"] = "system";
        system["content"] = systemPrompt;
        messages.append(system);
    }

    Json::Value user(Json::objectValue);
    user["role"] = "user";
    user["content"] = userMessage;
    messages.append(user);

    Json::Value body(Json::objectValue);
    body["model"] = normalizeModelId(model);
    body["messages"] = messages;
    body["max_tokens"] = kTitleGenerationMaxTokens;
    body["temperature"] = 0.0;
    // Title generation should be one short answer with reasoning disabled,
    // not a stop-sequence hack that tries to catch injected thinking tags.
    body["chat_template_kwargs"]["enable_thinking"] = false;
    body["thinking_budget_tokens"] = 0;
    Json::Value stop(Json::arrayValue);
    stop.append("\n");
    body["stop"] = stop;

    const Json::Value response = postJson("/v1/chat/completions", body, 120);
    if (response.isMember("error")) {
        std::cerr << "[LlamaCpp] Title generation error: " << response["error"].asString() << "\n";
        return "";
    }

    if (!response.isMember("choices") || !response["choices"].isArray() || response["choices"].empty()) {
        return "";
    }

    const Json::Value& choice = response["choices"][0];
    if (!choice.isMember("message") || !choice["message"].isObject()) {
        return "";
    }

    std::string title = choice["message"].get("content", "").asString();
    trimWhitespace(title);
    if (title.size() >= 2 && title.front() == '"' && title.back() == '"') {
        title = title.substr(1, title.size() - 2);
    }
    trimWhitespace(title);
    if (title.size() > 60) {
        title = title.substr(0, 57) + "...";
    }
    return title;
}

std::string LlamaCppService::streamOneRound(
    const Json::Value& requestBody,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    std::vector<std::tuple<std::string, std::string, std::string>>& toolCallsOut) const {
    auto* self = const_cast<LlamaCppService*>(this);
    if (!self->ensureServerRunning()) {
        onError("llama.cpp server unavailable");
        return "_internal_error_";
    }

    CURL* curl = curl_easy_init();
    if (!curl) {
        onError("Failed to init CURL");
        return "_internal_error_";
    }

    Json::Value body = requestBody;
    body["model"] = normalizeModelId(body.get("model", "").asString());

    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    const std::string jsonBody = Json::writeString(writer, body);

    const std::string url = serverBaseUrl_ + "/v1/chat/completions";
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    headers = curl_slist_append(headers, "Expect:");

    StreamContext ctx;
    ctx.onChunk = std::move(onChunk);

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(jsonBody.size()));
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallbackStream);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 120L);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, progressCallback);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &ctx);

    const CURLcode result = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (result == CURLE_WRITE_ERROR || result == CURLE_ABORTED_BY_CALLBACK) {
        return "_cancelled_";
    }

    if (result != CURLE_OK) {
        onError(std::string("Connection error: ") + curl_easy_strerror(result));
        return "_internal_error_";
    }

    if (httpCode != 200) {
        std::string cleanMsg;
        if (!ctx.buffer.empty()) {
            Json::Value errJson;
            Json::CharReaderBuilder reader;
            std::string errors;
            std::istringstream stream(ctx.buffer);
            if (Json::parseFromStream(reader, stream, &errJson, &errors) && errJson.isMember("error")) {
                const Json::Value& errorObj = errJson["error"];
                if (errorObj.isObject()) {
                    cleanMsg = errorObj.get("message", "").asString();
                } else if (errorObj.isString()) {
                    cleanMsg = errorObj.asString();
                }
            }
        }
        if (cleanMsg.empty()) {
            cleanMsg = "HTTP " + std::to_string(httpCode);
        }
        onError(cleanMsg);
        return "_internal_error_";
    }

    for (const auto& toolCall : ctx.toolCalls) {
        toolCallsOut.emplace_back(toolCall.id, toolCall.name, toolCall.argumentsJson);
    }
    return ctx.finishReason;
}

void LlamaCppService::streamingChatWithCallback(
    const std::string& model,
    const std::string& prompt,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    const std::string& systemPrompt,
    double temperature,
    int numCtx,
    std::function<bool()> cancelCheck,
    bool emitLogprobs) {
    Json::Value body(Json::objectValue);
    body["model"] = model;
    body["messages"] = buildMessages(prompt, systemPrompt);
    body["max_tokens"] = maxTokens;
    body["stream"] = true;
    body["reasoning_format"] = "deepseek";
    body["top_p"] = config_.getLlamacppTopP();
    body["min_p"] = config_.getLlamacppMinP();
    body["repeat_penalty"] = config_.getLlamacppRepeatPenalty();
    if (temperature >= 0.0) {
        body["temperature"] = temperature;
    }
    if (numCtx > 0) {
        body["n_ctx"] = numCtx;
    }
    if (emitLogprobs) {
        body["logprobs"] = true;
    }

    std::vector<std::tuple<std::string, std::string, std::string>> unused;
    const std::string finishReason = streamOneRound(
        body,
        [&](const std::string& chunk) {
            if (cancelCheck && cancelCheck()) {
                return false;
            }
            return onChunk ? onChunk(chunk) : true;
        },
        onError,
        unused);

    if (finishReason != "_cancelled_" && onChunk) {
        onChunk("data: [DONE]\n\n");
    }
}

void LlamaCppService::streamingChatWithTools(
    const std::string& model,
    Json::Value messages,
    const Json::Value& tools,
    const std::string& taskId,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    ToolSystem* toolSystem,
    double temperature,
    int numCtx,
    std::function<bool()> cancelCheck,
    bool emitLogprobs) {
    for (;;) {
        if (cancelCheck && cancelCheck()) {
            return;
        }

        const Json::Value currentTools = (toolSystem && !taskId.empty())
            ? toolSystem->getModelToolsForTask(taskId)
            : tools;
        const bool hasTools = currentTools.isArray() && !currentTools.empty();

        Json::Value body(Json::objectValue);
        body["model"] = model;
        body["messages"] = messages;
        body["max_tokens"] = maxTokens;
        body["stream"] = true;
        body["reasoning_format"] = "deepseek";
        body["top_p"] = config_.getLlamacppTopP();
        body["min_p"] = config_.getLlamacppMinP();
        body["repeat_penalty"] = config_.getLlamacppRepeatPenalty();
        if (temperature >= 0.0) {
            body["temperature"] = temperature;
        }
        if (numCtx > 0) {
            body["n_ctx"] = numCtx;
        }
        if (emitLogprobs && !hasTools) {
            body["logprobs"] = true;
        }

        if (hasTools) {
            body["tools"] = currentTools;
            body["tool_choice"] = "auto";
            body["parse_tool_calls"] = true;
            body["parallel_tool_calls"] = true;
        }

        std::vector<std::tuple<std::string, std::string, std::string>> toolCalls;
        const std::string finishReason = streamOneRound(
            body,
            [&](const std::string& chunk) {
                if (cancelCheck && cancelCheck()) {
                    return false;
                }
                return onChunk ? onChunk(chunk) : true;
            },
            onError,
            toolCalls);

        if (finishReason == "_cancelled_" || finishReason == "_internal_error_" || finishReason == "_api_error_") {
            return;
        }

        if (toolCalls.empty()) {
            break;
        }

        Json::Value assistantMsg(Json::objectValue);
        assistantMsg["role"] = "assistant";
        assistantMsg["content"] = Json::Value();
        assistantMsg["tool_calls"] = Json::Value(Json::arrayValue);

        for (const auto& [id, name, argumentsJson] : toolCalls) {
            Json::Value toolCall(Json::objectValue);
            toolCall["id"] = id;
            toolCall["type"] = "function";
            toolCall["function"]["name"] = name;
            toolCall["function"]["arguments"] = argumentsJson;
            assistantMsg["tool_calls"].append(toolCall);
        }
        messages.append(assistantMsg);

        for (const auto& [id, name, argumentsJson] : toolCalls) {
            if (onChunk) {
                Json::Value thinking(Json::objectValue);
                thinking["choices"][0]["delta"]["reasoning"] = "\n*Executing tool: " + name + "*\n";
                Json::StreamWriterBuilder writer;
                writer["indentation"] = "";
                if (!onChunk("data: " + Json::writeString(writer, thinking) + "\n\n")) {
                    return;
                }

            }

            std::string resultStr;
            if (toolSystem && !taskId.empty()) {
                Json::Value args(Json::objectValue);
                if (!argumentsJson.empty()) {
                    Json::CharReaderBuilder reader;
                    std::string errors;
                    std::istringstream stream(argumentsJson);
                    Json::parseFromStream(reader, stream, &args, &errors);
                }

                const auto execution = toolSystem->executeToolCall(
                    taskId,
                    name,
                    id,
                    args,
                    [onChunk](const Json::Value& event) {
                        if (!onChunk) {
                            return true;
                        }
                        return onChunk("data: " + writeJson(event) + "\n\n");
                    },
                    cancelCheck);
                resultStr = execution.modelOutput;
                if (resultStr.empty()) {
                    resultStr = "{}";
                }
            } else {
                resultStr = "{\"error\":\"Legacy raw tools are not executable without a task-scoped tool session\"}";
            }

            Json::Value toolResult(Json::objectValue);
            toolResult["role"] = "tool";
            toolResult["tool_call_id"] = id;
            toolResult["content"] = resultStr;
            messages.append(toolResult);
        }
    }

    if (onChunk) {
        onChunk("data: [DONE]\n\n");
    }
}
