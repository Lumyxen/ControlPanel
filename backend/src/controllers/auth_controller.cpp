#include "controllers/auth_controller.h"
#include <json/json.h>
#include <memory>
#include <cstdlib>

void handleAuthVerify(const httplib::Request& req, httplib::Response& res, const Config& config) {
    bool hasBackendKey = false;
    const char* envApiKey = std::getenv("OPENROUTER_API_KEY");
    if (envApiKey != nullptr && std::string(envApiKey).length() > 0) {
        hasBackendKey = true;
    }

    auto apiKeyIt = req.headers.find("x-api-key");
    
    if (apiKeyIt == req.headers.end() && !hasBackendKey) {
        res.status = 401;
        res.set_content("{\"error\": \"Missing API key\"}", "application/json");
        return;
    }

    if (!hasBackendKey && apiKeyIt != req.headers.end()) {
        std::string apiKey = apiKeyIt->second;
        if (apiKey.empty()) {
            res.status = 401;
            res.set_content("{\"error\": \"Invalid API key\"}", "application/json");
            return;
        }
    }

    Json::Value response;
    response["status"] = "valid";
    response["user"] = "admin";
    response["permissions"] = Json::Value(Json::arrayValue);
    response["permissions"].append("chat");
    response["permissions"].append("models");
    response["permissions"].append("config");

    res.status = 200;
    res.set_content(response.toStyledString(), "application/json");
}