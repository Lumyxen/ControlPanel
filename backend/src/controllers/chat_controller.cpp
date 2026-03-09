#include "controllers/chat_controller.h"
#include <json/json.h>
#include <sstream>
#include <iostream>

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    try {
        auto data = store.load();
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        res.status = 200;
        res.set_content(Json::writeString(writer, data), "application/json");
    } catch (const std::exception& e) {
        std::cerr << "[ChatController] GET /api/chats error: " << e.what() << "\n";
        res.status = 500;
        res.set_content("{\"error\": \"Internal server error\"}", "application/json");
    }
}

void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    try {
        Json::Value requestBody;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &requestBody, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }
        store.save(requestBody);
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        res.status = 200;
        res.set_content(Json::writeString(writer, requestBody), "application/json");
    } catch (const std::exception& e) {
        std::cerr << "[ChatController] PUT /api/chats error: " << e.what() << "\n";
        res.status = 500;
        res.set_content("{\"error\": \"Internal server error\"}", "application/json");
    }
}