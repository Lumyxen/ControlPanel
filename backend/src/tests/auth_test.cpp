#include "controllers/auth_controller.h"
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
        path_ = fs::temp_directory_path() / ("ctrlpanel-auth-test-" + std::to_string(
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
    originAllowed.path = "/api/config/settings";
    originAllowed.set_header("Origin", "http://127.0.0.1:8080");
    expect(isAllowedFrontendRequest(originAllowed), "exact allowed Origin should pass");

    httplib::Request refererAllowed;
    refererAllowed.path = "/api/config/settings";
    refererAllowed.set_header("Referer", "http://127.0.0.1:8080/#pages/settings.html");
    expect(isAllowedFrontendRequest(refererAllowed), "exact allowed Referer should pass");

    httplib::Request rejected;
    rejected.path = "/api/config/settings";
    rejected.set_header("Origin", "http://localhost:8080");
    expect(!isAllowedFrontendRequest(rejected), "localhost origin should be rejected");
}

} // namespace

int main() {
    try {
        testSetupDoesNotPersistAesKey();
        testLegacyLoginUpgradesKdf();
        testBearerExtractionAndSessionValidation();
        testOriginRefererAllowlist();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }

    return 0;
}
