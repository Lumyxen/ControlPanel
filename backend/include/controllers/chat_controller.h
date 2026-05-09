#ifndef CHAT_CONTROLLER_H
#define CHAT_CONTROLLER_H

#include <filesystem>
#include <json/json.h>
#include <mutex>
#include <string>

#include "controllers/auth_controller.h"
#include "httplib.h"

class ChatStore {
public:
    explicit ChatStore(
        const std::string& directoryPath,
        AuthStore* authStore = nullptr,
        const std::string& legacyFilePath = "");

    Json::Value loadSummaries();
    Json::Value loadChat(const std::string& chatId);
    Json::Value saveSummariesMerged(const Json::Value& incoming);
    Json::Value saveChatMerged(const Json::Value& incomingChat);
    bool deleteChat(const std::string& chatId);
    bool rotateEncryptionKey(const std::vector<uint8_t>& previousKey,
                             const std::vector<uint8_t>& nextKey);

    bool appendAssistantMessage(
        const std::string& chatId,
        const std::string& parentUserId,
        const std::string& content,
        const std::string& reasoning = "",
        const Json::Value& parts = Json::nullValue,
        const Json::Value& reasoningParts = Json::nullValue,
        const Json::Value& toolCalls = Json::nullValue,
        const Json::Value& logprobs = Json::nullValue,
        const Json::Value& revisionTrace = Json::nullValue);

private:
    Json::Value makeDefaultRoot() const;
    Json::Value makeDefaultGraph() const;
    Json::Value makeDefaultChat() const;
    Json::Value normalizeRoot(Json::Value root) const;
    Json::Value normalizeChat(Json::Value chat) const;
    Json::Value stripInternalRootFields(Json::Value root) const;

    Json::Value loadRootUnlocked();
    void saveRootUnlocked(const Json::Value& root) const;
    Json::Value migrateLegacyStoreUnlocked();

    Json::Value readJsonFileUnlocked(const std::filesystem::path& path, const Json::Value& fallback) const;
    void writeJsonFileUnlocked(const std::filesystem::path& path, const Json::Value& value) const;
    bool isEncryptedEnvelope(const Json::Value& root) const;

    std::filesystem::path chatFilePathForSummary(const Json::Value& summary) const;
    Json::Value loadChatFileUnlocked(const Json::Value& summary) const;
    void saveChatFileUnlocked(const Json::Value& summary, const Json::Value& chat) const;

    std::string storageKeyForSummary(const Json::Value& summary) const;
    Json::Value buildChatSummary(const Json::Value& chat, const Json::Value* existingSummary = nullptr) const;
    Json::Value applySummaryToChat(Json::Value chat, const Json::Value& summary) const;

    std::filesystem::path directoryPath_;
    std::filesystem::path indexFilePath_;
    std::filesystem::path legacyFilePath_;
    mutable std::mutex mutex_;
    AuthStore* authStore_;
};

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleGetChat(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleSaveChat(const httplib::Request& req, httplib::Response& res, ChatStore& store);
void handleDeleteChat(const httplib::Request& req, httplib::Response& res, ChatStore& store);

#endif // CHAT_CONTROLLER_H
