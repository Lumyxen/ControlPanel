// backend/src/controllers/auth_controller.cpp

#include "controllers/auth_controller.h"
#include <fstream>
#include <sstream>
#include <iostream>

// ── AuthStore ─────────────────────────────────────────────────────────────────

AuthStore::AuthStore(const std::string& path) : filePath_(path) {}

Json::Value AuthStore::load() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ifstream file(filePath_);
    if (!file.is_open()) return Json::Value(Json::objectValue);

    Json::CharReaderBuilder rb;
    Json::Value root;
    std::string errs;
    if (!Json::parseFromStream(rb, file, &root, &errs)) {
        std::cerr << "[AuthStore] Failed to parse " << filePath_
                  << ": " << errs << "\n";
        return Json::Value(Json::objectValue);
    }
    return root;
}

void AuthStore::save(const Json::Value& data) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ofstream file(filePath_);
    if (!file.is_open()) {
        std::cerr << "[AuthStore] Cannot open " << filePath_ << " for writing\n";
        return;
    }
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(wb.newStreamWriter());
    writer->write(data, &file);
}

bool AuthStore::hasAuth() const {
    auto data = load();
    return data.isMember("salt") && !data["salt"].asString().empty();
}

// ── Route handlers ────────────────────────────────────────────────────────────

void handleGetAuth(const httplib::Request& /*req*/, httplib::Response& res,
                   AuthStore& store) {
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    res.set_content(Json::writeString(wb, store.load()), "application/json");
}

void handleSetAuth(const httplib::Request& req, httplib::Response& res,
                   AuthStore& store) {
    Json::CharReaderBuilder rb;
    Json::Value body;
    std::string errs;
    std::istringstream ss(req.body);

    if (!Json::parseFromStream(rb, ss, &body, &errs)) {
        res.status = 400;
        res.set_content("{\"error\":\"Invalid JSON\"}", "application/json");
        return;
    }

    // Validate required fields
    if (!body.isMember("salt") || body["salt"].asString().empty()) {
        res.status = 400;
        res.set_content("{\"error\":\"Missing or empty field: salt\"}", "application/json");
        return;
    }
    if (!body.isMember("sentinel") || !body["sentinel"].isObject()) {
        res.status = 400;
        res.set_content("{\"error\":\"Missing or invalid field: sentinel\"}", "application/json");
        return;
    }
    if (!body["sentinel"].isMember("iv") || !body["sentinel"].isMember("ct")) {
        res.status = 400;
        res.set_content("{\"error\":\"sentinel must have iv and ct fields\"}", "application/json");
        return;
    }

    store.save(body);
    std::cout << "[Auth] Auth data saved to disk.\n";
    res.set_content("{\"ok\":true}", "application/json");
}