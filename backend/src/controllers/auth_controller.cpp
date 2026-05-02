#include "controllers/auth_controller.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <utility>

#include "controllers/chat_controller.h"
#include "server/http_utils.h"

namespace {

constexpr const char* kAuthSentinel = "ctrlpanel-v1-auth-ok";
constexpr int kLegacyIterations = 310000;
constexpr int kDefaultIterations = 600000;
constexpr int kAuthStateVersion = 2;
constexpr auto kPanelReauthTtl = std::chrono::minutes(5);

struct PanelReauthInfo {
    std::string sessionToken;
    std::chrono::steady_clock::time_point expiresAt;
};

std::mutex gPanelReauthMutex;
std::unordered_map<std::string, PanelReauthInfo> gPanelReauthTokens;

bool parseEncryptedJsonString(const std::string& json, Json::Value& out) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(json);
    return Json::parseFromStream(reader, stream, &out, &errors);
}

std::string trimAscii(std::string value) {
    const auto notSpace = [](unsigned char ch) { return !std::isspace(ch); };
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), notSpace));
    value.erase(std::find_if(value.rbegin(), value.rend(), notSpace).base(), value.end());
    return value;
}

bool startsWithBearer(const std::string& value) {
    if (value.size() < 7) {
        return false;
    }
    const std::string prefix = value.substr(0, 6);
    return std::equal(prefix.begin(), prefix.end(), "Bearer",
                      [](char lhs, char rhs) {
                          return std::tolower(static_cast<unsigned char>(lhs)) ==
                                 std::tolower(static_cast<unsigned char>(rhs));
                      }) &&
           std::isspace(static_cast<unsigned char>(value[6])) != 0;
}

void pruneExpiredPanelReauthTokensUnlocked() {
    const auto now = std::chrono::steady_clock::now();
    for (auto it = gPanelReauthTokens.begin(); it != gPanelReauthTokens.end();) {
        if (it->second.expiresAt <= now) {
            it = gPanelReauthTokens.erase(it);
        } else {
            ++it;
        }
    }
}

} // namespace

std::string extractBearerToken(const httplib::Request& req) {
    if (!req.has_header("Authorization")) {
        return "";
    }

    const std::string header = req.get_header_value("Authorization");
    if (!startsWithBearer(header)) {
        return "";
    }

    return trimAscii(header.substr(7));
}

std::string extractSessionToken(const httplib::Request& req) {
    const std::string bearer = extractBearerToken(req);
    if (!bearer.empty()) {
        return bearer;
    }

    if (req.has_header("X-Session-Token")) {
        return req.get_header_value("X-Session-Token");
    }

    if (req.has_param("token")) {
        return req.get_param_value("token");
    }

    Json::Value body;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(req.body);
    if (Json::parseFromStream(reader, stream, &body, &errors) && body.isMember("sessionToken")) {
        return body["sessionToken"].asString();
    }

    return "";
}

bool requireValidSession(const httplib::Request& req, httplib::Response& res, AuthStore* store) {
    const std::string token = extractSessionToken(req);
    if (token.empty() || !SessionManager::instance().isValid(token)) {
        setJsonError(res, 401, "Not authenticated");
        return false;
    }

    if (store && store->getAesKey().empty()) {
        setJsonError(res, 401, "Not authenticated");
        return false;
    }

    return true;
}

std::string issuePanelReauthToken(const std::string& sessionToken) {
    if (sessionToken.empty()) {
        return "";
    }

    const std::string token = CryptoService::toHex(CryptoService::randomBytes(32));
    std::lock_guard<std::mutex> lock(gPanelReauthMutex);
    pruneExpiredPanelReauthTokensUnlocked();
    gPanelReauthTokens[token] = PanelReauthInfo{
        sessionToken,
        std::chrono::steady_clock::now() + kPanelReauthTtl,
    };
    return token;
}

bool validatePanelReauthToken(const std::string& sessionToken,
                              const std::string& reauthToken) {
    if (sessionToken.empty() || reauthToken.empty()) {
        return false;
    }

    std::lock_guard<std::mutex> lock(gPanelReauthMutex);
    pruneExpiredPanelReauthTokensUnlocked();

    const auto it = gPanelReauthTokens.find(reauthToken);
    if (it == gPanelReauthTokens.end() || it->second.sessionToken != sessionToken) {
        return false;
    }

    gPanelReauthTokens.erase(it);
    return true;
}

AuthStore::AuthStore(const std::string& path) : filePath_(path) {
    loadFromDisk();
}

AuthStore::KdfConfig AuthStore::kdfFromJson(const Json::Value& root) {
    KdfConfig kdf;
    const Json::Value& kdfNode = root.isMember("kdf") && root["kdf"].isObject()
        ? root["kdf"]
        : Json::Value(Json::objectValue);

    if (kdfNode.isObject()) {
        if (kdfNode.isMember("type") && kdfNode["type"].isString()) {
            kdf.type = kdfNode["type"].asString();
        }
        if (kdfNode.isMember("hash") && kdfNode["hash"].isString()) {
            kdf.hash = kdfNode["hash"].asString();
        }
        if (kdfNode.isMember("iterations")) {
            kdf.iterations = std::max(1, kdfNode["iterations"].asInt());
        }
        if (kdfNode.isMember("salt") && kdfNode["salt"].isString()) {
            kdf.salt = CryptoService::fromHex(kdfNode["salt"].asString());
        }
    }

    if (kdf.salt.empty() && root.isMember("salt") && root["salt"].isString()) {
        kdf.salt = CryptoService::fromHex(root["salt"].asString());
        kdf.type = "pbkdf2";
        kdf.hash = "sha256";
        kdf.iterations = kLegacyIterations;
    }

    return kdf;
}

Json::Value AuthStore::kdfToJson(const KdfConfig& kdf) {
    Json::Value value(Json::objectValue);
    value["type"] = kdf.type;
    value["hash"] = kdf.hash;
    value["iterations"] = kdf.iterations;
    value["salt"] = CryptoService::toHex(kdf.salt);
    return value;
}

Json::Value AuthStore::readStateUnlocked() const {
    std::ifstream file(filePath_);
    if (!file.is_open()) {
        return Json::Value(Json::objectValue);
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    Json::Value root;
    if (!Json::parseFromStream(reader, file, &root, &errors) || !root.isObject()) {
        return Json::Value(Json::objectValue);
    }

    return root;
}

bool AuthStore::writeStateUnlocked(const Json::Value& state) const {
    std::ofstream file(filePath_);
    if (!file.is_open()) {
        return false;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(state, &file);
    return true;
}

Json::Value AuthStore::buildStateUnlocked(const KdfConfig& kdf,
                                          const std::vector<uint8_t>& key) const {
    Json::Value sentinel;
    if (!parseEncryptedJsonString(CryptoService::encrypt(kAuthSentinel, key), sentinel)) {
        return Json::Value(Json::nullValue);
    }

    Json::Value state(Json::objectValue);
    state["version"] = kAuthStateVersion;
    state["kdf"] = kdfToJson(kdf);
    state["sentinel"] = sentinel;
    return state;
}

AuthStore::KdfConfig AuthStore::currentKdfUnlocked() const {
    return kdf_;
}

bool AuthStore::isLegacyKdfUnlocked() const {
    return kdf_.type != "pbkdf2" ||
           kdf_.hash != "sha256" ||
           kdf_.iterations != kDefaultIterations;
}

void AuthStore::loadFromDisk() {
    std::scoped_lock lock(mutex_, keyMutex_);

    const Json::Value root = readStateUnlocked();
    kdf_ = kdfFromJson(root);
    aesKey_.clear();
    setup_ = root.isMember("sentinel") && root["sentinel"].isObject() && !kdf_.salt.empty();
}

bool AuthStore::isSetup() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return setup_;
}

Json::Value AuthStore::getKdfMetadata() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return kdfToJson(kdf_);
}

bool AuthStore::setupPassword(const std::string& password, int iterations) {
    KdfConfig nextKdf;
    nextKdf.type = "pbkdf2";
    nextKdf.hash = "sha256";
    nextKdf.iterations = std::max(1, iterations);
    nextKdf.salt = CryptoService::randomBytes(32);

    const auto key = CryptoService::deriveKey(password, nextKdf.salt, nextKdf.iterations);
    const Json::Value state = buildStateUnlocked(nextKdf, key);
    if (!state.isObject()) {
        return false;
    }

    {
        std::scoped_lock lock(mutex_, keyMutex_);
        if (setup_) {
            return false;
        }
        if (!writeStateUnlocked(state)) {
            return false;
        }

        kdf_ = std::move(nextKdf);
        aesKey_ = key;
        setup_ = true;
    }

    return true;
}

AuthStore::VerificationResult AuthStore::verifyPassword(const std::string& password) {
    VerificationResult result;
    Json::Value state;
    KdfConfig currentKdf;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!setup_ || kdf_.salt.empty()) {
            return result;
        }
        currentKdf = currentKdfUnlocked();
        state = readStateUnlocked();
    }

    if (!state.isMember("sentinel") || !state["sentinel"].isObject()) {
        return result;
    }

    const auto currentKey = CryptoService::deriveKey(password, currentKdf.salt, currentKdf.iterations);
    try {
        if (CryptoService::decryptWithKey(state["sentinel"], currentKey) != kAuthSentinel) {
            return result;
        }
    } catch (...) {
        return result;
    }

    result.success = true;

    if (currentKdf.type != "pbkdf2" ||
        currentKdf.hash != "sha256" ||
        currentKdf.iterations != kDefaultIterations) {
        KdfConfig nextKdf;
        nextKdf.type = "pbkdf2";
        nextKdf.hash = "sha256";
        nextKdf.iterations = kDefaultIterations;
        nextKdf.salt = CryptoService::randomBytes(32);

        result.kdfUpgraded = true;
        result.previousKey = currentKey;
        result.nextKey = CryptoService::deriveKey(password, nextKdf.salt, nextKdf.iterations);
        result.nextKdfMetadata = kdfToJson(nextKdf);

        std::lock_guard<std::mutex> keyLock(keyMutex_);
        aesKey_ = currentKey;
        return result;
    }

    {
        std::lock_guard<std::mutex> keyLock(keyMutex_);
        aesKey_ = currentKey;
    }

    if (state.isMember("aesKey") || state.isMember("salt") || !state.isMember("version")) {
        const Json::Value cleanedState = buildStateUnlocked(currentKdf, currentKey);
        if (cleanedState.isObject()) {
            std::lock_guard<std::mutex> lock(mutex_);
            writeStateUnlocked(cleanedState);
        }
    }

    return result;
}

bool AuthStore::commitKdfUpgrade(const Json::Value& nextKdfMetadata,
                                 const std::vector<uint8_t>& nextKey) {
    KdfConfig nextKdf = kdfFromJson(Json::Value(Json::objectValue));
    if (!nextKdfMetadata.isObject()) {
        return false;
    }

    Json::Value wrapper(Json::objectValue);
    wrapper["kdf"] = nextKdfMetadata;
    nextKdf = kdfFromJson(wrapper);
    if (nextKdf.salt.empty() || nextKey.empty()) {
        return false;
    }

    const Json::Value nextState = buildStateUnlocked(nextKdf, nextKey);
    if (!nextState.isObject()) {
        return false;
    }

    std::scoped_lock lock(mutex_, keyMutex_);
    if (!writeStateUnlocked(nextState)) {
        return false;
    }

    kdf_ = std::move(nextKdf);
    aesKey_ = nextKey;
    setup_ = true;
    return true;
}

std::vector<uint8_t> AuthStore::getAesKey() {
    std::lock_guard<std::mutex> lock(keyMutex_);
    return aesKey_;
}

void AuthStore::clearLoadedKey() {
    std::lock_guard<std::mutex> lock(keyMutex_);
    aesKey_.clear();
}

std::string AuthStore::encryptData(const std::string& plaintext) {
    const auto key = getAesKey();
    if (key.empty()) {
        throw std::runtime_error("No AES key loaded");
    }
    return CryptoService::encrypt(plaintext, key);
}

std::string AuthStore::decryptData(const Json::Value& encrypted) {
    const auto key = getAesKey();
    if (key.empty()) {
        throw std::runtime_error("No AES key loaded");
    }
    return CryptoService::decryptWithKey(encrypted, key);
}

void handleGetAuth(const httplib::Request&, httplib::Response& res, AuthStore& store) {
    Json::Value result(Json::objectValue);
    result["setup"] = store.isSetup();
    result["kdf"] = store.getKdfMetadata();
    setJson(res, result);
}

void handleSetupAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string password = body.get("password", "").asString();
    if (password.empty()) {
        setJsonError(res, 400, "Password is required");
        return;
    }

    if (store.isSetup()) {
        setJsonError(res, 409, "Password already set");
        return;
    }

    if (!store.setupPassword(password, kDefaultIterations)) {
        setJsonError(res, 500, "Failed to setup password");
        return;
    }

    Json::Value result(Json::objectValue);
    result["success"] = true;
    result["kdf"] = store.getKdfMetadata();
    result["sessionToken"] = SessionManager::instance().createSession();
    setJson(res, result);
}

void handleLoginAuth(const httplib::Request& req,
                     httplib::Response& res,
                     AuthStore& store,
                     ChatStore* chatStore) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string password = body.get("password", "").asString();
    if (password.empty()) {
        setJsonError(res, 400, "Password is required");
        return;
    }

    AuthStore::VerificationResult verification = store.verifyPassword(password);
    if (!verification.success) {
        setJsonError(res, 401, "Incorrect password");
        return;
    }

    if (verification.kdfUpgraded) {
        if (chatStore &&
            !chatStore->rotateEncryptionKey(verification.previousKey, verification.nextKey)) {
            store.clearLoadedKey();
            setJsonError(res, 500, "Failed to migrate encrypted chat data");
            return;
        }

        if (!store.commitKdfUpgrade(verification.nextKdfMetadata, verification.nextKey)) {
            store.clearLoadedKey();
            setJsonError(res, 500, "Failed to upgrade password metadata");
            return;
        }
    }

    Json::Value result(Json::objectValue);
    result["success"] = true;
    result["kdf"] = store.getKdfMetadata();
    result["sessionToken"] = SessionManager::instance().createSession();
    setJson(res, result);
}

void handleLogoutAuth(const httplib::Request& req, httplib::Response& res) {
    const std::string token = extractSessionToken(req);
    if (!token.empty()) {
        SessionManager::instance().revoke(token);
    }

    Json::Value result(Json::objectValue);
    result["success"] = true;
    setJson(res, result);
}

void handleValidateAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    const std::string token = extractSessionToken(req);
    if (!token.empty() && SessionManager::instance().isValid(token) && !store.getAesKey().empty()) {
        Json::Value result(Json::objectValue);
        result["valid"] = true;
        setJson(res, result);
        return;
    }

    setJsonError(res, 401, "Invalid session");
}

void handlePanelReauthAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    if (!requireValidSession(req, res, &store)) {
        return;
    }

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string password = body.get("password", "").asString();
    if (password.empty()) {
        setJsonError(res, 400, "Password is required");
        return;
    }

    const AuthStore::VerificationResult verification = store.verifyPassword(password);
    if (!verification.success || verification.kdfUpgraded) {
        setJsonError(res, 401, "Incorrect password");
        return;
    }

    Json::Value result(Json::objectValue);
    result["success"] = true;
    result["reauthToken"] = issuePanelReauthToken(extractSessionToken(req));
    setJson(res, result);
}
