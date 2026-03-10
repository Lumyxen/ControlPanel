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

    std::string settingsPath;
    std::mutex  mutex;

public:
    Config(const std::string& path)
        : port(8080), host("0.0.0.0"),
          defaultModel("arcee-ai/trinity-large-preview:free"),
          fallbackMaxOutputTokens(8192), temperature(0.7),
          systemPrompt(""), lmStudioUrl("http://localhost:1234"),
          settingsPath(path) {}

    // ── Persistence ───────────────────────────────────────────────────────────

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

        if (cfg.isMember("fallbackMaxOutputTokens"))
            fallbackMaxOutputTokens = cfg["fallbackMaxOutputTokens"].asInt();
        else if (cfg.isMember("maxTokens"))
            fallbackMaxOutputTokens = cfg["maxTokens"].asInt();
    }

    void save() {
        std::lock_guard<std::mutex> lock(mutex);
        saveUnlocked();
    }

    void updateFromJson(const Json::Value& root) {
        std::lock_guard<std::mutex> lock(mutex);
        if (root.isMember("port"))                    port                    = root["port"].asInt();
        if (root.isMember("host"))                    host                    = root["host"].asString();
        if (root.isMember("defaultModel"))            defaultModel            = root["defaultModel"].asString();
        if (root.isMember("temperature"))             temperature             = root["temperature"].asDouble();
        if (root.isMember("systemPrompt"))            systemPrompt            = root["systemPrompt"].asString();
        if (root.isMember("lmStudioUrl"))             lmStudioUrl             = root["lmStudioUrl"].asString();
        if (root.isMember("fallbackMaxOutputTokens")) fallbackMaxOutputTokens = root["fallbackMaxOutputTokens"].asInt();
        else if (root.isMember("maxTokens"))          fallbackMaxOutputTokens = root["maxTokens"].asInt();
        saveUnlocked();
    }

    Json::Value toJson() {
        std::lock_guard<std::mutex> lock(mutex);
        Json::Value root;
        root["host"]                    = host;
        root["port"]                    = port;
        root["defaultModel"]            = defaultModel;
        root["fallbackMaxOutputTokens"] = fallbackMaxOutputTokens;
        root["temperature"]             = temperature;
        root["systemPrompt"]            = systemPrompt;
        root["lmStudioUrl"]             = lmStudioUrl;
        return root;
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    int         getPort()                    { std::lock_guard<std::mutex> l(mutex); return port; }
    std::string getHost()                    { std::lock_guard<std::mutex> l(mutex); return host; }
    std::string getLmStudioUrl()             { std::lock_guard<std::mutex> l(mutex); return lmStudioUrl; }

    /** Path to the MCP config file (sibling of settings.json, named mcp.json). */
    std::string getMcpConfigPath() const {
        // Replace "settings.json" suffix with "mcp.json"
        const std::string suffix = "settings.json";
        if (settingsPath.size() >= suffix.size() &&
                settingsPath.substr(settingsPath.size() - suffix.size()) == suffix)
            return settingsPath.substr(0, settingsPath.size() - suffix.size()) + "mcp.json";
        // Fallback: same directory
        auto sep = settingsPath.find_last_of("/\\");
        if (sep != std::string::npos)
            return settingsPath.substr(0, sep + 1) + "mcp.json";
        return "mcp.json";
    }

private:
    void saveUnlocked() {
        Json::Value root;
        root["host"]                    = host;
        root["port"]                    = port;
        root["defaultModel"]            = defaultModel;
        root["fallbackMaxOutputTokens"] = fallbackMaxOutputTokens;
        root["temperature"]             = temperature;
        root["systemPrompt"]            = systemPrompt;
        root["lmStudioUrl"]             = lmStudioUrl;

        std::ofstream file(settingsPath);
        if (file.is_open()) {
            Json::StreamWriterBuilder builder;
            builder["indentation"] = "    ";
            builder["precision"]   = 17;
            std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
            writer->write(root, &file);
        }
    }
};

#endif // CONFIG_H