#pragma once

#include <json/json.h>
#include <mutex>
#include <string>
#include <vector>

#include "httplib.h"
#include "services/crypto_service.h"

class AuthStore {
public:
    explicit AuthStore(const std::string& path);

    void loadFromDisk();

    bool isSetup() const;
    bool setupPassword(const std::string& password, int iterations = 310000);
    bool verifyPassword(const std::string& password);

    std::vector<uint8_t> getAesKey();
    std::string encryptData(const std::string& plaintext);
    std::string decryptData(const Json::Value& encrypted);

private:
    Json::Value readStateUnlocked() const;
    bool writeStateUnlocked(const Json::Value& state) const;

    std::string filePath_;
    mutable std::mutex mutex_;
    mutable std::mutex keyMutex_;

    std::vector<uint8_t> salt_;
    std::vector<uint8_t> aesKey_;
    bool setup_ = false;
};

std::string extractSessionToken(const httplib::Request& req);
bool requireValidSession(const httplib::Request& req, httplib::Response& res, AuthStore* store = nullptr);

void handleGetAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handleSetupAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handleLoginAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handleLogoutAuth(const httplib::Request& req, httplib::Response& res);
void handleValidateAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
