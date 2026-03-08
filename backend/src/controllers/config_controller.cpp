#include "controllers/config_controller.h"
#include <json/json.h>
#include <fstream>
#include <mutex>
#include <ctime>
#include <sstream>
#include <iostream>

namespace {
    bool parseJsonBody(const std::string& body, Json::Value& result) {
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(body);
        return Json::parseFromStream(reader, stream, &result, &errs);
    }
}

void handleGetSettings(const httplib::Request& req, httplib::Response& res, Config& config) {
    res.status = 200;
    res.set_content(config.toJson().toStyledString(), "application/json");
}

void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config) {
    Json::Value requestBody;
    if (!parseJsonBody(req.body, requestBody)) {
        res.status = 400;
        res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
        return;
    }

    config.updateFromJson(requestBody);

    res.status = 200;
    res.set_content(config.toJson().toStyledString(), "application/json");
}