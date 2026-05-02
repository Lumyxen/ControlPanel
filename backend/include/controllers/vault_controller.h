#pragma once

#include <json/json.h>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "httplib.h"
#include "services/rate_limiter.h"

class VaultStore {
public:
    struct OperationResult {
        int httpStatus = 200;
        Json::Value body = Json::Value(Json::objectValue);
    };

    explicit VaultStore(const std::string& path);

    void loadFromDisk();
    bool exists() const;
    Json::Value getStatus(const std::string& deviceId) const;

    OperationResult setup(const Json::Value& kdfMetadata,
                          const std::string& vaultAuthKeyHex,
                          const Json::Value& encryptedVaultBlob,
                          bool replaceExisting);
    OperationResult issueChallenge(const std::string& mode,
                                   const std::string& deviceId = "");
    OperationResult unlockWithMaster(const std::string& challengeId,
                                     const std::string& proofHex,
                                     const std::string& attemptKey,
                                     int rateLimitPerMinute);
    OperationResult reauthWithMaster(const std::string& challengeId,
                                     const std::string& proofHex,
                                     const std::string& attemptKey,
                                     int rateLimitPerMinute);
    OperationResult unlockWithPin(const std::string& deviceId,
                                  const std::string& challengeId,
                                  const std::string& proofHex,
                                  int rateLimitPerMinute);
    OperationResult saveVault(const Json::Value& encryptedVaultBlob,
                              int expectedRevision);
    OperationResult registerPin(const std::string& deviceId,
                                const Json::Value& pinAuthKdf,
                                const std::string& pinAuthVerifierHex);
    OperationResult deletePinSlot(const std::string& deviceId);

    bool validateAccessToken(const std::string& token,
                             bool requireMasterFresh = false) const;

private:
    struct ChallengeInfo {
        std::string mode;
        std::string deviceId;
        std::chrono::steady_clock::time_point expiresAt;
    };

    struct AccessTokenInfo {
        bool masterVerified = false;
        std::chrono::steady_clock::time_point issuedAt;
        std::chrono::steady_clock::time_point expiresAt;
    };

    Json::Value readRootUnlocked() const;
    bool writeRootUnlocked(const Json::Value& root) const;
    static bool hasVaultUnlocked(const Json::Value& root);
    static int currentRevisionUnlocked(const Json::Value& root);
    static Json::Value sanitizeKdf(const Json::Value& source, int fallbackIterations = 600000);
    static bool isHexString(const std::string& value);
    static Json::Value makeError(const std::string& message);

    OperationResult unlockWithStoredKey(const std::string& challengeId,
                                        const std::string& proofHex,
                                        const std::vector<uint8_t>& verifierKey,
                                        bool masterVerified,
                                        const Json::Value& root,
                                        const std::string& pepper = "") const;
    std::string issueAccessTokenUnlocked(bool masterVerified) const;
    bool validateProof(const std::vector<uint8_t>& key,
                       const std::string& challengeId,
                       const std::string& proofHex,
                       const std::string& prefix) const;
    bool consumeChallengeUnlocked(const std::string& challengeId,
                                  const std::string& expectedMode,
                                  const std::string& expectedDeviceId = "") const;
    void pruneExpiredChallengesUnlocked() const;
    void pruneExpiredAccessTokensUnlocked() const;

    std::string filePath_;
    mutable std::mutex mutex_;
    mutable std::unordered_map<std::string, ChallengeInfo> challenges_;
    mutable std::unordered_map<std::string, AccessTokenInfo> accessTokens_;
    mutable SlidingWindowRateLimiter masterUnlockRateLimiter_;
};

std::string extractVaultAccessToken(const httplib::Request& req);
std::string extractVaultDeviceId(const httplib::Request& req);
bool requireVaultAccess(const httplib::Request& req,
                        httplib::Response& res,
                        const VaultStore& store,
                        bool requireMasterFresh = false);

void handleGetVaultStatus(const httplib::Request& req, httplib::Response& res, VaultStore& store);
void handleSetupVault(const httplib::Request& req, httplib::Response& res, VaultStore& store);
void handleVaultUnlockChallenge(const httplib::Request& req, httplib::Response& res, VaultStore& store);
void handleVaultUnlockMaster(const httplib::Request& req,
                             httplib::Response& res,
                             VaultStore& store,
                             int rateLimitPerMinute);
void handleVaultUnlockPin(const httplib::Request& req,
                          httplib::Response& res,
                          VaultStore& store,
                          int rateLimitPerMinute);
void handlePutVault(const httplib::Request& req, httplib::Response& res, VaultStore& store);
void handleSetupVaultPin(const httplib::Request& req, httplib::Response& res, VaultStore& store);
void handleDeleteVaultPin(const httplib::Request& req,
                          httplib::Response& res,
                          VaultStore& store,
                          const std::string& deviceId);
void handleVaultReauth(const httplib::Request& req,
                       httplib::Response& res,
                       VaultStore& store,
                       int rateLimitPerMinute);
