#ifndef WEB_SEARCH_TOOL_H
#define WEB_SEARCH_TOOL_H

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include <json/json.h>

class WebSearchTool {
public:
    struct Options {
        std::string storageRoot;
        std::string databasePath;
        std::string userAgent = "ctrlpanel-websearch/1.0";
        std::string liveSearchBaseUrl = "https://html.duckduckgo.com/html/";
        int maxBodyBytes = 2 * 1024 * 1024;
        int httpTimeoutMs = 8000;
        int robotsTimeoutMs = 2500;
        int lowSpeedLimitBytesPerSec = 128;
        int lowSpeedTimeSeconds = 5;
        int liveSearchBootstrapCount = 3;
        bool enableBackgroundWorker = true;
        bool enableLiveSearchFallback = true;
        bool allowPrivateHosts = false;
    };

    explicit WebSearchTool(Options options);
    ~WebSearchTool();

    WebSearchTool(const WebSearchTool&) = delete;
    WebSearchTool& operator=(const WebSearchTool&) = delete;

    bool initialize(std::string* errorOut = nullptr);

    Json::Value search(const Json::Value& arguments);
    Json::Value openResult(const Json::Value& arguments);
    Json::Value fetchUrl(const Json::Value& arguments, std::function<bool()> cancelCheck = nullptr);
    Json::Value relatedResults(const Json::Value& arguments);
    Json::Value status() const;
    Json::Value health() const;
    void shutdown();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

#endif // WEB_SEARCH_TOOL_H
