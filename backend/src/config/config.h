#ifndef CONFIG_H
#define CONFIG_H

#include <string>
#include <fstream>
#include <json/json.h>
#include <stdexcept>
#include <mutex>

class Config {
private:
    int port;
    std::string host;
    std::string defaultModel;
    int fallbackMaxOutputTokens;
    double temperature;
    std::string systemPrompt;

    std::string settingsPath;
    std::mutex mutex;

public:
    Config(const std::string& path)
        : port(1024), host("0.0.0.0"), defaultModel("arcee-ai/trinity-large-preview:free"),
          fallbackMaxOutputTokens(8192), temperature(0.7), systemPrompt(""), settingsPath(path) {
    }

    void load() {
        std::lock_guard<std::mutex> lock(mutex);
        std::ifstream file(settingsPath);
        if (!file.is_open()) {
            saveUnlocked();
            return;
        }

        Json::Value config;
        try {
            file >> config;
        } catch (...) {
            saveUnlocked();
            return;
        }

        if (config.isMember("port"))         port         = config["port"].asInt();
        if (config.isMember("host"))         host         = config["host"].asString();
        if (config.isMember("defaultModel")) defaultModel = config["defaultModel"].asString();
        if (config.isMember("temperature"))  temperature  = config["temperature"].asDouble();
        if (config.isMember("systemPrompt")) systemPrompt = config["systemPrompt"].asString();

        // Prefer the new key; fall back to the old "maxTokens" key for existing configs.
        if (config.isMember("fallbackMaxOutputTokens"))
            fallbackMaxOutputTokens = config["fallbackMaxOutputTokens"].asInt();
        else if (config.isMember("maxTokens"))
            fallbackMaxOutputTokens = config["maxTokens"].asInt();
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
        if (root.isMember("fallbackMaxOutputTokens")) fallbackMaxOutputTokens = root["fallbackMaxOutputTokens"].asInt();
        // Also accept the old key name from clients that haven't updated yet.
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
        return root;
    }

    int         getPort()                   { std::lock_guard<std::mutex> lock(mutex); return port; }
    std::string getHost()                   { std::lock_guard<std::mutex> lock(mutex); return host; }
    std::string getDefaultModel()           { std::lock_guard<std::mutex> lock(mutex); return defaultModel; }
    int         getFallbackMaxOutputTokens(){ std::lock_guard<std::mutex> lock(mutex); return fallbackMaxOutputTokens; }
    double      getTemperature()            { std::lock_guard<std::mutex> lock(mutex); return temperature; }
    std::string getSystemPrompt()           { std::lock_guard<std::mutex> lock(mutex); return systemPrompt; }

private:
    void saveUnlocked() {
        Json::Value root;
        root["host"]                    = host;
        root["port"]                    = port;
        root["defaultModel"]            = defaultModel;
        root["fallbackMaxOutputTokens"] = fallbackMaxOutputTokens;
        root["temperature"]             = temperature;
        root["systemPrompt"]            = systemPrompt;

        std::ofstream file(settingsPath);
        if (file.is_open()) {
            Json::StreamWriterBuilder builder;
            builder["indentation"] = "    ";
            // Use full 17-digit precision so that values like 0.7 round-trip
            // correctly (stored as 0.69999999999999996) instead of being
            // truncated to a shorter decimal that maps to a different double.
            builder["precision"] = 17;
            std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
            writer->write(root, &file);
        }
    }
};

#endif // CONFIG_H