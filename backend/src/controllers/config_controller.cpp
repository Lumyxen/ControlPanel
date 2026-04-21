#include "controllers/config_controller.h"

#include "server/http_utils.h"

void handleGetSettings(const httplib::Request&, httplib::Response& res, Config& config) {
    setJson(res, config.toJson());
}

void handleUpdateSettings(const httplib::Request& req, httplib::Response& res, Config& config) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    config.updateFromJson(body);
    setJson(res, config.toJson());
}
