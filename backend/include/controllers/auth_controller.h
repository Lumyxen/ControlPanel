#pragma once

#include <json/json.h>
#include <mutex>
#include <string>
#include <vector>

#include "httplib.h"
#include "services/crypto_service.h"

class ChatStore;

class AuthStore {
public:
    struct VerificationResult {
        bool success = false;
        bool kdfUpgraded = false;
        std::vector<uint8_t> previousKey;
        std::vector<uint8_t> nextKey;
        Json::Value nextKdfMetadata = Json::Value(Json::objectValue);
    };

    explicit AuthStore(const std::string& path);

    void loadFromDisk();

    bool isSetup() const;
    Json::Value getKdfMetadata() const;
    bool setupPassword(const std::string& password, int iterations = 600000);
    VerificationResult verifyPassword(const std::string& password);

    std::vector<uint8_t> getAesKey();
    void clearLoadedKey();
    std::string encryptData(const std::string& plaintext);
    std::string decryptData(const Json::Value& encrypted);

private:
    struct KdfConfig {
        std::string type = "pbkdf2";
        std::string hash = "sha256";
        int iterations = 310000;
        std::vector<uint8_t> salt;
    };

    Json::Value readStateUnlocked() const;
    bool writeStateUnlocked(const Json::Value& state) const;
    Json::Value buildStateUnlocked(const KdfConfig& kdf,
                                   const std::vector<uint8_t>& key) const;
    KdfConfig currentKdfUnlocked() const;
    bool isLegacyKdfUnlocked() const;
    static KdfConfig kdfFromJson(const Json::Value& root);
    static Json::Value kdfToJson(const KdfConfig& kdf);

    std::string filePath_;
    mutable std::mutex mutex_;
    mutable std::mutex keyMutex_;

    KdfConfig kdf_;
    std::vector<uint8_t> aesKey_;
    bool setup_ = false;

public:
    bool commitKdfUpgrade(const Json::Value& nextKdfMetadata,
                          const std::vector<uint8_t>& nextKey);
};

std::string extractBearerToken(const httplib::Request& req);
std::string extractSessionToken(const httplib::Request& req);
bool requireValidSession(const httplib::Request& req, httplib::Response& res, AuthStore* store = nullptr);
std::string issuePanelReauthToken(const std::string& sessionToken);
bool validatePanelReauthToken(const std::string& sessionToken,
                              const std::string& reauthToken);

void handleGetAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handleSetupAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handleLoginAuth(const httplib::Request& req,
                     httplib::Response& res,
                     AuthStore& store,
                     ChatStore* chatStore = nullptr);
void handleLogoutAuth(const httplib::Request& req, httplib::Response& res);
void handleValidateAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
void handlePanelReauthAuth(const httplib::Request& req, httplib::Response& res, AuthStore& store);
