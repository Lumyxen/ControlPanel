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
    int maxTokens;
    double temperature;
    
    std::string settingsPath;
    std::mutex mutex;

public:
    Config(const std::string& path) 
        : port(1024), host("0.0.0.0"), defaultModel("stepfun/step-3.5-flash:free"), 
          maxTokens(2048), temperature(0.7), settingsPath(path) {
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

        if (config.isMember("port")) port = config["port"].asInt();
        if (config.isMember("host")) host = config["host"].asString();
        if (config.isMember("defaultModel")) defaultModel = config["defaultModel"].asString();
        if (config.isMember("maxTokens")) maxTokens = config["maxTokens"].asInt();
        if (config.isMember("temperature")) temperature = config["temperature"].asDouble();
    }

    void save() {
        std::lock_guard<std::mutex> lock(mutex);
        saveUnlocked();
    }
    
    void updateFromJson(const Json::Value& root) {
        std::lock_guard<std::mutex> lock(mutex);
        if (root.isMember("port")) port = root["port"].asInt();
        if (root.isMember("host")) host = root["host"].asString();
        if (root.isMember("defaultModel")) defaultModel = root["defaultModel"].asString();
        if (root.isMember("maxTokens")) maxTokens = root["maxTokens"].asInt();
        if (root.isMember("temperature")) temperature = root["temperature"].asDouble();
        saveUnlocked();
    }
    
    Json::Value toJson() {
        std::lock_guard<std::mutex> lock(mutex);
        Json::Value root;
        root["port"] = port;
        root["host"] = host;
        root["defaultModel"] = defaultModel;
        root["maxTokens"] = maxTokens;
        root["temperature"] = temperature;
        return root;
    }

    int getPort() { std::lock_guard<std::mutex> lock(mutex); return port; }
    std::string getHost() { std::lock_guard<std::mutex> lock(mutex); return host; }

private:
    void saveUnlocked() {
        Json::Value root;
        root["port"] = port;
        root["host"] = host;
        root["defaultModel"] = defaultModel;
        root["maxTokens"] = maxTokens;
        root["temperature"] = temperature;

        std::ofstream file(settingsPath);
        if(file.is_open()) {
            Json::StreamWriterBuilder builder;
            builder["indentation"] = "    ";
            std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
            writer->write(root, &file);
        }
    }
};

#endif // CONFIG_H