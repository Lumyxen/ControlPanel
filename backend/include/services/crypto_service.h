#ifndef CRYPTO_SERVICE_H
#define CRYPTO_SERVICE_H

#include <string>
#include <vector>
#include <mutex>
#include <unordered_map>
#include <chrono>
#include <json/json.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

class CryptoService {
public:
    // PBKDF2 key derivation: password + salt → 32-byte AES key
    static std::vector<uint8_t> deriveKey(const std::string& password,
                                          const std::vector<uint8_t>& salt,
                                          int iterations = 310000);

    // AES-256-GCM encrypt
    static std::string encrypt(const std::string& plaintext,
                               const std::vector<uint8_t>& key);
    // Returns JSON: { _enc: true, iv: "<hex>", ct: "<hex>" }

    // AES-256-GCM decrypt (pass-through if not encrypted)
    static std::string decrypt(const Json::Value& encrypted);

    // AES-256-GCM decrypt with key (for backend-side decryption)
    static std::string decryptWithKey(const Json::Value& encrypted,
                                       const std::vector<uint8_t>& key);

    // Hex conversion
    static std::string toHex(const std::vector<uint8_t>& data);
    static std::vector<uint8_t> fromHex(const std::string& hex);
};

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager — manages authenticated session tokens
// ─────────────────────────────────────────────────────────────────────────────

struct SessionInfo {
    std::string token;
    std::chrono::steady_clock::time_point created;
    std::chrono::steady_clock::time_point lastAccessed;
};

class SessionManager {
public:
    static SessionManager& instance();

    // Create a session, return the token
    std::string createSession();

    // Validate a session token, returns true and updates lastAccessed
    bool isValid(const std::string& token);

    // Invalidate a session
    void revoke(const std::string& token);

    // Clean up expired sessions (older than 24h)
    void cleanup(int maxAgeHours = 24);

private:
    SessionManager();
    mutable std::mutex mutex_;
    std::unordered_map<std::string, SessionInfo> sessions_;
};

#endif // CRYPTO_SERVICE_H
