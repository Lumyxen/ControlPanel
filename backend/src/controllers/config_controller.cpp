#include "controllers/config_controller.h"

#include "controllers/auth_controller.h"
#include "controllers/vault_controller.h"
#include "server/http_utils.h"

namespace {

bool jsonValueDiffers(const Json::Value& lhs, const Json::Value& rhs) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, lhs) != Json::writeString(builder, rhs);
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
