#pragma once
// backend/include/controllers/auth_controller.h
//
// Provides server-side storage for the client-side authentication material
// (PBKDF2 salt + AES-256-GCM encrypted sentinel). Storing these on the
// backend rather than in the browser's localStorage means the auth data is
// not visible to browser extensions or other origins sharing localStorage,
// and it survives browser storage clears.
//
// The actual key derivation and verification happen entirely in the browser
// (Web Crypto API). The server never sees the raw password or the AES key.
//
// Routes:
//   GET  /api/auth   → returns stored {salt, sentinel} or {}
//   POST /api/auth   → saves {salt, sentinel} to data/auth.json

#include "httplib.h"
#include <string>
#include <mutex>
#include <json/json.h>

class AuthStore {
    std::string       filePath_;
    mutable std::mutex mutex_;

public:
    explicit AuthStore(const std::string& path);

    /**
     * Load stored auth data from disk.
     * Returns a JSON object with "salt" and "sentinel" fields,
     * or an empty object if no auth has been set up.
     */
    Json::Value load() const;

    /**
     * Persist auth data to disk.
     * @param data  Must contain "salt" (string) and "sentinel" (object {iv, ct}).
     */
    void save(const Json::Value& data);

    /** Returns true if auth data has been configured. */
    bool hasAuth() const;
};

void handleGetAuth(const httplib::Request& req, httplib::Response& res,
                   AuthStore& store);

void handleSetAuth(const httplib::Request& req, httplib::Response& res,
                   AuthStore& store);