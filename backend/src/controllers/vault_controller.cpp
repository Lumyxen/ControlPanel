#include "controllers/vault_controller.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <utility>

#include "controllers/auth_controller.h"
#include "server/http_utils.h"
#include "services/crypto_service.h"

namespace {

constexpr int kVaultStateVersion = 1;
constexpr auto kChallengeTtl = std::chrono::minutes(2);
constexpr auto kVaultAccessTokenTtl = std::chrono::minutes(10);
constexpr auto kSensitiveVaultAccessTtl = std::chrono::minutes(5);
constexpr auto kFailureWindow = std::chrono::seconds(60);

bool parseJsonText(const std::string& text, Json::Value& out) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(text);
    return Json::parseFromStream(reader, stream, &out, &errors);
}

Json::Value makeSuccess() {
    Json::Value result(Json::objectValue);
    result["success"] = true;
    return result;
}

std::string hexOrEmpty(const Json::Value& value) {
    return value.isString() ? value.asString() : "";
}

bool isHexDigit(char ch) {
    return (ch >= '0' && ch <= '9') ||
           (ch >= 'a' && ch <= 'f') ||
           (ch >= 'A' && ch <= 'F');
}

void pruneFailureWindow(Json::Value& failures) {
    if (!failures.isArray()) {
        failures = Json::Value(Json::arrayValue);
        return;
    }

    const Json::Int64 cutoff = static_cast<Json::Int64>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch() - kFailureWindow).count());
    Json::Value filtered(Json::arrayValue);
    for (const auto& value : failures) {
        if ((value.isInt64() || value.isUInt64() || value.isInt() || value.isUInt()) &&
            value.asInt64() >= cutoff) {
            filtered.append(value);
        }
    }
    failures = filtered;
}

Json::Int64 nowUnixMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

} // namespace

VaultStore::VaultStore(const std::string& path) : filePath_(path) {
    loadFromDisk();
}

Json::Value VaultStore::makeError(const std::string& message) {
    Json::Value error(Json::objectValue);
    error["error"] = message;
    return error;
}

bool VaultStore::isHexString(const std::string& value) {
    return !value.empty() &&
           value.size() % 2 == 0 &&
           std::all_of(value.begin(), value.end(), isHexDigit);
}

Json::Value VaultStore::sanitizeKdf(const Json::Value& source, int fallbackIterations) {
    Json::Value kdf(Json::objectValue);
    kdf["type"] = source.get("type", "pbkdf2").asString();
    kdf["hash"] = source.get("hash", "sha256").asString();
    kdf["iterations"] = std::max(1, source.get("iterations", fallbackIterations).asInt());
    kdf["salt"] = source.get("salt", "").asString();
    return kdf;
}

void VaultStore::loadFromDisk() {
    std::lock_guard<std::mutex> lock(mutex_);
    pruneExpiredChallengesUnlocked();
    pruneExpiredAccessTokensUnlocked();
}

Json::Value VaultStore::readRootUnlocked() const {
    std::ifstream file(filePath_);
    if (!file.is_open()) {
        Json::Value root(Json::objectValue);
        root["version"] = kVaultStateVersion;
        root["pinDevices"] = Json::Value(Json::objectValue);
        return root;
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    Json::Value root;
    if (!Json::parseFromStream(reader, file, &root, &errors) || !root.isObject()) {
        root = Json::Value(Json::objectValue);
    }

    if (!root.isMember("pinDevices") || !root["pinDevices"].isObject()) {
        root["pinDevices"] = Json::Value(Json::objectValue);
    }
    if (!root.isMember("version")) {
        root["version"] = kVaultStateVersion;
    }
    return root;
}

bool VaultStore::writeRootUnlocked(const Json::Value& root) const {
    const std::filesystem::path path(filePath_);
    std::error_code ec;
    std::filesystem::create_directories(path.parent_path(), ec);

    std::ofstream file(filePath_);
    if (!file.is_open()) {
        return false;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(root, &file);
    return true;
}

bool VaultStore::hasVaultUnlocked(const Json::Value& root) {
    return root.isObject() &&
           root.isMember("vault") &&
           root["vault"].isObject() &&
           root.isMember("vaultAuthKey") &&
           root["vaultAuthKey"].isString() &&
           !root["vaultAuthKey"].asString().empty() &&
           root.isMember("kdf") &&
           root["kdf"].isObject();
}

int VaultStore::currentRevisionUnlocked(const Json::Value& root) {
    if (!hasVaultUnlocked(root)) {
        return 0;
    }
    return root["vault"].get("revision", 0).asInt();
}

bool VaultStore::exists() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return hasVaultUnlocked(readRootUnlocked());
}

Json::Value VaultStore::getStatus(const std::string& deviceId) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const Json::Value root = readRootUnlocked();

    Json::Value result(Json::objectValue);
    result["setup"] = hasVaultUnlocked(root);
    result["revision"] = currentRevisionUnlocked(root);
    result["deviceId"] = deviceId;

    if (result["setup"].asBool()) {
        result["kdf"] = sanitizeKdf(root["kdf"]);
    }

    Json::Value pin(Json::objectValue);
    pin["configured"] = false;
    if (!deviceId.empty() &&
        root["pinDevices"].isObject() &&
        root["pinDevices"].isMember(deviceId) &&
        root["pinDevices"][deviceId].isObject()) {
        pin["configured"] = true;
        const Json::Value& auth = root["pinDevices"][deviceId]["auth"];
        if (auth.isObject() && auth.isMember("kdf")) {
            pin["kdf"] = sanitizeKdf(auth["kdf"], 310000);
        }
    }
    result["pin"] = pin;
    return result;
}

VaultStore::OperationResult VaultStore::setup(const Json::Value& kdfMetadata,
                                              const std::string& vaultAuthKeyHex,
                                              const Json::Value& encryptedVaultBlob,
                                              bool replaceExisting) {
    if (!isHexString(vaultAuthKeyHex) || !encryptedVaultBlob.isObject()) {
        return {400, makeError("Invalid vault setup payload")};
    }

    const Json::Value kdf = sanitizeKdf(kdfMetadata);
    if (!isHexString(kdf.get("salt", "").asString())) {
        return {400, makeError("Invalid vault KDF metadata")};
    }

    std::lock_guard<std::mutex> lock(mutex_);
    Json::Value root = readRootUnlocked();
    if (hasVaultUnlocked(root) && !replaceExisting) {
        return {409, makeError("Vault already configured")};
    }

    root["version"] = kVaultStateVersion;
    root["kdf"] = kdf;
    root["vaultAuthKey"] = vaultAuthKeyHex;
    root["vault"] = encryptedVaultBlob;
    root["pinDevices"] = Json::Value(Json::objectValue);
    challenges_.clear();
    accessTokens_.clear();

    if (!writeRootUnlocked(root)) {
        return {500, makeError("Failed to persist vault")};
    }

    Json::Value result = makeSuccess();
    result["revision"] = currentRevisionUnlocked(root);
    result["kdf"] = kdf;
    return {200, result};
}

void VaultStore::pruneExpiredChallengesUnlocked() const {
    const auto now = std::chrono::steady_clock::now();
    for (auto it = challenges_.begin(); it != challenges_.end();) {
        if (it->second.expiresAt <= now) {
            it = challenges_.erase(it);
        } else {
            ++it;
        }
    }
}

void VaultStore::pruneExpiredAccessTokensUnlocked() const {
    const auto now = std::chrono::steady_clock::now();
    for (auto it = accessTokens_.begin(); it != accessTokens_.end();) {
        if (it->second.expiresAt <= now) {
            it = accessTokens_.erase(it);
        } else {
            ++it;
        }
    }
}

VaultStore::OperationResult VaultStore::issueChallenge(const std::string& mode,
                                                       const std::string& deviceId) {
    std::lock_guard<std::mutex> lock(mutex_);
    const Json::Value root = readRootUnlocked();
    if (!hasVaultUnlocked(root)) {
        return {404, makeError("Vault not configured")};
    }

    if (mode != "master" && mode != "pin") {
        return {400, makeError("Unsupported unlock mode")};
    }

    if (mode == "pin") {
        if (deviceId.empty()) {
            return {400, makeError("Device ID is required for PIN unlock")};
        }
        if (!root["pinDevices"].isMember(deviceId)) {
            return {404, makeError("PIN unlock is not configured for this device")};
        }
    }

    pruneExpiredChallengesUnlocked();
    const std::string challengeId = CryptoService::toHex(CryptoService::randomBytes(32));
    challenges_[challengeId] = ChallengeInfo{
        mode,
        deviceId,
        std::chrono::steady_clock::now() + kChallengeTtl,
    };

    Json::Value result = makeSuccess();
    result["challenge"] = challengeId;
    result["mode"] = mode;
    result["deviceId"] = deviceId;
    result["expiresInSeconds"] = static_cast<int>(
        std::chrono::duration_cast<std::chrono::seconds>(kChallengeTtl).count());
    return {200, result};
}

bool VaultStore::consumeChallengeUnlocked(const std::string& challengeId,
                                          const std::string& expectedMode,
                                          const std::string& expectedDeviceId) const {
    pruneExpiredChallengesUnlocked();
    const auto it = challenges_.find(challengeId);
    if (it == challenges_.end()) {
        return false;
    }

    if (it->second.mode != expectedMode) {
        challenges_.erase(it);
        return false;
    }

    if (!expectedDeviceId.empty() && it->second.deviceId != expectedDeviceId) {
        challenges_.erase(it);
        return false;
    }

    challenges_.erase(it);
    return true;
}

bool VaultStore::validateProof(const std::vector<uint8_t>& key,
                               const std::string& challengeId,
                               const std::string& proofHex,
                               const std::string& prefix) const {
    if (key.empty() || !isHexString(proofHex)) {
        return false;
    }

    const std::vector<uint8_t> expected = CryptoService::hmacSha256(key, prefix + challengeId);
    return CryptoService::constantTimeEqualsHex(CryptoService::toHex(expected), proofHex);
}

std::string VaultStore::issueAccessTokenUnlocked(bool masterVerified) const {
    pruneExpiredAccessTokensUnlocked();
    const std::string token = CryptoService::toHex(CryptoService::randomBytes(32));
    const auto now = std::chrono::steady_clock::now();
    accessTokens_[token] = AccessTokenInfo{
        masterVerified,
        now,
        now + kVaultAccessTokenTtl,
    };
    return token;
}

VaultStore::OperationResult VaultStore::unlockWithStoredKey(
    const std::string& challengeId,
    const std::string& proofHex,
    const std::vector<uint8_t>& verifierKey,
    bool masterVerified,
    const Json::Value& root,
    const std::string& pepper) const {
    const std::string prefix = masterVerified ? "vault:master:" : "vault:pin:";
    if (!validateProof(verifierKey, challengeId, proofHex, prefix)) {
        return {401, makeError("Invalid unlock proof")};
    }

    Json::Value result = makeSuccess();
    result["vault"] = root["vault"];
    result["revision"] = currentRevisionUnlocked(root);
    result["vaultAccessToken"] = issueAccessTokenUnlocked(masterVerified);
    if (!pepper.empty()) {
        result["pepper"] = pepper;
    }
    return {200, result};
}

VaultStore::OperationResult VaultStore::unlockWithMaster(const std::string& challengeId,
                                                         const std::string& proofHex,
                                                         const std::string& attemptKey,
                                                         int rateLimitPerMinute) {
    const std::string limiterKey = attemptKey.empty() ? "vault-master" : attemptKey;
    if (masterUnlockRateLimiter_.isLimited(limiterKey, std::max(1, rateLimitPerMinute), kFailureWindow)) {
        return {429, makeError("Vault unlock rate limit exceeded")};
    }

    std::lock_guard<std::mutex> lock(mutex_);
    const Json::Value root = readRootUnlocked();
    if (!hasVaultUnlocked(root)) {
        return {404, makeError("Vault not configured")};
    }

    if (!consumeChallengeUnlocked(challengeId, "master")) {
        return {401, makeError("Invalid or expired challenge")};
    }

    const std::vector<uint8_t> verifierKey = CryptoService::fromHex(root["vaultAuthKey"].asString());
    OperationResult result = unlockWithStoredKey(challengeId, proofHex, verifierKey, true, root);
    if (result.httpStatus == 200) {
        masterUnlockRateLimiter_.clear(limiterKey);
    } else {
        masterUnlockRateLimiter_.recordFailure(limiterKey, kFailureWindow);
    }
    return result;
}

VaultStore::OperationResult VaultStore::reauthWithMaster(const std::string& challengeId,
                                                         const std::string& proofHex,
                                                         const std::string& attemptKey,
                                                         int rateLimitPerMinute) {
    OperationResult result = unlockWithMaster(challengeId, proofHex, attemptKey, rateLimitPerMinute);
    if (result.httpStatus != 200) {
        return result;
    }
    result.body.removeMember("vault");
    result.body.removeMember("revision");
    return result;
}

VaultStore::OperationResult VaultStore::unlockWithPin(const std::string& deviceId,
                                                      const std::string& challengeId,
                                                      const std::string& proofHex,
                                                      int rateLimitPerMinute) {
    std::lock_guard<std::mutex> lock(mutex_);
    Json::Value root = readRootUnlocked();
    if (!hasVaultUnlocked(root)) {
        return {404, makeError("Vault not configured")};
    }
    if (deviceId.empty()) {
        return {400, makeError("Device ID is required")};
    }
    if (!consumeChallengeUnlocked(challengeId, "pin", deviceId)) {
        return {401, makeError("Invalid or expired challenge")};
    }
    if (!root["pinDevices"].isMember(deviceId) || !root["pinDevices"][deviceId].isObject()) {
        return {404, makeError("PIN unlock is not configured for this device")};
    }

    Json::Value& device = root["pinDevices"][deviceId];
    pruneFailureWindow(device["failures"]);

    const Json::Value& auth = device["auth"];
    const std::string verifierHex = auth.get("verifier", "").asString();
    if (!isHexString(verifierHex)) {
        return {500, makeError("Stored PIN verifier is invalid")};
    }

    const std::vector<uint8_t> verifierKey = CryptoService::fromHex(verifierHex);
    OperationResult result = unlockWithStoredKey(
        challengeId,
        proofHex,
        verifierKey,
        false,
        root,
        device.get("pepper", "").asString());

    if (result.httpStatus == 200) {
        device["failures"] = Json::Value(Json::arrayValue);
        writeRootUnlocked(root);
        return result;
    }

    device["failures"].append(nowUnixMillis());
    pruneFailureWindow(device["failures"]);
    if (static_cast<int>(device["failures"].size()) >= std::max(1, rateLimitPerMinute)) {
        root["pinDevices"].removeMember(deviceId);
        if (!writeRootUnlocked(root)) {
            return {500, makeError("Failed to update PIN lockout state")};
        }
        Json::Value error = makeError("PIN unlock disabled after too many failed attempts");
        error["pinDisabled"] = true;
        return {401, error};
    }

    if (!writeRootUnlocked(root)) {
        return {500, makeError("Failed to update PIN attempt state")};
    }

    return result;
}

VaultStore::OperationResult VaultStore::saveVault(const Json::Value& encryptedVaultBlob,
                                                  int expectedRevision) {
    if (!encryptedVaultBlob.isObject()) {
        return {400, makeError("Vault blob is required")};
    }

    std::lock_guard<std::mutex> lock(mutex_);
    Json::Value root = readRootUnlocked();
    if (!hasVaultUnlocked(root)) {
        return {404, makeError("Vault not configured")};
    }

    const int currentRevision = currentRevisionUnlocked(root);
    if (expectedRevision != currentRevision) {
        Json::Value conflict = makeError("Vault revision conflict");
        conflict["revision"] = currentRevision;
        return {409, conflict};
    }

    const int nextRevision = encryptedVaultBlob.get("revision", 0).asInt();
    if (nextRevision != currentRevision + 1) {
        return {400, makeError("Vault revision must increment by one")};
    }

    root["vault"] = encryptedVaultBlob;
    if (!writeRootUnlocked(root)) {
        return {500, makeError("Failed to save vault")};
    }

    Json::Value result = makeSuccess();
    result["revision"] = nextRevision;
    return {200, result};
}

VaultStore::OperationResult VaultStore::registerPin(const std::string& deviceId,
                                                    const Json::Value& pinAuthKdf,
                                                    const std::string& pinAuthVerifierHex) {
    if (deviceId.empty() || !isHexString(pinAuthVerifierHex)) {
        return {400, makeError("Invalid PIN setup payload")};
    }

    Json::Value kdf = sanitizeKdf(pinAuthKdf, 310000);
    if (!isHexString(kdf.get("salt", "").asString())) {
        return {400, makeError("Invalid PIN KDF metadata")};
    }

    std::lock_guard<std::mutex> lock(mutex_);
    Json::Value root = readRootUnlocked();
    if (!hasVaultUnlocked(root)) {
        return {404, makeError("Vault not configured")};
    }

    Json::Value device(Json::objectValue);
    device["pepper"] = CryptoService::toHex(CryptoService::randomBytes(32));
    device["auth"]["kdf"] = kdf;
    device["auth"]["verifier"] = pinAuthVerifierHex;
    device["failures"] = Json::Value(Json::arrayValue);
    root["pinDevices"][deviceId] = device;

    if (!writeRootUnlocked(root)) {
        return {500, makeError("Failed to register PIN")};
    }

    Json::Value result = makeSuccess();
    result["deviceId"] = deviceId;
    result["pepper"] = device["pepper"];
    result["pin"]["configured"] = true;
    result["pin"]["kdf"] = kdf;
    return {200, result};
}

VaultStore::OperationResult VaultStore::deletePinSlot(const std::string& deviceId) {
    if (deviceId.empty()) {
        return {400, makeError("Device ID is required")};
    }

    std::lock_guard<std::mutex> lock(mutex_);
    Json::Value root = readRootUnlocked();
    if (!root["pinDevices"].isObject()) {
        root["pinDevices"] = Json::Value(Json::objectValue);
    }
    root["pinDevices"].removeMember(deviceId);

    if (!writeRootUnlocked(root)) {
        return {500, makeError("Failed to remove PIN registration")};
    }

    return {200, makeSuccess()};
}

bool VaultStore::validateAccessToken(const std::string& token,
                                     bool requireMasterFresh) const {
    if (token.empty()) {
        return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    pruneExpiredAccessTokensUnlocked();
    const auto it = accessTokens_.find(token);
    if (it == accessTokens_.end()) {
        return false;
    }

    if (!requireMasterFresh) {
        return true;
    }

    const auto now = std::chrono::steady_clock::now();
    return it->second.masterVerified &&
           (now - it->second.issuedAt) <= kSensitiveVaultAccessTtl;
}

std::string extractVaultAccessToken(const httplib::Request& req) {
    if (!req.has_header("X-Vault-Access-Token")) {
        return "";
    }
    return req.get_header_value("X-Vault-Access-Token");
}

std::string extractVaultDeviceId(const httplib::Request& req) {
    if (!req.has_header("X-Vault-Device-Id")) {
        return "";
    }
    return req.get_header_value("X-Vault-Device-Id");
}

bool requireVaultAccess(const httplib::Request& req,
                        httplib::Response& res,
                        const VaultStore& store,
                        bool requireMasterFresh) {
    if (!store.validateAccessToken(extractVaultAccessToken(req), requireMasterFresh)) {
        setJsonError(res, 401, requireMasterFresh ? "Fresh vault reauthentication required"
                                                  : "Vault access token is required");
        return false;
    }
    return true;
}

void handleGetVaultStatus(const httplib::Request& req, httplib::Response& res, VaultStore& store) {
    setJson(res, store.getStatus(extractVaultDeviceId(req)));
}

void handleSetupVault(const httplib::Request& req, httplib::Response& res, VaultStore& store) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.setup(
        body["kdf"],
        body.get("vaultAuthKey", "").asString(),
        body["vault"],
        body.get("replaceExisting", false).asBool());
    setJson(res, result.body, result.httpStatus);
}

void handleVaultUnlockChallenge(const httplib::Request& req, httplib::Response& res, VaultStore& store) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.issueChallenge(
        body.get("mode", "").asString(),
        body.get("deviceId", "").asString());
    setJson(res, result.body, result.httpStatus);
}

void handleVaultUnlockMaster(const httplib::Request& req,
                             httplib::Response& res,
                             VaultStore& store,
                             int rateLimitPerMinute) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.unlockWithMaster(
        body.get("challenge", "").asString(),
        body.get("proof", "").asString(),
        extractSessionToken(req),
        rateLimitPerMinute);
    setJson(res, result.body, result.httpStatus);
}

void handleVaultUnlockPin(const httplib::Request& req,
                          httplib::Response& res,
                          VaultStore& store,
                          int rateLimitPerMinute) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.unlockWithPin(
        body.get("deviceId", "").asString(),
        body.get("challenge", "").asString(),
        body.get("proof", "").asString(),
        rateLimitPerMinute);
    setJson(res, result.body, result.httpStatus);
}

void handlePutVault(const httplib::Request& req, httplib::Response& res, VaultStore& store) {
    if (!requireVaultAccess(req, res, store, false)) {
        return;
    }

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.saveVault(
        body["vault"],
        body.get("expectedRevision", -1).asInt());
    setJson(res, result.body, result.httpStatus);
}

void handleSetupVaultPin(const httplib::Request& req, httplib::Response& res, VaultStore& store) {
    if (!requireVaultAccess(req, res, store, true)) {
        return;
    }

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.registerPin(
        body.get("deviceId", "").asString(),
        body["pinAuthKdf"],
        body.get("pinAuthVerifier", "").asString());
    setJson(res, result.body, result.httpStatus);
}

void handleDeleteVaultPin(const httplib::Request& req,
                          httplib::Response& res,
                          VaultStore& store,
                          const std::string& deviceId) {
    if (!requireVaultAccess(req, res, store, true)) {
        return;
    }

    const VaultStore::OperationResult result = store.deletePinSlot(deviceId);
    setJson(res, result.body, result.httpStatus);
}

void handleVaultReauth(const httplib::Request& req,
                       httplib::Response& res,
                       VaultStore& store,
                       int rateLimitPerMinute) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const VaultStore::OperationResult result = store.reauthWithMaster(
        body.get("challenge", "").asString(),
        body.get("proof", "").asString(),
        extractSessionToken(req),
        rateLimitPerMinute);
    setJson(res, result.body, result.httpStatus);
}
