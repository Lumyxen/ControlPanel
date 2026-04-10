#ifndef CHAT_CONTROLLER_H
#define CHAT_CONTROLLER_H

#include "httplib.h"
#include <string>
#include <mutex>
#include <fstream>
#include <json/json.h>
#include "controllers/auth_controller.h"

class ChatStore {
private:
    std::string filePath;
    mutable std::mutex mutex;
    AuthStore* authStore_;

    Json::Value makeDefault() const {
        Json::Value v;
        v["chats"]         = Json::Value(Json::arrayValue);
        v["currentChatId"] = "";
        v["pins"]          = Json::Value(Json::arrayValue);
        return v;
    }

    static std::string generateId() {
        // Simple unique ID: timestamp_ms + random hex
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        char buf[32];
        snprintf(buf, sizeof(buf), "%lld_%04x", (long long)ms, rand() & 0xFFFF);
        return buf;
    }

public:
    explicit ChatStore(const std::string& path, AuthStore* authStore = nullptr)
        : filePath(path), authStore_(authStore) {}

    Json::Value load() {
        std::lock_guard<std::mutex> lock(mutex);
        std::ifstream file(filePath);
        if (!file.is_open()) return makeDefault();

        Json::CharReaderBuilder builder;
        std::string errs;
        Json::Value root;
        if (!Json::parseFromStream(builder, file, &root, &errs)) return makeDefault();

        // Decrypt if data has encrypted envelope (iv+ct fields) and we have the key
        if (root.isMember("iv") && root.isMember("ct") && authStore_) {
            try {
                std::string plaintext = authStore_->decryptData(root);
                Json::CharReaderBuilder rb2;
                std::string errs2;
                std::istringstream ss(plaintext);
                if (!Json::parseFromStream(rb2, ss, &root, &errs2)) {
                    std::cerr << "[ChatStore] Failed to decrypt data: " << errs2 << "\n";
                    return makeDefault();
                }
            } catch (const std::exception& e) {
                std::cerr << "[ChatStore] Decrypt failed (not authenticated?): " << e.what() << "\n";
                return makeDefault();
            }
        }

        if (!root.isMember("chats"))         root["chats"]         = Json::Value(Json::arrayValue);
        if (!root.isMember("currentChatId")) root["currentChatId"] = "";
        if (!root.isMember("pins"))          root["pins"]          = Json::Value(Json::arrayValue);
        return root;
    }

    void save(const Json::Value& data) {
        std::lock_guard<std::mutex> lock(mutex);
        std::ofstream file(filePath);
        if (!file.is_open()) return;

        Json::Value toWrite = data;
        // Encrypt if we have the key and data is not already an encrypted envelope
        if (authStore_ && !(data.isMember("iv") && data.isMember("ct"))) {
            try {
                Json::StreamWriterBuilder wb;
                wb["indentation"] = "";
                std::string plaintext = Json::writeString(wb, data);
                std::string encrypted = authStore_->encryptData(plaintext);
                Json::CharReaderBuilder rb;
                std::string errs;
                std::istringstream ss(encrypted);
                if (Json::parseFromStream(rb, ss, &toWrite, &errs)) {
                    // Successfully encrypted
                }
            } catch (const std::exception& e) {
                std::cerr << "[ChatStore] Encrypt failed (not authenticated?): " << e.what() << "\n";
                // Save unencrypted as fallback
            }
        }

        Json::StreamWriterBuilder builder;
        builder["indentation"] = "    ";
        std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
        writer->write(toWrite, &file);
    }

    // Append an assistant message to a chat.
    // chatId: the chat's ID
    // parentUserId: the ID of the parent user message node (or null to append to leaf)
    // content: the assistant's response text
    // reasoning: optional reasoning/thinking content
    // toolCalls: optional JSON array of tool call objects
    // logprobs: optional JSON array of token logprobs
    // Returns true if the message was appended.
    bool appendAssistantMessage(
        const std::string& chatId,
        const std::string& parentUserId,
        const std::string& content,
        const std::string& reasoning = "",
        const Json::Value& toolCalls = Json::nullValue,
        const Json::Value& logprobs = Json::nullValue
    );
};

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);

#endif // CHAT_CONTROLLER_H