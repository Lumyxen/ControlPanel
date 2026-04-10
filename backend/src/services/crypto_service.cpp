// backend/src/services/crypto_service.cpp
#include "services/crypto_service.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/err.h>
#include <sstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>

// ─────────────────────────────────────────────────────────────────────────────
// CryptoService — PBKDF2 + AES-256-GCM using OpenSSL
// ─────────────────────────────────────────────────────────────────────────────

std::vector<uint8_t> CryptoService::deriveKey(const std::string& password,
                                               const std::vector<uint8_t>& salt,
                                               int iterations) {
    std::vector<uint8_t> key(32); // AES-256
    int rc = PKCS5_PBKDF2_HMAC(
        password.c_str(), static_cast<int>(password.size()),
        salt.data(), static_cast<int>(salt.size()),
        iterations,
        EVP_sha256(),
        32, key.data()
    );
    if (rc != 1) {
        throw std::runtime_error("PBKDF2 key derivation failed");
    }
    return key;
}

std::string CryptoService::encrypt(const std::string& plaintext,
                                    const std::vector<uint8_t>& key) {
    // Generate random 12-byte IV
    std::vector<uint8_t> iv(12);
    if (RAND_bytes(iv.data(), 12) != 1) {
        throw std::runtime_error("RAND_bytes failed for IV");
    }

    // Encrypt
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");

    EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr);
    EVP_EncryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data());

    std::vector<uint8_t> ciphertext(plaintext.size() + 128);
    int outlen = 0;

    EVP_EncryptUpdate(ctx, ciphertext.data(), &outlen,
                      reinterpret_cast<const uint8_t*>(plaintext.data()),
                      static_cast<int>(plaintext.size()));
    int totalLen = outlen;

    EVP_EncryptFinal_ex(ctx, ciphertext.data() + totalLen, &outlen);
    totalLen += outlen;

    // Get auth tag (16 bytes)
    std::vector<uint8_t> tag(16);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag.data());
    EVP_CIPHER_CTX_free(ctx);

    // Append tag to ciphertext
    ciphertext.resize(totalLen);
    ciphertext.insert(ciphertext.end(), tag.begin(), tag.end());

    // Build JSON: { _enc: true, iv: "<hex>", ct: "<hex>" }
    Json::Value result;
    result["_enc"] = true;
    result["iv"] = toHex(iv);
    result["ct"] = toHex(ciphertext);

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    return Json::writeString(wb, result);
}

std::string CryptoService::decrypt(const Json::Value& encrypted) {
    if (!encrypted.isMember("_enc") || !encrypted["_enc"].asBool()) {
        // Not encrypted — return as-is (migration compat)
        Json::StreamWriterBuilder wb;
        wb["indentation"] = "";
        return Json::writeString(wb, encrypted);
    }

    std::string ivHex = encrypted.get("iv", "").asString();
    std::string ctHex = encrypted.get("ct", "").asString();
    if (ivHex.empty() || ctHex.empty()) {
        throw std::runtime_error("Missing iv or ct in encrypted payload");
    }

    std::vector<uint8_t> iv = fromHex(ivHex);
    std::vector<uint8_t> data = fromHex(ctHex);

    if (data.size() < 17) { // 16 byte tag + at least 1 byte ciphertext
        throw std::runtime_error("Ciphertext too short");
    }

    // Extract tag (last 16 bytes)
    std::vector<uint8_t> tag(data.end() - 16, data.end());
    data.resize(data.size() - 16);

    // Decrypt — need the key! This function needs to receive it.
    // The key is held by the backend's auth module.
    // For now, this is a placeholder — the actual key is passed from the caller.
    (void)iv; (void)tag;
    throw std::runtime_error("decrypt() called without key — use decryptWithKey()");
}

// Version that takes the key
std::string CryptoService::decryptWithKey(const Json::Value& encrypted,
                                           const std::vector<uint8_t>& key) {
    if (!encrypted.isMember("iv") || !encrypted.isMember("ct")) {
        // Not an encrypted envelope — return as-is
        Json::StreamWriterBuilder wb;
        wb["indentation"] = "";
        return Json::writeString(wb, encrypted);
    }

    std::string ivHex = encrypted.get("iv", "").asString();
    std::string ctHex = encrypted.get("ct", "").asString();
    if (ivHex.empty() || ctHex.empty()) {
        throw std::runtime_error("Missing iv or ct in encrypted payload");
    }

    std::vector<uint8_t> iv = fromHex(ivHex);
    std::vector<uint8_t> data = fromHex(ctHex);

    if (data.size() < 17) {
        throw std::runtime_error("Ciphertext too short");
    }

    std::vector<uint8_t> tag(data.end() - 16, data.end());
    data.resize(data.size() - 16);

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");

    EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr);
    EVP_DecryptInit_ex(ctx, nullptr, nullptr, key.data(), iv.data());

    std::vector<uint8_t> plaintext(data.size() + 16);
    int outlen = 0;

    EVP_DecryptUpdate(ctx, plaintext.data(), &outlen,
                      data.data(), static_cast<int>(data.size()));
    int totalLen = outlen;

    // Set expected tag
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, tag.data());

    int ret = EVP_DecryptFinal_ex(ctx, plaintext.data() + totalLen, &outlen);
    EVP_CIPHER_CTX_free(ctx);

    if (ret <= 0) {
        throw std::runtime_error("AES-256-GCM decryption failed — wrong key or corrupted data");
    }
    totalLen += outlen;

    return std::string(reinterpret_cast<char*>(plaintext.data()), totalLen);
}

std::string CryptoService::toHex(const std::vector<uint8_t>& data) {
    std::ostringstream oss;
    for (auto b : data) oss << std::hex << std::setw(2) << std::setfill('0') << (int)b;
    return oss.str();
}

std::vector<uint8_t> CryptoService::fromHex(const std::string& hex) {
    std::vector<uint8_t> data;
    data.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        data.push_back(static_cast<uint8_t>(std::stoi(hex.substr(i, 2), nullptr, 16)));
    }
    return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager
// ─────────────────────────────────────────────────────────────────────────────

SessionManager::SessionManager() {}

SessionManager& SessionManager::instance() {
    static SessionManager inst;
    return inst;
}

std::string SessionManager::createSession() {
    // Generate a random 32-byte token
    std::vector<uint8_t> token(32);
    RAND_bytes(token.data(), 32);

    std::string tokenHex = CryptoService::toHex(token);
    SessionInfo info;
    info.token = tokenHex;
    info.created = std::chrono::steady_clock::now();
    info.lastAccessed = info.created;

    std::lock_guard<std::mutex> lock(mutex_);
    sessions_[tokenHex] = info;
    return tokenHex;
}

bool SessionManager::isValid(const std::string& token) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = sessions_.find(token);
    if (it == sessions_.end()) return false;

    // Check expiry (24 hours)
    auto age = std::chrono::duration_cast<std::chrono::hours>(
        std::chrono::steady_clock::now() - it->second.created).count();
    if (age > 24) {
        sessions_.erase(it);
        return false;
    }

    it->second.lastAccessed = std::chrono::steady_clock::now();
    return true;
}

void SessionManager::revoke(const std::string& token) {
    std::lock_guard<std::mutex> lock(mutex_);
    sessions_.erase(token);
}

void SessionManager::cleanup(int maxAgeHours) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    std::vector<std::string> toRemove;
    for (const auto& [token, info] : sessions_) {
        auto age = std::chrono::duration_cast<std::chrono::hours>(
            now - info.created).count();
        if (age > maxAgeHours) toRemove.push_back(token);
    }
    for (const auto& token : toRemove) {
        sessions_.erase(token);
    }
}
