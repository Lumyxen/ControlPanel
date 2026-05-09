#include "services/llamacpp_service.h"
#include "services/llama_api.h"
#include "services/tools/tool_system.h"

#include "config/config.h"
#include "server/http_utils.h"
#include "services/mcp_registry.h"

#include <curl/curl.h>

#include <algorithm>
#include <array>
#include <cerrno>
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
#include <utility>

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
#else
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace {

constexpr int kTitleGenerationMaxTokens = 24;
constexpr std::string_view kMropeMetadataSuffix = ".rope.dimension_sections";
constexpr const char* kMtmdDefaultMarker = "<__media__>";
constexpr const char* kSanitizedMalformedToolArguments = "{}";

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
    std::string apiErrorMessage;
};

bool messageContentHasRichParts(const Json::Value& content) {
    if (content.isArray()) {
        for (const auto& part : content) {
            if (!part.isObject()) {
                continue;
            }

            const std::string type = part.get("type", "").asString();
            if (!type.empty() && type != "text") {
                return true;
            }
        }
    }

    return false;
}

std::string flattenMessageContentForTemplate(const Json::Value& message) {
    if (!message.isObject()) {
        return "";
    }

    auto appendLine = [](std::string& target, const std::string& value) {
        if (value.empty()) {
            return;
        }
        if (!target.empty()) {
            target += '\n';
        }
        target += value;
    };

    const Json::Value& content = message["content"];
    std::string flattened;
    if (content.isString()) {
        flattened = content.asString();
    } else if (content.isArray()) {
        for (const auto& part : content) {
            if (!part.isObject()) {
                continue;
            }

            const std::string type = part.get("type", "").asString();
            std::string piece;
            if (type == "text") {
                piece = part.get("text", "").asString();
            } else if (type == "media_marker" || type == "image_url" || type == "input_audio") {
                piece = part.get("text", kMtmdDefaultMarker).asString();
                if (piece.empty()) {
                    piece = kMtmdDefaultMarker;
                }
            } else {
                continue;
            }

            appendLine(flattened, piece);
        }
    }

    if (message.isMember("tool_calls") && message["tool_calls"].isArray() && !message["tool_calls"].empty()) {
        appendLine(flattened, "[Tool Calls]");
        appendLine(flattened, writeJson(message["tool_calls"]));
    }
    if (message.isMember("tool_call_id") && message["tool_call_id"].isString()) {
        appendLine(flattened, "[Tool Call ID] " + message["tool_call_id"].asString());
    }

    return flattened;
}

std::string findLlamaSharedLibrary(const fs::path& dir) {
#ifdef _WIN32
    for (const auto& name : {"llama.dll", "libllama.dll"}) {
        const fs::path candidate = dir / name;
        if (fs::exists(candidate) && fs::is_regular_file(candidate)) {
            return candidate.string();
        }
    }
#elif defined(__APPLE__)
    for (const auto& name : {"libllama.dylib", "libllama.so"}) {
        const fs::path candidate = dir / name;
        if (fs::exists(candidate) && fs::is_regular_file(candidate)) {
            return candidate.string();
        }
    }
#else
    for (const auto& name : {"libllama.so"}) {
        const fs::path candidate = dir / name;
        if (fs::exists(candidate) && fs::is_regular_file(candidate)) {
            return candidate.string();
        }
    }
#endif

    if (fs::exists(dir) && fs::is_directory(dir)) {
        for (const auto& entry : fs::directory_iterator(dir)) {
            if (!entry.is_regular_file()) {
                continue;
            }
            const std::string name = entry.path().filename().string();
#ifdef _WIN32
            if (name == "llama.dll" || name == "libllama.dll") {
                return entry.path().string();
            }
#elif defined(__APPLE__)
            if (name.rfind("libllama.", 0) == 0) {
                return entry.path().string();
            }
#else
            if (name.rfind("libllama.so", 0) == 0) {
                return entry.path().string();
            }
#endif
        }
    }

    return "";
}

std::optional<ModelInfo> findModelInfoById(const std::vector<ModelInfo>& models, const std::string& modelId) {
    for (const auto& model : models) {
        if (model.id == modelId) {
            return model;
        }
    }
    return std::nullopt;
}

template <typename T>
bool loadRequiredLlamaSymbol(void* handle, const char* name, T& target, std::string& error) {
#ifdef _WIN32
    auto symbol = reinterpret_cast<T>(GetProcAddress(static_cast<HMODULE>(handle), name));
#else
    dlerror();
    auto symbol = reinterpret_cast<T>(dlsym(handle, name));
#endif
    if (!symbol) {
        error = std::string("Missing libllama symbol: ") + name;
        return false;
    }
    target = symbol;
    return true;
}

template <typename T>
bool loadOptionalLlamaSymbol(void* handle, const char* name, T& target) {
#ifdef _WIN32
    target = reinterpret_cast<T>(GetProcAddress(static_cast<HMODULE>(handle), name));
#else
    dlerror();
    target = reinterpret_cast<T>(dlsym(handle, name));
    (void) dlerror();
#endif
    return target != nullptr;
}

struct TokenizerLogState {
    std::mutex mutex;
    enum ggml_log_level level = GGML_LOG_LEVEL_NONE;
    bool emit = false;
    std::string buffer;
};

TokenizerLogState& tokenizerLogState() {
    static TokenizerLogState state;
    return state;
}

bool shouldEmitTokenizerLog(enum ggml_log_level level) {
    return level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR;
}

const char* tokenizerLogPrefix(enum ggml_log_level level) {
    return level == GGML_LOG_LEVEL_ERROR
        ? "[LlamaCpp][tokenizer][error] "
        : "[LlamaCpp][tokenizer][warn] ";
}

void flushTokenizerLogLinesLocked(TokenizerLogState& state, bool flushPartial) {
    if (!state.emit) {
        state.buffer.clear();
        return;
    }

    std::size_t newlinePos = std::string::npos;
    while ((newlinePos = state.buffer.find('\n')) != std::string::npos) {
        const std::string line = state.buffer.substr(0, newlinePos);
        state.buffer.erase(0, newlinePos + 1);
        std::cerr << tokenizerLogPrefix(state.level) << line << "\n";
    }

    if (flushPartial && !state.buffer.empty()) {
        std::cerr << tokenizerLogPrefix(state.level) << state.buffer << "\n";
        state.buffer.clear();
    }
}

void flushTokenizerLogState() {
    auto& state = tokenizerLogState();
    std::lock_guard<std::mutex> lock(state.mutex);
    flushTokenizerLogLinesLocked(state, true);
    state.level = GGML_LOG_LEVEL_NONE;
    state.emit = false;
}

void tokenizerLogCallback(enum ggml_log_level level, const char* text, void* userData) {
    auto* state = static_cast<TokenizerLogState*>(userData);
    if (!state || !text || !*text) {
        return;
    }

    std::lock_guard<std::mutex> lock(state->mutex);

    if (level != GGML_LOG_LEVEL_CONT) {
        flushTokenizerLogLinesLocked(*state, true);
        state->level = level;
        state->emit = shouldEmitTokenizerLog(level);
    }

    if (!state->emit) {
        return;
    }

    state->buffer += text;
    flushTokenizerLogLinesLocked(*state, false);
}

int extractPromptTokensFromChatResponse(const Json::Value& response) {
    if (response.isMember("usage") && response["usage"].isObject()) {
        const Json::Value& usage = response["usage"];
        if (usage.isMember("prompt_tokens") &&
            (usage["prompt_tokens"].isInt() || usage["prompt_tokens"].isUInt())) {
            return usage["prompt_tokens"].asInt();
        }
    }

    if (response.isMember("timings") && response["timings"].isObject()) {
        const Json::Value& timings = response["timings"];
        const int promptN = timings.get("prompt_n", 0).asInt();
        const int cacheN = timings.get("cache_n", 0).asInt();
        if (promptN > 0 || cacheN > 0) {
            return promptN + cacheN;
        }
    }

    return -1;
}

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

bool readGgufPositiveInt(std::ifstream& stream, std::int32_t type, std::optional<int>& out) {
    out.reset();
    auto clampPositive = [](auto value) -> std::optional<int> {
        using ValueType = decltype(value);
        if (value <= static_cast<ValueType>(0)) {
            return std::nullopt;
        }
        constexpr auto kIntMax = static_cast<ValueType>(std::numeric_limits<int>::max());
        if (value > kIntMax) {
            return std::numeric_limits<int>::max();
        }
        return static_cast<int>(value);
    };

    switch (type) {
        case 0: { // GGUF_TYPE_UINT8
            std::uint8_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 1: { // GGUF_TYPE_INT8
            std::int8_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 2: { // GGUF_TYPE_UINT16
            std::uint16_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 3: { // GGUF_TYPE_INT16
            std::int16_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 4: { // GGUF_TYPE_UINT32
            std::uint32_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 5: { // GGUF_TYPE_INT32
            std::int32_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 10: { // GGUF_TYPE_UINT64
            std::uint64_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 11: { // GGUF_TYPE_INT64
            std::int64_t value = 0;
            if (!readExact(stream, value)) {
                return false;
            }
            out = clampPositive(value);
            return true;
        }
        case 8: { // GGUF_TYPE_STRING
            std::string value;
            if (!readGgufString(stream, value)) {
                return false;
            }
            const std::size_t start = value.find_first_not_of(" \t\r\n");
            if (start == std::string::npos) {
                return true;
            }
            const std::size_t end = value.find_last_not_of(" \t\r\n");
            value = value.substr(start, end - start + 1);
            if (value.empty()) {
                return true;
            }
            try {
                const long long parsed = std::stoll(value);
                out = clampPositive(parsed);
                return true;
            } catch (...) {
                return true;
            }
        }
        default:
            return skipGgufValue(stream, type);
    }
}

bool isGgufContextLengthKey(const std::string& key) {
    const std::string_view keyView(key);
    return keyView == "context_length" ||
           keyView == "context.window" ||
           keyView == "context_window" ||
           keyView == "max_context_length" ||
           keyView == "max_position_embeddings" ||
           keyView.ends_with(".context_length") ||
           keyView.ends_with(".context_window") ||
           keyView.ends_with(".max_context_length") ||
           keyView.ends_with(".max_position_embeddings");
}

std::optional<int> ggufContextLength(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream.is_open()) {
        return std::nullopt;
    }

    std::array<char, 4> magic{};
    if (!readExact(stream, magic.data(), magic.size()) ||
        magic[0] != 'G' || magic[1] != 'G' || magic[2] != 'U' || magic[3] != 'F') {
        return std::nullopt;
    }

    std::uint32_t version = 0;
    std::int64_t tensorCount = 0;
    std::int64_t kvCount = 0;
    if (!readExact(stream, version) ||
        !readExact(stream, tensorCount) ||
        !readExact(stream, kvCount)) {
        return std::nullopt;
    }

    if (version == 0 || version > 3 || tensorCount < 0 || kvCount < 0) {
        return std::nullopt;
    }

    for (std::int64_t index = 0; index < kvCount; ++index) {
        std::string key;
        std::int32_t type = -1;
        if (!readGgufString(stream, key) || !readExact(stream, type)) {
            return std::nullopt;
        }

        if (isGgufContextLengthKey(key)) {
            std::optional<int> value;
            if (!readGgufPositiveInt(stream, type, value)) {
                return std::nullopt;
            }
            if (value && *value > 0) {
                return value;
            }
            continue;
        }

        if (!skipGgufValue(stream, type)) {
            return std::nullopt;
        }
    }

    return std::nullopt;
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

std::string extractStreamErrorMessage(const Json::Value& parsed) {
    const Json::Value& error = parsed["error"];
    if (error.isObject()) {
        const std::string message = error.get("message", "").asString();
        if (!message.empty()) {
            return message;
        }
    }
    if (error.isString()) {
        return error.asString();
    }
    return writeJson(error);
}

bool isRecoverableToolArgumentParseError(const std::string& message) {
    return message.find("Failed to parse tool call arguments as JSON") != std::string::npos;
}

bool parseToolArgumentsJson(
    const std::string& argumentsJson,
    Json::Value& parsedArguments,
    std::string& error) {
    parsedArguments = Json::Value(Json::objectValue);
    error.clear();

    if (argumentsJson.empty()) {
        return true;
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(argumentsJson);
    if (Json::parseFromStream(reader, stream, &parsedArguments, &errors)) {
        return true;
    }

    trimWhitespace(errors);
    error = "Failed to parse tool call arguments as JSON: " + errors;
    return false;
}

Json::Value buildToolArgumentParseFailureOutput(
    const std::string& error,
    const std::string& rawArguments) {
    Json::Value output(Json::objectValue);
    output["error"] = error;
    if (!rawArguments.empty()) {
        output["raw_arguments"] = rawArguments;
    }
    return output;
}

Json::Value buildMalformedToolCallEvent(
    const std::string& toolCallId,
    const std::string& toolName,
    const std::string& rawArguments,
    const Json::Value& output) {
    Json::Value toolCall(Json::objectValue);
    toolCall["id"] = toolCallId;
    toolCall["name"] = toolName;
    toolCall["title"] = toolName;
    toolCall["status"] = "failed";
    toolCall["input"] = Json::Value(Json::objectValue);
    if (!rawArguments.empty()) {
        toolCall["input_raw"] = rawArguments;
    }
    toolCall["error"] = output.get("error", "Failed to parse tool call arguments as JSON");
    toolCall["output"] = output;
    toolCall["modelOutput"] = writeJson(output);
    return toolCall;
}

bool emitToolFailureEvent(
    const std::function<bool(const std::string&)>& onChunk,
    const Json::Value& toolCall) {
    if (!onChunk) {
        return true;
    }

    Json::Value event(Json::objectValue);
    event["type"] = "tool_event";
    event["event"] = "failed";
    event["tool_call"] = toolCall;
    return onChunk("data: " + writeJson(event) + "\n\n");
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
            ctx->apiErrorMessage = extractStreamErrorMessage(parsed);
            const bool recoverable =
                !ctx->toolCalls.empty() &&
                isRecoverableToolArgumentParseError(ctx->apiErrorMessage);

            if (!recoverable && ctx->onChunk) {
                Json::StreamWriterBuilder writer;
                writer["indentation"] = "";
                if (!ctx->onChunk("data: " + Json::writeString(writer, parsed) + "\n\n")) {
                    return 0;
                }
            }
            ctx->finishReason = recoverable ? "_tool_call_parse_error_" : "_api_error_";
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
    {
        std::lock_guard<std::mutex> tokenizerLock(tokenizerMutex_);
        clearTokenizerCacheLocked();
    }
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

std::string LlamaCppService::resolveTokenizerBackend() const {
    const auto available = listAvailableBackends(libsDir_);
    if (std::find(available.begin(), available.end(), "cpu") != available.end()) {
        return "cpu";
    }

    std::lock_guard<std::mutex> lock(stateMutex_);
    if (!activeBackend_.empty()) {
        return activeBackend_;
    }
    return resolveBackendPreference(config_.getLlamacppBackend(), available);
}

void LlamaCppService::clearTokenizerCacheLocked() {
    flushTokenizerLogState();

    for (auto& [path, model] : tokenizerModels_) {
        if (model && tokenizerApi_ && tokenizerApi_->model_free) {
            tokenizerApi_->model_free(model);
        }
    }
    tokenizerModels_.clear();

    if (tokenizerApi_ && tokenizerApi_->loaded && tokenizerApi_->backend_free) {
        tokenizerApi_->backend_free();
    }

#ifdef _WIN32
    if (tokenizerLibHandle_) {
        FreeLibrary(static_cast<HMODULE>(tokenizerLibHandle_));
    }
#else
    if (tokenizerLibHandle_) {
        dlclose(tokenizerLibHandle_);
    }
#endif

    tokenizerBackend_.clear();
    tokenizerLibHandle_ = nullptr;
    tokenizerApi_.reset();
}

bool LlamaCppService::ensureTokenizerBackendLocked(const std::string& backend, std::string* error) {
    if (backend.empty() || backend == "none") {
        if (error) {
            *error = "No llama.cpp backend is available for tokenizer loading";
        }
        return false;
    }

    if (tokenizerApi_ && tokenizerApi_->loaded && tokenizerBackend_ == backend && tokenizerLibHandle_) {
        return true;
    }

    clearTokenizerCacheLocked();

    const fs::path backendDir = backendInstallDir(backend);
    const std::string libPath = findLlamaSharedLibrary(backendDir);
    if (libPath.empty()) {
        if (error) {
            *error = "Could not find libllama in " + backendDir.string();
        }
        return false;
    }

#ifdef _WIN32
    tokenizerLibHandle_ = LoadLibraryA(libPath.c_str());
    if (!tokenizerLibHandle_) {
        if (error) {
            *error = "Failed to load libllama: " + libPath;
        }
        return false;
    }
#else
    tokenizerLibHandle_ = dlopen(libPath.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!tokenizerLibHandle_) {
        if (error) {
            *error = std::string("Failed to load libllama: ") + dlerror();
        }
        return false;
    }
#endif

    tokenizerApi_ = std::make_unique<LlamaApi>();
    std::string loadError;
    auto& api = *tokenizerApi_;
    loadOptionalLlamaSymbol(tokenizerLibHandle_, "llama_log_set", api.log_set);
    if (!loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_backend_init", api.backend_init, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_backend_free", api.backend_free, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_model_default_params", api.model_default_params, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_model_load_from_file", api.model_load_from_file, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_model_free", api.model_free, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_model_get_vocab", api.model_get_vocab, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_model_chat_template", api.model_chat_template, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_tokenize", api.tokenize, loadError) ||
        !loadRequiredLlamaSymbol(tokenizerLibHandle_, "llama_chat_apply_template", api.chat_apply_template, loadError)) {
        clearTokenizerCacheLocked();
        if (error) {
            *error = loadError;
        }
        return false;
    }

    if (api.log_set) {
        api.log_set(tokenizerLogCallback, &tokenizerLogState());
    }
    api.backend_init();
    api.loaded = true;
    tokenizerBackend_ = backend;
    return true;
}

llama_model* LlamaCppService::ensureTokenizerModelLocked(const std::string& backend,
                                                         const ModelInfo& model,
                                                         std::string* error) {
    if (!ensureTokenizerBackendLocked(backend, error)) {
        return nullptr;
    }

    auto existing = tokenizerModels_.find(model.ggufPath);
    if (existing != tokenizerModels_.end() && existing->second) {
        return existing->second;
    }

    auto params = tokenizerApi_->model_default_params();
    params.n_gpu_layers = 0;
    params.vocab_only = true;
    params.use_mmap = true;
    params.use_mlock = false;
    params.no_alloc = false;
    params.no_host = false;

    llama_model* loadedModel = tokenizerApi_->model_load_from_file(model.ggufPath.c_str(), params);
    if (!loadedModel) {
        if (error) {
            *error = "Failed to load tokenizer vocabulary from " + model.ggufPath;
        }
        return nullptr;
    }

    tokenizerModels_[model.ggufPath] = loadedModel;
    return loadedModel;
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
        info.contextLength = ggufContextLength(ggufPath).value_or(contextLength > 0 ? contextLength : 65536);
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
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 65536);
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

bool LlamaCppService::isServerProcessGroupAliveLocked() const {
#ifdef _WIN32
    return false;
#else
    if (serverProcessGroupId_ <= 0) {
        return false;
    }

    errno = 0;
    const int result = ::kill(-static_cast<pid_t>(serverProcessGroupId_), 0);
    return result == 0 || errno == EPERM;
#endif
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
        if (::kill(serverPid_, 0) == 0) {
            return true;
        }
    }

    serverPid_ = 0;
    serverRunning_ = false;
    loadedModelId_.clear();
    loadedModelIds_ = Json::Value(Json::arrayValue);
    if (!isServerProcessGroupAliveLocked()) {
        serverProcessGroupId_ = 0;
    }
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
            config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 65536);
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
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 65536);

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
            config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 65536);
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
    serverProcessGroupId_ = static_cast<int>(pid);
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
    const pid_t pid = serverPid_ > 0 ? static_cast<pid_t>(serverPid_) : 0;
    const pid_t processGroupId = serverProcessGroupId_ > 0
        ? static_cast<pid_t>(serverProcessGroupId_)
        : pid;

    auto groupAlive = [&]() {
        if (processGroupId <= 0) {
            return false;
        }

        errno = 0;
        const int result = ::kill(-processGroupId, 0);
        return result == 0 || errno == EPERM;
    };

    auto reapRouter = [&]() {
        if (pid <= 0 || serverPid_ <= 0) {
            return false;
        }

        int status = 0;
        const pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid) {
            serverPid_ = 0;
            return false;
        }
        if (result < 0) {
            serverPid_ = 0;
            return false;
        }
        return true;
    };

    if (processGroupId <= 0 && !reapRouter()) {
        serverProcessGroupId_ = 0;
        serverRunning_ = false;
        loadedModelId_.clear();
        loadedModelIds_ = Json::Value(Json::arrayValue);
        return;
    }

    if (groupAlive()) {
        std::cout << "[LlamaCpp] Stopping router process group " << processGroupId << "\n";
        ::kill(-processGroupId, SIGTERM);
    } else if (pid > 0 && reapRouter()) {
        std::cout << "[LlamaCpp] Stopping router process " << pid << "\n";
        ::kill(pid, SIGTERM);
    }

    for (int attempt = 0; attempt < 50; ++attempt) {
        const bool routerAlive = reapRouter();
        const bool descendantsAlive = groupAlive();
        if (!routerAlive && !descendantsAlive) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (groupAlive()) {
        std::cerr << "[LlamaCpp] Forcing router process group " << processGroupId << " to exit\n";
        ::kill(-processGroupId, SIGKILL);
    } else if (pid > 0 && reapRouter()) {
        std::cerr << "[LlamaCpp] Forcing router process " << pid << " to exit\n";
        ::kill(pid, SIGKILL);
    }

    for (int attempt = 0; attempt < 20; ++attempt) {
        const bool routerAlive = reapRouter();
        const bool descendantsAlive = groupAlive();
        if (!routerAlive && !descendantsAlive) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
#endif

    serverPid_ = 0;
    serverProcessGroupId_ = 0;
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
        config_.getLlamacppCtxSize() > 0 ? config_.getLlamacppCtxSize() : 65536);

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

int LlamaCppService::countTokens(const std::string& model, const Json::Value& messages) {
    Json::Value preparedMessages = messages;
    if (!preparedMessages.isArray()) {
        preparedMessages = Json::Value(Json::arrayValue);
    }

    const auto modelInfo = findModelInfoById(scanModels(), model);
    if (!modelInfo || modelInfo->ggufPath.empty()) {
        throw std::runtime_error("Could not locate llama.cpp model files for token counting");
    }

    std::string backend = resolveTokenizerBackend();
    std::string localCountError;

    {
        std::lock_guard<std::mutex> tokenizerLock(tokenizerMutex_);
        llama_model* tokenizerModel = ensureTokenizerModelLocked(backend, *modelInfo, &localCountError);
        if (tokenizerModel) {
            const char* tmpl = tokenizerApi_->model_chat_template
                ? tokenizerApi_->model_chat_template(tokenizerModel, nullptr)
                : nullptr;
            if (tmpl && *tmpl) {
                std::vector<std::pair<std::string, std::string>> storage;
                storage.reserve(preparedMessages.size());
                for (const auto& message : preparedMessages) {
                    if (!message.isObject()) {
                        continue;
                    }

                    const std::string role = message.get("role", "").asString();
                    if (role.empty()) {
                        continue;
                    }
                    storage.emplace_back(role, flattenMessageContentForTemplate(message));
                }

                std::vector<llama_chat_message> chatMessages;
                chatMessages.reserve(storage.size());
                for (const auto& entry : storage) {
                    chatMessages.push_back({ entry.first.c_str(), entry.second.c_str() });
                }

                int32_t promptBytes = tokenizerApi_->chat_apply_template(
                    tmpl,
                    chatMessages.data(),
                    chatMessages.size(),
                    true,
                    nullptr,
                    0);
                std::vector<char> promptBuffer;
                if (promptBytes > 0) {
                    promptBuffer.resize(static_cast<std::size_t>(promptBytes));
                    promptBytes = tokenizerApi_->chat_apply_template(
                        tmpl,
                        chatMessages.data(),
                        chatMessages.size(),
                        true,
                        promptBuffer.data(),
                        static_cast<int32_t>(promptBuffer.size()));
                }

                if (promptBytes > 0) {
                    const llama_vocab* vocab = tokenizerApi_->model_get_vocab(tokenizerModel);
                    if (vocab) {
                        std::vector<llama_token> tokens(static_cast<std::size_t>(promptBytes) + 8);
                        int32_t tokenCount = tokenizerApi_->tokenize(
                            vocab,
                            promptBuffer.data(),
                            promptBytes,
                            tokens.data(),
                            static_cast<int32_t>(tokens.size()),
                            true,
                            true);
                        if (tokenCount < 0) {
                            tokens.resize(static_cast<std::size_t>(-tokenCount));
                            tokenCount = tokenizerApi_->tokenize(
                                vocab,
                                promptBuffer.data(),
                                promptBytes,
                                tokens.data(),
                                static_cast<int32_t>(tokens.size()),
                                true,
                                true);
                        }

                        if (tokenCount >= 0) {
                            return tokenCount;
                        }
                        localCountError = "Local llama.cpp tokenization failed";
                    } else {
                        localCountError = "Could not access llama.cpp vocabulary";
                    }
                } else {
                    localCountError = "Failed to apply llama.cpp chat template";
                }
            } else {
                localCountError = "Model does not expose a llama.cpp chat template";
            }
        }
    }

    bool modelLoaded = false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        auto* self = const_cast<LlamaCppService*>(this);
        if (self->ensureServerRunningLocked()) {
            self->refreshLoadedModelStateLocked();
            for (const auto& loadedId : loadedModelIds_) {
                if (loadedId.isString() && loadedId.asString() == model) {
                    modelLoaded = true;
                    break;
                }
            }
        }
    }

    if (modelLoaded) {
        std::string lastError = localCountError.empty()
            ? "llama.cpp did not return prompt token usage"
            : localCountError;
        for (const int maxTokens : {0, 1}) {
            Json::Value body(Json::objectValue);
            body["model"] = normalizeModelId(model);
            body["messages"] = preparedMessages;
            body["stream"] = false;
            body["max_tokens"] = maxTokens;
            body["temperature"] = 0.0;
            body["reasoning_format"] = "none";

            const Json::Value response = postJson("/v1/chat/completions", body, 120);
            if (response.isMember("error")) {
                lastError = response["error"].asString();
                continue;
            }

            const int promptTokens = extractPromptTokensFromChatResponse(response);
            if (promptTokens >= 0) {
                return promptTokens;
            }
        }
        throw std::runtime_error(lastError);
    }

    throw std::runtime_error(localCountError.empty()
        ? "llama.cpp tokenizer is unavailable for this unloaded model"
        : localCountError);
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
    std::vector<std::tuple<std::string, std::string, std::string>>& toolCallsOut,
    std::string* apiErrorOut) const {
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
    if (apiErrorOut) {
        *apiErrorOut = ctx.apiErrorMessage;
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
    streamingMessagesWithCallback(
        model,
        buildMessages(prompt, systemPrompt),
        maxTokens,
        std::move(onChunk),
        std::move(onError),
        temperature,
        numCtx,
        std::move(cancelCheck),
        emitLogprobs);
}

void LlamaCppService::streamingMessagesWithCallback(
    const std::string& model,
    Json::Value messages,
    int maxTokens,
    std::function<bool(const std::string&)> onChunk,
    std::function<void(const std::string&)> onError,
    double temperature,
    int numCtx,
    std::function<bool()> cancelCheck,
    bool emitLogprobs) {
    Json::Value body(Json::objectValue);
    body["model"] = model;
    body["messages"] = std::move(messages);
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
        std::string apiErrorMessage;
        const std::string finishReason = streamOneRound(
            body,
            [&](const std::string& chunk) {
                if (cancelCheck && cancelCheck()) {
                    return false;
                }
                return onChunk ? onChunk(chunk) : true;
            },
            onError,
            toolCalls,
            &apiErrorMessage);
        const bool recoverableToolCallParseError =
            finishReason == "_tool_call_parse_error_" ||
            (finishReason == "_api_error_" &&
             !toolCalls.empty() &&
             isRecoverableToolArgumentParseError(apiErrorMessage));

        if (finishReason == "_cancelled_" || finishReason == "_internal_error_") {
            return;
        }
        if (finishReason == "_api_error_" && !recoverableToolCallParseError) {
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
            Json::Value parsedArgs;
            std::string parseError;
            const bool argumentsParsed = parseToolArgumentsJson(argumentsJson, parsedArgs, parseError);
            toolCall["function"]["arguments"] = argumentsParsed
                ? argumentsJson
                : kSanitizedMalformedToolArguments;
            assistantMsg["tool_calls"].append(toolCall);
        }
        messages.append(assistantMsg);

        for (const auto& [id, name, argumentsJson] : toolCalls) {
            Json::Value parsedArgs;
            std::string parseError;
            const bool argumentsParsed = parseToolArgumentsJson(argumentsJson, parsedArgs, parseError);
            std::string resultStr;
            if (!argumentsParsed) {
                const std::string effectiveError =
                    (recoverableToolCallParseError && !apiErrorMessage.empty())
                        ? apiErrorMessage
                        : parseError;
                const Json::Value output = buildToolArgumentParseFailureOutput(
                    effectiveError,
                    argumentsJson);
                if (!emitToolFailureEvent(
                        onChunk,
                        buildMalformedToolCallEvent(id, name, argumentsJson, output))) {
                    return;
                }
                resultStr = writeJson(output);
            } else if (toolSystem && !taskId.empty()) {
                const auto execution = toolSystem->executeToolCall(
                    taskId,
                    name,
                    id,
                    parsedArgs,
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
