#include "controllers/auth_controller.h"

#include <fstream>
#include <sstream>
#include <utility>

#include <openssl/rand.h>

#include "server/http_utils.h"

namespace {

constexpr const char* kAuthSentinel = "ctrlpanel-v1-auth-ok";

bool parseEncryptedJsonString(const std::string& json, Json::Value& out) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(json);
    return Json::parseFromStream(reader, stream, &out, &errors);
}

} // namespace

std::string extractSessionToken(const httplib::Request& req) {
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

AuthStore::AuthStore(const std::string& path) : filePath_(path) {
    loadFromDisk();
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

void AuthStore::loadFromDisk() {
    std::scoped_lock lock(mutex_, keyMutex_);

    const Json::Value root = readStateUnlocked();
    setup_ = false;
    salt_.clear();
    aesKey_.clear();

    if (root.isMember("salt") && root["salt"].isString() && !root["salt"].asString().empty()) {
        salt_ = CryptoService::fromHex(root["salt"].asString());
        setup_ = !salt_.empty();
    }

    if (root.isMember("aesKey") && root["aesKey"].isString() && !root["aesKey"].asString().empty()) {
        aesKey_ = CryptoService::fromHex(root["aesKey"].asString());
    }
}

bool AuthStore::isSetup() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return setup_;
}

bool AuthStore::setupPassword(const std::string& password, int iterations) {
    std::vector<uint8_t> salt(32);
    if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1) {
        return false;
    }

    const auto key = CryptoService::deriveKey(password, salt, iterations);
    const std::string sentinelEnvelope = CryptoService::encrypt(kAuthSentinel, key);

    Json::Value sentinel;
    if (!parseEncryptedJsonString(sentinelEnvelope, sentinel)) {
        return false;
    }

    Json::Value state(Json::objectValue);
    state["salt"] = CryptoService::toHex(salt);
    state["sentinel"] = sentinel;
    state["aesKey"] = CryptoService::toHex(key);

    {
        std::scoped_lock lock(mutex_, keyMutex_);
        if (setup_) {
            return false;
        }
        if (!writeStateUnlocked(state)) {
            return false;
        }

        salt_ = std::move(salt);
        aesKey_ = key;
        setup_ = true;
    }

    return true;
}

bool AuthStore::verifyPassword(const std::string& password) {
    Json::Value state;
    std::vector<uint8_t> salt;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!setup_ || salt_.empty()) {
            return false;
        }
        salt = salt_;
        state = readStateUnlocked();
    }

    if (!state.isMember("sentinel") || !state["sentinel"].isObject()) {
        return false;
    }

    const auto key = CryptoService::deriveKey(password, salt);
    try {
        if (CryptoService::decryptWithKey(state["sentinel"], key) != kAuthSentinel) {
            return false;
        }
    } catch (...) {
        return false;
    }

    state["aesKey"] = CryptoService::toHex(key);

    {
        std::scoped_lock lock(mutex_, keyMutex_);
        if (!writeStateUnlocked(state)) {
            return false;
        }
        aesKey_ = key;
    }

    return true;
}

std::vector<uint8_t> AuthStore::getAesKey() {
    std::lock_guard<std::mutex> lock(keyMutex_);
    return aesKey_;
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
    Json::Value result;
    result["setup"] = store.isSetup();
    setJson(res, result);
}

void handleSetupAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string password = body.get("password", "").asString();
    const int iterations = body.get("iterations", 310000).asInt();

    if (password.empty()) {
        setJsonError(res, 400, "Password is required");
        return;
    }

    if (store.isSetup()) {
        setJsonError(res, 409, "Password already set");
        return;
    }

    if (!store.setupPassword(password, iterations)) {
        setJsonError(res, 500, "Failed to setup password");
        return;
    }

    Json::Value result;
    result["success"] = true;
    result["sessionToken"] = SessionManager::instance().createSession();
    setJson(res, result);
}

void handleLoginAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    const std::string password = body.get("password", "").asString();
    if (password.empty()) {
        setJsonError(res, 400, "Password is required");
        return;
    }

    if (!store.verifyPassword(password)) {
        setJsonError(res, 401, "Incorrect password");
        return;
    }

    Json::Value result;
    result["success"] = true;
    result["sessionToken"] = SessionManager::instance().createSession();
    setJson(res, result);
}

void handleLogoutAuth(const httplib::Request& req, httplib::Response& res) {
    const std::string token = extractSessionToken(req);
    if (!token.empty()) {
        SessionManager::instance().revoke(token);
    }

    Json::Value result;
    result["success"] = true;
    setJson(res, result);
}

void handleValidateAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store) {
    std::string token;
    if (req.has_header("X-Session-Token")) {
        token = req.get_header_value("X-Session-Token");
    } else if (req.has_param("token")) {
        token = req.get_param_value("token");
    }

    if (!token.empty() && SessionManager::instance().isValid(token) && !store.getAesKey().empty()) {
        Json::Value result;
        result["valid"] = true;
        setJson(res, result);
        return;
    }

    setJsonError(res, 401, "Invalid session");
}
