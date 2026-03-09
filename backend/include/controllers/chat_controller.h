#ifndef CHAT_CONTROLLER_H
#define CHAT_CONTROLLER_H

#include "httplib.h"
#include <string>
#include <mutex>
#include <fstream>
#include <json/json.h>

class ChatStore {
private:
    std::string filePath;
    mutable std::mutex mutex;

    Json::Value makeDefault() const {
        Json::Value v;
        v["chats"]         = Json::Value(Json::arrayValue);
        v["currentChatId"] = "";
        v["pins"]          = Json::Value(Json::arrayValue);
        return v;
    }

public:
    explicit ChatStore(const std::string& path) : filePath(path) {}

    Json::Value load() const {
        std::lock_guard<std::mutex> lock(mutex);
        std::ifstream file(filePath);
        if (!file.is_open()) return makeDefault();

        Json::CharReaderBuilder builder;
        std::string errs;
        Json::Value root;
        if (!Json::parseFromStream(builder, file, &root, &errs)) return makeDefault();

        if (!root.isMember("chats"))         root["chats"]         = Json::Value(Json::arrayValue);
        if (!root.isMember("currentChatId")) root["currentChatId"] = "";
        if (!root.isMember("pins"))          root["pins"]          = Json::Value(Json::arrayValue);
        return root;
    }

    void save(const Json::Value& data) {
        std::lock_guard<std::mutex> lock(mutex);
        std::ofstream file(filePath);
        if (!file.is_open()) return;
        Json::StreamWriterBuilder builder;
        builder["indentation"] = "    ";
        std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
        writer->write(data, &file);
    }
};

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);

#endif // CHAT_CONTROLLER_H