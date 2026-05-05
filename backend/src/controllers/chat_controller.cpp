#include "controllers/chat_controller.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <set>
#include <sstream>

#include "controllers/auth_controller.h"
#include "server/http_utils.h"

namespace fs = std::filesystem;

namespace {

constexpr const char* kStorageKeyField = "_storageKey";

Json::Int64 nowMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

bool validateSessionToken(const httplib::Request& req, httplib::Response& res) {
    return requireValidSession(req, res);
}

Json::Int64 normalizeTimestamp(const Json::Value& value, Json::Int64 fallback) {
    if (value.isInt64() || value.isUInt64() || value.isInt() || value.isUInt()) {
        const Json::Int64 parsed = value.asInt64();
        return parsed > 0 ? parsed : fallback;
    }
    if (value.isString()) {
        try {
            const Json::Int64 parsed = std::stoll(value.asString());
            return parsed > 0 ? parsed : fallback;
        } catch (...) {
        }
    }
    return fallback;
}

std::string stringValueOr(const Json::Value& value, const std::string& fallback = "") {
    if (value.isString()) {
        return value.asString();
    }
    return fallback;
}

bool parseJsonString(const std::string& text, Json::Value& out) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(text);
    return Json::parseFromStream(reader, stream, &out, &errors);
}

bool writeJsonFileRaw(const fs::path& path, const Json::Value& value) {
    fs::create_directories(path.parent_path());
    std::ofstream file(path);
    if (!file.is_open()) {
        return false;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(value, &file);
    return true;
}

void appendUniqueChildId(Json::Value& children, const std::string& childId) {
    if (childId.empty()) {
        return;
    }

    if (!children.isArray()) {
        children = Json::Value(Json::arrayValue);
    }

    for (const auto& value : children) {
        if (value.isString() && value.asString() == childId) {
            return;
        }
    }

    children.append(childId);
}

bool graphHasNode(const Json::Value& graph, const std::string& nodeId) {
    return !nodeId.empty() &&
           graph.isMember("nodes") &&
           graph["nodes"].isObject() &&
           graph["nodes"].isMember(nodeId);
}

Json::Value mergeGraphState(const Json::Value& currentGraph, const Json::Value& incomingGraph) {
    if (!currentGraph.isObject()) {
        return incomingGraph;
    }
    if (!incomingGraph.isObject()) {
        return currentGraph;
    }

    Json::Value merged = incomingGraph;
    if (!merged.isMember("nodes") || !merged["nodes"].isObject()) {
        merged["nodes"] = Json::Value(Json::objectValue);
    }
    if (!merged.isMember("selections") || !merged["selections"].isObject()) {
        merged["selections"] = Json::Value(Json::objectValue);
    }

    std::set<std::string> incomingNodeIds;
    if (incomingGraph.isMember("nodes") && incomingGraph["nodes"].isObject()) {
        for (const auto& nodeId : incomingGraph["nodes"].getMemberNames()) {
            incomingNodeIds.insert(nodeId);
        }
    }

    if (currentGraph.isMember("nodes") && currentGraph["nodes"].isObject()) {
        for (const auto& nodeId : currentGraph["nodes"].getMemberNames()) {
            const auto& currentNode = currentGraph["nodes"][nodeId];
            if (!merged["nodes"].isMember(nodeId)) {
                merged["nodes"][nodeId] = currentNode;
                continue;
            }

            Json::Value& mergedNode = merged["nodes"][nodeId];
            if (currentNode.isMember("children") && currentNode["children"].isArray()) {
                if (!mergedNode.isMember("children") || !mergedNode["children"].isArray()) {
                    mergedNode["children"] = Json::Value(Json::arrayValue);
                }
                for (const auto& childValue : currentNode["children"]) {
                    if (childValue.isString()) {
                        appendUniqueChildId(mergedNode["children"], childValue.asString());
                    }
                }
            }
        }
    }

    if (!merged.isMember("rootId") && currentGraph.isMember("rootId")) {
        merged["rootId"] = currentGraph["rootId"];
    }
    if (!merged.isMember("version") && currentGraph.isMember("version")) {
        merged["version"] = currentGraph["version"];
    }

    if (currentGraph.isMember("selections") && currentGraph["selections"].isObject()) {
        for (const auto& parentId : currentGraph["selections"].getMemberNames()) {
            const auto& currentSelection = currentGraph["selections"][parentId];
            if (!currentSelection.isString()) {
                continue;
            }

            const std::string currentChildId = currentSelection.asString();
            const bool currentChildWasAddedLater = incomingNodeIds.find(currentChildId) == incomingNodeIds.end();
            const bool mergedSelectionValid =
                merged["selections"].isMember(parentId) &&
                merged["selections"][parentId].isString() &&
                graphHasNode(merged, merged["selections"][parentId].asString());

            if (currentChildWasAddedLater || !mergedSelectionValid) {
                merged["selections"][parentId] = currentChildId;
            }
        }
    }

    const std::string incomingLeafId = merged.get("leafId", "").asString();
    const std::string currentLeafId = currentGraph.get("leafId", "").asString();

    if ((!incomingLeafId.empty() && !graphHasNode(merged, incomingLeafId)) ||
        (incomingLeafId.empty() && graphHasNode(merged, currentLeafId))) {
        merged["leafId"] = currentLeafId;
    } else if (!currentLeafId.empty() &&
               incomingNodeIds.find(currentLeafId) == incomingNodeIds.end() &&
               graphHasNode(merged, currentLeafId)) {
        merged["leafId"] = currentLeafId;
    }

    return merged;
}

Json::Value mergeChatState(const Json::Value& currentChat, const Json::Value& incomingChat) {
    if (!currentChat.isObject()) {
        return incomingChat;
    }
    if (!incomingChat.isObject()) {
        return currentChat;
    }

    Json::Value merged = incomingChat;

    if (currentChat.isMember("graph") && currentChat["graph"].isObject()) {
        merged["graph"] = incomingChat.isMember("graph") && incomingChat["graph"].isObject()
            ? mergeGraphState(currentChat["graph"], incomingChat["graph"])
            : currentChat["graph"];
    }

    if (!merged.isMember("createdAt") && currentChat.isMember("createdAt")) {
        merged["createdAt"] = currentChat["createdAt"];
    }

    if ((!merged.isMember("model") || merged["model"].asString().empty()) && currentChat.isMember("model")) {
        merged["model"] = currentChat["model"];
    }

    if ((!merged.isMember("toolScope") || !merged["toolScope"].isObject()) && currentChat.isMember("toolScope")) {
        merged["toolScope"] = currentChat["toolScope"];
    }

    const std::string incomingTitle = merged.get("title", "").asString();
    const std::string currentTitle = currentChat.get("title", "").asString();
    if ((incomingTitle.empty() || incomingTitle == "New Chat") &&
        !currentTitle.empty() &&
        currentTitle != "New Chat") {
        merged["title"] = currentChat["title"];
    }

    const Json::Int64 incomingUpdatedAt = merged.get("updatedAt", 0).asInt64();
    const Json::Int64 currentUpdatedAt = currentChat.get("updatedAt", 0).asInt64();
    merged["updatedAt"] = std::max(incomingUpdatedAt, currentUpdatedAt);
    return merged;
}

Json::Value mergeChatSummaryState(const Json::Value& currentSummary, const Json::Value& incomingSummary) {
    if (!currentSummary.isObject()) {
        return incomingSummary;
    }
    if (!incomingSummary.isObject()) {
        return currentSummary;
    }

    Json::Value merged = incomingSummary;

    if (!merged.isMember("createdAt") && currentSummary.isMember("createdAt")) {
        merged["createdAt"] = currentSummary["createdAt"];
    }

    if ((!merged.isMember("model") || merged["model"].asString().empty()) && currentSummary.isMember("model")) {
        merged["model"] = currentSummary["model"];
    }

    if ((!merged.isMember("toolScope") || !merged["toolScope"].isObject()) && currentSummary.isMember("toolScope")) {
        merged["toolScope"] = currentSummary["toolScope"];
    }

    if ((!merged.isMember(kStorageKeyField) || merged[kStorageKeyField].asString().empty()) &&
        currentSummary.isMember(kStorageKeyField)) {
        merged[kStorageKeyField] = currentSummary[kStorageKeyField];
    }

    const std::string incomingTitle = merged.get("title", "").asString();
    const std::string currentTitle = currentSummary.get("title", "").asString();
    if ((incomingTitle.empty() || incomingTitle == "New Chat") &&
        !currentTitle.empty() &&
        currentTitle != "New Chat") {
        merged["title"] = currentSummary["title"];
    }

    const Json::Int64 incomingUpdatedAt = merged.get("updatedAt", 0).asInt64();
    const Json::Int64 currentUpdatedAt = currentSummary.get("updatedAt", 0).asInt64();
    merged["updatedAt"] = std::max(incomingUpdatedAt, currentUpdatedAt);
    return merged;
}

std::string generateNodeId() {
    const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    std::random_device random;
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "node_%lld_%04x", static_cast<long long>(millis), random() & 0xFFFF);
    return buffer;
}

Json::Value makePinsArray(const Json::Value& pins) {
    Json::Value normalized(Json::arrayValue);
    if (!pins.isArray()) {
        return normalized;
    }

    std::set<std::string> seen;
    for (const auto& value : pins) {
        const std::string id = stringValueOr(value);
        if (!id.empty() && seen.insert(id).second) {
            normalized.append(id);
        }
    }
    return normalized;
}

Json::Value* findChatById(Json::Value& chats, const std::string& chatId) {
    if (!chats.isArray() || chatId.empty()) {
        return nullptr;
    }
    for (auto& chat : chats) {
        if (chat.isObject() && chat.get("id", "").asString() == chatId) {
            return &chat;
        }
    }
    return nullptr;
}

const Json::Value* findChatById(const Json::Value& chats, const std::string& chatId) {
    if (!chats.isArray() || chatId.empty()) {
        return nullptr;
    }
    for (const auto& chat : chats) {
        if (chat.isObject() && chat.get("id", "").asString() == chatId) {
            return &chat;
        }
    }
    return nullptr;
}

} // namespace

ChatStore::ChatStore(const std::string& directoryPath, AuthStore* authStore, const std::string& legacyFilePath)
    : directoryPath_(directoryPath),
      indexFilePath_(directoryPath_ / "index.json"),
      legacyFilePath_(legacyFilePath.empty() ? directoryPath_.parent_path() / "chats.json" : fs::path(legacyFilePath)),
      authStore_(authStore) {}

Json::Value ChatStore::makeDefaultRoot() const {
    Json::Value root(Json::objectValue);
    root["chats"] = Json::Value(Json::arrayValue);
    root["currentChatId"] = "";
    root["pins"] = Json::Value(Json::arrayValue);
    return root;
}

Json::Value ChatStore::makeDefaultGraph() const {
    Json::Value graph(Json::objectValue);
    graph["version"] = 1;
    graph["rootId"] = "root";
    graph["leafId"] = Json::nullValue;
    graph["selections"] = Json::Value(Json::objectValue);

    Json::Value rootNode(Json::objectValue);
    rootNode["id"] = "root";
    rootNode["role"] = "system";
    rootNode["content"] = "";
    rootNode["timestamp"] = 0;
    rootNode["parentId"] = Json::nullValue;
    rootNode["children"] = Json::Value(Json::arrayValue);

    Json::Value nodes(Json::objectValue);
    nodes["root"] = rootNode;
    graph["nodes"] = nodes;
    return graph;
}

Json::Value ChatStore::makeDefaultChat() const {
    const Json::Int64 createdAt = nowMillis();
    Json::Value chat(Json::objectValue);
    chat["id"] = "";
    chat["title"] = "New Chat";
    chat["createdAt"] = createdAt;
    chat["updatedAt"] = createdAt;
    chat["graph"] = makeDefaultGraph();
    return chat;
}

bool ChatStore::isEncryptedEnvelope(const Json::Value& root) const {
    return root.isObject() && root.isMember("iv") && root.isMember("ct");
}

Json::Value ChatStore::normalizeRoot(Json::Value root) const {
    if (!root.isObject()) {
        root = makeDefaultRoot();
    }
    if (!root.isMember("chats") || !root["chats"].isArray()) {
        root["chats"] = Json::Value(Json::arrayValue);
    }
    if (!root.isMember("currentChatId") || !root["currentChatId"].isString()) {
        root["currentChatId"] = "";
    }
    root["pins"] = makePinsArray(root["pins"]);
    return root;
}

Json::Value ChatStore::normalizeChat(Json::Value chat) const {
    Json::Value normalized = makeDefaultChat();
    if (!chat.isObject()) {
        return normalized;
    }

    const Json::Int64 fallbackCreatedAt = normalizeTimestamp(chat["updatedAt"], nowMillis());
    const Json::Int64 createdAt = normalizeTimestamp(chat["createdAt"], fallbackCreatedAt);
    const Json::Int64 updatedAt = std::max(normalizeTimestamp(chat["updatedAt"], createdAt), createdAt);

    normalized["id"] = stringValueOr(chat["id"]);
    normalized["title"] = stringValueOr(chat["title"], "New Chat");
    normalized["createdAt"] = createdAt;
    normalized["updatedAt"] = updatedAt;

    if (chat.isMember("model") && chat["model"].isString() && !chat["model"].asString().empty()) {
        normalized["model"] = chat["model"];
    } else {
        normalized.removeMember("model");
    }

    if (chat.isMember("toolScope") && chat["toolScope"].isObject()) {
        normalized["toolScope"] = chat["toolScope"];
    } else {
        normalized.removeMember("toolScope");
    }

    if (chat.isMember("graph") && chat["graph"].isObject()) {
        normalized["graph"] = chat["graph"];
    }

    if (!normalized["graph"].isObject()) {
        normalized["graph"] = makeDefaultGraph();
    }
    if (!normalized["graph"].isMember("nodes") || !normalized["graph"]["nodes"].isObject()) {
        normalized["graph"]["nodes"] = Json::Value(Json::objectValue);
    }
    if (!normalized["graph"].isMember("selections") || !normalized["graph"]["selections"].isObject()) {
        normalized["graph"]["selections"] = Json::Value(Json::objectValue);
    }
    if (!normalized["graph"].isMember("rootId") || !normalized["graph"]["rootId"].isString() ||
        normalized["graph"]["rootId"].asString().empty()) {
        normalized["graph"]["rootId"] = "root";
    }

    const std::string rootId = normalized["graph"]["rootId"].asString();
    if (!normalized["graph"]["nodes"].isMember(rootId) || !normalized["graph"]["nodes"][rootId].isObject()) {
        Json::Value rootNode(Json::objectValue);
        rootNode["id"] = rootId;
        rootNode["role"] = "system";
        rootNode["content"] = "";
        rootNode["timestamp"] = 0;
        rootNode["parentId"] = Json::nullValue;
        rootNode["children"] = Json::Value(Json::arrayValue);
        normalized["graph"]["nodes"][rootId] = rootNode;
    }

    return normalized;
}

Json::Value ChatStore::stripInternalRootFields(Json::Value root) const {
    root = normalizeRoot(root);
    for (auto& chat : root["chats"]) {
        if (chat.isObject()) {
            chat.removeMember(kStorageKeyField);
        }
    }
    return root;
}

Json::Value ChatStore::readJsonFileUnlocked(const fs::path& path, const Json::Value& fallback) const {
    std::ifstream file(path);
    if (!file.is_open()) {
        return fallback;
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    Json::Value root;
    if (!Json::parseFromStream(reader, file, &root, &errors)) {
        return fallback;
    }

    if (isEncryptedEnvelope(root) && authStore_) {
        try {
            const std::string plaintext = authStore_->decryptData(root);
            std::istringstream stream(plaintext);
            Json::Value decrypted;
            if (Json::parseFromStream(reader, stream, &decrypted, &errors)) {
                root = decrypted;
            } else {
                return fallback;
            }
        } catch (...) {
            return fallback;
        }
    }

    return root;
}

void ChatStore::writeJsonFileUnlocked(const fs::path& path, const Json::Value& value) const {
    Json::Value toWrite = value;

    if (authStore_ && !isEncryptedEnvelope(toWrite)) {
        try {
            const std::string encrypted = authStore_->encryptData(writeJson(toWrite));
            Json::CharReaderBuilder reader;
            std::string errors;
            std::istringstream stream(encrypted);
            Json::Value envelope;
            if (Json::parseFromStream(reader, stream, &envelope, &errors)) {
                toWrite = envelope;
            }
        } catch (...) {
            // Fall back to plaintext if the store is not currently unlocked.
        }
    }

    fs::create_directories(path.parent_path());
    std::ofstream file(path);
    if (!file.is_open()) {
        return;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(toWrite, &file);
}

std::string ChatStore::storageKeyForSummary(const Json::Value& summary) const {
    if (summary.isObject() && summary.isMember(kStorageKeyField) && summary[kStorageKeyField].isString()) {
        const std::string key = summary[kStorageKeyField].asString();
        if (!key.empty()) {
            return key;
        }
    }

    const Json::Int64 createdAt = normalizeTimestamp(summary["createdAt"], nowMillis());
    return std::to_string(createdAt);
}

fs::path ChatStore::chatFilePathForSummary(const Json::Value& summary) const {
    return directoryPath_ / (storageKeyForSummary(summary) + ".json");
}

Json::Value ChatStore::buildChatSummary(const Json::Value& chat, const Json::Value* existingSummary) const {
    Json::Value summary(Json::objectValue);

    const Json::Int64 fallbackCreatedAt = existingSummary
        ? normalizeTimestamp((*existingSummary)["createdAt"], nowMillis())
        : nowMillis();
    const Json::Int64 createdAt = normalizeTimestamp(chat["createdAt"], fallbackCreatedAt);
    const Json::Int64 updatedAt = std::max(
        normalizeTimestamp(chat["updatedAt"], createdAt),
        existingSummary ? normalizeTimestamp((*existingSummary)["updatedAt"], createdAt) : createdAt);

    summary["id"] = stringValueOr(chat["id"], existingSummary ? stringValueOr((*existingSummary)["id"]) : "");
    summary["title"] = stringValueOr(chat["title"], existingSummary ? stringValueOr((*existingSummary)["title"], "New Chat") : "New Chat");
    summary["createdAt"] = createdAt;
    summary["updatedAt"] = updatedAt;

    if (chat.isMember("model") && chat["model"].isString() && !chat["model"].asString().empty()) {
        summary["model"] = chat["model"];
    } else if (existingSummary && existingSummary->isMember("model") && (*existingSummary)["model"].isString()) {
        summary["model"] = (*existingSummary)["model"];
    }

    if (chat.isMember("toolScope") && chat["toolScope"].isObject()) {
        summary["toolScope"] = chat["toolScope"];
    } else if (existingSummary && existingSummary->isMember("toolScope") && (*existingSummary)["toolScope"].isObject()) {
        summary["toolScope"] = (*existingSummary)["toolScope"];
    }

    if (existingSummary && existingSummary->isMember(kStorageKeyField) && (*existingSummary)[kStorageKeyField].isString()) {
        summary[kStorageKeyField] = (*existingSummary)[kStorageKeyField];
    } else {
        summary[kStorageKeyField] = std::to_string(createdAt);
    }

    return summary;
}

Json::Value ChatStore::applySummaryToChat(Json::Value chat, const Json::Value& summary) const {
    chat = normalizeChat(chat);

    if (summary.isObject()) {
        if (summary.isMember("id")) {
            chat["id"] = summary["id"];
        }
        if (summary.isMember("title")) {
            chat["title"] = summary["title"];
        }
        if (summary.isMember("createdAt")) {
            chat["createdAt"] = summary["createdAt"];
        }
        if (summary.isMember("updatedAt")) {
            chat["updatedAt"] = summary["updatedAt"];
        }
        if (summary.isMember("model") && summary["model"].isString() && !summary["model"].asString().empty()) {
            chat["model"] = summary["model"];
        } else {
            chat.removeMember("model");
        }
        if (summary.isMember("toolScope") && summary["toolScope"].isObject()) {
            chat["toolScope"] = summary["toolScope"];
        } else {
            chat.removeMember("toolScope");
        }
    }

    return chat;
}

Json::Value ChatStore::migrateLegacyStoreUnlocked() {
    if (fs::exists(indexFilePath_)) {
        return normalizeRoot(readJsonFileUnlocked(indexFilePath_, makeDefaultRoot()));
    }

    fs::create_directories(directoryPath_);

    Json::Value legacyRoot = normalizeRoot(readJsonFileUnlocked(legacyFilePath_, makeDefaultRoot()));
    if (!legacyRoot["chats"].isArray() || legacyRoot["chats"].empty()) {
        const Json::Value emptyRoot = makeDefaultRoot();
        writeJsonFileUnlocked(indexFilePath_, emptyRoot);
        return emptyRoot;
    }

    Json::Value migrated = makeDefaultRoot();
    migrated["currentChatId"] = legacyRoot.get("currentChatId", "");
    migrated["pins"] = makePinsArray(legacyRoot["pins"]);

    std::set<Json::Int64> usedCreatedAt;
    for (const auto& legacyChat : legacyRoot["chats"]) {
        Json::Value fullChat = normalizeChat(legacyChat);
        Json::Int64 createdAt = normalizeTimestamp(fullChat["createdAt"], nowMillis());
        while (usedCreatedAt.find(createdAt) != usedCreatedAt.end()) {
            ++createdAt;
        }
        usedCreatedAt.insert(createdAt);
        fullChat["createdAt"] = createdAt;
        if (normalizeTimestamp(fullChat["updatedAt"], createdAt) < createdAt) {
            fullChat["updatedAt"] = createdAt;
        }

        Json::Value summary = buildChatSummary(fullChat, nullptr);
        saveChatFileUnlocked(summary, fullChat);
        migrated["chats"].append(summary);
    }

    writeJsonFileUnlocked(indexFilePath_, migrated);
    return migrated;
}

Json::Value ChatStore::loadRootUnlocked() {
    fs::create_directories(directoryPath_);
    if (!fs::exists(indexFilePath_)) {
        return migrateLegacyStoreUnlocked();
    }
    return normalizeRoot(readJsonFileUnlocked(indexFilePath_, makeDefaultRoot()));
}

void ChatStore::saveRootUnlocked(const Json::Value& root) const {
    writeJsonFileUnlocked(indexFilePath_, normalizeRoot(root));
}

Json::Value ChatStore::loadChatFileUnlocked(const Json::Value& summary) const {
    Json::Value chat = readJsonFileUnlocked(chatFilePathForSummary(summary), Json::Value(Json::objectValue));
    if (!chat.isObject()) {
        chat = Json::Value(Json::objectValue);
    }
    return applySummaryToChat(chat, summary);
}

void ChatStore::saveChatFileUnlocked(const Json::Value& summary, const Json::Value& chat) const {
    writeJsonFileUnlocked(chatFilePathForSummary(summary), normalizeChat(chat));
}

Json::Value ChatStore::loadSummaries() {
    std::lock_guard<std::mutex> lock(mutex_);
    return stripInternalRootFields(loadRootUnlocked());
}

Json::Value ChatStore::loadChat(const std::string& chatId) {
    std::lock_guard<std::mutex> lock(mutex_);

    const Json::Value root = loadRootUnlocked();
    const Json::Value* summary = findChatById(root["chats"], chatId);
    if (!summary) {
        return Json::Value(Json::nullValue);
    }

    return loadChatFileUnlocked(*summary);
}

Json::Value ChatStore::saveSummariesMerged(const Json::Value& incoming) {
    std::lock_guard<std::mutex> lock(mutex_);

    const Json::Value currentRoot = loadRootUnlocked();
    Json::Value merged = normalizeRoot(currentRoot);

    if (incoming.isObject()) {
        if (incoming.isMember("currentChatId") && incoming["currentChatId"].isString()) {
            merged["currentChatId"] = incoming["currentChatId"];
        }
        if (incoming.isMember("pins")) {
            merged["pins"] = makePinsArray(incoming["pins"]);
        }

        if (incoming.isMember("chats") && incoming["chats"].isArray()) {
            Json::Value nextChats(Json::arrayValue);
            std::set<std::string> seenIds;

            for (const auto& incomingChat : incoming["chats"]) {
                if (!incomingChat.isObject()) {
                    continue;
                }

                Json::Value incomingSummary = buildChatSummary(incomingChat, nullptr);
                const std::string chatId = incomingSummary.get("id", "").asString();
                if (chatId.empty() || !seenIds.insert(chatId).second) {
                    continue;
                }

                const Json::Value* currentSummary = findChatById(currentRoot["chats"], chatId);
                if (currentSummary) {
                    incomingSummary = mergeChatSummaryState(*currentSummary, incomingSummary);
                }

                nextChats.append(incomingSummary);
            }

            for (const auto& currentChat : currentRoot["chats"]) {
                const std::string chatId = currentChat.get("id", "").asString();
                if (!chatId.empty() && seenIds.insert(chatId).second) {
                    nextChats.append(currentChat);
                }
            }

            merged["chats"] = nextChats;
        }
    }

    saveRootUnlocked(merged);
    return stripInternalRootFields(merged);
}

Json::Value ChatStore::saveChatMerged(const Json::Value& incomingChat) {
    std::lock_guard<std::mutex> lock(mutex_);

    Json::Value normalizedIncoming = normalizeChat(incomingChat);
    const std::string chatId = normalizedIncoming.get("id", "").asString();
    if (chatId.empty()) {
        return Json::Value(Json::nullValue);
    }

    Json::Value root = loadRootUnlocked();
    Json::Value* summary = findChatById(root["chats"], chatId);
    const Json::Value existingSummary = summary ? *summary : Json::Value(Json::objectValue);
    Json::Value currentChat = summary ? loadChatFileUnlocked(*summary) : makeDefaultChat();
    if (summary && existingSummary.isObject()) {
        currentChat = applySummaryToChat(currentChat, existingSummary);
    }

    Json::Int64 createdAt = normalizeTimestamp(normalizedIncoming["createdAt"], nowMillis());
    std::set<Json::Int64> usedCreatedAt;
    for (const auto& existingChat : root["chats"]) {
        if (!existingChat.isObject() || existingChat.get("id", "").asString() == chatId) {
            continue;
        }
        usedCreatedAt.insert(normalizeTimestamp(existingChat["createdAt"], 0));
    }
    while (usedCreatedAt.find(createdAt) != usedCreatedAt.end()) {
        ++createdAt;
    }
    normalizedIncoming["createdAt"] = createdAt;
    if (normalizeTimestamp(normalizedIncoming["updatedAt"], createdAt) < createdAt) {
        normalizedIncoming["updatedAt"] = createdAt;
    }

    Json::Value mergedChat = summary ? mergeChatState(currentChat, normalizedIncoming) : normalizedIncoming;
    mergedChat = normalizeChat(mergedChat);

    Json::Value nextSummary = buildChatSummary(mergedChat, summary ? &existingSummary : nullptr);
    if (summary) {
        *summary = nextSummary;
    } else {
        root["chats"].append(nextSummary);
    }

    saveChatFileUnlocked(nextSummary, mergedChat);
    saveRootUnlocked(root);
    return mergedChat;
}

bool ChatStore::deleteChat(const std::string& chatId) {
    std::lock_guard<std::mutex> lock(mutex_);

    Json::Value root = loadRootUnlocked();
    if (!root["chats"].isArray()) {
        return false;
    }

    Json::Value remaining(Json::arrayValue);
    Json::Value deletedSummary(Json::nullValue);
    for (const auto& chat : root["chats"]) {
        if (chat.isObject() && chat.get("id", "").asString() == chatId) {
            deletedSummary = chat;
            continue;
        }
        remaining.append(chat);
    }

    if (deletedSummary.isNull()) {
        return false;
    }

    root["chats"] = remaining;
    if (root.get("currentChatId", "").asString() == chatId) {
        root["currentChatId"] = remaining.empty() ? "" : remaining[0].get("id", "");
    }

    Json::Value nextPins(Json::arrayValue);
    for (const auto& value : root["pins"]) {
        if (value.isString() && value.asString() != chatId) {
            nextPins.append(value);
        }
    }
    root["pins"] = nextPins;

    std::error_code ec;
    fs::remove(chatFilePathForSummary(deletedSummary), ec);
    saveRootUnlocked(root);
    return true;
}

bool ChatStore::rotateEncryptionKey(const std::vector<uint8_t>& previousKey,
                                    const std::vector<uint8_t>& nextKey) {
    if (previousKey.empty() || nextKey.empty()) {
        return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    fs::create_directories(directoryPath_);

    std::vector<fs::path> files;
    if (fs::exists(indexFilePath_)) {
        files.push_back(indexFilePath_);
    }

    if (fs::exists(directoryPath_)) {
        for (const auto& entry : fs::directory_iterator(directoryPath_)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".json") {
                continue;
            }
            if (entry.path() == indexFilePath_) {
                continue;
            }
            files.push_back(entry.path());
        }
    }

    for (const auto& path : files) {
        const Json::Value raw = readJsonFileUnlocked(path, Json::Value(Json::nullValue));
        Json::Value plaintextValue = raw;

        if (isEncryptedEnvelope(raw)) {
            try {
                const std::string plaintext = CryptoService::decryptWithKey(raw, previousKey);
                if (!parseJsonString(plaintext, plaintextValue)) {
                    return false;
                }
            } catch (...) {
                return false;
            }
        }

        Json::Value nextEnvelope;
        try {
            const std::string encrypted = CryptoService::encrypt(writeJson(plaintextValue), nextKey);
            if (!parseJsonString(encrypted, nextEnvelope)) {
                return false;
            }
        } catch (...) {
            return false;
        }

        if (!writeJsonFileRaw(path, nextEnvelope)) {
            return false;
        }
    }

    return true;
}

bool ChatStore::appendAssistantMessage(
    const std::string& chatId,
    const std::string& parentUserId,
    const std::string& content,
    const std::string& reasoning,
    const Json::Value& parts,
    const Json::Value& reasoningParts,
    const Json::Value& toolCalls,
    const Json::Value& logprobs) {
    std::lock_guard<std::mutex> lock(mutex_);

    Json::Value root = loadRootUnlocked();
    Json::Value* summary = findChatById(root["chats"], chatId);
    if (!summary) {
        return false;
    }

    Json::Value chat = loadChatFileUnlocked(*summary);
    if (!chat.isObject() || !chat.isMember("graph") || !chat["graph"].isObject()) {
        return false;
    }

    Json::Value& graph = chat["graph"];
    if (!graph.isMember("nodes") || !graph["nodes"].isObject()) {
        return false;
    }
    if (!graph.isMember("selections") || !graph["selections"].isObject()) {
        graph["selections"] = Json::Value(Json::objectValue);
    }

    Json::Value& nodes = graph["nodes"];
    std::string parentId = parentUserId;
    if (parentId.empty()) {
        parentId = graph.get("leafId", "").asString();
        if (parentId.empty()) {
            parentId = graph.get("rootId", "").asString();
        }
    }

    if (!nodes.isMember(parentId)) {
        parentId = graph.get("rootId", "").asString();
        if (parentId.empty() || !nodes.isMember(parentId)) {
            return false;
        }
    }

    const Json::Int64 millis = nowMillis();
    const std::string nodeId = generateNodeId();

    Json::Value node(Json::objectValue);
    node["id"] = nodeId;
    node["role"] = "assistant";
    node["timestamp"] = millis;
    node["parentId"] = parentId;
    node["children"] = Json::Value(Json::arrayValue);
    if (!content.empty()) {
        node["content"] = content;
    }
    if (parts.isArray() && !parts.empty()) {
        node["parts"] = parts;
    }
    if (!reasoning.empty()) {
        node["reasoning"] = reasoning;
    }
    if (reasoningParts.isArray() && !reasoningParts.empty()) {
        node["reasoningParts"] = reasoningParts;
    }
    if (toolCalls.isArray() && !toolCalls.empty()) {
        node["toolCalls"] = toolCalls;
    }
    if (logprobs.isArray() && !logprobs.empty()) {
        node["tokenLogprobs"] = logprobs;
    }

    nodes[nodeId] = node;
    appendUniqueChildId(nodes[parentId]["children"], nodeId);
    graph["selections"][parentId] = nodeId;
    graph["leafId"] = nodeId;
    chat["updatedAt"] = millis;

    *summary = buildChatSummary(chat, summary);
    saveChatFileUnlocked(*summary, chat);
    saveRootUnlocked(root);
    return true;
}

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    if (!validateSessionToken(req, res)) {
        return;
    }
    setJson(res, store.loadSummaries());
}

void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    if (!validateSessionToken(req, res)) {
        return;
    }

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    setJson(res, store.saveSummariesMerged(body));
}

void handleGetChat(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    if (!validateSessionToken(req, res)) {
        return;
    }

    const std::string chatId = req.matches.size() > 1 ? req.matches[1].str() : "";
    const Json::Value chat = store.loadChat(chatId);
    if (chat.isNull()) {
        setJsonError(res, 404, "Chat not found");
        return;
    }
    setJson(res, chat);
}

void handleSaveChat(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    if (!validateSessionToken(req, res)) {
        return;
    }

    Json::Value body;
    if (!parseJsonBody(req.body, body, res)) {
        return;
    }

    if (!body.isObject()) {
        setJsonError(res, 400, "Chat payload must be an object");
        return;
    }

    const std::string chatId = req.matches.size() > 1 ? req.matches[1].str() : "";
    if (chatId.empty()) {
        setJsonError(res, 400, "Chat id is required");
        return;
    }

    body["id"] = chatId;
    const Json::Value saved = store.saveChatMerged(body);
    if (saved.isNull()) {
        setJsonError(res, 400, "Invalid chat payload");
        return;
    }
    setJson(res, saved);
}

void handleDeleteChat(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    if (!validateSessionToken(req, res)) {
        return;
    }

    const std::string chatId = req.matches.size() > 1 ? req.matches[1].str() : "";
    if (!store.deleteChat(chatId)) {
        setJsonError(res, 404, "Chat not found");
        return;
    }

    Json::Value result(Json::objectValue);
    result["success"] = true;
    setJson(res, result);
}
