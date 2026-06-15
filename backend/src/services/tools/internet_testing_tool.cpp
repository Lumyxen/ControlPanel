#include "services/tools/internet_testing_tool.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <curl/curl.h>

#ifndef _WIN32
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

using SteadyClock = std::chrono::steady_clock;

constexpr int kDefaultLatencySamples = 5;
constexpr int kMaxLatencySamples = 20;
constexpr std::uint64_t kDefaultWanDownloadBytes = 8ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kDefaultWanUploadBytes = 2ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kDefaultLocalBytes = 32ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kMaxTestBytes = 128ULL * 1024ULL * 1024ULL;

std::int64_t nowMillis() {
    return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

bool cancelled(const std::function<bool()>& cancelCheck) {
    return cancelCheck && cancelCheck();
}

int intArg(const Json::Value& args, const std::string& key, int fallback, int minValue, int maxValue) {
    if (!args.isObject() || !args.isMember(key) || !args[key].isInt()) {
        return fallback;
    }
    return std::clamp(args[key].asInt(), minValue, maxValue);
}

std::uint64_t uint64Arg(
    const Json::Value& args,
    const std::string& key,
    std::uint64_t fallback,
    std::uint64_t minValue,
    std::uint64_t maxValue) {
    if (!args.isObject() || !args.isMember(key) || !args[key].isNumeric()) {
        return fallback;
    }
    try {
        const auto value = static_cast<std::uint64_t>(args[key].asUInt64());
        return std::clamp(value, minValue, maxValue);
    } catch (...) {
        return fallback;
    }
}

std::string stringArg(const Json::Value& args, const std::string& key, const std::string& fallback) {
    if (args.isObject() && args.isMember(key) && args[key].isString()) {
        return args[key].asString();
    }
    return fallback;
}

Json::Value makeStats(const std::vector<double>& values, const std::string& unit) {
    Json::Value result(Json::objectValue);
    result["unit"] = unit;
    result["samples"] = Json::Value(Json::arrayValue);
    for (double value : values) {
        result["samples"].append(value);
    }
    if (values.empty()) {
        result["available"] = false;
        return result;
    }

    const auto [minIt, maxIt] = std::minmax_element(values.begin(), values.end());
    const double sum = std::accumulate(values.begin(), values.end(), 0.0);
    const double average = sum / static_cast<double>(values.size());
    double variance = 0.0;
    for (double value : values) {
        const double delta = value - average;
        variance += delta * delta;
    }
    variance /= static_cast<double>(values.size());

    double jitter = 0.0;
    if (values.size() > 1) {
        for (std::size_t i = 1; i < values.size(); ++i) {
            jitter += std::abs(values[i] - values[i - 1]);
        }
        jitter /= static_cast<double>(values.size() - 1);
    }

    result["available"] = true;
    result["count"] = static_cast<Json::UInt64>(values.size());
    result["min"] = *minIt;
    result["max"] = *maxIt;
    result["average"] = average;
    result["stddev"] = std::sqrt(variance);
    result["jitter"] = jitter;
    return result;
}

std::string curlCodeToString(CURLcode code) {
    return curl_easy_strerror(code);
}

size_t discardWriteCallback(char*, size_t size, size_t nmemb, void*) {
    return size * nmemb;
}

struct UploadState {
    std::uint64_t remaining = 0;
    std::vector<char> buffer;
};

size_t uploadReadCallback(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* state = static_cast<UploadState*>(userdata);
    const std::size_t capacity = size * nmemb;
    const std::size_t bytes = static_cast<std::size_t>(
        std::min<std::uint64_t>(state->remaining, static_cast<std::uint64_t>(capacity)));
    if (bytes == 0) {
        return 0;
    }
    if (state->buffer.size() < bytes) {
        state->buffer.assign(bytes, 'x');
    }
    std::memcpy(ptr, state->buffer.data(), bytes);
    state->remaining -= bytes;
    return bytes;
}

struct HttpTiming {
    bool success = false;
    long status = 0;
    double elapsedMs = 0.0;
    std::uint64_t bytes = 0;
    std::string error;
};

HttpTiming performDownload(const std::string& url, std::uint64_t bytes, int timeoutMs) {
    HttpTiming result;
    CURL* curl = curl_easy_init();
    if (!curl) {
        result.error = "curl initialization failed";
        return result;
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discardWriteCallback);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(timeoutMs));
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(std::min(timeoutMs, 3000)));
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "ctrlpanel-internet-test/1.0");
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    const auto start = SteadyClock::now();
    const CURLcode code = curl_easy_perform(curl);
    const auto end = SteadyClock::now();
    curl_off_t downloadedBytes = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.status);
    curl_easy_getinfo(curl, CURLINFO_SIZE_DOWNLOAD_T, &downloadedBytes);
    curl_easy_cleanup(curl);

    result.elapsedMs = std::chrono::duration<double, std::milli>(end - start).count();
    result.bytes = downloadedBytes > 0 ? static_cast<std::uint64_t>(downloadedBytes) : bytes;
    result.success = code == CURLE_OK && result.status >= 200 && result.status < 400;
    if (!result.success) {
        std::ostringstream message;
        message << curlCodeToString(code);
        if (result.status > 0) {
            message << " (HTTP " << result.status << ")";
        }
        result.error = message.str();
    }
    return result;
}

HttpTiming performUpload(const std::string& url, std::uint64_t bytes, int timeoutMs) {
    HttpTiming result;
    UploadState upload;
    upload.remaining = bytes;
    upload.buffer.assign(16384, 'x');

    CURL* curl = curl_easy_init();
    if (!curl) {
        result.error = "curl initialization failed";
        return result;
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_READFUNCTION, uploadReadCallback);
    curl_easy_setopt(curl, CURLOPT_READDATA, &upload);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(bytes));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discardWriteCallback);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(timeoutMs));
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(std::min(timeoutMs, 3000)));
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "ctrlpanel-internet-test/1.0");
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    const auto start = SteadyClock::now();
    const CURLcode code = curl_easy_perform(curl);
    const auto end = SteadyClock::now();
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.status);
    curl_easy_cleanup(curl);

    result.elapsedMs = std::chrono::duration<double, std::milli>(end - start).count();
    result.bytes = bytes - upload.remaining;
    result.success = code == CURLE_OK && result.status >= 200 && result.status < 400;
    if (!result.success) {
        std::ostringstream message;
        message << curlCodeToString(code);
        if (result.status > 0) {
            message << " (HTTP " << result.status << ")";
        }
        result.error = message.str();
    }
    return result;
}

Json::Value throughputResult(const HttpTiming& timing) {
    Json::Value result(Json::objectValue);
    result["available"] = timing.success;
    result["bytes"] = static_cast<Json::UInt64>(timing.bytes);
    result["elapsed_ms"] = timing.elapsedMs;
    if (timing.success && timing.elapsedMs > 0.0) {
        result["mbps"] = (static_cast<double>(timing.bytes) * 8.0) / (timing.elapsedMs / 1000.0) / 1000000.0;
    } else if (!timing.error.empty()) {
        result["error"] = timing.error;
    }
    if (timing.status > 0) {
        result["http_status"] = static_cast<Json::Int64>(timing.status);
    }
    return result;
}

Json::Value runWanTest(const Json::Value& args, const std::function<bool()>& cancelCheck) {
    Json::Value wan(Json::objectValue);
    const int latencySamples = intArg(args, "latency_samples", kDefaultLatencySamples, 1, kMaxLatencySamples);
    const int timeoutMs = intArg(args, "http_timeout_ms", 8000, 1000, 30000);
    const auto downloadBytes = uint64Arg(args, "wan_download_bytes", kDefaultWanDownloadBytes, 1024, kMaxTestBytes);
    const auto uploadBytes = uint64Arg(args, "wan_upload_bytes", kDefaultWanUploadBytes, 1024, kMaxTestBytes);
    const std::string latencyUrl = stringArg(args, "wan_latency_url", "https://www.gstatic.com/generate_204");
    const std::string downloadUrl = stringArg(
        args,
        "wan_download_url",
        "https://speed.cloudflare.com/__down?bytes=" + std::to_string(downloadBytes));
    const std::string uploadUrl = stringArg(
        args,
        "wan_upload_url",
        "https://speed.cloudflare.com/__up");

    std::vector<double> latencies;
    Json::Value errors(Json::arrayValue);
    for (int i = 0; i < latencySamples && !cancelled(cancelCheck); ++i) {
        const HttpTiming timing = performDownload(latencyUrl, 0, timeoutMs);
        if (timing.success) {
            latencies.push_back(timing.elapsedMs);
        } else {
            errors.append(timing.error);
        }
    }

    wan["available"] = !latencies.empty();
    wan["latency_ms"] = makeStats(latencies, "ms");
    wan["jitter_ms"] = wan["latency_ms"].get("jitter", Json::Value());
    wan["latency_url"] = latencyUrl;

    if (!cancelled(cancelCheck) && wan["available"].asBool()) {
        const HttpTiming download = performDownload(downloadUrl, downloadBytes, timeoutMs);
        wan["download"] = throughputResult(download);
        wan["download"]["url"] = downloadUrl;
    }

    if (!cancelled(cancelCheck) && wan["available"].asBool()) {
        const HttpTiming upload = performUpload(uploadUrl, uploadBytes, timeoutMs);
        wan["upload"] = throughputResult(upload);
        wan["upload"]["url"] = uploadUrl;
    }

    if (!errors.empty()) {
        wan["connectivity_errors"] = errors;
    }
    wan["method"] = "HTTPS probes to configurable endpoints";
    return wan;
}

#ifndef _WIN32
bool readExact(int fd, void* data, std::size_t bytes) {
    auto* ptr = static_cast<char*>(data);
    std::size_t total = 0;
    while (total < bytes) {
        const ssize_t n = recv(fd, ptr + total, bytes - total, 0);
        if (n <= 0) {
            return false;
        }
        total += static_cast<std::size_t>(n);
    }
    return true;
}

bool writeExact(int fd, const void* data, std::size_t bytes) {
    const auto* ptr = static_cast<const char*>(data);
    std::size_t total = 0;
    while (total < bytes) {
#ifdef MSG_NOSIGNAL
        const ssize_t n = send(fd, ptr + total, bytes - total, MSG_NOSIGNAL);
#else
        const ssize_t n = send(fd, ptr + total, bytes - total, 0);
#endif
        if (n <= 0) {
            return false;
        }
        total += static_cast<std::size_t>(n);
    }
    return true;
}

void encodeUint64(std::uint64_t value, unsigned char out[8]) {
    for (int i = 7; i >= 0; --i) {
        out[i] = static_cast<unsigned char>(value & 0xffU);
        value >>= 8U;
    }
}

std::uint64_t decodeUint64(const unsigned char in[8]) {
    std::uint64_t value = 0;
    for (int i = 0; i < 8; ++i) {
        value = (value << 8U) | in[i];
    }
    return value;
}

bool sendCommandWithSize(int fd, char command, std::uint64_t bytes) {
    unsigned char header[9] = {};
    header[0] = static_cast<unsigned char>(command);
    encodeUint64(bytes, header + 1);
    return writeExact(fd, header, sizeof(header));
}

void localServerLoop(int listenFd) {
    const int client = accept(listenFd, nullptr, nullptr);
    close(listenFd);
    if (client < 0) {
        return;
    }

    std::vector<char> buffer(64 * 1024, 'l');
    for (;;) {
        char command = '\0';
        if (!readExact(client, &command, 1)) {
            break;
        }
        if (command == 'Q') {
            break;
        }
        if (command == 'P') {
            char reply = 'p';
            if (!writeExact(client, &reply, 1)) {
                break;
            }
            continue;
        }

        unsigned char encodedSize[8] = {};
        if (!readExact(client, encodedSize, sizeof(encodedSize))) {
            break;
        }
        std::uint64_t remaining = decodeUint64(encodedSize);

        if (command == 'D') {
            while (remaining > 0) {
                const std::size_t chunk = static_cast<std::size_t>(
                    std::min<std::uint64_t>(remaining, buffer.size()));
                if (!writeExact(client, buffer.data(), chunk)) {
                    close(client);
                    return;
                }
                remaining -= chunk;
            }
        } else if (command == 'U') {
            while (remaining > 0) {
                const std::size_t chunk = static_cast<std::size_t>(
                    std::min<std::uint64_t>(remaining, buffer.size()));
                if (!readExact(client, buffer.data(), chunk)) {
                    close(client);
                    return;
                }
                remaining -= chunk;
            }
            char ack = 'u';
            if (!writeExact(client, &ack, 1)) {
                break;
            }
        } else {
            break;
        }
    }
    close(client);
}

Json::Value localThroughputResult(bool success, std::uint64_t bytes, double elapsedMs, const std::string& error = "") {
    Json::Value result(Json::objectValue);
    result["available"] = success;
    result["bytes"] = static_cast<Json::UInt64>(bytes);
    result["elapsed_ms"] = elapsedMs;
    if (success && elapsedMs > 0.0) {
        result["mbps"] = (static_cast<double>(bytes) * 8.0) / (elapsedMs / 1000.0) / 1000000.0;
    } else if (!error.empty()) {
        result["error"] = error;
    }
    return result;
}

Json::Value runLocalTest(const Json::Value& args, const std::function<bool()>& cancelCheck) {
    Json::Value local(Json::objectValue);
    const int latencySamples = intArg(args, "local_latency_samples", kDefaultLatencySamples, 1, kMaxLatencySamples);
    const auto localBytes = uint64Arg(args, "local_test_bytes", kDefaultLocalBytes, 1024, kMaxTestBytes);

    const int listenFd = socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd < 0) {
        local["available"] = false;
        local["error"] = "failed to create loopback socket";
        return local;
    }

    int enabled = 1;
    setsockopt(listenFd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (bind(listenFd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
        listen(listenFd, 1) != 0) {
        close(listenFd);
        local["available"] = false;
        local["error"] = "failed to bind loopback benchmark socket";
        return local;
    }

    socklen_t addressLength = sizeof(address);
    if (getsockname(listenFd, reinterpret_cast<sockaddr*>(&address), &addressLength) != 0) {
        close(listenFd);
        local["available"] = false;
        local["error"] = "failed to inspect loopback benchmark socket";
        return local;
    }
    const std::uint16_t port = ntohs(address.sin_port);

    std::thread server(localServerLoop, listenFd);
    const int client = socket(AF_INET, SOCK_STREAM, 0);
    if (client < 0) {
        shutdown(listenFd, SHUT_RDWR);
        close(listenFd);
        server.join();
        local["available"] = false;
        local["error"] = "failed to create loopback client socket";
        return local;
    }
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
    address.sin_port = htons(port);
    if (connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
        close(client);
        shutdown(listenFd, SHUT_RDWR);
        close(listenFd);
        server.join();
        local["available"] = false;
        local["error"] = "failed to connect to loopback benchmark socket";
        return local;
    }

    std::vector<double> latencies;
    for (int i = 0; i < latencySamples && !cancelled(cancelCheck); ++i) {
        const char command = 'P';
        const auto start = SteadyClock::now();
        char reply = '\0';
        if (!writeExact(client, &command, 1) || !readExact(client, &reply, 1) || reply != 'p') {
            break;
        }
        const auto end = SteadyClock::now();
        latencies.push_back(std::chrono::duration<double, std::milli>(end - start).count());
    }

    std::vector<char> buffer(64 * 1024, 'c');
    bool downloadOk = false;
    double downloadMs = 0.0;
    if (!cancelled(cancelCheck) && sendCommandWithSize(client, 'D', localBytes)) {
        std::uint64_t remaining = localBytes;
        const auto start = SteadyClock::now();
        while (remaining > 0) {
            const std::size_t chunk = static_cast<std::size_t>(
                std::min<std::uint64_t>(remaining, buffer.size()));
            if (!readExact(client, buffer.data(), chunk)) {
                break;
            }
            remaining -= chunk;
        }
        const auto end = SteadyClock::now();
        downloadOk = remaining == 0;
        downloadMs = std::chrono::duration<double, std::milli>(end - start).count();
    }

    bool uploadOk = false;
    double uploadMs = 0.0;
    if (!cancelled(cancelCheck) && sendCommandWithSize(client, 'U', localBytes)) {
        std::uint64_t remaining = localBytes;
        const auto start = SteadyClock::now();
        while (remaining > 0) {
            const std::size_t chunk = static_cast<std::size_t>(
                std::min<std::uint64_t>(remaining, buffer.size()));
            if (!writeExact(client, buffer.data(), chunk)) {
                break;
            }
            remaining -= chunk;
        }
        char ack = '\0';
        uploadOk = remaining == 0 && readExact(client, &ack, 1) && ack == 'u';
        const auto end = SteadyClock::now();
        uploadMs = std::chrono::duration<double, std::milli>(end - start).count();
    }

    const char quit = 'Q';
    writeExact(client, &quit, 1);
    close(client);
    server.join();

    local["available"] = !latencies.empty() && downloadOk && uploadOk;
    local["latency_ms"] = makeStats(latencies, "ms");
    local["jitter_ms"] = local["latency_ms"].get("jitter", Json::Value());
    local["download"] = localThroughputResult(downloadOk, localBytes, downloadMs, "loopback download failed");
    local["upload"] = localThroughputResult(uploadOk, localBytes, uploadMs, "loopback upload failed");
    local["method"] = "TCP loopback benchmark on 127.0.0.1";
    return local;
}
#else
Json::Value runLocalTest(const Json::Value&, const std::function<bool()>&) {
    Json::Value local(Json::objectValue);
    local["available"] = false;
    local["error"] = "local loopback benchmark is not implemented on Windows";
    return local;
}
#endif

} // namespace

Json::Value internet_testing_tool::runTest(const Json::Value& arguments, std::function<bool()> cancelCheck) {
    Json::Value result(Json::objectValue);
    result["timestamp_ms"] = static_cast<Json::Int64>(nowMillis());
    result["summary"]["wan_available"] = false;
    result["summary"]["local_available"] = false;

    const bool includeWan = !arguments.isObject() ||
        !arguments.isMember("include_wan") ||
        !arguments["include_wan"].isBool() ||
        arguments["include_wan"].asBool();
    const bool includeLocal = !arguments.isObject() ||
        !arguments.isMember("include_local") ||
        !arguments["include_local"].isBool() ||
        arguments["include_local"].asBool();

    if (includeWan && !cancelled(cancelCheck)) {
        result["wan"] = runWanTest(arguments, cancelCheck);
        result["summary"]["wan_available"] = result["wan"].get("available", false).asBool();
    }
    if (includeLocal && !cancelled(cancelCheck)) {
        result["local"] = runLocalTest(arguments, cancelCheck);
        result["summary"]["local_available"] = result["local"].get("available", false).asBool();
    }
    if (cancelled(cancelCheck)) {
        result["cancelled"] = true;
    }
    return result;
}
