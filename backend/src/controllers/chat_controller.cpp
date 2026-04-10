#include "controllers/chat_controller.h"
#include "services/crypto_service.h"
#include "controllers/auth_controller.h"
#include <json/json.h>
#include <sstream>
#include <iostream>
#include <chrono>
#include <random>
#include <cstdlib>

// Auth validation helper
static bool validateSessionToken(const httplib::Request& req, httplib::Response& res) {
    std::string token;
    if (req.has_header("X-Session-Token")) {
        token = req.get_header_value("X-Session-Token");
    }
    if (token.empty() || !SessionManager::instance().isValid(token)) {
        res.status = 401;
        res.set_content("{\"error\":\"Not authenticated\"}", "application/json");
        return false;
    }
    return true;
}

void handleGetChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    try {
        if (!validateSessionToken(req, res)) return;
        Json::Value data = store.load();
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        res.status = 200;
        res.set_content(Json::writeString(writer, data), "application/json");
    } catch (const std::exception& e) {
        std::cerr << "[ChatController] GET /api/chats error: " << e.what() << "\n";
        res.status = 500;
        res.set_content("{\"error\": \"Internal server error\"}", "application/json");
    }
}

void handleSaveChats(const httplib::Request& req, httplib::Response& res, ChatStore& store) {
    try {
        if (!validateSessionToken(req, res)) return;
        Json::Value requestBody;
        Json::CharReaderBuilder reader;
        std::string errs;
        std::istringstream stream(req.body);
        if (!Json::parseFromStream(reader, stream, &requestBody, &errs)) {
            res.status = 400;
            res.set_content("{\"error\": \"Invalid JSON\"}", "application/json");
            return;
        }
        store.save(requestBody);
        Json::StreamWriterBuilder writer;
        writer["indentation"] = "";
        res.status = 200;
        res.set_content(Json::writeString(writer, requestBody), "application/json");
    } catch (const std::exception& e) {
        std::cerr << "[ChatController] PUT /api/chats error: " << e.what() << "\n";
        res.status = 500;
        res.set_content("{\"error\": \"Internal server error\"}", "application/json");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// appendAssistantMessage
// ─────────────────────────────────────────────────────────────────────────────

bool ChatStore::appendAssistantMessage(
    const std::string& chatId,
    const std::string& parentUserId,
    const std::string& content,
    const std::string& reasoning,
    const Json::Value& toolCalls,
    const Json::Value& logprobs
) {
    std::lock_guard<std::mutex> lock(mutex);

    // Load and decrypt if needed (uses same logic as load())
    Json::Value root;
    {
        std::ifstream fileIn(filePath);
        if (!fileIn.is_open()) {
            std::cerr << "[ChatStore] Cannot open file: " << filePath << "\n";
            return false;
        }

        Json::CharReaderBuilder builder;
        std::string errs;
        if (!Json::parseFromStream(builder, fileIn, &root, &errs)) {
            std::cerr << "[ChatStore] Cannot parse file: " << errs << "\n";
            return false;
        }
        fileIn.close();
    }

    // Decrypt if needed
    if ((root.isMember("_enc") && root["_enc"].asBool()) && authStore_) {
        try {
            std::string plaintext = authStore_->decryptData(root);
            Json::CharReaderBuilder rb2;
            std::string errs2;
            std::istringstream ss(plaintext);
            if (!Json::parseFromStream(rb2, ss, &root, &errs2)) {
                std::cerr << "[ChatStore] Cannot parse decrypted data: " << errs2 << "\n";
                return false;
            }
        } catch (const std::exception& e) {
            std::cerr << "[ChatStore] Decrypt failed: " << e.what() << "\n";
            return false;
        }
    }

    // Find the chat
    if (!root.isMember("chats") || !root["chats"].isArray()) {
        std::cerr << "[ChatStore] No chats array\n";
        return false;
    }
    Json::Value& chats = root["chats"];
    Json::Value* chat = nullptr;
    for (auto& c : chats) {
        if (c.isMember("id") && c["id"].asString() == chatId) {
            chat = &c;
            break;
        }
    }
    if (!chat) {
        std::cerr << "[ChatStore] Chat not found: " << chatId << "\n";
        return false;
    }

    // Ensure graph structure
    if (!chat->isMember("graph") || !(*chat)["graph"].isObject()) {
        std::cerr << "[ChatStore] Chat has no graph\n";
        return false;
    }

    Json::Value& graph = (*chat)["graph"];
    if (!graph.isMember("nodes") || !graph["nodes"].isObject()) {
        std::cerr << "[ChatStore] Graph has no nodes\n";
        return false;
    }
    if (!graph.isMember("selections") || !graph["selections"].isObject()) {
        graph["selections"] = Json::Value(Json::objectValue);
    }

    Json::Value& nodes = graph["nodes"];

    // Determine the parent node
    std::string parentId = parentUserId;
    if (parentId.empty()) {
        if (graph.isMember("leafId") && !graph["leafId"].isNull()) {
            parentId = graph["leafId"].asString();
        } else {
            parentId = graph["rootId"].asString();
        }
    }

    // If parent doesn't exist in nodes, use root
    if (!nodes.isMember(parentId)) {
        std::string rootId = graph["rootId"].asString();
        if (nodes.isMember(rootId)) {
            std::cerr << "[ChatStore] Parent " << parentUserId << " not found, using root " << rootId << "\n";
            parentId = rootId;
        } else {
            std::cerr << "[ChatStore] Neither parent " << parentUserId << " nor root exist\n";
            return false;
        }
    }

    // Create the assistant node
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    std::random_device rd;
    char nodeId[64];
    snprintf(nodeId, sizeof(nodeId), "node_%lld_%04x", (long long)ms, rd() & 0xFFFF);

    Json::Value node;
    node["id"] = nodeId;
    node["role"] = "assistant";
    node["timestamp"] = ms;
    node["parentId"] = parentId;
    node["children"] = Json::Value(Json::arrayValue);

    if (!content.empty()) node["content"] = content;
    if (!reasoning.empty()) node["reasoning"] = reasoning;
    if (toolCalls.isArray() && toolCalls.size() > 0) node["toolCalls"] = toolCalls;
    if (logprobs.isArray() && logprobs.size() > 0) node["tokenLogprobs"] = logprobs;

    nodes[nodeId] = node;

    // Link to parent
    if (!nodes[parentId].isMember("children") || !nodes[parentId]["children"].isArray()) {
        nodes[parentId]["children"] = Json::Value(Json::arrayValue);
    }
    nodes[parentId]["children"].append(nodeId);
    graph["selections"][parentId] = nodeId;
    graph["leafId"] = nodeId;

    // Update chat metadata
    (*chat)["updatedAt"] = ms;

    // Save - encrypt if we have the key
    std::ofstream fileOut(filePath);
    if (!fileOut.is_open()) {
        std::cerr << "[ChatStore] Cannot write to file: " << filePath << "\n";
        return false;
    }

    Json::Value toWrite = root;
    if (authStore_) {
        try {
            Json::StreamWriterBuilder wbPlain;
            wbPlain["indentation"] = "";
            std::string plaintext = Json::writeString(wbPlain, root);
            std::string encrypted = authStore_->encryptData(plaintext);
            Json::CharReaderBuilder rbEnc;
            std::string errsEnc;
            std::istringstream ssEnc(encrypted);
            if (Json::parseFromStream(rbEnc, ssEnc, &toWrite, &errsEnc)) {
                // Successfully encrypted, toWrite now has { _enc, iv, ct }
            }
        } catch (const std::exception& e) {
            std::cerr << "[ChatStore] Encrypt failed: " << e.what() << "\n";
            // Fall through — save unencrypted
        }
    }

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(wb.newStreamWriter());
    writer->write(toWrite, &fileOut);

    std::cout << "[ChatStore] Appended assistant node " << nodeId
              << " to chat " << chatId
              << " (parent=" << parentId << ", content_len=" << content.size()
              << ", reasoning_len=" << reasoning.size() << ")\n";
    return true;
}