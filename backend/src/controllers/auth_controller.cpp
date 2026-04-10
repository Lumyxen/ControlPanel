// backend/src/controllers/auth_controller.cpp
#include "controllers/auth_controller.h"
#include <openssl/rand.h>
#include <fstream>
#include <iostream>
#include <sstream>

// Forward declarations from main.cpp
void addSecurityHeaders(httplib::Response& res);
void addCorsHeaders(httplib::Response& res, const httplib::Request& req);

AuthStore::AuthStore(const std::string& path) : filePath_(path) {
    loadFromDisk();
}

void AuthStore::loadFromDisk() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ifstream file(filePath_);
    if (!file.is_open()) {
        setup_ = false;
        return;
    }

    Json::CharReaderBuilder builder;
    std::string errs;
    Json::Value root;
    if (!Json::parseFromStream(builder, file, &root, &errs)) {
        setup_ = false;
        return;
    }

    if (root.isMember("salt") && root["salt"].isString() && !root["salt"].asString().empty()) {
        salt_ = CryptoService::fromHex(root["salt"].asString());
        setup_ = true;
    } else {
        setup_ = false;
    }

    // Restore AES key if persisted on disk
    if (root.isMember("aesKey") && root["aesKey"].isString() && !root["aesKey"].asString().empty()) {
        aesKey_ = CryptoService::fromHex(root["aesKey"].asString());
    }
}

bool AuthStore::isSetup() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return setup_;
}

bool AuthStore::setupPassword(const std::string& password, int iterations) {
    // Generate random 32-byte salt
    salt_.resize(32);
    if (RAND_bytes(salt_.data(), 32) != 1) {
        std::cerr << "[AuthStore] RAND_bytes failed for salt\n";
        return false;
    }

    auto key = CryptoService::deriveKey(password, salt_, iterations);

    // Encrypt sentinel to verify
    std::string sentinelJson = CryptoService::encrypt(
        "ctrlpanel-v1-auth-ok", key);

    // Parse sentinel
    Json::CharReaderBuilder rb;
    std::string errs;
    Json::Value sentinel;
    std::istringstream ss(sentinelJson);
    if (!Json::parseFromStream(rb, ss, &sentinel, &errs)) return false;

    // Save salt + sentinel + AES key to disk
    {
        std::lock_guard<std::mutex> lock(mutex_);
        Json::Value data;
        data["salt"] = CryptoService::toHex(salt_);
        data["sentinel"] = sentinel;
        data["aesKey"] = CryptoService::toHex(key);

        std::ofstream file(filePath_);
        if (!file.is_open()) return false;

        Json::StreamWriterBuilder wb;
        wb["indentation"] = "    ";
        std::unique_ptr<Json::StreamWriter> writer(wb.newStreamWriter());
        writer->write(data, &file);

        setup_ = true;
    }

    // Store the key in memory
    {
        std::lock_guard<std::mutex> lock(keyMutex_);
        aesKey_ = key;
        std::cout << "[AuthStore] AES key stored (" << key.size() << " bytes)\n";
    }

    std::cout << "[AuthStore] Password setup completed\n";
    return true;
}

bool AuthStore::verifyPassword(const std::string& password) {
    std::vector<uint8_t> salt;
    bool isSetup;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        salt = salt_;
        isSetup = setup_;
    }

    if (!isSetup || salt.empty()) return false;

    auto key = CryptoService::deriveKey(password, salt);

    // Load sentinel from disk
    Json::CharReaderBuilder rb;
    std::string errs;
    Json::Value root;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::ifstream file(filePath_);
        if (!file.is_open()) return false;
        if (!Json::parseFromStream(rb, file, &root, &errs)) return false;
    }

    if (!root.isMember("sentinel") || !root["sentinel"].isObject()) return false;

    try {
        std::string decrypted = CryptoService::decryptWithKey(root["sentinel"], key);
        if (decrypted != "ctrlpanel-v1-auth-ok") return false;
    } catch (const std::exception&) {
        return false;
    }

    // Store the key in memory
    {
        std::lock_guard<std::mutex> lock(keyMutex_);
        aesKey_ = key;
    }

    // Persist the AES key to disk so it survives server restarts
    {
        std::lock_guard<std::mutex> lock(mutex_);
        Json::CharReaderBuilder rb2;
        std::string errs2;
        Json::Value root;
        std::ifstream inFile(filePath_);
        if (Json::parseFromStream(rb2, inFile, &root, &errs2)) {
            root["aesKey"] = CryptoService::toHex(key);
            std::ofstream outFile(filePath_);
            if (outFile.is_open()) {
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "    ";
                std::unique_ptr<Json::StreamWriter> writer(wb.newStreamWriter());
                writer->write(root, &outFile);
            }
        }
    }

    std::cout << "[AuthStore] Login verified\n";
    return true;
}

std::vector<uint8_t> AuthStore::getAesKey() {
    std::lock_guard<std::mutex> lock(keyMutex_);
    return aesKey_;
}

std::string AuthStore::encryptData(const std::string& plaintext) {
    std::vector<uint8_t> key;
    {
        std::lock_guard<std::mutex> lock(keyMutex_);
        key = aesKey_;
    }
    if (key.empty()) {
        throw std::runtime_error("No AES key — not authenticated");
    }
    return CryptoService::encrypt(plaintext, key);
}

std::string AuthStore::decryptData(const Json::Value& encrypted) {
    std::vector<uint8_t> key;
    {
        std::lock_guard<std::mutex> lock(keyMutex_);
        key = aesKey_;
    }
    if (key.empty()) {
        throw std::runtime_error("No AES key — not authenticated");
    }
    return CryptoService::decryptWithKey(encrypted, key);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handlers
// ─────────────────────────────────────────────────────────────────────────────

static bool parseJsonBody(const std::string& body, Json::Value& out, httplib::Response& res) {
    Json::CharReaderBuilder rb;
    std::string errs;
    std::istringstream ss(body);
    if (!Json::parseFromStream(rb, ss, &out, &errs)) {
        res.status = 400;
        res.set_content("{\"error\":\"Invalid JSON\"}", "application/json");
        return false;
    }
    return true;
}

void handleGetAuth(const httplib::Request& req, httplib::Response& res,
                   AuthStore& store) {
    addSecurityHeaders(res); addCorsHeaders(res, req);

    Json::Value result;
    result["setup"] = store.isSetup();
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.set_content(Json::writeString(wb, result), "application/json");
}

void handleSetupAuth(const httplib::Request& req, httplib::Response& res,
                     AuthStore& store) {
    addSecurityHeaders(res); addCorsHeaders(res, req);

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) return;

    if (!body.isMember("password") || body["password"].asString().empty()) {
        res.status = 400;
        res.set_content("{\"error\":\"Password is required\"}", "application/json");
        return;
    }

    std::string password = body["password"].asString();
    int iterations = body.get("iterations", 310000).asInt();

    if (store.isSetup()) {
        res.status = 409;
        res.set_content("{\"error\":\"Password already set. Use change-password endpoint.\"}", "application/json");
        return;
    }

    if (!store.setupPassword(password, iterations)) {
        res.status = 500;
        res.set_content("{\"error\":\"Failed to setup password\"}", "application/json");
        return;
    }

    // Create a session
    std::string token = SessionManager::instance().createSession();

    Json::Value result;
    result["success"] = true;
    result["sessionToken"] = token;
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.set_content(Json::writeString(wb, result), "application/json");
}

void handleLoginAuth(const httplib::Request& req, httplib::Response& res,
                     AuthStore& store) {
    addSecurityHeaders(res); addCorsHeaders(res, req);

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) return;

    if (!body.isMember("password") || body["password"].asString().empty()) {
        res.status = 400;
        res.set_content("{\"error\":\"Password is required\"}", "application/json");
        return;
    }

    std::string password = body["password"].asString();

    if (!store.verifyPassword(password)) {
        res.status = 401;
        res.set_content("{\"error\":\"Incorrect password\"}", "application/json");
        return;
    }

    // Create a session
    std::string token = SessionManager::instance().createSession();

    Json::Value result;
    result["success"] = true;
    result["sessionToken"] = token;
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.set_content(Json::writeString(wb, result), "application/json");
}

void handleLogoutAuth(const httplib::Request& req, httplib::Response& res) {
    addSecurityHeaders(res); addCorsHeaders(res, req);

    std::string token;
    if (req.has_header("X-Session-Token")) {
        token = req.get_header_value("X-Session-Token");
    } else {
        Json::Value body;
        Json::CharReaderBuilder rb;
        std::string errs;
        std::istringstream ss(req.body);
        if (Json::parseFromStream(rb, ss, &body, &errs) && body.isMember("sessionToken")) {
            token = body["sessionToken"].asString();
        }
    }

    if (!token.empty()) {
        SessionManager::instance().revoke(token);
    }

    Json::Value result;
    result["success"] = true;
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.set_content(Json::writeString(wb, result), "application/json");
}

void handleValidateAuth(const httplib::Request& req, httplib::Response& res,
                        AuthStore& store) {
    addSecurityHeaders(res); addCorsHeaders(res, req);

    std::string token;
    if (req.has_header("X-Session-Token")) {
        token = req.get_header_value("X-Session-Token");
    } else if (req.has_param("token")) {
        token = req.get_param_value("token");
    }

    if (!token.empty() && SessionManager::instance().isValid(token)) {
        if (!store.getAesKey().empty()) {
            Json::Value result;
            result["valid"] = true;
            Json::StreamWriterBuilder wb;
            wb["indentation"] = "";
            res.set_content(Json::writeString(wb, result), "application/json");
            return;
        }
    }

    res.status = 401;
    res.set_content("{\"error\":\"Invalid session\"}", "application/json");
}
