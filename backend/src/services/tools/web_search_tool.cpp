#include "services/tools/web_search_tool.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <curl/curl.h>
#include <openssl/sha.h>
#include <sqlite3.h>

#ifndef _WIN32
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#endif

namespace fs = std::filesystem;

namespace {

using Clock = std::chrono::system_clock;

constexpr std::int64_t kHourMs = 60LL * 60LL * 1000LL;
constexpr std::int64_t kDayMs = 24LL * kHourMs;
constexpr std::int64_t kWeekMs = 7LL * kDayMs;
constexpr int kDefaultQueueLinks = 25;
constexpr int kMaxCrawlDepth = 2;
constexpr int kHostDiversityCap = 2;
constexpr int kMaxRelatedCandidates = 32;
constexpr int kMaxExtractedLinks = 256;
constexpr int kRobotsBodyBytes = 256 * 1024;

std::int64_t nowMillis() {
    return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now().time_since_epoch()).count());
}

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

bool startsWith(const std::string& value, const std::string& prefix) {
    return value.size() >= prefix.size() &&
           value.compare(0, prefix.size(), prefix) == 0;
}

bool endsWith(const std::string& value, const std::string& suffix) {
    return value.size() >= suffix.size() &&
           value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string jsonToString(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

Json::Value makeError(const std::string& message) {
    Json::Value error(Json::objectValue);
    error["error"] = message;
    return error;
}

std::string normalizeWhitespace(const std::string& input) {
    std::string out;
    out.reserve(input.size());
    bool previousSpace = true;
    int newlineRun = 0;

    for (char ch : input) {
        if (ch == '\r') {
            continue;
        }

        if (ch == '\n') {
            while (!out.empty() && out.back() == ' ') {
                out.pop_back();
            }
            if (!out.empty() && out.back() != '\n' && newlineRun == 0) {
                out.push_back('\n');
            } else if (!out.empty() && out.back() == '\n' && newlineRun == 1) {
                out.push_back('\n');
            } else if (out.empty()) {
                out.push_back('\n');
            }
            newlineRun = std::min(newlineRun + 1, 2);
            previousSpace = true;
            continue;
        }

        newlineRun = 0;
        if (std::isspace(static_cast<unsigned char>(ch))) {
            if (!previousSpace && (out.empty() || out.back() != '\n')) {
                out.push_back(' ');
            }
            previousSpace = true;
            continue;
        }

        out.push_back(ch);
        previousSpace = false;
    }

    return trimCopy(out);
}

void appendUtf8(std::string& out, unsigned int codepoint) {
    if (codepoint <= 0x7F) {
        out.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | ((codepoint >> 6) & 0x1F)));
        out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else if (codepoint <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | ((codepoint >> 12) & 0x0F)));
        out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | ((codepoint >> 18) & 0x07)));
        out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    }
}

std::string decodeHtmlEntities(const std::string& input) {
    std::string out;
    out.reserve(input.size());

    for (std::size_t index = 0; index < input.size(); ++index) {
        if (input[index] != '&') {
            out.push_back(input[index]);
            continue;
        }

        const std::size_t semi = input.find(';', index + 1);
        if (semi == std::string::npos || semi - index > 12) {
            out.push_back(input[index]);
            continue;
        }

        const std::string entity = input.substr(index + 1, semi - index - 1);
        bool decoded = true;
        if (entity == "amp") out.push_back('&');
        else if (entity == "lt") out.push_back('<');
        else if (entity == "gt") out.push_back('>');
        else if (entity == "quot") out.push_back('"');
        else if (entity == "apos" || entity == "#39") out.push_back('\'');
        else if (!entity.empty() && entity[0] == '#') {
            try {
                const unsigned int codepoint =
                    entity.size() > 2 && (entity[1] == 'x' || entity[1] == 'X')
                        ? static_cast<unsigned int>(std::stoul(entity.substr(2), nullptr, 16))
                        : static_cast<unsigned int>(std::stoul(entity.substr(1), nullptr, 10));
                appendUtf8(out, codepoint);
            } catch (...) {
                decoded = false;
            }
        } else {
            decoded = false;
        }

        if (!decoded) {
            out.push_back('&');
            continue;
        }
        index = semi;
    }

    return out;
}

std::string stripCdata(const std::string& input) {
    std::string value = trimCopy(input);
    if (startsWith(value, "<![CDATA[") && endsWith(value, "]]>")) {
        value = value.substr(9, value.size() - 12);
    }
    return value;
}

std::vector<std::string> tokenizeTerms(const std::string& input) {
    std::vector<std::string> tokens;
    std::string current;
    current.reserve(input.size());

    for (char ch : input) {
        const unsigned char value = static_cast<unsigned char>(ch);
        if (std::isalnum(value)) {
            current.push_back(static_cast<char>(std::tolower(value)));
            continue;
        }
        if (current.size() >= 2) {
            tokens.push_back(current);
        }
        current.clear();
    }

    if (current.size() >= 2) {
        tokens.push_back(current);
    }
    return tokens;
}

std::string sha256Hex(const std::string& input) {
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(input.data()), input.size(), digest);

    std::ostringstream stream;
    stream << std::hex << std::setfill('0');
    for (unsigned char byte : digest) {
        stream << std::setw(2) << static_cast<int>(byte);
    }
    return stream.str();
}

std::uint64_t fnv1a64(const std::string& input) {
    constexpr std::uint64_t kOffset = 1469598103934665603ULL;
    constexpr std::uint64_t kPrime = 1099511628211ULL;

    std::uint64_t hash = kOffset;
    for (unsigned char ch : input) {
        hash ^= static_cast<std::uint64_t>(ch);
        hash *= kPrime;
    }
    return hash;
}

std::uint64_t computeSimhash(const std::string& text) {
    const auto tokens = tokenizeTerms(text);
    if (tokens.empty()) {
        return 0;
    }

    std::array<long long, 64> weights{};
    if (tokens.size() < 3) {
        for (const auto& token : tokens) {
            const std::uint64_t hash = fnv1a64(token);
            for (int bit = 0; bit < 64; ++bit) {
                weights[bit] += ((hash >> bit) & 1ULL) ? 1LL : -1LL;
            }
        }
    } else {
        for (std::size_t index = 0; index + 2 < tokens.size(); ++index) {
            const std::string shingle = tokens[index] + " " + tokens[index + 1] + " " + tokens[index + 2];
            const std::uint64_t hash = fnv1a64(shingle);
            for (int bit = 0; bit < 64; ++bit) {
                weights[bit] += ((hash >> bit) & 1ULL) ? 1LL : -1LL;
            }
        }
    }

    std::uint64_t output = 0;
    for (int bit = 0; bit < 64; ++bit) {
        if (weights[bit] >= 0) {
            output |= (1ULL << bit);
        }
    }
    return output;
}

std::string simhashHex(std::uint64_t value) {
    std::ostringstream stream;
    stream << std::hex << std::setfill('0') << std::setw(16) << value;
    return stream.str();
}

std::uint64_t parseSimhashHex(const std::string& value) {
    try {
        return static_cast<std::uint64_t>(std::stoull(value, nullptr, 16));
    } catch (...) {
        return 0;
    }
}

int hammingDistance(std::uint64_t left, std::uint64_t right) {
    std::uint64_t diff = left ^ right;
    int count = 0;
    while (diff != 0) {
        diff &= (diff - 1);
        ++count;
    }
    return count;
}

bool hostMatchesFilter(const std::string& host, const std::string& filter) {
    if (filter.empty()) {
        return false;
    }
    return host == filter || endsWith(host, "." + filter);
}

std::string normalizeDomainFilter(std::string value) {
    value = trimCopy(toLower(std::move(value)));
    if (startsWith(value, "https://")) {
        value = value.substr(8);
    } else if (startsWith(value, "http://")) {
        value = value.substr(7);
    }
    const auto slash = value.find('/');
    if (slash != std::string::npos) {
        value = value.substr(0, slash);
    }
    if (startsWith(value, "www.")) {
        value = value.substr(4);
    }
    return trimCopy(value);
}

std::string firstNChars(const std::string& value, std::size_t maxChars) {
    if (value.size() <= maxChars) {
        return value;
    }
    return value.substr(0, maxChars);
}

std::string pathExtension(const std::string& path) {
    const auto slash = path.find_last_of('/');
    const auto dot = path.find_last_of('.');
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) {
        return "";
    }
    return toLower(path.substr(dot));
}

bool looksLikeBinaryAsset(const std::string& path) {
    static const std::unordered_set<std::string> blockedExt = {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".css", ".js",
        ".mjs", ".mp3", ".mp4", ".m4a", ".mov", ".avi", ".zip", ".gz", ".tgz",
        ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".webm", ".dmg", ".exe"
    };
    return blockedExt.find(pathExtension(path)) != blockedExt.end();
}

double computeQualityScore(
    const std::string& title,
    const std::string& description,
    const std::string& bodyText,
    std::size_t headingCount,
    std::size_t linkCount) {
    double score = 0.0;
    if (!title.empty()) score += 18.0;
    if (!description.empty()) score += 10.0;

    const double bodyLen = static_cast<double>(bodyText.size());
    score += std::min(45.0, bodyLen / 70.0);
    score += std::min(12.0, static_cast<double>(headingCount) * 3.0);

    if (linkCount > 0 && bodyLen > 0) {
        const double linkPenalty = std::min(15.0, (static_cast<double>(linkCount) * 40.0) / bodyLen);
        score -= linkPenalty;
    }

    return std::clamp(score, 0.0, 100.0);
}

std::string joinLines(const std::vector<std::string>& values) {
    std::string output;
    for (const auto& value : values) {
        if (value.empty()) {
            continue;
        }
        if (!output.empty()) {
            output += "\n";
        }
        output += value;
    }
    return output;
}

struct CurlStringBuffer {
    std::string body;
    std::size_t maxBytes = 0;
    bool truncated = false;
};

struct CurlProgressContext {
    const std::function<bool()>* cancelCheck = nullptr;
    const std::atomic<bool>* shutdownRequested = nullptr;
    bool cancelled = false;
};

size_t curlWriteToString(void* contents, size_t size, size_t nmemb, void* userp) {
    const size_t total = size * nmemb;
    auto* buffer = static_cast<CurlStringBuffer*>(userp);
    if (buffer->maxBytes > 0 && buffer->body.size() + total > buffer->maxBytes) {
        const std::size_t remaining = buffer->maxBytes > buffer->body.size()
            ? buffer->maxBytes - buffer->body.size()
            : 0;
        if (remaining > 0) {
            buffer->body.append(static_cast<const char*>(contents), remaining);
        }
        buffer->truncated = true;
        return 0;
    }
    buffer->body.append(static_cast<const char*>(contents), total);
    return total;
}

int curlProgressAbortCheck(
    void* clientp,
    curl_off_t,
    curl_off_t,
    curl_off_t,
    curl_off_t) {
    auto* context = static_cast<CurlProgressContext*>(clientp);
    if (!context) {
        return 0;
    }
    if (context->shutdownRequested && context->shutdownRequested->load(std::memory_order_relaxed)) {
        context->cancelled = true;
        return 1;
    }
    if (context->cancelCheck && *context->cancelCheck && (*context->cancelCheck)()) {
        context->cancelled = true;
        return 1;
    }
    return 0;
}

struct HeaderCapture {
    std::unordered_map<std::string, std::string> headers;
};

size_t curlHeaderToMap(char* buffer, size_t size, size_t nitems, void* userdata) {
    const size_t total = size * nitems;
    auto* capture = static_cast<HeaderCapture*>(userdata);
    std::string line(buffer, total);

    const auto colon = line.find(':');
    if (colon != std::string::npos) {
        std::string key = toLower(trimCopy(line.substr(0, colon)));
        std::string value = trimCopy(line.substr(colon + 1));
        if (!key.empty()) {
            capture->headers[key] = value;
        }
    }
    return total;
}

class SqliteStatement {
public:
    SqliteStatement(sqlite3* db, const std::string& sql) {
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt_, nullptr) != SQLITE_OK) {
            stmt_ = nullptr;
        }
    }

    ~SqliteStatement() {
        if (stmt_) {
            sqlite3_finalize(stmt_);
        }
    }

    sqlite3_stmt* get() const {
        return stmt_;
    }

    explicit operator bool() const {
        return stmt_ != nullptr;
    }

private:
    sqlite3_stmt* stmt_ = nullptr;
};

bool execSql(sqlite3* db, const std::string& sql, std::string* errorOut = nullptr) {
    char* error = nullptr;
    if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &error) == SQLITE_OK) {
        return true;
    }

    if (errorOut) {
        *errorOut = error ? error : "sqlite error";
    }
    if (error) {
        sqlite3_free(error);
    }
    return false;
}

std::string columnText(sqlite3_stmt* stmt, int column) {
    const unsigned char* text = sqlite3_column_text(stmt, column);
    if (!text) {
        return "";
    }
    return reinterpret_cast<const char*>(text);
}

struct ParsedUrl {
    std::string url;
    std::string scheme;
    std::string host;
    std::string authority;
    std::string path;
    std::string query;
    std::string pathWithQuery;
};

std::string normalizePath(const std::string& rawPath) {
    std::vector<std::string> segments;
    std::stringstream stream(rawPath);
    std::string item;

    while (std::getline(stream, item, '/')) {
        if (item.empty() || item == ".") {
            continue;
        }
        if (item == "..") {
            if (!segments.empty()) {
                segments.pop_back();
            }
            continue;
        }
        segments.push_back(item);
    }

    std::string normalized = "/";
    for (std::size_t index = 0; index < segments.size(); ++index) {
        if (index > 0) {
            normalized += "/";
        }
        normalized += segments[index];
    }

    if (!rawPath.empty() && rawPath.back() == '/' && normalized.back() != '/') {
        normalized.push_back('/');
    }

    return normalized;
}

std::optional<ParsedUrl> canonicalizeUrl(const std::string& input, const std::string& baseUrl, std::string& errorOut) {
    std::string candidate = trimCopy(input);
    if (candidate.empty()) {
        errorOut = "URL is empty";
        return std::nullopt;
    }

    if (baseUrl.empty() && candidate.find("://") == std::string::npos) {
        candidate = "https://" + candidate;
    }

    CURLU* handle = curl_url();
    if (!handle) {
        errorOut = "Failed to initialize URL parser";
        return std::nullopt;
    }

    const auto cleanup = [&]() {
        curl_url_cleanup(handle);
    };

    CURLUcode code = CURLUE_OK;
    if (!baseUrl.empty()) {
        code = curl_url_set(handle, CURLUPART_URL, baseUrl.c_str(), 0);
        if (code == CURLUE_OK) {
            code = curl_url_set(handle, CURLUPART_URL, candidate.c_str(), 0);
        }
    } else {
        code = curl_url_set(handle, CURLUPART_URL, candidate.c_str(), 0);
    }

    if (code != CURLUE_OK) {
        errorOut = "Invalid URL";
        cleanup();
        return std::nullopt;
    }

    curl_url_set(handle, CURLUPART_FRAGMENT, nullptr, 0);
    curl_url_set(handle, CURLUPART_USER, nullptr, 0);
    curl_url_set(handle, CURLUPART_PASSWORD, nullptr, 0);

    char* schemeRaw = nullptr;
    char* hostRaw = nullptr;
    char* portRaw = nullptr;
    char* pathRaw = nullptr;
    char* queryRaw = nullptr;

    if (curl_url_get(handle, CURLUPART_SCHEME, &schemeRaw, 0) != CURLUE_OK ||
        curl_url_get(handle, CURLUPART_HOST, &hostRaw, 0) != CURLUE_OK) {
        cleanup();
        errorOut = "URL is missing a host";
        return std::nullopt;
    }

    std::string scheme = toLower(schemeRaw ? schemeRaw : "");
    std::string host = toLower(hostRaw ? hostRaw : "");
    curl_free(schemeRaw);
    curl_free(hostRaw);

    if (scheme != "http" && scheme != "https") {
        cleanup();
        errorOut = "Only http and https URLs are supported";
        return std::nullopt;
    }

    if (host.empty()) {
        cleanup();
        errorOut = "URL is missing a host";
        return std::nullopt;
    }

    if (curl_url_get(handle, CURLUPART_PORT, &portRaw, 0) != CURLUE_OK) {
        portRaw = nullptr;
    }
    if (curl_url_get(handle, CURLUPART_PATH, &pathRaw, 0) != CURLUE_OK || !pathRaw || !*pathRaw) {
        curl_url_set(handle, CURLUPART_PATH, "/", 0);
        if (pathRaw) {
            curl_free(pathRaw);
        }
        pathRaw = nullptr;
        curl_url_get(handle, CURLUPART_PATH, &pathRaw, 0);
    }
    if (curl_url_get(handle, CURLUPART_QUERY, &queryRaw, 0) != CURLUE_OK) {
        queryRaw = nullptr;
    }

    const std::string path = normalizePath(pathRaw ? pathRaw : "/");
    curl_url_set(handle, CURLUPART_SCHEME, scheme.c_str(), 0);
    curl_url_set(handle, CURLUPART_HOST, host.c_str(), 0);
    curl_url_set(handle, CURLUPART_PATH, path.c_str(), 0);

    const bool defaultPort = (!portRaw || !*portRaw) ||
                             (scheme == "http" && std::string(portRaw) == "80") ||
                             (scheme == "https" && std::string(portRaw) == "443");
    if (defaultPort) {
        curl_url_set(handle, CURLUPART_PORT, nullptr, 0);
    }

    char* fullUrl = nullptr;
    if (curl_url_get(handle, CURLUPART_URL, &fullUrl, CURLU_NO_DEFAULT_PORT) != CURLUE_OK) {
        if (portRaw) curl_free(portRaw);
        if (pathRaw) curl_free(pathRaw);
        if (queryRaw) curl_free(queryRaw);
        cleanup();
        errorOut = "Failed to normalize URL";
        return std::nullopt;
    }

    ParsedUrl parsed;
    parsed.url = fullUrl ? fullUrl : "";
    parsed.scheme = scheme;
    parsed.host = host;
    parsed.path = path;
    parsed.query = queryRaw ? queryRaw : "";
    parsed.pathWithQuery = parsed.path + (parsed.query.empty() ? "" : "?" + parsed.query);
    parsed.authority = scheme + "://" + host;
    if (!defaultPort && portRaw && *portRaw) {
        parsed.authority += ":";
        parsed.authority += portRaw;
    }

    curl_free(fullUrl);
    if (portRaw) curl_free(portRaw);
    if (pathRaw) curl_free(pathRaw);
    if (queryRaw) curl_free(queryRaw);
    cleanup();
    return parsed;
}

bool isPrivateIpv4(std::uint32_t address) {
    const std::uint8_t a = static_cast<std::uint8_t>((address >> 24) & 0xFF);
    const std::uint8_t b = static_cast<std::uint8_t>((address >> 16) & 0xFF);

    if (a == 10 || a == 127 || a == 0) return true;
    if (a == 169 && b == 254) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    if (a == 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
}

bool isPrivateIpv6(const in6_addr& address) {
    if (IN6_IS_ADDR_LOOPBACK(&address) || IN6_IS_ADDR_LINKLOCAL(&address) ||
        IN6_IS_ADDR_MULTICAST(&address) || IN6_IS_ADDR_UNSPECIFIED(&address)) {
        return true;
    }
    return (address.s6_addr[0] & 0xFE) == 0xFC;
}

bool isPublicHttpHost(const ParsedUrl& url, bool allowPrivateHosts, std::string& reasonOut) {
    if (allowPrivateHosts) {
        return true;
    }

    if (url.host == "localhost" || url.host == "0.0.0.0" || endsWith(url.host, ".local")) {
        reasonOut = "Local and private hosts are blocked for web search fetches";
        return false;
    }

    in_addr ipv4{};
    if (inet_pton(AF_INET, url.host.c_str(), &ipv4) == 1) {
        const std::uint32_t address = ntohl(ipv4.s_addr);
        if (isPrivateIpv4(address)) {
            reasonOut = "Private IPv4 addresses are blocked";
            return false;
        }
        return true;
    }

    in6_addr ipv6{};
    if (inet_pton(AF_INET6, url.host.c_str(), &ipv6) == 1) {
        if (isPrivateIpv6(ipv6)) {
            reasonOut = "Private IPv6 addresses are blocked";
            return false;
        }
        return true;
    }

    // Hostname resolution can block outside libcurl's timeout handling on some
    // systems. Let curl resolve names, then reject private targets in the socket
    // open callback where the normal fetch timeout/cancellation still applies.
    return true;
}

curl_socket_t curlOpenPublicHttpSocket(void*, curlsocktype purpose, curl_sockaddr* address) {
    if (purpose != CURLSOCKTYPE_IPCXN || !address) {
        return CURL_SOCKET_BAD;
    }

    if (address->family == AF_INET) {
        const auto* addr = reinterpret_cast<const sockaddr_in*>(&address->addr);
        if (addr && isPrivateIpv4(ntohl(addr->sin_addr.s_addr))) {
            return CURL_SOCKET_BAD;
        }
    } else if (address->family == AF_INET6) {
        const auto* addr = reinterpret_cast<const sockaddr_in6*>(&address->addr);
        if (addr && isPrivateIpv6(addr->sin6_addr)) {
            return CURL_SOCKET_BAD;
        }
    }

    return socket(address->family, address->socktype, address->protocol);
}

struct RobotsRule {
    bool allow = false;
    std::string pattern;
};

struct RobotsDefinition {
    std::vector<RobotsRule> rules;
    std::vector<std::string> sitemaps;
    double crawlDelaySeconds = 0.0;
};

struct RobotsGroup {
    std::vector<std::string> userAgents;
    std::vector<RobotsRule> rules;
    double crawlDelaySeconds = 0.0;
};

bool robotsPatternMatches(const std::string& pattern, const std::string& value) {
    if (pattern.empty()) {
        return false;
    }

    bool endAnchored = false;
    std::string rule = pattern;
    if (!rule.empty() && rule.back() == '$') {
        endAnchored = true;
        rule.pop_back();
    }

    const auto star = rule.find('*');
    if (star == std::string::npos) {
        if (endAnchored) {
            return value == rule;
        }
        return startsWith(value, rule);
    }

    std::size_t position = 0;
    std::size_t tokenStart = 0;
    bool first = true;
    while (tokenStart <= rule.size()) {
        const std::size_t tokenEnd = rule.find('*', tokenStart);
        const std::string token = rule.substr(tokenStart, tokenEnd - tokenStart);
        if (!token.empty()) {
            if (first) {
                if (!startsWith(value, token)) {
                    return false;
                }
                position = token.size();
            } else {
                const std::size_t found = value.find(token, position);
                if (found == std::string::npos) {
                    return false;
                }
                position = found + token.size();
            }
            first = false;
        }
        if (tokenEnd == std::string::npos) {
            break;
        }
        tokenStart = tokenEnd + 1;
    }

    if (endAnchored) {
        const std::string tail = rule.substr(rule.find_last_of('*') == std::string::npos ? 0 : rule.find_last_of('*') + 1);
        if (!tail.empty()) {
            return endsWith(value, tail);
        }
    }
    return true;
}

RobotsDefinition parseRobotsDefinition(const std::string& body, const std::string& userAgent) {
    std::vector<RobotsGroup> groups;
    RobotsGroup current;
    bool seenRuleInGroup = false;
    std::vector<std::string> sitemaps;

    std::stringstream stream(body);
    std::string line;
    while (std::getline(stream, line)) {
        const auto hash = line.find('#');
        if (hash != std::string::npos) {
            line = line.substr(0, hash);
        }
        line = trimCopy(line);
        if (line.empty()) {
            continue;
        }

        const auto colon = line.find(':');
        if (colon == std::string::npos) {
            continue;
        }

        const std::string key = toLower(trimCopy(line.substr(0, colon)));
        const std::string value = trimCopy(line.substr(colon + 1));
        if (key == "user-agent") {
            if (!current.userAgents.empty() && seenRuleInGroup) {
                groups.push_back(current);
                current = RobotsGroup{};
                seenRuleInGroup = false;
            }
            current.userAgents.push_back(toLower(value));
            continue;
        }
        if (key == "sitemap") {
            sitemaps.push_back(value);
            continue;
        }
        if (current.userAgents.empty()) {
            continue;
        }

        seenRuleInGroup = true;
        if (key == "allow") {
            current.rules.push_back({true, value});
        } else if (key == "disallow") {
            current.rules.push_back({false, value});
        } else if (key == "crawl-delay") {
            try {
                current.crawlDelaySeconds = std::stod(value);
            } catch (...) {
            }
        }
    }

    if (!current.userAgents.empty()) {
        groups.push_back(current);
    }

    const std::string loweredAgent = toLower(userAgent);
    const RobotsGroup* bestGroup = nullptr;
    std::size_t bestLength = 0;
    for (const auto& group : groups) {
        for (const auto& groupAgent : group.userAgents) {
            if (groupAgent == "*" || loweredAgent.find(groupAgent) != std::string::npos) {
                if (groupAgent.size() >= bestLength) {
                    bestLength = groupAgent.size();
                    bestGroup = &group;
                }
            }
        }
    }

    RobotsDefinition definition;
    definition.sitemaps = sitemaps;
    if (bestGroup) {
        definition.rules = bestGroup->rules;
        definition.crawlDelaySeconds = bestGroup->crawlDelaySeconds;
    }
    return definition;
}

bool robotsAllowsPath(const RobotsDefinition& definition, const std::string& pathWithQuery) {
    const RobotsRule* bestRule = nullptr;
    std::size_t bestLength = 0;

    for (const auto& rule : definition.rules) {
        if (rule.pattern.empty()) {
            continue;
        }
        if (!robotsPatternMatches(rule.pattern, pathWithQuery)) {
            continue;
        }
        if (!bestRule || rule.pattern.size() > bestLength ||
            (rule.pattern.size() == bestLength && rule.allow)) {
            bestRule = &rule;
            bestLength = rule.pattern.size();
        }
    }

    if (!bestRule) {
        return true;
    }
    return bestRule->allow;
}

struct ParsedTag {
    bool valid = false;
    bool isClosing = false;
    bool selfClosing = false;
    bool isComment = false;
    std::string name;
    std::unordered_map<std::string, std::string> attrs;
};

ParsedTag parseTag(const std::string& html, std::size_t start, std::size_t& nextPosition) {
    ParsedTag tag;
    nextPosition = start;
    if (start >= html.size() || html[start] != '<') {
        return tag;
    }

    if (html.compare(start, 4, "<!--") == 0) {
        const auto end = html.find("-->", start + 4);
        nextPosition = end == std::string::npos ? html.size() : end + 3;
        tag.isComment = true;
        return tag;
    }

    std::size_t index = start + 1;
    if (index < html.size() && html[index] == '/') {
        tag.isClosing = true;
        ++index;
    }
    while (index < html.size() && std::isspace(static_cast<unsigned char>(html[index]))) {
        ++index;
    }

    const std::size_t nameStart = index;
    while (index < html.size() &&
           (std::isalnum(static_cast<unsigned char>(html[index])) || html[index] == ':' || html[index] == '-')) {
        ++index;
    }

    tag.name = toLower(html.substr(nameStart, index - nameStart));
    if (tag.name.empty()) {
        const auto end = html.find('>', start + 1);
        nextPosition = end == std::string::npos ? html.size() : end + 1;
        return tag;
    }

    while (index < html.size()) {
        while (index < html.size() && std::isspace(static_cast<unsigned char>(html[index]))) {
            ++index;
        }
        if (index >= html.size()) {
            break;
        }
        if (html[index] == '>') {
            ++index;
            break;
        }
        if (html[index] == '/') {
            tag.selfClosing = true;
            ++index;
            continue;
        }

        const std::size_t keyStart = index;
        while (index < html.size() &&
               (std::isalnum(static_cast<unsigned char>(html[index])) || html[index] == '-' || html[index] == ':')) {
            ++index;
        }
        std::string key = toLower(html.substr(keyStart, index - keyStart));
        while (index < html.size() && std::isspace(static_cast<unsigned char>(html[index]))) {
            ++index;
        }

        std::string value;
        if (index < html.size() && html[index] == '=') {
            ++index;
            while (index < html.size() && std::isspace(static_cast<unsigned char>(html[index]))) {
                ++index;
            }
            if (index < html.size() && (html[index] == '"' || html[index] == '\'')) {
                const char quote = html[index++];
                const std::size_t valueStart = index;
                while (index < html.size() && html[index] != quote) {
                    ++index;
                }
                value = html.substr(valueStart, index - valueStart);
                if (index < html.size()) {
                    ++index;
                }
            } else {
                const std::size_t valueStart = index;
                while (index < html.size() && !std::isspace(static_cast<unsigned char>(html[index])) &&
                       html[index] != '>') {
                    ++index;
                }
                value = html.substr(valueStart, index - valueStart);
            }
        }

        if (!key.empty()) {
            tag.attrs[key] = decodeHtmlEntities(value);
        }
    }

    nextPosition = index;
    tag.valid = true;
    return tag;
}

struct ExtractedLink {
    std::string url;
    std::string text;
};

struct ExtractedDocument {
    std::string title;
    std::string headings;
    std::string description;
    std::string lang;
    std::string canonicalUrl;
    std::string metaRobots;
    std::string bodyText;
    std::vector<ExtractedLink> links;
};

ExtractedDocument extractHtmlDocument(const std::string& html) {
    ExtractedDocument doc;
    std::string rawBody;
    std::vector<std::string> headings;

    int skipDepth = 0;
    int boilerplateDepth = 0;
    int headDepth = 0;
    int titleDepth = 0;
    std::vector<std::string> headingStack;
    std::vector<std::string> headingTextStack;
    struct Anchor {
        std::string href;
        std::string text;
    };
    std::vector<Anchor> anchors;

    auto appendBlockBreak = [&]() {
        if (!rawBody.empty() && rawBody.back() != '\n') {
            rawBody.push_back('\n');
        }
    };

    std::size_t cursor = 0;
    while (cursor < html.size()) {
        const auto tagStart = html.find('<', cursor);
        const std::string text = decodeHtmlEntities(html.substr(cursor, tagStart - cursor));
        if (!text.empty()) {
            if (titleDepth > 0) {
                doc.title += text;
            }
            if (!headingTextStack.empty()) {
                headingTextStack.back() += text;
            }
            if (skipDepth == 0 && headDepth == 0 && boilerplateDepth == 0) {
                rawBody += text;
            }
            if (!anchors.empty()) {
                anchors.back().text += text;
            }
        }

        if (tagStart == std::string::npos) {
            break;
        }

        std::size_t next = tagStart + 1;
        const ParsedTag tag = parseTag(html, tagStart, next);
        cursor = next;
        if (!tag.valid || tag.isComment) {
            continue;
        }

        static const std::unordered_set<std::string> blockTags = {
            "article", "section", "div", "p", "br", "li", "ul", "ol", "main",
            "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"
        };
        static const std::unordered_set<std::string> skipTags = {
            "script", "style", "noscript", "svg", "canvas", "template"
        };
        static const std::unordered_set<std::string> boilerplateTags = {
            "nav", "header", "footer", "aside", "form"
        };

        if (tag.isClosing) {
            if (skipTags.find(tag.name) != skipTags.end() && skipDepth > 0) {
                --skipDepth;
            }
            if (boilerplateTags.find(tag.name) != boilerplateTags.end() && boilerplateDepth > 0) {
                --boilerplateDepth;
            }
            if (tag.name == "head" && headDepth > 0) {
                --headDepth;
            }
            if (tag.name == "title" && titleDepth > 0) {
                --titleDepth;
            }
            if ((tag.name == "h1" || tag.name == "h2" || tag.name == "h3") && !headingTextStack.empty()) {
                const std::string heading = normalizeWhitespace(headingTextStack.back());
                if (!heading.empty()) {
                    headings.push_back(heading);
                }
                headingTextStack.pop_back();
                headingStack.pop_back();
            }
            if (tag.name == "a" && !anchors.empty()) {
                const Anchor anchor = anchors.back();
                anchors.pop_back();
                const std::string anchorText = normalizeWhitespace(anchor.text);
                if (!anchor.href.empty() && !anchorText.empty() && doc.links.size() < kMaxExtractedLinks) {
                    doc.links.push_back({anchor.href, firstNChars(anchorText, 200)});
                }
            }
            if (blockTags.find(tag.name) != blockTags.end()) {
                appendBlockBreak();
            }
            continue;
        }

        if (blockTags.find(tag.name) != blockTags.end()) {
            appendBlockBreak();
        }
        if (skipTags.find(tag.name) != skipTags.end()) {
            ++skipDepth;
        }
        if (boilerplateTags.find(tag.name) != boilerplateTags.end()) {
            ++boilerplateDepth;
        }
        if (tag.name == "head") {
            ++headDepth;
        }
        if (tag.name == "title") {
            ++titleDepth;
        }
        if (tag.name == "html") {
            auto langIt = tag.attrs.find("lang");
            if (langIt != tag.attrs.end()) {
                doc.lang = trimCopy(langIt->second);
            }
        }
        if (tag.name == "meta") {
            const std::string name = toLower(tag.attrs.count("name") ? tag.attrs.at("name") : "");
            const std::string property = toLower(tag.attrs.count("property") ? tag.attrs.at("property") : "");
            const std::string content = trimCopy(tag.attrs.count("content") ? tag.attrs.at("content") : "");
            if (!content.empty() && (name == "description" || property == "og:description") && doc.description.empty()) {
                doc.description = content;
            }
            if (!content.empty() && name == "robots" && doc.metaRobots.empty()) {
                doc.metaRobots = toLower(content);
            }
        }
        if (tag.name == "link") {
            const std::string rel = toLower(tag.attrs.count("rel") ? tag.attrs.at("rel") : "");
            if (rel.find("canonical") != std::string::npos) {
                auto hrefIt = tag.attrs.find("href");
                if (hrefIt != tag.attrs.end()) {
                    doc.canonicalUrl = trimCopy(hrefIt->second);
                }
            }
        }
        if ((tag.name == "h1" || tag.name == "h2" || tag.name == "h3")) {
            headingStack.push_back(tag.name);
            headingTextStack.emplace_back();
        }
        if (tag.name == "a") {
            auto hrefIt = tag.attrs.find("href");
            anchors.push_back({hrefIt == tag.attrs.end() ? "" : trimCopy(hrefIt->second), ""});
        }
    }

    doc.title = normalizeWhitespace(doc.title);
    doc.description = normalizeWhitespace(doc.description);
    doc.headings = joinLines(headings);
    doc.bodyText = normalizeWhitespace(rawBody);
    return doc;
}

std::vector<std::string> parseSitemapUrls(const std::string& body) {
    std::vector<std::string> urls;
    const std::string lowered = toLower(body);
    std::size_t position = 0;

    while (true) {
        const auto start = lowered.find("<loc>", position);
        if (start == std::string::npos) {
            break;
        }
        const auto end = lowered.find("</loc>", start + 5);
        if (end == std::string::npos) {
            break;
        }
        const std::string value = trimCopy(decodeHtmlEntities(stripCdata(body.substr(start + 5, end - start - 5))));
        if (!value.empty()) {
            urls.push_back(value);
        }
        position = end + 6;
    }

    return urls;
}

bool containsExplicitContent(const std::string& text) {
    static const std::array<const char*, 12> blockedTerms = {
        "porn", "xxx", "sex video", "escort", "incest", "bestiality",
        "nude teen", "adult cam", "hentai", "hardcore", "fetish porn", "nsfw"
    };

    const std::string lowered = toLower(text);
    for (const char* term : blockedTerms) {
        if (lowered.find(term) != std::string::npos) {
            return true;
        }
    }
    return false;
}

struct SearchCandidate {
    int docId = 0;
    std::string title;
    std::string url;
    std::string host;
    std::string lang;
    std::string snippet;
    std::int64_t fetchedAt = 0;
    std::int64_t indexedAt = 0;
    double bm25 = 0.0;
    double qualityScore = 0.0;
    double finalScore = 0.0;
};

struct LiveSearchHit {
    std::string title;
    std::string url;
    std::string snippet;
    std::int64_t publishedAt = 0;
};

struct QueueItem {
    std::string url;
    std::string discoveredFrom;
    int priority = 0;
    int depth = 0;
    int attempts = 0;
};

std::string stripMarkup(const std::string& input) {
    std::string out;
    out.reserve(input.size());
    bool inTag = false;

    for (char ch : input) {
        if (ch == '<') {
            inTag = true;
            if (!out.empty() && !std::isspace(static_cast<unsigned char>(out.back()))) {
                out.push_back(' ');
            }
            continue;
        }
        if (ch == '>') {
            inTag = false;
            continue;
        }
        if (!inTag) {
            out.push_back(ch);
        }
    }

    return out;
}

std::string extractXmlTagValue(const std::string& xml, const std::string& tag) {
    const std::string lowered = toLower(xml);
    const std::string openToken = "<" + toLower(tag);
    const std::string closeToken = "</" + toLower(tag) + ">";

    const auto openStart = lowered.find(openToken);
    if (openStart == std::string::npos) {
        return "";
    }

    const auto openEnd = lowered.find('>', openStart + openToken.size());
    if (openEnd == std::string::npos) {
        return "";
    }

    const auto closeStart = lowered.find(closeToken, openEnd + 1);
    if (closeStart == std::string::npos) {
        return "";
    }

    return xml.substr(openEnd + 1, closeStart - openEnd - 1);
}

std::vector<LiveSearchHit> parseRssSearchHits(const std::string& xml) {
    std::vector<LiveSearchHit> hits;
    const std::string lowered = toLower(xml);
    std::size_t position = 0;

    while (true) {
        const auto itemStart = lowered.find("<item", position);
        if (itemStart == std::string::npos) {
            break;
        }

        const auto itemOpenEnd = lowered.find('>', itemStart);
        if (itemOpenEnd == std::string::npos) {
            break;
        }

        const auto itemEnd = lowered.find("</item>", itemOpenEnd + 1);
        if (itemEnd == std::string::npos) {
            break;
        }

        const std::string block = xml.substr(itemOpenEnd + 1, itemEnd - itemOpenEnd - 1);
        LiveSearchHit hit;
        hit.title = normalizeWhitespace(decodeHtmlEntities(stripMarkup(stripCdata(extractXmlTagValue(block, "title")))));
        hit.url = trimCopy(decodeHtmlEntities(stripCdata(extractXmlTagValue(block, "link"))));
        hit.snippet = normalizeWhitespace(decodeHtmlEntities(stripMarkup(stripCdata(extractXmlTagValue(block, "description")))));

        const std::string pubDate = trimCopy(decodeHtmlEntities(stripCdata(extractXmlTagValue(block, "pubDate"))));
        const std::time_t parsedDate = pubDate.empty() ? -1 : curl_getdate(pubDate.c_str(), nullptr);
        if (parsedDate >= 0) {
            hit.publishedAt = static_cast<std::int64_t>(parsedDate) * 1000LL;
        }

        if (!hit.title.empty() && !hit.url.empty()) {
            hits.push_back(std::move(hit));
        }
        position = itemEnd + 7;
    }

    return hits;
}

std::string urlDecode(const std::string& input) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        return input;
    }

    int decodedLength = 0;
    char* decoded = curl_easy_unescape(curl, input.c_str(), static_cast<int>(input.size()), &decodedLength);
    std::string output = decoded ? std::string(decoded, decodedLength) : input;
    if (decoded) {
        curl_free(decoded);
    }
    curl_easy_cleanup(curl);
    return output;
}

std::string extractQueryParamValue(const std::string& url, const std::string& key) {
    const auto queryStart = url.find('?');
    if (queryStart == std::string::npos) {
        return "";
    }

    const std::string query = url.substr(queryStart + 1);
    std::stringstream stream(query);
    std::string item;
    while (std::getline(stream, item, '&')) {
        const auto equals = item.find('=');
        const std::string paramKey = equals == std::string::npos ? item : item.substr(0, equals);
        if (paramKey != key) {
            continue;
        }
        return equals == std::string::npos ? "" : item.substr(equals + 1);
    }
    return "";
}

std::string unwrapDuckDuckGoRedirectUrl(const std::string& input) {
    std::string value = trimCopy(decodeHtmlEntities(input));
    if (startsWith(value, "//")) {
        value = "https:" + value;
    } else if (startsWith(value, "/")) {
        value = "https://duckduckgo.com" + value;
    }

    const std::string uddg = extractQueryParamValue(value, "uddg");
    if (!uddg.empty()) {
        return urlDecode(uddg);
    }
    return value;
}

std::vector<LiveSearchHit> parseDuckDuckGoHtmlSearchHits(const std::string& html) {
    std::vector<LiveSearchHit> hits;
    LiveSearchHit current;
    bool inTitle = false;
    bool inSnippet = false;
    std::string titleBuffer;
    std::string snippetBuffer;

    auto flushCurrent = [&]() {
        current.title = normalizeWhitespace(current.title);
        current.snippet = normalizeWhitespace(current.snippet);
        current.url = trimCopy(current.url);
        if (!current.title.empty() && !current.url.empty()) {
            hits.push_back(current);
        }
        current = LiveSearchHit{};
        titleBuffer.clear();
        snippetBuffer.clear();
        inTitle = false;
        inSnippet = false;
    };

    std::size_t cursor = 0;
    while (cursor < html.size()) {
        const auto tagStart = html.find('<', cursor);
        const std::string text = decodeHtmlEntities(html.substr(cursor, tagStart - cursor));
        if (inTitle) {
            titleBuffer += text;
        }
        if (inSnippet) {
            snippetBuffer += text;
        }

        if (tagStart == std::string::npos) {
            break;
        }

        std::size_t next = tagStart + 1;
        const ParsedTag tag = parseTag(html, tagStart, next);
        cursor = next;
        if (!tag.valid || tag.isComment) {
            continue;
        }

        if (tag.isClosing) {
            if (tag.name == "a" && inTitle) {
                current.title = normalizeWhitespace(titleBuffer);
                inTitle = false;
                continue;
            }
            if (tag.name == "a" && inSnippet) {
                current.snippet = normalizeWhitespace(snippetBuffer);
                inSnippet = false;
                continue;
            }
            continue;
        }

        if (tag.name != "a") {
            continue;
        }

        const std::string className = toLower(tag.attrs.count("class") ? tag.attrs.at("class") : "");
        const std::string href = tag.attrs.count("href") ? tag.attrs.at("href") : "";
        if (className.find("result__a") != std::string::npos) {
            if (!current.title.empty() || !current.url.empty() || !current.snippet.empty()) {
                flushCurrent();
            }
            current.url = unwrapDuckDuckGoRedirectUrl(href);
            titleBuffer.clear();
            inTitle = true;
            continue;
        }

        if (className.find("result__snippet") != std::string::npos) {
            if (current.url.empty()) {
                continue;
            }
            snippetBuffer.clear();
            inSnippet = true;
        }
    }

    if (!current.title.empty() || !current.url.empty() || !current.snippet.empty()) {
        flushCurrent();
    }

    return hits;
}

std::string urlEncode(const std::string& input) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        return input;
    }

    char* escaped = curl_easy_escape(curl, input.c_str(), static_cast<int>(input.size()));
    std::string output = escaped ? escaped : input;
    if (escaped) {
        curl_free(escaped);
    }
    curl_easy_cleanup(curl);
    return output;
}

} // namespace

struct WebSearchTool::Impl {
    explicit Impl(Options inOptions)
        : options(std::move(inOptions)) {}

    struct DocumentRow {
        int docId = 0;
        std::string normalizedUrl;
        std::string canonicalUrl;
        std::string sourceUrl;
        std::string host;
        std::string scheme;
        std::string title;
        std::string headings;
        std::string description;
        std::string lang;
        std::string contentType;
        std::string bodyText;
        std::string etag;
        std::string lastModified;
        std::string textHash;
        std::string simhash;
        std::string metaRobots;
        std::int64_t fetchedAt = 0;
        std::int64_t indexedAt = 0;
        std::int64_t nextRefreshAt = 0;
        std::int64_t lastChangeAt = 0;
        int changeCount = 0;
        int statusCode = 0;
        int contentLength = 0;
        int linkCount = 0;
        double qualityScore = 0.0;
        bool blocked = false;
        std::string blockedReason;
        int duplicateOf = 0;
        int nearDuplicateOf = 0;
    };

    struct HostState {
        std::string hostKey;
        std::string robotsBody;
        std::string robotsEtag;
        std::string robotsLastModified;
        std::int64_t robotsFetchedAt = 0;
        double crawlDelaySeconds = 0.0;
        std::int64_t nextAllowedFetchAt = 0;
        std::vector<std::string> sitemapUrls;
    };

    struct HttpFetchResult {
        bool success = false;
        bool notModified = false;
        bool truncated = false;
        bool timedOut = false;
        bool cancelled = false;
        long statusCode = 0;
        double totalTimeMs = 0.0;
        double connectTimeMs = 0.0;
        double startTransferTimeMs = 0.0;
        std::string effectiveUrl;
        std::string body;
        std::string contentType;
        std::string etag;
        std::string lastModified;
        std::string xRobotsTag;
        std::string error;
    };

    struct HttpRequestOptions {
        int timeoutMs = 0;
        int maxBodyBytes = 0;
        bool followRedirects = true;
        std::function<bool()> cancelCheck;
    };

    struct QueryPlan {
        std::string originalQuery;
        std::string matchExpression;
        std::vector<std::string> terms;
        std::vector<std::string> siteAllow;
        std::vector<std::string> siteBlock;
    };

    Options options;
    mutable std::mutex mutex;
    sqlite3* db = nullptr;
    bool initialized = false;
    std::string initError;

    mutable std::mutex workerMutex;
    std::condition_variable workerCv;
    std::thread workerThread;
    std::mutex workerExitMutex;
    std::condition_variable workerExitCv;
    std::atomic<bool> stopWorker{false};
    bool workerStarted = false;
    bool workerExited = false;
    std::atomic<bool> shutdownRequested{false};
    std::atomic<bool> allowForcedDetachOnShutdown{false};
    std::int64_t lastWorkerTick = 0;
    std::string lastWorkerError;

    bool ensureInitialized(std::string* errorOut) {
        bool startWorker = false;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (initialized) {
                return true;
            }
            if (!initError.empty()) {
                if (errorOut) {
                    *errorOut = initError;
                }
                return false;
            }

            try {
                fs::create_directories(options.storageRoot);
            } catch (const std::exception& exception) {
                initError = std::string("Failed to create web search storage: ") + exception.what();
                if (errorOut) {
                    *errorOut = initError;
                }
                return false;
            }

            if (options.databasePath.empty()) {
                options.databasePath = (fs::path(options.storageRoot) / "index.sqlite3").string();
            }

            if (sqlite3_open_v2(
                    options.databasePath.c_str(),
                    &db,
                    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                    nullptr) != SQLITE_OK) {
                initError = db ? sqlite3_errmsg(db) : "Failed to open sqlite database";
                if (db) {
                    sqlite3_close(db);
                    db = nullptr;
                }
                if (errorOut) {
                    *errorOut = initError;
                }
                return false;
            }

            std::string sqlError;
            const std::string pragmas =
                "PRAGMA journal_mode=WAL;"
                "PRAGMA synchronous=NORMAL;"
                "PRAGMA foreign_keys=ON;"
                "PRAGMA busy_timeout=5000;"
                "PRAGMA temp_store=MEMORY;";
            if (!execSql(db, pragmas, &sqlError)) {
                initError = sqlError;
            } else if (!execSql(db,
                "CREATE TABLE IF NOT EXISTS documents ("
                "  doc_id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "  source_url TEXT NOT NULL DEFAULT '',"
                "  normalized_url TEXT NOT NULL UNIQUE,"
                "  canonical_url TEXT NOT NULL DEFAULT '',"
                "  host TEXT NOT NULL DEFAULT '',"
                "  scheme TEXT NOT NULL DEFAULT '',"
                "  title TEXT NOT NULL DEFAULT '',"
                "  headings TEXT NOT NULL DEFAULT '',"
                "  description TEXT NOT NULL DEFAULT '',"
                "  lang TEXT NOT NULL DEFAULT '',"
                "  content_type TEXT NOT NULL DEFAULT '',"
                "  status_code INTEGER NOT NULL DEFAULT 0,"
                "  fetched_at INTEGER NOT NULL DEFAULT 0,"
                "  indexed_at INTEGER NOT NULL DEFAULT 0,"
                "  last_modified TEXT NOT NULL DEFAULT '',"
                "  etag TEXT NOT NULL DEFAULT '',"
                "  body_text TEXT NOT NULL DEFAULT '',"
                "  text_hash TEXT NOT NULL DEFAULT '',"
                "  simhash TEXT NOT NULL DEFAULT '',"
                "  content_length INTEGER NOT NULL DEFAULT 0,"
                "  quality_score REAL NOT NULL DEFAULT 0,"
                "  link_count INTEGER NOT NULL DEFAULT 0,"
                "  discovered_from TEXT NOT NULL DEFAULT '',"
                "  change_count INTEGER NOT NULL DEFAULT 0,"
                "  last_change_at INTEGER NOT NULL DEFAULT 0,"
                "  next_refresh_at INTEGER NOT NULL DEFAULT 0,"
                "  fetch_error TEXT NOT NULL DEFAULT '',"
                "  blocked INTEGER NOT NULL DEFAULT 0,"
                "  blocked_reason TEXT NOT NULL DEFAULT '',"
                "  meta_robots TEXT NOT NULL DEFAULT '',"
                "  duplicate_of INTEGER NOT NULL DEFAULT 0,"
                "  near_duplicate_of INTEGER NOT NULL DEFAULT 0,"
                "  created_at INTEGER NOT NULL DEFAULT 0,"
                "  updated_at INTEGER NOT NULL DEFAULT 0"
                ");"
                "CREATE INDEX IF NOT EXISTS idx_documents_host ON documents(host);"
                "CREATE INDEX IF NOT EXISTS idx_documents_fetched_at ON documents(fetched_at);"
                "CREATE INDEX IF NOT EXISTS idx_documents_next_refresh ON documents(next_refresh_at);"
                "CREATE INDEX IF NOT EXISTS idx_documents_text_hash ON documents(text_hash);"
                "CREATE TABLE IF NOT EXISTS link_edges ("
                "  src_doc_id INTEGER NOT NULL,"
                "  dst_url TEXT NOT NULL,"
                "  anchor_text TEXT NOT NULL DEFAULT '',"
                "  PRIMARY KEY (src_doc_id, dst_url)"
                ");"
                "CREATE INDEX IF NOT EXISTS idx_link_edges_src ON link_edges(src_doc_id);"
                "CREATE TABLE IF NOT EXISTS fetch_queue ("
                "  normalized_url TEXT PRIMARY KEY,"
                "  discovered_from TEXT NOT NULL DEFAULT '',"
                "  priority INTEGER NOT NULL DEFAULT 0,"
                "  depth INTEGER NOT NULL DEFAULT 0,"
                "  next_fetch_at INTEGER NOT NULL DEFAULT 0,"
                "  enqueued_at INTEGER NOT NULL DEFAULT 0,"
                "  attempts INTEGER NOT NULL DEFAULT 0,"
                "  last_error TEXT NOT NULL DEFAULT ''"
                ");"
                "CREATE INDEX IF NOT EXISTS idx_fetch_queue_due ON fetch_queue(next_fetch_at, priority);"
                "CREATE TABLE IF NOT EXISTS host_state ("
                "  host_key TEXT PRIMARY KEY,"
                "  robots_body TEXT NOT NULL DEFAULT '',"
                "  robots_etag TEXT NOT NULL DEFAULT '',"
                "  robots_last_modified TEXT NOT NULL DEFAULT '',"
                "  robots_fetched_at INTEGER NOT NULL DEFAULT 0,"
                "  crawl_delay_seconds REAL NOT NULL DEFAULT 0,"
                "  next_allowed_fetch_at INTEGER NOT NULL DEFAULT 0,"
                "  sitemap_urls TEXT NOT NULL DEFAULT '[]'"
                ");"
                "CREATE TABLE IF NOT EXISTS meta ("
                "  key TEXT PRIMARY KEY,"
                "  value TEXT NOT NULL DEFAULT ''"
                ");",
                &sqlError)) {
                initError = sqlError;
            } else if (!execSql(
                db,
                "CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5("
                "  title, headings, body_text, tokenize='porter unicode61 remove_diacritics 2'"
                ");",
                &sqlError)) {
                initError = sqlError;
            }

            if (!initError.empty()) {
                sqlite3_close(db);
                db = nullptr;
                if (errorOut) {
                    *errorOut = initError;
                }
                return false;
            }

            initialized = true;
            startWorker = options.enableBackgroundWorker;
        }

        if (startWorker) {
            startWorkerLoop();
        }
        return true;
    }

    void startWorkerLoop() {
        std::lock_guard<std::mutex> workerLock(workerMutex);
        if (workerStarted) {
            return;
        }
        stopWorker.store(false, std::memory_order_relaxed);
        shutdownRequested.store(false, std::memory_order_relaxed);
        {
            std::lock_guard<std::mutex> exitLock(workerExitMutex);
            workerExited = false;
        }
        workerStarted = true;
        workerThread = std::thread([this]() {
            workerLoop();
            {
                std::lock_guard<std::mutex> exitLock(workerExitMutex);
                workerExited = true;
            }
            workerExitCv.notify_all();
        });
    }

    bool workerStopRequested() const {
        return stopWorker.load(std::memory_order_relaxed) ||
            shutdownRequested.load(std::memory_order_relaxed);
    }

    void requestWorkerStop() {
        stopWorker.store(true, std::memory_order_relaxed);
        shutdownRequested.store(true, std::memory_order_relaxed);
        workerCv.notify_all();
    }

    bool stopWorkerLoop() {
        requestWorkerStop();
        const bool allowDetach = allowForcedDetachOnShutdown.load(std::memory_order_relaxed);
        if (workerThread.joinable()) {
            bool exited = false;
            {
                std::unique_lock<std::mutex> exitLock(workerExitMutex);
                exited = workerExitCv.wait_for(exitLock, std::chrono::seconds(5), [this]() {
                    return workerExited;
                });
            }
            if (!exited) {
                if (allowDetach) {
                    std::cerr << "[WebSearch] Worker did not stop within 5s; detaching during shutdown\n";
                    std::thread joiner([worker = std::move(workerThread)]() mutable {
                        if (worker.joinable()) {
                            worker.join();
                        }
                    });
                    joiner.detach();
                    std::lock_guard<std::mutex> workerLock(workerMutex);
                    workerStarted = false;
                    return false;
                }
            }
            workerThread.join();
        }
        std::lock_guard<std::mutex> workerLock(workerMutex);
        workerStarted = false;
        return true;
    }

    void workerLoop() {
        for (;;) {
            {
                std::unique_lock<std::mutex> workerLock(workerMutex);
                workerCv.wait_for(workerLock, std::chrono::seconds(2), [this]() {
                    return workerStopRequested();
                });
                if (workerStopRequested()) {
                    return;
                }
            }

            lastWorkerTick = nowMillis();
            try {
                if (workerStopRequested()) {
                    return;
                }
                enqueueDueRefreshes();
                if (workerStopRequested()) {
                    return;
                }
                auto item = takeNextQueueItem();
                if (!item.has_value()) {
                    continue;
                }

                Json::Value request(Json::objectValue);
                request["url"] = item->url;
                request["force_refresh"] = false;
                request["queue_discovered"] = true;
                request["max_queue_links"] = kDefaultQueueLinks;
                Json::Value result = fetchUrl(
                    request,
                    item->depth,
                    item->discoveredFrom,
                    true,
                    [this]() {
                        return workerStopRequested();
                    });
                if (workerStopRequested()) {
                    return;
                }
                if (result.get("retryable", false).asBool()) {
                    requeue(item->url, item->discoveredFrom, item->priority, item->depth, item->attempts + 1, 10 * 1000);
                }
            } catch (const std::exception& exception) {
                std::lock_guard<std::mutex> workerLock(workerMutex);
                lastWorkerError = exception.what();
            } catch (...) {
                std::lock_guard<std::mutex> workerLock(workerMutex);
                lastWorkerError = "Unknown worker failure";
            }
        }
    }

    void closeDatabase() {
        std::lock_guard<std::mutex> lock(mutex);
        if (db) {
            sqlite3_close(db);
            db = nullptr;
        }
        initialized = false;
    }

    std::optional<DocumentRow> loadDocumentById(int docId) {
        std::lock_guard<std::mutex> lock(mutex);
        return loadDocumentByIdUnlocked(docId);
    }

    std::optional<DocumentRow> loadDocumentByIdUnlocked(int docId) {
        if (!db) {
            return std::nullopt;
        }

        SqliteStatement stmt(db,
            "SELECT doc_id, source_url, normalized_url, canonical_url, host, scheme, title, headings, description, lang, "
            "content_type, status_code, fetched_at, indexed_at, last_modified, etag, body_text, text_hash, "
            "simhash, content_length, quality_score, link_count, change_count, last_change_at, next_refresh_at, "
            "blocked, blocked_reason, meta_robots, duplicate_of, near_duplicate_of "
            "FROM documents WHERE doc_id = ?;");
        if (!stmt) {
            return std::nullopt;
        }

        sqlite3_bind_int(stmt.get(), 1, docId);
        if (sqlite3_step(stmt.get()) != SQLITE_ROW) {
            return std::nullopt;
        }

        DocumentRow row;
        row.docId = sqlite3_column_int(stmt.get(), 0);
        row.sourceUrl = columnText(stmt.get(), 1);
        row.normalizedUrl = columnText(stmt.get(), 2);
        row.canonicalUrl = columnText(stmt.get(), 3);
        row.host = columnText(stmt.get(), 4);
        row.scheme = columnText(stmt.get(), 5);
        row.title = columnText(stmt.get(), 6);
        row.headings = columnText(stmt.get(), 7);
        row.description = columnText(stmt.get(), 8);
        row.lang = columnText(stmt.get(), 9);
        row.contentType = columnText(stmt.get(), 10);
        row.statusCode = sqlite3_column_int(stmt.get(), 11);
        row.fetchedAt = sqlite3_column_int64(stmt.get(), 12);
        row.indexedAt = sqlite3_column_int64(stmt.get(), 13);
        row.lastModified = columnText(stmt.get(), 14);
        row.etag = columnText(stmt.get(), 15);
        row.bodyText = columnText(stmt.get(), 16);
        row.textHash = columnText(stmt.get(), 17);
        row.simhash = columnText(stmt.get(), 18);
        row.contentLength = sqlite3_column_int(stmt.get(), 19);
        row.qualityScore = sqlite3_column_double(stmt.get(), 20);
        row.linkCount = sqlite3_column_int(stmt.get(), 21);
        row.changeCount = sqlite3_column_int(stmt.get(), 22);
        row.lastChangeAt = sqlite3_column_int64(stmt.get(), 23);
        row.nextRefreshAt = sqlite3_column_int64(stmt.get(), 24);
        row.blocked = sqlite3_column_int(stmt.get(), 25) != 0;
        row.blockedReason = columnText(stmt.get(), 26);
        row.metaRobots = columnText(stmt.get(), 27);
        row.duplicateOf = sqlite3_column_int(stmt.get(), 28);
        row.nearDuplicateOf = sqlite3_column_int(stmt.get(), 29);
        return row;
    }

    std::optional<DocumentRow> loadDocumentByNormalizedUrl(const std::string& normalizedUrl) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return std::nullopt;
        }

        SqliteStatement stmt(db,
            "SELECT doc_id, source_url, normalized_url, canonical_url, host, scheme, title, headings, description, lang, "
            "content_type, status_code, fetched_at, indexed_at, last_modified, etag, body_text, text_hash, "
            "simhash, content_length, quality_score, link_count, change_count, last_change_at, next_refresh_at, "
            "blocked, blocked_reason, meta_robots, duplicate_of, near_duplicate_of "
            "FROM documents WHERE normalized_url = ?;");
        if (!stmt) {
            return std::nullopt;
        }
        sqlite3_bind_text(stmt.get(), 1, normalizedUrl.c_str(), -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt.get()) != SQLITE_ROW) {
            return std::nullopt;
        }

        DocumentRow row;
        row.docId = sqlite3_column_int(stmt.get(), 0);
        row.sourceUrl = columnText(stmt.get(), 1);
        row.normalizedUrl = columnText(stmt.get(), 2);
        row.canonicalUrl = columnText(stmt.get(), 3);
        row.host = columnText(stmt.get(), 4);
        row.scheme = columnText(stmt.get(), 5);
        row.title = columnText(stmt.get(), 6);
        row.headings = columnText(stmt.get(), 7);
        row.description = columnText(stmt.get(), 8);
        row.lang = columnText(stmt.get(), 9);
        row.contentType = columnText(stmt.get(), 10);
        row.statusCode = sqlite3_column_int(stmt.get(), 11);
        row.fetchedAt = sqlite3_column_int64(stmt.get(), 12);
        row.indexedAt = sqlite3_column_int64(stmt.get(), 13);
        row.lastModified = columnText(stmt.get(), 14);
        row.etag = columnText(stmt.get(), 15);
        row.bodyText = columnText(stmt.get(), 16);
        row.textHash = columnText(stmt.get(), 17);
        row.simhash = columnText(stmt.get(), 18);
        row.contentLength = sqlite3_column_int(stmt.get(), 19);
        row.qualityScore = sqlite3_column_double(stmt.get(), 20);
        row.linkCount = sqlite3_column_int(stmt.get(), 21);
        row.changeCount = sqlite3_column_int(stmt.get(), 22);
        row.lastChangeAt = sqlite3_column_int64(stmt.get(), 23);
        row.nextRefreshAt = sqlite3_column_int64(stmt.get(), 24);
        row.blocked = sqlite3_column_int(stmt.get(), 25) != 0;
        row.blockedReason = columnText(stmt.get(), 26);
        row.metaRobots = columnText(stmt.get(), 27);
        row.duplicateOf = sqlite3_column_int(stmt.get(), 28);
        row.nearDuplicateOf = sqlite3_column_int(stmt.get(), 29);
        return row;
    }

    HostState loadHostState(const std::string& hostKey) {
        std::lock_guard<std::mutex> lock(mutex);
        HostState state;
        state.hostKey = hostKey;
        if (!db) {
            return state;
        }

        SqliteStatement stmt(db,
            "SELECT robots_body, robots_etag, robots_last_modified, robots_fetched_at, "
            "crawl_delay_seconds, next_allowed_fetch_at, sitemap_urls "
            "FROM host_state WHERE host_key = ?;");
        if (!stmt) {
            return state;
        }

        sqlite3_bind_text(stmt.get(), 1, hostKey.c_str(), -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt.get()) != SQLITE_ROW) {
            return state;
        }

        state.robotsBody = columnText(stmt.get(), 0);
        state.robotsEtag = columnText(stmt.get(), 1);
        state.robotsLastModified = columnText(stmt.get(), 2);
        state.robotsFetchedAt = sqlite3_column_int64(stmt.get(), 3);
        state.crawlDelaySeconds = sqlite3_column_double(stmt.get(), 4);
        state.nextAllowedFetchAt = sqlite3_column_int64(stmt.get(), 5);
        const std::string sitemapJson = columnText(stmt.get(), 6);

        Json::Value parsed;
        Json::CharReaderBuilder reader;
        std::string errors;
        std::istringstream stream(sitemapJson);
        if (Json::parseFromStream(reader, stream, &parsed, &errors) && parsed.isArray()) {
            for (const auto& item : parsed) {
                if (item.isString()) {
                    state.sitemapUrls.push_back(item.asString());
                }
            }
        }
        return state;
    }

    void upsertHostState(const HostState& state) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return;
        }

        SqliteStatement stmt(db,
            "INSERT INTO host_state(host_key, robots_body, robots_etag, robots_last_modified, robots_fetched_at, "
            "crawl_delay_seconds, next_allowed_fetch_at, sitemap_urls) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(host_key) DO UPDATE SET "
            "robots_body=excluded.robots_body, robots_etag=excluded.robots_etag, "
            "robots_last_modified=excluded.robots_last_modified, robots_fetched_at=excluded.robots_fetched_at, "
            "crawl_delay_seconds=excluded.crawl_delay_seconds, next_allowed_fetch_at=excluded.next_allowed_fetch_at, "
            "sitemap_urls=excluded.sitemap_urls;");
        if (!stmt) {
            return;
        }

        Json::Value sitemapArray(Json::arrayValue);
        for (const auto& sitemap : state.sitemapUrls) {
            sitemapArray.append(sitemap);
        }

        sqlite3_bind_text(stmt.get(), 1, state.hostKey.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt.get(), 2, state.robotsBody.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt.get(), 3, state.robotsEtag.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt.get(), 4, state.robotsLastModified.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt.get(), 5, state.robotsFetchedAt);
        sqlite3_bind_double(stmt.get(), 6, state.crawlDelaySeconds);
        sqlite3_bind_int64(stmt.get(), 7, state.nextAllowedFetchAt);
        const std::string sitemaps = jsonToString(sitemapArray);
        sqlite3_bind_text(stmt.get(), 8, sitemaps.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(stmt.get());
    }

    void updateHostNextFetch(const std::string& hostKey, std::int64_t nextAllowedFetchAt) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return;
        }
        SqliteStatement stmt(db,
            "INSERT INTO host_state(host_key, next_allowed_fetch_at) VALUES(?, ?) "
            "ON CONFLICT(host_key) DO UPDATE SET next_allowed_fetch_at = excluded.next_allowed_fetch_at;");
        if (!stmt) {
            return;
        }
        sqlite3_bind_text(stmt.get(), 1, hostKey.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt.get(), 2, nextAllowedFetchAt);
        sqlite3_step(stmt.get());
    }

    Json::Value makeFetchTimingJson(const HttpFetchResult& response) const {
        Json::Value timing(Json::objectValue);
        timing["total"] = response.totalTimeMs;
        timing["connect"] = response.connectTimeMs;
        timing["first_byte"] = response.startTransferTimeMs;
        return timing;
    }

    HttpFetchResult httpFetch(const std::string& url, const std::vector<std::string>& requestHeaders) {
        return httpFetch(url, requestHeaders, HttpRequestOptions{});
    }

    HttpFetchResult httpFetch(
        const std::string& url,
        const std::vector<std::string>& requestHeaders,
        const HttpRequestOptions& requestOptions) {
        HttpFetchResult result;
        CURL* curl = curl_easy_init();
        if (!curl) {
            result.error = "Failed to initialize CURL";
            return result;
        }

        const int timeoutMs = requestOptions.timeoutMs > 0 ? requestOptions.timeoutMs : options.httpTimeoutMs;
        const int maxBodyBytes = requestOptions.maxBodyBytes > 0 ? requestOptions.maxBodyBytes : options.maxBodyBytes;
        CurlStringBuffer body;
        body.maxBytes = maxBodyBytes > 0 ? static_cast<std::size_t>(maxBodyBytes) : 0;
        HeaderCapture headers;
        CurlProgressContext progress;
        progress.cancelCheck = &requestOptions.cancelCheck;
        progress.shutdownRequested = &shutdownRequested;
        struct curl_slist* curlHeaders = nullptr;
        for (const auto& header : requestHeaders) {
            curlHeaders = curl_slist_append(curlHeaders, header.c_str());
        }

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, curlHeaders);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteToString);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, curlHeaderToMap);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &headers);
        curl_easy_setopt(curl, CURLOPT_USERAGENT, options.userAgent.c_str());
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, requestOptions.followRedirects ? 1L : 0L);
        curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "");
        if (!options.allowPrivateHosts) {
            curl_easy_setopt(curl, CURLOPT_OPENSOCKETFUNCTION, curlOpenPublicHttpSocket);
        }
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &progress);
        curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, curlProgressAbortCheck);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(std::max(750, timeoutMs)));
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(std::min(4000, std::max(500, timeoutMs / 3))));
        if (options.lowSpeedLimitBytesPerSec > 0 && options.lowSpeedTimeSeconds > 0) {
            curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, static_cast<long>(options.lowSpeedLimitBytesPerSec));
            curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, static_cast<long>(options.lowSpeedTimeSeconds));
        }
#ifdef CURLOPT_HAPPY_EYEBALLS_TIMEOUT_MS
        curl_easy_setopt(curl, CURLOPT_HAPPY_EYEBALLS_TIMEOUT_MS, 250L);
#endif
#if LIBCURL_VERSION_NUM >= 0x075500
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
        curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
#endif

        const CURLcode code = curl_easy_perform(curl);
        char* effectiveUrl = nullptr;
        double totalTimeSeconds = 0.0;
        double connectTimeSeconds = 0.0;
        double startTransferSeconds = 0.0;
        curl_easy_getinfo(curl, CURLINFO_EFFECTIVE_URL, &effectiveUrl);
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.statusCode);
        curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &totalTimeSeconds);
        curl_easy_getinfo(curl, CURLINFO_CONNECT_TIME, &connectTimeSeconds);
        curl_easy_getinfo(curl, CURLINFO_STARTTRANSFER_TIME, &startTransferSeconds);

        result.effectiveUrl = effectiveUrl ? effectiveUrl : url;
        result.totalTimeMs = totalTimeSeconds * 1000.0;
        result.connectTimeMs = connectTimeSeconds * 1000.0;
        result.startTransferTimeMs = startTransferSeconds * 1000.0;
        result.contentType = headers.headers.count("content-type") ? headers.headers["content-type"] : "";
        result.etag = headers.headers.count("etag") ? headers.headers["etag"] : "";
        result.lastModified = headers.headers.count("last-modified") ? headers.headers["last-modified"] : "";
        result.xRobotsTag = headers.headers.count("x-robots-tag") ? headers.headers["x-robots-tag"] : "";
        result.truncated = body.truncated;

        if (code == CURLE_WRITE_ERROR && body.truncated) {
            result.success = result.statusCode >= 200 && result.statusCode < 400;
            result.notModified = result.statusCode == 304;
            result.body = std::move(body.body);
        } else if (code == CURLE_ABORTED_BY_CALLBACK && progress.cancelled) {
            result.cancelled = true;
            result.error = "Cancelled";
        } else if (code != CURLE_OK) {
            result.timedOut = code == CURLE_OPERATION_TIMEDOUT;
            result.error = curl_easy_strerror(code);
        } else {
            result.success = result.statusCode >= 200 && result.statusCode < 400;
            result.notModified = result.statusCode == 304;
            result.body = std::move(body.body);
        }

        curl_slist_free_all(curlHeaders);
        curl_easy_cleanup(curl);
        return result;
    }

    HostState ensureRobots(const ParsedUrl& url, Json::Value* infoOut = nullptr) {
        HostState state = loadHostState(url.authority);
        if (infoOut) {
            (*infoOut) = Json::Value(Json::objectValue);
            (*infoOut)["url"] = url.authority + "/robots.txt";
            (*infoOut)["used_cached_state"] = state.robotsFetchedAt != 0;
        }
        const bool stale = state.robotsFetchedAt == 0 || nowMillis() - state.robotsFetchedAt > kDayMs;
        if (!stale) {
            if (infoOut) {
                (*infoOut)["status"] = "cache_fresh";
                (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
                (*infoOut)["sitemaps"] = static_cast<int>(state.sitemapUrls.size());
            }
            return state;
        }

        std::vector<std::string> headers;
        if (!state.robotsEtag.empty()) {
            headers.push_back("If-None-Match: " + state.robotsEtag);
        }
        if (!state.robotsLastModified.empty()) {
            headers.push_back("If-Modified-Since: " + state.robotsLastModified);
        }

        HttpRequestOptions requestOptions;
        requestOptions.timeoutMs = std::min(options.httpTimeoutMs, std::max(500, options.robotsTimeoutMs));
        requestOptions.maxBodyBytes = kRobotsBodyBytes;
        const HttpFetchResult response = httpFetch(url.authority + "/robots.txt", headers, requestOptions);
        if (infoOut) {
            (*infoOut)["http_status"] = static_cast<int>(response.statusCode);
            (*infoOut)["timing_ms"] = makeFetchTimingJson(response);
            (*infoOut)["timed_out"] = response.timedOut;
            if (!response.error.empty()) {
                (*infoOut)["error"] = response.error;
            }
        }
        if (!response.error.empty() && state.robotsFetchedAt != 0) {
            if (infoOut) {
                (*infoOut)["status"] = "stale_cache";
            }
            return state;
        }

        state.hostKey = url.authority;
        if (response.notModified) {
            state.robotsFetchedAt = nowMillis();
            upsertHostState(state);
            if (infoOut) {
                (*infoOut)["status"] = "not_modified";
                (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
                (*infoOut)["sitemaps"] = static_cast<int>(state.sitemapUrls.size());
            }
            return state;
        }

        if (response.statusCode == 404) {
            state.robotsBody.clear();
            state.robotsEtag.clear();
            state.robotsLastModified.clear();
            state.robotsFetchedAt = nowMillis();
            state.crawlDelaySeconds = 0.0;
            state.sitemapUrls.clear();
            upsertHostState(state);
            if (infoOut) {
                (*infoOut)["status"] = "missing";
                (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
                (*infoOut)["sitemaps"] = 0;
            }
            return state;
        }

        if (response.statusCode == 401 || response.statusCode == 403) {
            state.robotsBody = "User-agent: *\nDisallow: /\n";
            state.robotsFetchedAt = nowMillis();
            state.robotsEtag = response.etag;
            state.robotsLastModified = response.lastModified;
            state.crawlDelaySeconds = 0.0;
            state.sitemapUrls.clear();
            upsertHostState(state);
            if (infoOut) {
                (*infoOut)["status"] = "blocked";
                (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
                (*infoOut)["sitemaps"] = 0;
            }
            return state;
        }

        if (!response.success) {
            if (infoOut) {
                (*infoOut)["status"] = "unavailable";
                (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
                (*infoOut)["sitemaps"] = static_cast<int>(state.sitemapUrls.size());
            }
            return state;
        }

        const RobotsDefinition definition = parseRobotsDefinition(response.body, options.userAgent);
        state.robotsBody = response.body;
        state.robotsEtag = response.etag;
        state.robotsLastModified = response.lastModified;
        state.robotsFetchedAt = nowMillis();
        state.crawlDelaySeconds = definition.crawlDelaySeconds;
        state.sitemapUrls = definition.sitemaps;
        upsertHostState(state);
        if (infoOut) {
            (*infoOut)["status"] = "fetched";
            (*infoOut)["crawl_delay_seconds"] = state.crawlDelaySeconds;
            (*infoOut)["sitemaps"] = static_cast<int>(state.sitemapUrls.size());
            (*infoOut)["body_truncated"] = response.truncated;
        }
        return state;
    }

    void enqueueUrl(
        const std::string& normalizedUrl,
        const std::string& discoveredFrom,
        int priority,
        int depth,
        int attempts,
        std::int64_t delayMs) {
        if (workerStopRequested()) {
            return;
        }
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return;
        }

        SqliteStatement stmt(db,
            "INSERT INTO fetch_queue(normalized_url, discovered_from, priority, depth, next_fetch_at, enqueued_at, attempts, last_error) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, '') "
            "ON CONFLICT(normalized_url) DO UPDATE SET "
            "priority = MAX(priority, excluded.priority), "
            "depth = MIN(depth, excluded.depth), "
            "next_fetch_at = MIN(next_fetch_at, excluded.next_fetch_at), "
            "discovered_from = CASE WHEN excluded.discovered_from != '' THEN excluded.discovered_from ELSE fetch_queue.discovered_from END, "
            "attempts = excluded.attempts;");
        if (!stmt) {
            return;
        }

        const std::int64_t scheduledAt = nowMillis() + std::max<std::int64_t>(0, delayMs);
        sqlite3_bind_text(stmt.get(), 1, normalizedUrl.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt.get(), 2, discoveredFrom.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt.get(), 3, priority);
        sqlite3_bind_int(stmt.get(), 4, depth);
        sqlite3_bind_int64(stmt.get(), 5, scheduledAt);
        sqlite3_bind_int64(stmt.get(), 6, nowMillis());
        sqlite3_bind_int(stmt.get(), 7, attempts);
        sqlite3_step(stmt.get());

        workerCv.notify_one();
    }

    void requeue(
        const std::string& normalizedUrl,
        const std::string& discoveredFrom,
        int priority,
        int depth,
        int attempts,
        std::int64_t delayMs) {
        enqueueUrl(normalizedUrl, discoveredFrom, priority, depth, attempts, delayMs);
    }

    std::optional<QueueItem> takeNextQueueItem() {
        if (workerStopRequested()) {
            return std::nullopt;
        }
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return std::nullopt;
        }

        SqliteStatement select(db,
            "SELECT normalized_url, discovered_from, priority, depth, attempts "
            "FROM fetch_queue WHERE next_fetch_at <= ? "
            "ORDER BY priority DESC, next_fetch_at ASC, enqueued_at ASC LIMIT 1;");
        if (!select) {
            return std::nullopt;
        }
        sqlite3_bind_int64(select.get(), 1, nowMillis());
        if (sqlite3_step(select.get()) != SQLITE_ROW) {
            return std::nullopt;
        }

        QueueItem item;
        item.url = columnText(select.get(), 0);
        item.discoveredFrom = columnText(select.get(), 1);
        item.priority = sqlite3_column_int(select.get(), 2);
        item.depth = sqlite3_column_int(select.get(), 3);
        item.attempts = sqlite3_column_int(select.get(), 4);

        SqliteStatement remove(db, "DELETE FROM fetch_queue WHERE normalized_url = ?;");
        if (remove) {
            sqlite3_bind_text(remove.get(), 1, item.url.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_step(remove.get());
        }
        return item;
    }

    void enqueueDueRefreshes() {
        std::vector<std::pair<std::string, std::int64_t>> due;
        {
            if (workerStopRequested()) {
                return;
            }
            std::lock_guard<std::mutex> lock(mutex);
            if (!db) {
                return;
            }

            SqliteStatement stmt(db,
                "SELECT normalized_url, next_refresh_at "
                "FROM documents "
                "WHERE next_refresh_at > 0 AND next_refresh_at <= ? "
                "ORDER BY next_refresh_at ASC LIMIT 10;");
            if (!stmt) {
                return;
            }
            sqlite3_bind_int64(stmt.get(), 1, nowMillis());
            while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
                due.emplace_back(columnText(stmt.get(), 0), sqlite3_column_int64(stmt.get(), 1));
            }
        }

        for (const auto& [url, _nextRefresh] : due) {
            if (workerStopRequested()) {
                return;
            }
            enqueueUrl(url, "", 1, 0, 0, 0);
        }
    }

    std::optional<int> findExactDuplicate(const std::string& textHash, int selfDocId) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db || textHash.empty()) {
            return std::nullopt;
        }

        SqliteStatement stmt(db,
            "SELECT doc_id FROM documents "
            "WHERE text_hash = ? AND doc_id != ? AND blocked = 0 "
            "ORDER BY fetched_at DESC LIMIT 1;");
        if (!stmt) {
            return std::nullopt;
        }
        sqlite3_bind_text(stmt.get(), 1, textHash.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt.get(), 2, selfDocId);
        if (sqlite3_step(stmt.get()) != SQLITE_ROW) {
            return std::nullopt;
        }
        return sqlite3_column_int(stmt.get(), 0);
    }

    std::optional<int> findNearDuplicate(const std::string& host, const std::string& simhash, int selfDocId) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db || host.empty() || simhash.empty()) {
            return std::nullopt;
        }

        const std::uint64_t needle = parseSimhashHex(simhash);
        SqliteStatement stmt(db,
            "SELECT doc_id, simhash FROM documents "
            "WHERE host = ? AND doc_id != ? AND blocked = 0 AND simhash != '' "
            "ORDER BY fetched_at DESC LIMIT 64;");
        if (!stmt) {
            return std::nullopt;
        }

        sqlite3_bind_text(stmt.get(), 1, host.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt.get(), 2, selfDocId);
        while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
            const int docId = sqlite3_column_int(stmt.get(), 0);
            const std::uint64_t candidate = parseSimhashHex(columnText(stmt.get(), 1));
            if (candidate == 0) {
                continue;
            }
            if (hammingDistance(needle, candidate) <= 3) {
                return docId;
            }
        }
        return std::nullopt;
    }

    void updateFtsEntry(int docId, const DocumentRow& row) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!db) {
            return;
        }

        SqliteStatement remove(db, "DELETE FROM documents_fts WHERE rowid = ?;");
        if (remove) {
            sqlite3_bind_int(remove.get(), 1, docId);
            sqlite3_step(remove.get());
        }

        const bool indexable =
            !row.blocked &&
            row.duplicateOf == 0 &&
            row.nearDuplicateOf == 0 &&
            row.metaRobots.find("noindex") == std::string::npos &&
            !row.bodyText.empty();
        if (!indexable) {
            return;
        }

        SqliteStatement insert(db,
            "INSERT INTO documents_fts(rowid, title, headings, body_text) VALUES(?, ?, ?, ?);");
        if (!insert) {
            return;
        }
        sqlite3_bind_int(insert.get(), 1, docId);
        sqlite3_bind_text(insert.get(), 2, row.title.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(insert.get(), 3, row.headings.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(insert.get(), 4, row.bodyText.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(insert.get());
    }

    int upsertDocument(DocumentRow row, const std::vector<ExtractedLink>& links) {
        int docId = row.docId;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (!db) {
                return 0;
            }

            if (docId == 0) {
                SqliteStatement insert(db,
                    "INSERT INTO documents("
                    "source_url, normalized_url, canonical_url, host, scheme, title, headings, description, lang, "
                    "content_type, status_code, fetched_at, indexed_at, last_modified, etag, body_text, text_hash, "
                    "simhash, content_length, quality_score, link_count, discovered_from, change_count, "
                    "last_change_at, next_refresh_at, fetch_error, blocked, blocked_reason, meta_robots, "
                    "duplicate_of, near_duplicate_of, created_at, updated_at"
                    ") VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?);");
                if (!insert) {
                    return 0;
                }

                const std::int64_t createdAt = nowMillis();
                sqlite3_bind_text(insert.get(), 1, row.sourceUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 2, row.normalizedUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 3, row.canonicalUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 4, row.host.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 5, row.scheme.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 6, row.title.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 7, row.headings.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 8, row.description.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 9, row.lang.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 10, row.contentType.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(insert.get(), 11, row.statusCode);
                sqlite3_bind_int64(insert.get(), 12, row.fetchedAt);
                sqlite3_bind_int64(insert.get(), 13, row.indexedAt);
                sqlite3_bind_text(insert.get(), 14, row.lastModified.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 15, row.etag.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 16, row.bodyText.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 17, row.textHash.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 18, row.simhash.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(insert.get(), 19, row.contentLength);
                sqlite3_bind_double(insert.get(), 20, row.qualityScore);
                sqlite3_bind_int(insert.get(), 21, row.linkCount);
                sqlite3_bind_int(insert.get(), 22, row.changeCount);
                sqlite3_bind_int64(insert.get(), 23, row.lastChangeAt);
                sqlite3_bind_int64(insert.get(), 24, row.nextRefreshAt);
                sqlite3_bind_int(insert.get(), 25, row.blocked ? 1 : 0);
                sqlite3_bind_text(insert.get(), 26, row.blockedReason.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(insert.get(), 27, row.metaRobots.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(insert.get(), 28, row.duplicateOf);
                sqlite3_bind_int(insert.get(), 29, row.nearDuplicateOf);
                sqlite3_bind_int64(insert.get(), 30, createdAt);
                sqlite3_bind_int64(insert.get(), 31, createdAt);
                if (sqlite3_step(insert.get()) != SQLITE_DONE) {
                    return 0;
                }
                docId = static_cast<int>(sqlite3_last_insert_rowid(db));
            } else {
                SqliteStatement update(db,
                    "UPDATE documents SET "
                    "source_url=?, normalized_url=?, canonical_url=?, host=?, scheme=?, title=?, headings=?, description=?, lang=?, "
                    "content_type=?, status_code=?, fetched_at=?, indexed_at=?, last_modified=?, etag=?, body_text=?, "
                    "text_hash=?, simhash=?, content_length=?, quality_score=?, link_count=?, change_count=?, "
                    "last_change_at=?, next_refresh_at=?, fetch_error='', blocked=?, blocked_reason=?, meta_robots=?, "
                    "duplicate_of=?, near_duplicate_of=?, updated_at=? "
                    "WHERE doc_id = ?;");
                if (!update) {
                    return 0;
                }

                sqlite3_bind_text(update.get(), 1, row.sourceUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 2, row.normalizedUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 3, row.canonicalUrl.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 4, row.host.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 5, row.scheme.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 6, row.title.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 7, row.headings.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 8, row.description.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 9, row.lang.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 10, row.contentType.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(update.get(), 11, row.statusCode);
                sqlite3_bind_int64(update.get(), 12, row.fetchedAt);
                sqlite3_bind_int64(update.get(), 13, row.indexedAt);
                sqlite3_bind_text(update.get(), 14, row.lastModified.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 15, row.etag.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 16, row.bodyText.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 17, row.textHash.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 18, row.simhash.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(update.get(), 19, row.contentLength);
                sqlite3_bind_double(update.get(), 20, row.qualityScore);
                sqlite3_bind_int(update.get(), 21, row.linkCount);
                sqlite3_bind_int(update.get(), 22, row.changeCount);
                sqlite3_bind_int64(update.get(), 23, row.lastChangeAt);
                sqlite3_bind_int64(update.get(), 24, row.nextRefreshAt);
                sqlite3_bind_int(update.get(), 25, row.blocked ? 1 : 0);
                sqlite3_bind_text(update.get(), 26, row.blockedReason.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(update.get(), 27, row.metaRobots.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_int(update.get(), 28, row.duplicateOf);
                sqlite3_bind_int(update.get(), 29, row.nearDuplicateOf);
                sqlite3_bind_int64(update.get(), 30, nowMillis());
                sqlite3_bind_int(update.get(), 31, docId);
                if (sqlite3_step(update.get()) != SQLITE_DONE) {
                    return 0;
                }
            }

            SqliteStatement deleteLinks(db, "DELETE FROM link_edges WHERE src_doc_id = ?;");
            if (deleteLinks) {
                sqlite3_bind_int(deleteLinks.get(), 1, docId);
                sqlite3_step(deleteLinks.get());
            }

            SqliteStatement insertLink(db,
                "INSERT OR REPLACE INTO link_edges(src_doc_id, dst_url, anchor_text) VALUES(?, ?, ?);");
            if (insertLink) {
                for (const auto& link : links) {
                    sqlite3_reset(insertLink.get());
                    sqlite3_clear_bindings(insertLink.get());
                    sqlite3_bind_int(insertLink.get(), 1, docId);
                    sqlite3_bind_text(insertLink.get(), 2, link.url.c_str(), -1, SQLITE_TRANSIENT);
                    sqlite3_bind_text(insertLink.get(), 3, link.text.c_str(), -1, SQLITE_TRANSIENT);
                    sqlite3_step(insertLink.get());
                }
            }
        }

        row.docId = docId;
        updateFtsEntry(docId, row);
        return docId;
    }

    QueryPlan buildQueryPlan(const Json::Value& arguments) const {
        QueryPlan plan;
        plan.originalQuery = trimCopy(arguments.get("query", "").asString());

        std::vector<std::string> expressions;
        std::string current;
        bool inQuote = false;
        std::vector<std::string> quoted;

        for (char ch : plan.originalQuery) {
            if (ch == '"') {
                if (inQuote && !current.empty()) {
                    quoted.push_back(trimCopy(current));
                    current.clear();
                }
                inQuote = !inQuote;
                continue;
            }
            current.push_back(ch);
            if (!inQuote && std::isspace(static_cast<unsigned char>(ch))) {
                current.pop_back();
                const std::string token = trimCopy(current);
                if (!token.empty()) {
                    if (startsWith(toLower(token), "site:")) {
                        plan.siteAllow.push_back(normalizeDomainFilter(token.substr(5)));
                    } else if (startsWith(toLower(token), "-site:")) {
                        plan.siteBlock.push_back(normalizeDomainFilter(token.substr(6)));
                    } else {
                        const auto parts = tokenizeTerms(token);
                        for (const auto& part : parts) {
                            plan.terms.push_back(part);
                        }
                    }
                }
                current.clear();
            }
        }
        if (!current.empty()) {
            const std::string token = trimCopy(current);
            if (!token.empty()) {
                if (inQuote) {
                    quoted.push_back(token);
                } else if (startsWith(toLower(token), "site:")) {
                    plan.siteAllow.push_back(normalizeDomainFilter(token.substr(5)));
                } else if (startsWith(toLower(token), "-site:")) {
                    plan.siteBlock.push_back(normalizeDomainFilter(token.substr(6)));
                } else {
                    const auto parts = tokenizeTerms(token);
                    for (const auto& part : parts) {
                        plan.terms.push_back(part);
                    }
                }
            }
        }

        if (arguments.isMember("site_allow") && arguments["site_allow"].isArray()) {
            for (const auto& item : arguments["site_allow"]) {
                if (item.isString()) {
                    plan.siteAllow.push_back(normalizeDomainFilter(item.asString()));
                }
            }
        }
        if (arguments.isMember("site_block") && arguments["site_block"].isArray()) {
            for (const auto& item : arguments["site_block"]) {
                if (item.isString()) {
                    plan.siteBlock.push_back(normalizeDomainFilter(item.asString()));
                }
            }
        }

        std::sort(plan.siteAllow.begin(), plan.siteAllow.end());
        plan.siteAllow.erase(std::unique(plan.siteAllow.begin(), plan.siteAllow.end()), plan.siteAllow.end());
        std::sort(plan.siteBlock.begin(), plan.siteBlock.end());
        plan.siteBlock.erase(std::unique(plan.siteBlock.begin(), plan.siteBlock.end()), plan.siteBlock.end());

        for (const auto& phrase : quoted) {
            const std::string normalized = normalizeWhitespace(phrase);
            if (!normalized.empty()) {
                expressions.push_back("\"" + normalized + "\"");
            }
        }
        for (const auto& term : plan.terms) {
            expressions.push_back(term.size() >= 4 ? term + "*" : term);
        }

        if (expressions.empty()) {
            const auto fallbackTerms = tokenizeTerms(plan.originalQuery);
            for (const auto& term : fallbackTerms) {
                expressions.push_back(term.size() >= 4 ? term + "*" : term);
            }
        }

        for (std::size_t index = 0; index < expressions.size(); ++index) {
            if (index > 0) {
                plan.matchExpression += " AND ";
            }
            plan.matchExpression += expressions[index];
        }

        return plan;
    }

    Json::Value liveSearch(
        const QueryPlan& query,
        int topK,
        int freshnessDays,
        const std::string& languageFilter,
        bool safeMode) {
        const auto usesDuckDuckGoHtml = [](const std::string& baseUrl) {
            const std::string lowered = toLower(baseUrl);
            return lowered.find("duckduckgo") != std::string::npos ||
                   lowered.find("/html") != std::string::npos ||
                   lowered.find("/lite") != std::string::npos;
        };
        const auto buildProviderQuery = [&](const QueryPlan& plan) {
            std::string providerQuery = plan.originalQuery;
            for (const auto& filter : plan.siteAllow) {
                if (!filter.empty()) {
                    providerQuery += " site:" + filter;
                }
            }
            for (const auto& filter : plan.siteBlock) {
                if (!filter.empty()) {
                    providerQuery += " -site:" + filter;
                }
            }
            return trimCopy(providerQuery);
        };
        const auto buildFreshnessParam = [](int days) {
            if (days <= 0) return std::string{};
            if (days <= 1) return std::string{"d"};
            if (days <= 7) return std::string{"w"};
            if (days <= 31) return std::string{"m"};
            if (days <= 366) return std::string{"y"};
            return std::string{};
        };
        const auto buildLiveSearchTerms = [&](const QueryPlan& plan) {
            static const std::unordered_set<std::string> ignored = {
                "latest", "recent", "news", "article", "articles", "story", "stories",
                "update", "updates", "current"
            };
            std::vector<std::string> terms;
            std::unordered_set<std::string> seen;
            const auto addTerms = [&](const std::vector<std::string>& source) {
                for (const auto& term : source) {
                    if (term.empty() || ignored.find(term) != ignored.end()) {
                        continue;
                    }
                    if (seen.insert(term).second) {
                        terms.push_back(term);
                    }
                }
            };

            addTerms(plan.terms);
            addTerms(tokenizeTerms(plan.originalQuery));
            if (terms.empty()) {
                for (const auto& term : tokenizeTerms(plan.originalQuery)) {
                    if (seen.insert(term).second) {
                        terms.push_back(term);
                    }
                }
            }
            return terms;
        };
        const auto scoreLiveHit = [](const std::vector<std::string>& terms, const LiveSearchHit& hit) {
            if (terms.empty()) {
                return 1.0;
            }

            const std::string loweredTitle = toLower(hit.title);
            const std::string loweredSnippet = toLower(hit.snippet);
            const std::string loweredUrl = toLower(hit.url);
            double score = 0.0;
            int matched = 0;

            for (const auto& term : terms) {
                bool termMatched = false;
                if (loweredTitle.find(term) != std::string::npos) {
                    score += 2.0;
                    termMatched = true;
                }
                if (loweredSnippet.find(term) != std::string::npos) {
                    score += 1.0;
                    termMatched = true;
                }
                if (loweredUrl.find(term) != std::string::npos) {
                    score += 0.5;
                    termMatched = true;
                }
                if (termMatched) {
                    matched += 1;
                }
            }

            if (matched == 0) {
                return 0.0;
            }
            return score + (static_cast<double>(matched) / static_cast<double>(terms.size()));
        };

        Json::Value result(Json::objectValue);
        result["query"] = query.originalQuery;
        result["match_expression"] = query.matchExpression;
        result["results"] = Json::Value(Json::arrayValue);
        result["filters"]["site_allow"] = Json::Value(Json::arrayValue);
        result["filters"]["site_block"] = Json::Value(Json::arrayValue);
        for (const auto& filter : query.siteAllow) {
            result["filters"]["site_allow"].append(filter);
        }
        for (const auto& filter : query.siteBlock) {
            result["filters"]["site_block"].append(filter);
        }
        if (freshnessDays > 0) {
            result["filters"]["freshness_days"] = freshnessDays;
        }
        if (!languageFilter.empty()) {
            result["filters"]["language"] = languageFilter;
        }
        result["filters"]["safe_mode"] = safeMode;
        result["source"] = "live_fallback";
        result["provider"] = "bing_rss";

        if (!options.enableLiveSearchFallback || options.liveSearchBaseUrl.empty()) {
            result["hint"] = "Live search fallback is disabled.";
            return result;
        }

        const std::string separator = options.liveSearchBaseUrl.find('?') == std::string::npos ? "?" : "&";
        const std::string providerQuery = buildProviderQuery(query);
        const bool htmlProvider = usesDuckDuckGoHtml(options.liveSearchBaseUrl);
        std::string searchUrl = options.liveSearchBaseUrl + separator + "q=" + urlEncode(providerQuery);
        if (htmlProvider) {
            const std::string df = buildFreshnessParam(freshnessDays);
            if (!df.empty()) {
                searchUrl += "&df=" + df;
            }
            searchUrl += "&kp=" + std::string(safeMode ? "1" : "-1");
        } else {
            searchUrl += "&format=rss";
            if (safeMode) {
                searchUrl += "&adlt=strict";
            }
        }
        const HttpFetchResult response = httpFetch(searchUrl, {});
        if (!response.success) {
            result["hint"] = "Indexed search found no matches, and live search fallback failed.";
            if (!response.error.empty()) {
                result["live_search_error"] = response.error;
            } else if (response.statusCode > 0) {
                result["live_search_error"] = "HTTP " + std::to_string(response.statusCode);
            }
            return result;
        }

        const std::string loweredBody = toLower(response.body);
        const bool rssLike =
            loweredBody.find("<rss") != std::string::npos ||
            loweredBody.find("<feed") != std::string::npos ||
            loweredBody.find("<item") != std::string::npos;
        const std::string liveProvider = rssLike ? "bing_rss" : "duckduckgo_html";
        auto hits = rssLike ? parseRssSearchHits(response.body) : parseDuckDuckGoHtmlSearchHits(response.body);
        const auto liveSearchTerms = buildLiveSearchTerms(query);
        std::stable_sort(hits.begin(), hits.end(), [&](const LiveSearchHit& left, const LiveSearchHit& right) {
            return scoreLiveHit(liveSearchTerms, left) > scoreLiveHit(liveSearchTerms, right);
        });
        const std::int64_t freshnessCutoff = freshnessDays > 0
            ? nowMillis() - (static_cast<std::int64_t>(freshnessDays) * kDayMs)
            : 0;
        const int bootstrapBudget = std::max(0, std::min(options.liveSearchBootstrapCount, topK));
        const bool queueBootstrap = options.enableBackgroundWorker;
        int emitted = 0;
        int bootstrapped = 0;
        int queued = 0;
        std::unordered_set<std::string> bootstrappedHosts;

        for (const auto& hit : hits) {
            std::string canonicalError;
            const auto normalized = canonicalizeUrl(hit.url, "", canonicalError);
            if (!normalized.has_value()) {
                continue;
            }

            if (!query.siteAllow.empty()) {
                bool allowed = false;
                for (const auto& filter : query.siteAllow) {
                    if (hostMatchesFilter(normalized->host, filter)) {
                        allowed = true;
                        break;
                    }
                }
                if (!allowed) {
                    continue;
                }
            }

            bool blocked = false;
            for (const auto& filter : query.siteBlock) {
                if (hostMatchesFilter(normalized->host, filter)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                continue;
            }

            if (freshnessCutoff > 0 && hit.publishedAt > 0 && hit.publishedAt < freshnessCutoff) {
                continue;
            }

            if (safeMode && containsExplicitContent(hit.title + " " + hit.snippet + " " + normalized->url)) {
                continue;
            }

            if (scoreLiveHit(liveSearchTerms, hit) <= 0.0) {
                continue;
            }

            Json::Value entry(Json::objectValue);
            entry["title"] = hit.title;
            entry["url"] = normalized->url;
            entry["host"] = normalized->host;
            entry["snippet"] = hit.snippet;
            entry["source"] = "live_fallback";
            if (hit.publishedAt > 0) {
                entry["published_at"] = static_cast<Json::Int64>(hit.publishedAt);
            }

            if ((bootstrapped + queued) < bootstrapBudget &&
                bootstrappedHosts.insert(normalized->host).second) {
                if (queueBootstrap) {
                    enqueueUrl(normalized->url, "live_search", 3, 0, 0, 0);
                    entry["bootstrap_status"] = "queued";
                    queued += 1;
                } else {
                    Json::Value fetchArgs(Json::objectValue);
                    fetchArgs["url"] = normalized->url;
                    fetchArgs["queue_discovered"] = false;
                    fetchArgs["max_queue_links"] = 0;
                    fetchArgs["force_refresh"] = false;

                    const Json::Value fetchResult = fetchUrl(fetchArgs, 0, "", false, nullptr);
                    const std::string fetchStatus = fetchResult.get("status", "").asString();
                    if (fetchResult.isObject()) {
                        entry["bootstrap_status"] = fetchStatus;
                        if (fetchResult.isMember("doc_id")) {
                            entry["doc_id"] = fetchResult["doc_id"];
                        }
                    }
                    if ((fetchStatus == "indexed" || fetchStatus == "indexed_blocked" || fetchStatus == "not_modified") &&
                        fetchResult.get("doc_id", 0).asInt() > 0) {
                        bootstrapped += 1;
                    }
                }
            }

            result["results"].append(entry);
            emitted += 1;
            if (emitted >= topK) {
                break;
            }
        }

        result["live_search"]["enabled"] = options.enableLiveSearchFallback;
        result["live_search"]["provider"] = liveProvider;
        result["live_search"]["base_url"] = options.liveSearchBaseUrl;
        result["live_search"]["bootstrap_mode"] = queueBootstrap ? "queued" : "inline";
        result["live_search"]["bootstrapped_results"] = bootstrapped;
        result["live_search"]["queued_results"] = queued;
        result["provider"] = liveProvider;

        if (emitted == 0) {
            result["hint"] = "No indexed pages or live fallback results matched the query and filters.";
        } else if (queueBootstrap && !languageFilter.empty()) {
            result["hint"] = "No indexed pages matched. Returned live web results and queued local indexing in the background; language filtering is best-effort for live fallback.";
        } else if (queueBootstrap) {
            result["hint"] = "No indexed pages matched. Returned live web results and queued local indexing in the background.";
        } else if (!languageFilter.empty()) {
            result["hint"] = "No indexed pages matched. Returned live web results and bootstrapped the local index where possible; language filtering is best-effort for live fallback.";
        } else {
            result["hint"] = "No indexed pages matched. Returned live web results and bootstrapped the local index where possible.";
        }

        return result;
    }

    Json::Value search(const Json::Value& arguments) {
        std::string error;
        if (!ensureInitialized(&error)) {
            return makeError(error);
        }

        const QueryPlan query = buildQueryPlan(arguments);
        if (query.matchExpression.empty()) {
            return makeError("query did not contain searchable terms");
        }

        const int topK = std::clamp(arguments.get("top_k", 8).asInt(), 1, 20);
        const int freshnessDays = arguments.get("freshness_days", 0).asInt();
        const std::string languageFilter = toLower(trimCopy(arguments.get("language", "").asString()));
        const bool safeMode = arguments.get("safe_mode", false).asBool();

        std::vector<SearchCandidate> candidates;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (!db) {
                return makeError("web search database is unavailable");
            }

            SqliteStatement stmt(db,
                "SELECT d.doc_id, d.title, d.canonical_url, d.host, d.lang, d.fetched_at, d.indexed_at, "
                "d.quality_score, bm25(documents_fts, 8.0, 3.0, 1.0) AS lexical_rank, "
                "snippet(documents_fts, 2, '[[', ']]', ' ... ', 28) "
                "FROM documents_fts "
                "JOIN documents d ON d.doc_id = documents_fts.rowid "
                "WHERE documents_fts MATCH ? "
                "AND d.blocked = 0 "
                "AND d.duplicate_of = 0 "
                "AND d.near_duplicate_of = 0 "
                "AND d.meta_robots NOT LIKE '%noindex%' "
                "ORDER BY lexical_rank ASC LIMIT 96;");
            if (!stmt) {
                return makeError("failed to prepare search query");
            }

            sqlite3_bind_text(stmt.get(), 1, query.matchExpression.c_str(), -1, SQLITE_TRANSIENT);
            while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
                SearchCandidate candidate;
                candidate.docId = sqlite3_column_int(stmt.get(), 0);
                candidate.title = columnText(stmt.get(), 1);
                candidate.url = columnText(stmt.get(), 2);
                candidate.host = columnText(stmt.get(), 3);
                candidate.lang = toLower(columnText(stmt.get(), 4));
                candidate.fetchedAt = sqlite3_column_int64(stmt.get(), 5);
                candidate.indexedAt = sqlite3_column_int64(stmt.get(), 6);
                candidate.qualityScore = sqlite3_column_double(stmt.get(), 7);
                candidate.bm25 = sqlite3_column_double(stmt.get(), 8);
                candidate.snippet = columnText(stmt.get(), 9);
                candidates.push_back(std::move(candidate));
            }
        }

        Json::Value result(Json::objectValue);
        result["query"] = query.originalQuery;
        result["match_expression"] = query.matchExpression;
        result["results"] = Json::Value(Json::arrayValue);
        result["filters"]["site_allow"] = Json::Value(Json::arrayValue);
        result["filters"]["site_block"] = Json::Value(Json::arrayValue);
        for (const auto& filter : query.siteAllow) {
            result["filters"]["site_allow"].append(filter);
        }
        for (const auto& filter : query.siteBlock) {
            result["filters"]["site_block"].append(filter);
        }
        if (freshnessDays > 0) {
            result["filters"]["freshness_days"] = freshnessDays;
        }
        if (!languageFilter.empty()) {
            result["filters"]["language"] = languageFilter;
        }
        result["filters"]["safe_mode"] = safeMode;

        const std::int64_t freshnessCutoff = freshnessDays > 0 ? nowMillis() - (static_cast<std::int64_t>(freshnessDays) * kDayMs) : 0;
        for (auto& candidate : candidates) {
            if (!query.siteAllow.empty()) {
                bool allowed = false;
                for (const auto& filter : query.siteAllow) {
                    if (hostMatchesFilter(candidate.host, filter)) {
                        allowed = true;
                        break;
                    }
                }
                if (!allowed) {
                    candidate.finalScore = -1.0;
                    continue;
                }
            }

            bool blocked = false;
            for (const auto& filter : query.siteBlock) {
                if (hostMatchesFilter(candidate.host, filter)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) {
                candidate.finalScore = -1.0;
                continue;
            }

            if (freshnessCutoff > 0 && candidate.fetchedAt > 0 && candidate.fetchedAt < freshnessCutoff) {
                candidate.finalScore = -1.0;
                continue;
            }

            if (!languageFilter.empty() && !candidate.lang.empty() &&
                !startsWith(candidate.lang, languageFilter)) {
                candidate.finalScore = -1.0;
                continue;
            }

            if (safeMode && containsExplicitContent(candidate.title + " " + candidate.snippet + " " + candidate.url)) {
                candidate.finalScore = -1.0;
                continue;
            }

            double score = -candidate.bm25;
            if (score <= 0.0) {
                score = 1.0 / (1.0 + std::fabs(candidate.bm25));
            }
            score *= 1.0 + (candidate.qualityScore / 120.0);

            const std::string loweredTitle = toLower(candidate.title);
            const std::string loweredQuery = toLower(query.originalQuery);
            if (!loweredQuery.empty() && loweredTitle.find(loweredQuery) != std::string::npos) {
                score *= 1.35;
            }
            if (candidate.fetchedAt > 0) {
                const double ageDays = std::max(0.0, static_cast<double>(nowMillis() - candidate.fetchedAt) / static_cast<double>(kDayMs));
                score *= 0.75 + (0.5 * std::exp(-ageDays / 30.0));
            }
            candidate.finalScore = score;
        }

        std::sort(candidates.begin(), candidates.end(), [](const SearchCandidate& left, const SearchCandidate& right) {
            return left.finalScore > right.finalScore;
        });

        std::unordered_map<std::string, int> hostCounts;
        int emitted = 0;
        for (const auto& candidate : candidates) {
            if (candidate.finalScore <= 0.0) {
                continue;
            }
            const int cap = query.siteAllow.empty() ? kHostDiversityCap : std::numeric_limits<int>::max();
            if (hostCounts[candidate.host] >= cap) {
                continue;
            }

            Json::Value entry(Json::objectValue);
            entry["doc_id"] = candidate.docId;
            entry["title"] = candidate.title;
            entry["url"] = candidate.url;
            entry["host"] = candidate.host;
            entry["snippet"] = candidate.snippet;
            entry["score"] = candidate.finalScore;
            entry["bm25"] = candidate.bm25;
            entry["quality_score"] = candidate.qualityScore;
            entry["fetched_at"] = static_cast<Json::Int64>(candidate.fetchedAt);
            entry["indexed_at"] = static_cast<Json::Int64>(candidate.indexedAt);
            result["results"].append(entry);
            hostCounts[candidate.host] += 1;
            emitted += 1;
            if (emitted >= topK) {
                break;
            }
        }

        if (emitted == 0) {
            const Json::Value liveFallback = liveSearch(query, topK, freshnessDays, languageFilter, safeMode);
            if (liveFallback.isObject() &&
                liveFallback.isMember("results") &&
                liveFallback["results"].isArray() &&
                !liveFallback["results"].empty()) {
                return liveFallback;
            }

            const Json::Value stats = status();
            if (liveFallback.isObject() && liveFallback.isMember("live_search_error")) {
                result["live_search_error"] = liveFallback["live_search_error"];
            }
            if (stats.isObject() && stats.get("documents", Json::Value(Json::objectValue)).get("indexed", 0).asInt() == 0) {
                result["hint"] = "The index is empty, and live fallback returned no usable results. Use fetch_url on a root page or sitemap to bootstrap crawling before searching.";
            } else {
                result["hint"] = "No indexed pages matched the query, and live fallback returned no usable results.";
            }
        }

        return result;
    }

    Json::Value openResult(const Json::Value& arguments) {
        std::string error;
        if (!ensureInitialized(&error)) {
            return makeError(error);
        }

        const int docId = arguments.get("doc_id", 0).asInt();
        if (docId <= 0) {
            return makeError("doc_id must be a positive integer");
        }

        const int maxChars = std::clamp(arguments.get("max_chars", 20000).asInt(), 500, 100000);
        const bool includeLinks = arguments.get("include_links", true).asBool();
        const auto row = loadDocumentById(docId);
        if (!row.has_value()) {
            return makeError("Document not found");
        }

        Json::Value result(Json::objectValue);
        result["doc_id"] = row->docId;
        result["title"] = row->title;
        result["url"] = row->normalizedUrl;
        result["canonical_url"] = row->canonicalUrl;
        result["description"] = row->description;
        result["headings"] = row->headings;
        result["lang"] = row->lang;
        result["content_type"] = row->contentType;
        result["fetched_at"] = static_cast<Json::Int64>(row->fetchedAt);
        result["indexed_at"] = static_cast<Json::Int64>(row->indexedAt);
        result["quality_score"] = row->qualityScore;
        result["duplicate_of"] = row->duplicateOf;
        result["near_duplicate_of"] = row->nearDuplicateOf;
        result["blocked"] = row->blocked;
        result["blocked_reason"] = row->blockedReason;
        result["truncated"] = static_cast<int>(row->bodyText.size()) > maxChars;
        result["text"] = firstNChars(row->bodyText, maxChars);

        if (includeLinks) {
            Json::Value links(Json::arrayValue);
            std::lock_guard<std::mutex> lock(mutex);
            if (db) {
                SqliteStatement stmt(db,
                    "SELECT dst_url, anchor_text FROM link_edges WHERE src_doc_id = ? ORDER BY dst_url ASC LIMIT 40;");
                if (stmt) {
                    sqlite3_bind_int(stmt.get(), 1, row->docId);
                    while (sqlite3_step(stmt.get()) == SQLITE_ROW) {
                        Json::Value link(Json::objectValue);
                        link["url"] = columnText(stmt.get(), 0);
                        link["text"] = columnText(stmt.get(), 1);
                        links.append(link);
                    }
                }
            }
            result["links"] = links;
        }

        return result;
    }

    Json::Value relatedResults(const Json::Value& arguments) {
        std::string error;
        if (!ensureInitialized(&error)) {
            return makeError(error);
        }

        const int docId = arguments.get("doc_id", 0).asInt();
        if (docId <= 0) {
            return makeError("doc_id must be a positive integer");
        }

        const int topK = std::clamp(arguments.get("top_k", 8).asInt(), 1, 20);
        const std::string strategy = arguments.get("strategy", "mixed").asString();
        const auto source = loadDocumentById(docId);
        if (!source.has_value()) {
            return makeError("Document not found");
        }

        const auto sourceTerms = tokenizeTerms(source->title + " " + source->headings + " " + firstNChars(source->bodyText, 2000));
        std::unordered_set<std::string> uniqueTerms(sourceTerms.begin(), sourceTerms.end());

        struct RelatedCandidate {
            int docId = 0;
            std::string title;
            std::string url;
            std::string host;
            std::string reason;
            double score = 0.0;
        };

        std::unordered_map<int, RelatedCandidate> candidates;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (!db) {
                return makeError("web search database is unavailable");
            }

            if (strategy == "mixed" || strategy == "linked") {
                SqliteStatement outgoing(db,
                    "SELECT d.doc_id, d.title, d.canonical_url, d.host "
                    "FROM link_edges l "
                    "JOIN documents d ON d.normalized_url = l.dst_url "
                    "WHERE l.src_doc_id = ? AND d.doc_id != ? "
                    "LIMIT 24;");
                if (outgoing) {
                    sqlite3_bind_int(outgoing.get(), 1, docId);
                    sqlite3_bind_int(outgoing.get(), 2, docId);
                    while (sqlite3_step(outgoing.get()) == SQLITE_ROW) {
                        RelatedCandidate candidate;
                        candidate.docId = sqlite3_column_int(outgoing.get(), 0);
                        candidate.title = columnText(outgoing.get(), 1);
                        candidate.url = columnText(outgoing.get(), 2);
                        candidate.host = columnText(outgoing.get(), 3);
                        candidate.reason = "linked";
                        candidate.score = 3.0;
                        candidates[candidate.docId] = candidate;
                    }
                }
            }

            if (strategy == "mixed" || strategy == "same_host") {
                SqliteStatement sameHost(db,
                    "SELECT doc_id, title, canonical_url, host, headings, body_text "
                    "FROM documents "
                    "WHERE host = ? AND doc_id != ? AND blocked = 0 "
                    "ORDER BY fetched_at DESC LIMIT 48;");
                if (sameHost) {
                    sqlite3_bind_text(sameHost.get(), 1, source->host.c_str(), -1, SQLITE_TRANSIENT);
                    sqlite3_bind_int(sameHost.get(), 2, docId);
                    while (sqlite3_step(sameHost.get()) == SQLITE_ROW) {
                        const int candidateId = sqlite3_column_int(sameHost.get(), 0);
                        const std::string title = columnText(sameHost.get(), 1);
                        const std::string url = columnText(sameHost.get(), 2);
                        const std::string host = columnText(sameHost.get(), 3);
                        const std::string headings = columnText(sameHost.get(), 4);
                        const std::string bodyText = firstNChars(columnText(sameHost.get(), 5), 2000);

                        int overlap = 0;
                        for (const auto& token : tokenizeTerms(title + " " + headings + " " + bodyText)) {
                            if (uniqueTerms.find(token) != uniqueTerms.end()) {
                                overlap += 1;
                            }
                        }
                        if (overlap == 0 && strategy == "same_host") {
                            continue;
                        }

                        RelatedCandidate candidate;
                        candidate.docId = candidateId;
                        candidate.title = title;
                        candidate.url = url;
                        candidate.host = host;
                        candidate.reason = "same_host";
                        candidate.score = 1.0 + static_cast<double>(overlap) / 10.0;
                        const auto it = candidates.find(candidateId);
                        if (it == candidates.end() || it->second.score < candidate.score) {
                            candidates[candidateId] = candidate;
                        }
                    }
                }
            }
        }

        std::vector<RelatedCandidate> ordered;
        ordered.reserve(candidates.size());
        for (const auto& [id, candidate] : candidates) {
            ordered.push_back(candidate);
        }
        std::sort(ordered.begin(), ordered.end(), [](const RelatedCandidate& left, const RelatedCandidate& right) {
            return left.score > right.score;
        });

        Json::Value result(Json::objectValue);
        result["doc_id"] = docId;
        result["strategy"] = strategy;
        result["results"] = Json::Value(Json::arrayValue);
        for (std::size_t index = 0; index < ordered.size() && index < static_cast<std::size_t>(topK); ++index) {
            Json::Value entry(Json::objectValue);
            entry["doc_id"] = ordered[index].docId;
            entry["title"] = ordered[index].title;
            entry["url"] = ordered[index].url;
            entry["host"] = ordered[index].host;
            entry["reason"] = ordered[index].reason;
            entry["score"] = ordered[index].score;
            result["results"].append(entry);
        }
        return result;
    }

    std::int64_t computeNextRefreshAt(
        const std::optional<DocumentRow>& existing,
        bool changed,
        bool notModified,
        bool isSitemap,
        int statusCode) const {
        if (statusCode >= 500) {
            return nowMillis() + 6 * kHourMs;
        }
        if (statusCode == 429) {
            return nowMillis() + 3 * kHourMs;
        }
        if (isSitemap) {
            return nowMillis() + 12 * kHourMs;
        }
        if (changed) {
            return nowMillis() + kDayMs;
        }
        if (notModified) {
            return nowMillis() + 3 * kDayMs;
        }
        if (existing.has_value() && existing->changeCount == 0) {
            return nowMillis() + 7 * kDayMs;
        }
        return nowMillis() + 3 * kDayMs;
    }

    Json::Value makeCancelledResult(
        const std::string& url,
        const Json::Value& robotsInfo,
        const HttpFetchResult* response = nullptr) const {
        Json::Value cancelled(Json::objectValue);
        cancelled["status"] = "cancelled";
        cancelled["url"] = url;
        cancelled["error"] = "Fetch cancelled";
        cancelled["retryable"] = false;
        if (!robotsInfo.isNull()) {
            cancelled["robots"] = robotsInfo;
        }
        if (response) {
            cancelled["timed_out"] = response->timedOut;
            cancelled["timing_ms"] = makeFetchTimingJson(*response);
        }
        return cancelled;
    }

    Json::Value fetchUrl(
        const Json::Value& arguments,
        int depth,
        const std::string& discoveredFrom,
        bool fromWorker,
        std::function<bool()> cancelCheck) {
        std::string error;
        if (!ensureInitialized(&error)) {
            return makeError(error);
        }

        const std::string rawUrl = trimCopy(arguments.get("url", "").asString());
        if (rawUrl.empty()) {
            return makeError("url is required");
        }

        std::string canonicalError;
        const auto normalized = canonicalizeUrl(rawUrl, "", canonicalError);
        if (!normalized.has_value()) {
            return makeError(canonicalError);
        }

        if (looksLikeBinaryAsset(normalized->path)) {
            return makeError("Binary assets are not indexed by the web search tool");
        }

        std::string safetyReason;
        if (!isPublicHttpHost(*normalized, options.allowPrivateHosts, safetyReason)) {
            return makeError(safetyReason);
        }

        if (cancelCheck && cancelCheck()) {
            return makeCancelledResult(normalized->url, Json::Value(Json::objectValue));
        }

        Json::Value robotsInfo(Json::objectValue);
        HostState hostState = ensureRobots(*normalized, &robotsInfo);
        if (cancelCheck && cancelCheck()) {
            return makeCancelledResult(normalized->url, robotsInfo);
        }
        const RobotsDefinition robots = parseRobotsDefinition(hostState.robotsBody, options.userAgent);
        if (!hostState.robotsBody.empty() && !robotsAllowsPath(robots, normalized->pathWithQuery)) {
            Json::Value blocked(Json::objectValue);
            blocked["status"] = "blocked";
            blocked["reason"] = "robots_txt_disallow";
            blocked["url"] = normalized->url;
            blocked["robots"] = robotsInfo;
            blocked["retryable"] = false;
            return blocked;
        }

        if (hostState.nextAllowedFetchAt > nowMillis()) {
            Json::Value delayed(Json::objectValue);
            delayed["status"] = "delayed";
            delayed["url"] = normalized->url;
            delayed["robots"] = robotsInfo;
            delayed["retryable"] = true;
            delayed["retry_after_ms"] = static_cast<Json::Int64>(hostState.nextAllowedFetchAt - nowMillis());
            if (!fromWorker) {
                enqueueUrl(normalized->url, discoveredFrom, 1, depth, 0, delayed["retry_after_ms"].asInt64());
            }
            return delayed;
        }

        const bool forceRefresh = arguments.get("force_refresh", false).asBool();
        const bool queueDiscovered = arguments.get("queue_discovered", true).asBool();
        const bool allowCrossHost = arguments.get("allow_cross_host", false).asBool();
        const int maxQueueLinks = std::clamp(arguments.get("max_queue_links", kDefaultQueueLinks).asInt(), 0, 100);

        const auto existing = loadDocumentByNormalizedUrl(normalized->url);
        std::vector<std::string> headers;
        if (!forceRefresh && existing.has_value()) {
            if (!existing->etag.empty()) {
                headers.push_back("If-None-Match: " + existing->etag);
            }
            if (!existing->lastModified.empty()) {
                headers.push_back("If-Modified-Since: " + existing->lastModified);
            }
        }

        HttpRequestOptions requestOptions;
        requestOptions.cancelCheck = std::move(cancelCheck);
        const HttpFetchResult response = httpFetch(normalized->url, headers, requestOptions);
        const double crawlDelaySeconds = robots.crawlDelaySeconds > 0.0 ? robots.crawlDelaySeconds : 0.5;
        updateHostNextFetch(normalized->authority, nowMillis() + static_cast<std::int64_t>(crawlDelaySeconds * 1000.0));

        if (response.cancelled) {
            return makeCancelledResult(normalized->url, robotsInfo, &response);
        }

        if (!response.error.empty()) {
            Json::Value failure(Json::objectValue);
            failure["status"] = "error";
            failure["url"] = normalized->url;
            failure["error"] = response.error;
            failure["timed_out"] = response.timedOut;
            failure["timing_ms"] = makeFetchTimingJson(response);
            failure["robots"] = robotsInfo;
            failure["retryable"] = true;
            return failure;
        }

        if (response.notModified && existing.has_value()) {
            DocumentRow refreshed = *existing;
            refreshed.fetchedAt = nowMillis();
            refreshed.nextRefreshAt = computeNextRefreshAt(existing, false, true, false, static_cast<int>(response.statusCode));
            refreshed.statusCode = static_cast<int>(response.statusCode);
            upsertDocument(refreshed, {});

            Json::Value result(Json::objectValue);
            result["status"] = "not_modified";
            result["doc_id"] = existing->docId;
            result["url"] = existing->normalizedUrl;
            result["canonical_url"] = existing->canonicalUrl;
            result["title"] = existing->title;
            result["body_truncated"] = response.truncated;
            result["timing_ms"] = makeFetchTimingJson(response);
            result["robots"] = robotsInfo;
            result["retryable"] = false;
            return result;
        }

        if (!response.success) {
            Json::Value failure(Json::objectValue);
            failure["status"] = "error";
            failure["url"] = normalized->url;
            failure["http_status"] = static_cast<int>(response.statusCode);
            failure["error"] = "Fetch failed";
            failure["timed_out"] = response.timedOut;
            failure["timing_ms"] = makeFetchTimingJson(response);
            failure["robots"] = robotsInfo;
            failure["retryable"] = response.statusCode == 429 || response.statusCode >= 500;
            return failure;
        }

        std::string effectiveError;
        const auto effective = canonicalizeUrl(response.effectiveUrl.empty() ? normalized->url : response.effectiveUrl, "", effectiveError);
        if (!effective.has_value()) {
            return makeError("Fetched URL could not be normalized");
        }

        std::string redirectedSafety;
        if (!isPublicHttpHost(*effective, options.allowPrivateHosts, redirectedSafety)) {
            return makeError(redirectedSafety);
        }

        if (effective->authority != normalized->authority) {
            Json::Value redirectedRobotsInfo(Json::objectValue);
            HostState redirectedHost = ensureRobots(*effective, &redirectedRobotsInfo);
            const RobotsDefinition redirectedRobots = parseRobotsDefinition(redirectedHost.robotsBody, options.userAgent);
            if (!redirectedHost.robotsBody.empty() && !robotsAllowsPath(redirectedRobots, effective->pathWithQuery)) {
                Json::Value blocked(Json::objectValue);
                blocked["status"] = "blocked";
                blocked["reason"] = "redirected_url_disallowed_by_robots";
                blocked["url"] = effective->url;
                blocked["timing_ms"] = makeFetchTimingJson(response);
                blocked["robots"] = robotsInfo;
                blocked["redirected_robots"] = redirectedRobotsInfo;
                blocked["retryable"] = false;
                return blocked;
            }
            hostState = redirectedHost;
            robotsInfo["redirected"] = redirectedRobotsInfo;
        }

        const std::string loweredType = toLower(response.contentType);
        const bool isHtml = loweredType.find("text/html") != std::string::npos ||
                            loweredType.find("application/xhtml+xml") != std::string::npos ||
                            loweredType.empty();
        const bool isText = loweredType.find("text/plain") != std::string::npos;
        const bool isXml = loweredType.find("xml") != std::string::npos ||
                           startsWith(trimCopy(response.body), "<?xml") ||
                           toLower(response.body).find("<urlset") != std::string::npos ||
                           toLower(response.body).find("<sitemapindex") != std::string::npos;

        if (isXml && (toLower(response.body).find("<urlset") != std::string::npos ||
                      toLower(response.body).find("<sitemapindex") != std::string::npos)) {
            const auto sitemapUrls = parseSitemapUrls(response.body);
            int enqueued = 0;
            for (const auto& item : sitemapUrls) {
                std::string itemError;
                const auto sitemapTarget = canonicalizeUrl(item, effective->url, itemError);
                if (!sitemapTarget.has_value()) {
                    continue;
                }
                if (!allowCrossHost && sitemapTarget->host != effective->host) {
                    continue;
                }
                enqueueUrl(sitemapTarget->url, effective->url, 2, std::min(depth + 1, kMaxCrawlDepth), 0, 0);
                enqueued += 1;
            }

            Json::Value result(Json::objectValue);
            result["status"] = "sitemap_processed";
            result["url"] = effective->url;
            result["http_status"] = static_cast<int>(response.statusCode);
            result["body_truncated"] = response.truncated;
            result["timing_ms"] = makeFetchTimingJson(response);
            result["robots"] = robotsInfo;
            result["queued"] = enqueued;
            result["retryable"] = false;
            return result;
        }

        ExtractedDocument extracted;
        if (isHtml) {
            extracted = extractHtmlDocument(response.body);
        } else if (isText) {
            extracted.title = effective->host + effective->path;
            extracted.bodyText = normalizeWhitespace(response.body);
            extracted.canonicalUrl = effective->url;
        } else {
            Json::Value unsupported(Json::objectValue);
            unsupported["status"] = "unsupported";
            unsupported["url"] = effective->url;
            unsupported["content_type"] = response.contentType;
            unsupported["body_truncated"] = response.truncated;
            unsupported["timing_ms"] = makeFetchTimingJson(response);
            unsupported["robots"] = robotsInfo;
            unsupported["retryable"] = false;
            return unsupported;
        }

        if (!extracted.canonicalUrl.empty()) {
            std::string canonicalPageError;
            const auto normalizedCanonical = canonicalizeUrl(extracted.canonicalUrl, effective->url, canonicalPageError);
            if (normalizedCanonical.has_value()) {
                extracted.canonicalUrl = normalizedCanonical->url;
            } else {
                extracted.canonicalUrl = effective->url;
            }
        } else {
            extracted.canonicalUrl = effective->url;
        }

        const std::string effectiveMetaRobots = toLower(
            extracted.metaRobots.empty() ? response.xRobotsTag : extracted.metaRobots + " " + response.xRobotsTag);
        const std::string title = extracted.title.empty() ? effective->host + effective->path : extracted.title;
        const std::string bodyText = extracted.bodyText;
        const std::string textHash = sha256Hex(bodyText);
        const std::string simhash = simhashHex(computeSimhash(bodyText));

        DocumentRow row;
        if (existing.has_value()) {
            row = *existing;
        }
        row.sourceUrl = rawUrl;
        row.normalizedUrl = effective->url;
        row.canonicalUrl = extracted.canonicalUrl;
        row.host = effective->host;
        row.scheme = effective->scheme;
        row.title = title;
        row.headings = extracted.headings;
        row.description = extracted.description;
        row.lang = extracted.lang;
        row.contentType = response.contentType;
        row.statusCode = static_cast<int>(response.statusCode);
        row.fetchedAt = nowMillis();
        row.indexedAt = nowMillis();
        row.lastModified = response.lastModified;
        row.etag = response.etag;
        row.bodyText = bodyText;
        row.textHash = textHash;
        row.simhash = simhash;
        row.contentLength = static_cast<int>(bodyText.size());
        row.linkCount = static_cast<int>(extracted.links.size());
        row.metaRobots = effectiveMetaRobots;
        row.qualityScore = computeQualityScore(title, extracted.description, bodyText, tokenizeTerms(extracted.headings).size(), extracted.links.size());

        const bool changed = !existing.has_value() || existing->textHash != textHash;
        row.changeCount = existing.has_value() ? existing->changeCount + (changed ? 1 : 0) : (changed ? 1 : 0);
        row.lastChangeAt = changed ? nowMillis() : (existing.has_value() ? existing->lastChangeAt : nowMillis());
        row.nextRefreshAt = computeNextRefreshAt(existing, changed, false, false, static_cast<int>(response.statusCode));
        row.blocked = effectiveMetaRobots.find("noindex") != std::string::npos;
        row.blockedReason = row.blocked ? "meta_noindex" : "";

        const int existingDocId = existing.has_value() ? existing->docId : 0;
        if (!row.blocked) {
            if (const auto duplicate = findExactDuplicate(row.textHash, existingDocId); duplicate.has_value()) {
                row.duplicateOf = *duplicate;
                row.blocked = true;
                row.blockedReason = "exact_duplicate";
            } else if (const auto nearDuplicate = findNearDuplicate(row.host, row.simhash, existingDocId); nearDuplicate.has_value()) {
                row.nearDuplicateOf = *nearDuplicate;
                row.blocked = true;
                row.blockedReason = "near_duplicate";
            } else {
                row.duplicateOf = 0;
                row.nearDuplicateOf = 0;
            }
        }

        std::vector<ExtractedLink> normalizedLinks;
        normalizedLinks.reserve(extracted.links.size());
        const std::string baseHost = effective->host;
        for (const auto& link : extracted.links) {
            if (link.url.empty()) {
                continue;
            }
            std::string linkError;
            const auto normalizedLink = canonicalizeUrl(link.url, effective->url, linkError);
            if (!normalizedLink.has_value()) {
                continue;
            }
            if (looksLikeBinaryAsset(normalizedLink->path)) {
                continue;
            }
            normalizedLinks.push_back({normalizedLink->url, link.text});
        }

        const int docId = upsertDocument(row, normalizedLinks);
        if (docId <= 0) {
            return makeError("Failed to write indexed document");
        }

        int queued = 0;
        if (queueDiscovered && depth < kMaxCrawlDepth) {
            std::unordered_set<std::string> seen;
            for (const auto& sitemap : hostState.sitemapUrls) {
                std::string sitemapError;
                const auto normalizedSitemap = canonicalizeUrl(sitemap, effective->url, sitemapError);
                if (!normalizedSitemap.has_value()) {
                    continue;
                }
                if (!allowCrossHost && normalizedSitemap->host != baseHost) {
                    continue;
                }
                if (seen.insert(normalizedSitemap->url).second) {
                    enqueueUrl(normalizedSitemap->url, effective->url, 3, std::min(depth + 1, kMaxCrawlDepth), 0, 0);
                    ++queued;
                }
            }

            for (const auto& link : normalizedLinks) {
                if (queued >= maxQueueLinks) {
                    break;
                }
                std::string normalizedFilterError;
                const auto filtered = canonicalizeUrl(link.url, "", normalizedFilterError);
                if (!filtered.has_value()) {
                    continue;
                }
                if (!allowCrossHost && filtered->host != baseHost) {
                    continue;
                }
                if (seen.insert(filtered->url).second) {
                    enqueueUrl(filtered->url, effective->url, 1, std::min(depth + 1, kMaxCrawlDepth), 0, 0);
                    ++queued;
                }
            }
        }

        Json::Value result(Json::objectValue);
        result["status"] = row.blocked ? "indexed_blocked" : "indexed";
        result["doc_id"] = docId;
        result["url"] = row.normalizedUrl;
        result["canonical_url"] = row.canonicalUrl;
        result["title"] = row.title;
        result["description"] = row.description;
        result["lang"] = row.lang;
        result["http_status"] = static_cast<int>(response.statusCode);
        result["content_type"] = row.contentType;
        result["body_truncated"] = response.truncated;
        result["duplicate_of"] = row.duplicateOf;
        result["near_duplicate_of"] = row.nearDuplicateOf;
        result["blocked"] = row.blocked;
        result["blocked_reason"] = row.blockedReason;
        result["queued_links"] = queued;
        result["discovered_links"] = static_cast<int>(normalizedLinks.size());
        result["quality_score"] = row.qualityScore;
        result["fetched_at"] = static_cast<Json::Int64>(row.fetchedAt);
        result["timing_ms"] = makeFetchTimingJson(response);
        result["robots"] = robotsInfo;
        result["summary"] = firstNChars(row.bodyText, 400);
        result["retryable"] = false;
        return result;
    }

    Json::Value status() const {
        std::string error;
        if (!const_cast<Impl*>(this)->ensureInitialized(&error)) {
            return makeError(error);
        }

        Json::Value result(Json::objectValue);
        result["storage_root"] = options.storageRoot;
        result["database_path"] = options.databasePath;
        result["documents"] = Json::Value(Json::objectValue);
        result["queue"] = Json::Value(Json::objectValue);
        result["worker"] = Json::Value(Json::objectValue);
        result["live_search"] = Json::Value(Json::objectValue);

        {
            std::lock_guard<std::mutex> lock(mutex);
            if (!db) {
                return makeError("web search database is unavailable");
            }

            auto scalarInt = [&](const std::string& sql) -> Json::Int64 {
                SqliteStatement stmt(db, sql);
                if (!stmt || sqlite3_step(stmt.get()) != SQLITE_ROW) {
                    return 0;
                }
                return sqlite3_column_int64(stmt.get(), 0);
            };

            result["documents"]["total"] = scalarInt("SELECT COUNT(*) FROM documents;");
            result["documents"]["indexed"] = scalarInt(
                "SELECT COUNT(*) FROM documents "
                "WHERE blocked = 0 AND duplicate_of = 0 AND near_duplicate_of = 0 AND meta_robots NOT LIKE '%noindex%';");
            result["documents"]["blocked"] = scalarInt("SELECT COUNT(*) FROM documents WHERE blocked = 1;");
            result["documents"]["duplicates"] = scalarInt("SELECT COUNT(*) FROM documents WHERE duplicate_of != 0;");
            result["documents"]["near_duplicates"] = scalarInt("SELECT COUNT(*) FROM documents WHERE near_duplicate_of != 0;");
            result["documents"]["hosts"] = scalarInt("SELECT COUNT(DISTINCT host) FROM documents;");
            result["documents"]["stale"] = scalarInt("SELECT COUNT(*) FROM documents WHERE next_refresh_at > 0 AND next_refresh_at <= strftime('%s','now') * 1000;");
            result["queue"]["pending"] = scalarInt("SELECT COUNT(*) FROM fetch_queue;");
            result["queue"]["due_now"] = scalarInt("SELECT COUNT(*) FROM fetch_queue WHERE next_fetch_at <= strftime('%s','now') * 1000;");
        }

        {
            std::lock_guard<std::mutex> workerLock(workerMutex);
            result["worker"]["enabled"] = options.enableBackgroundWorker;
            result["worker"]["running"] = workerStarted && !stopWorker;
            result["worker"]["last_tick"] = static_cast<Json::Int64>(lastWorkerTick);
            result["worker"]["last_error"] = lastWorkerError;
        }

        result["live_search"]["enabled"] = options.enableLiveSearchFallback;
        result["live_search"]["base_url"] = options.liveSearchBaseUrl;
        result["live_search"]["bootstrap_count"] = options.liveSearchBootstrapCount;
        result["limits"]["max_body_bytes"] = options.maxBodyBytes;
        result["limits"]["http_timeout_ms"] = options.httpTimeoutMs;
        result["limits"]["robots_timeout_ms"] = options.robotsTimeoutMs;
        result["limits"]["low_speed_limit_bytes_per_sec"] = options.lowSpeedLimitBytesPerSec;
        result["limits"]["low_speed_time_seconds"] = options.lowSpeedTimeSeconds;

        return result;
    }

    Json::Value health() const {
        Json::Value health(Json::objectValue);
        health["available"] = true;
        health["storage_root"] = options.storageRoot;
        health["database_path"] = options.databasePath;
        health["live_search_enabled"] = options.enableLiveSearchFallback;
        health["live_search_base_url"] = options.liveSearchBaseUrl;
        health["http_timeout_ms"] = options.httpTimeoutMs;
        health["robots_timeout_ms"] = options.robotsTimeoutMs;
        health["max_body_bytes"] = options.maxBodyBytes;
        {
            std::lock_guard<std::mutex> lock(mutex);
            health["initialized"] = initialized;
            if (!initError.empty()) {
                health["available"] = false;
                health["error"] = initError;
            }
        }
        {
            std::lock_guard<std::mutex> workerLock(workerMutex);
            health["worker_running"] = workerStarted && !stopWorker;
            if (!lastWorkerError.empty()) {
                health["worker_error"] = lastWorkerError;
            }
        }
        return health;
    }
};

WebSearchTool::WebSearchTool(Options options)
    : impl_(std::make_unique<Impl>(std::move(options))) {}

WebSearchTool::~WebSearchTool() {
    if (impl_) {
        if (!impl_->stopWorkerLoop()) {
            impl_.release();
            return;
        }
        impl_->closeDatabase();
    }
}

bool WebSearchTool::initialize(std::string* errorOut) {
    return impl_->ensureInitialized(errorOut);
}

Json::Value WebSearchTool::search(const Json::Value& arguments) {
    return impl_->search(arguments);
}

Json::Value WebSearchTool::openResult(const Json::Value& arguments) {
    return impl_->openResult(arguments);
}

Json::Value WebSearchTool::fetchUrl(const Json::Value& arguments, std::function<bool()> cancelCheck) {
    return impl_->fetchUrl(arguments, 0, "", false, std::move(cancelCheck));
}

Json::Value WebSearchTool::relatedResults(const Json::Value& arguments) {
    return impl_->relatedResults(arguments);
}

Json::Value WebSearchTool::status() const {
    return impl_->status();
}

Json::Value WebSearchTool::health() const {
    return impl_->health();
}

void WebSearchTool::shutdown() {
    if (impl_) {
        impl_->allowForcedDetachOnShutdown.store(true, std::memory_order_relaxed);
        impl_->requestWorkerStop();
    }
}
