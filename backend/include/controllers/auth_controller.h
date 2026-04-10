#pragma once
// backend/include/controllers/auth_controller.h
//
// Backend-managed authentication and encryption.
// The backend holds the AES key derived from the user's password and handles
// all encryption/decryption. The frontend only needs the password to
// authenticate and receives a session token.
//
// Routes:
//   GET  /api/auth            → returns { setup: bool }
//   POST /api/auth/setup      → first-time password setup
//   POST /api/auth/login      → login with password, returns session token
//   POST /api/auth/logout     → invalidate session token
//   POST /api/auth/change-password → change password (requires current password)

#include "httplib.h"
#include "services/crypto_service.h"
#include <string>
#include <mutex>
#include <vector>
#include <json/json.h>

class AuthStore {
    std::string       filePath_;
    mutable std::mutex mutex_;

    // The AES key — derived from password, held in memory
    std::vector<uint8_t> aesKey_;
    mutable std::mutex   keyMutex_;

    // PBKDF2 salt (stored on disk)
    std::vector<uint8_t> salt_;

    // Whether setup has been completed
    bool setup_ = false;

public:
    explicit AuthStore(const std::string& path);

    // Load auth.json from disk (salt + sentinel for verification)
    void loadFromDisk();

    // Check if the panel has been set up
    bool isSetup() const;

    // Setup: derive key from password, store salt+sentinel
    bool setupPassword(const std::string& password, int iterations = 310000);

    // Login: verify password against stored sentinel, stores the key in memory
    bool verifyPassword(const std::string& password);

    // Get the AES key (only after successful login)
    std::vector<uint8_t> getAesKey();

    // Encrypt plaintext → JSON string
    std::string encryptData(const std::string& plaintext);

    // Decrypt JSON → plaintext
    std::string decryptData(const Json::Value& encrypted);
};

void handleGetAuth    (const httplib::Request& req, httplib::Response& res,
                       AuthStore& store);
void handleSetupAuth  (const httplib::Request& req, httplib::Response& res,
                       AuthStore& store);
void handleLoginAuth  (const httplib::Request& req, httplib::Response& res,
                       AuthStore& store);
void handleLogoutAuth (const httplib::Request& req, httplib::Response& res);
void handleValidateAuth(const httplib::Request& req, httplib::Response& res,
                        AuthStore& store);
