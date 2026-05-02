#include "controllers/auth_controller.h"
#include "controllers/vault_controller.h"
#include "server/http_utils.h"
#include "services/crypto_service.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;

namespace {

class ScopedDir {
public:
    ScopedDir() {
        path_ = fs::temp_directory_path() / ("ctrlpanel-auth-vault-test-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path_);
    }

    ~ScopedDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }

    const fs::path& path() const {
        return path_;
    }

private:
    fs::path path_;
};

void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

Json::Value parseJsonFile(const fs::path& path) {
    std::ifstream file(path);
    expect(file.is_open(), "Failed to open " + path.string());

    Json::CharReaderBuilder reader;
    Json::Value root;
    std::string errors;
    expect(Json::parseFromStream(reader, file, &root, &errors), "Invalid JSON: " + errors);
    return root;
}

Json::Value parseJsonString(const std::string& text) {
    Json::CharReaderBuilder reader;
    Json::Value root;
    std::string errors;
    std::istringstream stream(text);
    expect(Json::parseFromStream(reader, stream, &root, &errors), "Invalid JSON string: " + errors);
    return root;
}

void writeLegacyAuthFile(const fs::path& path, const std::string& password) {
    const std::vector<uint8_t> salt = CryptoService::randomBytes(32);
    const std::vector<uint8_t> key = CryptoService::deriveKey(password, salt, 310000);
    const Json::Value sentinel = parseJsonString(CryptoService::encrypt("ctrlpanel-v1-auth-ok", key));

    Json::Value root(Json::objectValue);
    root["salt"] = CryptoService::toHex(salt);
    root["sentinel"] = sentinel;
    root["aesKey"] = CryptoService::toHex(key);

    std::ofstream file(path);
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(root, &file);
}

void testSetupDoesNotPersistAesKey() {
    ScopedDir temp;
    AuthStore store((temp.path() / "auth.json").string());
    expect(store.setupPassword("panel-password"), "setupPassword should succeed");

    const Json::Value root = parseJsonFile(temp.path() / "auth.json");
    expect(root.isMember("kdf"), "auth.json should store KDF metadata");
    expect(root["kdf"]["iterations"].asInt() == 600000, "new panel auth should default to 600000 iterations");
    expect(!root.isMember("aesKey"), "auth.json must not persist aesKey");
}

void testLegacyLoginUpgradesKdf() {
    ScopedDir temp;
    writeLegacyAuthFile(temp.path() / "auth.json", "panel-password");

    AuthStore store((temp.path() / "auth.json").string());
    httplib::Request req;
    httplib::Response res;
    req.body = R"({"password":"panel-password"})";

    handleLoginAuth(req, res, store, nullptr);
    expect(res.status == 200, "legacy login should succeed");

    const Json::Value root = parseJsonFile(temp.path() / "auth.json");
    expect(root["kdf"]["iterations"].asInt() == 600000, "legacy auth should upgrade to 600000 iterations");
    expect(!root.isMember("aesKey"), "legacy aesKey should be scrubbed after successful login");
}

void testBearerExtractionAndSessionValidation() {
    ScopedDir temp;
    AuthStore store((temp.path() / "auth.json").string());
    expect(store.setupPassword("panel-password"), "setupPassword should succeed");

    const std::string sessionToken = SessionManager::instance().createSession();

    httplib::Request req;
    httplib::Response res;
    req.set_header("Authorization", "Bearer " + sessionToken);

    expect(extractSessionToken(req) == sessionToken, "Authorization bearer token should be extracted");
    expect(requireValidSession(req, res, &store), "Bearer-authenticated request should validate");
}

void testOriginRefererAllowlist() {
    httplib::Request originAllowed;
    originAllowed.path = "/api/vault/status";
    originAllowed.set_header("Origin", "http://127.0.0.1:8080");
    expect(isAllowedFrontendRequest(originAllowed), "exact allowed Origin should pass");

    httplib::Request refererAllowed;
    refererAllowed.path = "/api/vault/status";
    refererAllowed.set_header("Referer", "http://127.0.0.1:8080/#pages/password-manager.html");
    expect(isAllowedFrontendRequest(refererAllowed), "exact allowed Referer should pass");

    httplib::Request rejected;
    rejected.path = "/api/vault/status";
    rejected.set_header("Origin", "http://localhost:8080");
    expect(!isAllowedFrontendRequest(rejected), "localhost origin should be rejected");
}

void testVaultMasterUnlockAndRevisionConflict() {
    ScopedDir temp;
    VaultStore store((temp.path() / "password-vault.json").string());

    Json::Value kdf(Json::objectValue);
    kdf["type"] = "pbkdf2";
    kdf["hash"] = "sha256";
    kdf["iterations"] = 600000;
    kdf["salt"] = CryptoService::toHex(CryptoService::randomBytes(32));

    const std::vector<uint8_t> authKey = CryptoService::randomBytes(32);
    Json::Value vault(Json::objectValue);
    vault["version"] = 1;
    vault["revision"] = 1;
    vault["createdAt"] = 1;
    vault["updatedAt"] = 1;
    vault["iv"] = "iv";
    vault["ct"] = "ct";

    const auto setupResult = store.setup(kdf, CryptoService::toHex(authKey), vault, false);
    expect(setupResult.httpStatus == 200, "vault setup should succeed");

    const auto challenge = store.issueChallenge("master");
    expect(challenge.httpStatus == 200, "master challenge should succeed");
    const std::string challengeId = challenge.body["challenge"].asString();

    const std::string proof = CryptoService::toHex(
        CryptoService::hmacSha256(authKey, "vault:master:" + challengeId));
    const auto unlockResult = store.unlockWithMaster(challengeId, proof, "master-test", 5);
    expect(unlockResult.httpStatus == 200, "master unlock proof should validate");

    const auto badChallenge = store.issueChallenge("master");
    const auto badUnlock = store.unlockWithMaster(
        badChallenge.body["challenge"].asString(),
        std::string(64, '0'),
        "master-test",
        5);
    expect(badUnlock.httpStatus == 401, "bad master proof should fail");

    Json::Value nextVault = vault;
    nextVault["revision"] = 2;
    nextVault["updatedAt"] = 2;
    const auto conflict = store.saveVault(nextVault, 0);
    expect(conflict.httpStatus == 409, "stale vault revision should return 409");
}

void testPinUnlockAndLockout() {
    ScopedDir temp;
    VaultStore store((temp.path() / "password-vault.json").string());

    Json::Value kdf(Json::objectValue);
    kdf["type"] = "pbkdf2";
    kdf["hash"] = "sha256";
    kdf["iterations"] = 600000;
    kdf["salt"] = CryptoService::toHex(CryptoService::randomBytes(32));

    const std::vector<uint8_t> authKey = CryptoService::randomBytes(32);
    Json::Value vault(Json::objectValue);
    vault["version"] = 1;
    vault["revision"] = 1;
    vault["createdAt"] = 1;
    vault["updatedAt"] = 1;
    vault["iv"] = "iv";
    vault["ct"] = "ct";
    expect(store.setup(kdf, CryptoService::toHex(authKey), vault, false).httpStatus == 200, "vault setup should succeed");

    Json::Value pinKdf(Json::objectValue);
    pinKdf["type"] = "pbkdf2";
    pinKdf["hash"] = "sha256";
    pinKdf["iterations"] = 310000;
    pinKdf["salt"] = CryptoService::toHex(CryptoService::randomBytes(16));
    const std::vector<uint8_t> pinKey = CryptoService::randomBytes(32);

    expect(
        store.registerPin("device-1", pinKdf, CryptoService::toHex(pinKey)).httpStatus == 200,
        "PIN registration should succeed");

    const auto challenge = store.issueChallenge("pin", "device-1");
    const std::string challengeId = challenge.body["challenge"].asString();
    const std::string proof = CryptoService::toHex(
        CryptoService::hmacSha256(pinKey, "vault:pin:" + challengeId));
    expect(store.unlockWithPin("device-1", challengeId, proof, 5).httpStatus == 200, "PIN proof should validate");

    for (int attempt = 0; attempt < 5; ++attempt) {
        const auto badChallenge = store.issueChallenge("pin", "device-1");
        const auto failure = store.unlockWithPin(
            "device-1",
            badChallenge.body["challenge"].asString(),
            std::string(64, 'f'),
            5);
        if (attempt < 4) {
            expect(failure.httpStatus == 401, "bad PIN proof should fail");
        } else {
            expect(failure.httpStatus == 401, "lockout response should still be an auth failure");
            expect(failure.body["pinDisabled"].asBool(), "fifth failed PIN attempt should disable the slot");
        }
    }

    const Json::Value status = store.getStatus("device-1");
    expect(!status["pin"]["configured"].asBool(), "PIN slot should be deleted after repeated failures");
}

} // namespace

int main() {
    try {
        testSetupDoesNotPersistAesKey();
        testLegacyLoginUpgradesKdf();
        testBearerExtractionAndSessionValidation();
        testOriginRefererAllowlist();
        testVaultMasterUnlockAndRevisionConflict();
        testPinUnlockAndLockout();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }

    return 0;
}
