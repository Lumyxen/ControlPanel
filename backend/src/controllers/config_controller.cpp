#include "controllers/config_controller.h"

#include "controllers/auth_controller.h"
#include "controllers/vault_controller.h"
#include "server/http_utils.h"

#include <filesystem>

namespace {

namespace fs = std::filesystem;

bool jsonValueDiffers(const Json::Value& lhs, const Json::Value& rhs) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, lhs) != Json::writeString(builder, rhs);
}

bool normalizeAndValidateAiToolsDefaultWorkingDirectory(Json::Value& body, httplib::Response& res) {
    constexpr const char* key = "aiToolsDefaultWorkingDirectory";
    if (!body.isMember(key)) {
        return true;
    }
    if (!body[key].isString()) {
        setJsonError(res, 400, "aiToolsDefaultWorkingDirectory must be a string");
        return false;
    }

    const std::string normalized = Config::normalizeAiToolsDefaultWorkingDirectory(body[key].asString());
    std::error_code ec;
    if (!fs::exists(normalized, ec) || ec) {
        setJsonError(res, 400, "Default AI working directory does not exist");
        return false;
    }
    if (!fs::is_directory(normalized, ec) || ec) {
        setJsonError(res, 400, "Default AI working directory must be a directory");
        return false;
    }

    body[key] = normalized;
    return true;
}

bool normalizeAndValidateWeatherSettings(Json::Value& body, httplib::Response& res) {
    if (body.isMember("weatherLocation")) {
        if (!body["weatherLocation"].isString()) {
            setJsonError(res, 400, "weatherLocation must be a string");
            return false;
        }
    }

    if (body.isMember("weatherMeasurementSystem")) {
        if (!body["weatherMeasurementSystem"].isString()) {
            setJsonError(res, 400, "weatherMeasurementSystem must be a string");
            return false;
        }
        const std::string system = body["weatherMeasurementSystem"].asString();
        if (system != "imperial" && system != "metric" && system != "mixed" && system != "custom") {
            setJsonError(res, 400, "weatherMeasurementSystem must be imperial, metric, mixed, or custom");
            return false;
        }
    }

    if (body.isMember("weatherCustomUnits")) {
        if (!body["weatherCustomUnits"].isObject()) {
            setJsonError(res, 400, "weatherCustomUnits must be an object");
            return false;
        }
        body["weatherCustomUnits"] = Config::normalizeWeatherCustomUnits(body["weatherCustomUnits"]);
    }

    return true;
}

} // namespace

void handleGetSettings(const httplib::Request&,
                       httplib::Response& res,
                       Config& config,
                       VaultStore& vaultStore) {
    Json::Value result = config.toJson();
    result["vaultConfigured"] = vaultStore.exists();
    setJson(res, result);
}

void handleUpdateSettings(const httplib::Request& req,
                          httplib::Response& res,
                          Config& config,
                          AuthStore&,
                          VaultStore& vaultStore) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }
    if (!normalizeAndValidateAiToolsDefaultWorkingDirectory(body, res)) {
        return;
    }
    if (!normalizeAndValidateWeatherSettings(body, res)) {
        return;
    }

    const Json::Value current = config.toJson();
    const bool changesPanelRateLimit =
        body.isMember("panelLoginRateLimitPerMinute") &&
        jsonValueDiffers(body["panelLoginRateLimitPerMinute"], current["panelLoginRateLimitPerMinute"]);
    const bool changesVaultRateLimit =
        body.isMember("vaultLoginRateLimitPerMinute") &&
        jsonValueDiffers(body["vaultLoginRateLimitPerMinute"], current["vaultLoginRateLimitPerMinute"]);
    const bool changesVaultIdleTimeout =
        body.isMember("vaultIdleTimeoutSeconds") &&
        jsonValueDiffers(body["vaultIdleTimeoutSeconds"], current["vaultIdleTimeoutSeconds"]);

    if (changesPanelRateLimit) {
        const std::string sessionToken = extractSessionToken(req);
        const std::string reauthToken = req.get_header_value("X-Panel-Reauth-Token");
        if (!validatePanelReauthToken(sessionToken, reauthToken)) {
            setJsonError(res, 401, "Fresh panel password reauthentication required");
            return;
        }
    }

    if ((changesVaultRateLimit || changesVaultIdleTimeout) &&
        vaultStore.exists() &&
        !vaultStore.validateAccessToken(extractVaultAccessToken(req), true)) {
        setJsonError(res, 401, "Fresh vault reauthentication required");
        return;
    }

    config.updateFromJson(body);
    Json::Value result = config.toJson();
    result["vaultConfigured"] = vaultStore.exists();
    setJson(res, result);
}
