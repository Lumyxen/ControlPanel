#include "services/tools/assistant_workspace_tool.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <utility>

namespace fs = std::filesystem;

namespace {

constexpr int kMaxNotes = 200;
constexpr int kMaxTodos = 500;
constexpr int kDefaultResultLimit = 100;
constexpr std::size_t kMaxTitleLength = 240;
constexpr std::size_t kMaxNoteContentLength = 24000;
constexpr std::size_t kMaxTodoDetailsLength = 12000;

std::mutex gStorageMutex;
std::atomic<unsigned long long> gIdSequence{1};

Json::Int64 nowMillis() {
    return static_cast<Json::Int64>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

Json::Value makeError(const std::string& message) {
    Json::Value error(Json::objectValue);
    error["error"] = message;
    return error;
}

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string getStringArg(const Json::Value& value, const std::string& key, const std::string& fallback = "") {
    if (value.isObject() && value.isMember(key) && value[key].isString()) {
        return value[key].asString();
    }
    return fallback;
}

int getIntArg(const Json::Value& value, const std::string& key, int fallback) {
    if (value.isObject() && value.isMember(key) && value[key].isInt()) {
        return value[key].asInt();
    }
    return fallback;
}

bool hasStringArg(const Json::Value& value, const std::string& key) {
    return value.isObject() && value.isMember(key) && value[key].isString();
}

bool exceedsLimit(const std::string& value, std::size_t limit) {
    return value.size() > limit;
}

std::string fnv1a64Hex(const std::string& input) {
    std::uint64_t hash = 14695981039346656037ULL;
    for (unsigned char ch : input) {
        hash ^= static_cast<std::uint64_t>(ch);
        hash *= 1099511628211ULL;
    }

    std::ostringstream stream;
    stream << std::hex << std::setw(16) << std::setfill('0') << hash;
    return stream.str();
}

std::string encodeChatIdForPath(const std::string& chatId) {
    std::ostringstream stream;
    stream << std::hex << std::uppercase << std::setfill('0');
    for (unsigned char ch : chatId) {
        if (std::isalnum(ch) || ch == '-' || ch == '_') {
            stream << static_cast<char>(ch);
        } else {
            stream << '_' << std::setw(2) << static_cast<int>(ch);
        }
    }

    std::string encoded = stream.str();
    if (encoded.empty()) {
        encoded = "chat";
    }
    if (encoded.size() > 120) {
        encoded = encoded.substr(0, 80) + "_" + fnv1a64Hex(chatId);
    }
    return encoded;
}

std::string makeId(const std::string& prefix) {
    return prefix + "_" + std::to_string(nowMillis()) + "_" + std::to_string(gIdSequence.fetch_add(1));
}

fs::path statePathForChat(const fs::path& storageRoot, const std::string& chatId) {
    return storageRoot / "chats" / (encodeChatIdForPath(chatId) + ".json");
}

Json::Value readJsonFile(const fs::path& path, const Json::Value& fallback) {
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
    return root;
}

bool writeJsonFile(const fs::path& path, const Json::Value& value) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    if (ec) {
        return false;
    }

    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file.is_open()) {
        return false;
    }

    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(value, &file);
    return file.good();
}

Json::Value normalizeState(Json::Value state, const std::string& chatId) {
    if (!state.isObject()) {
        state = Json::Value(Json::objectValue);
    }
    state["chat_id"] = chatId;
    if (!state.isMember("notes") || !state["notes"].isArray()) {
        state["notes"] = Json::Value(Json::arrayValue);
    }
    if (!state.isMember("todos") || !state["todos"].isArray()) {
        state["todos"] = Json::Value(Json::arrayValue);
    }
    if (!state.isMember("created_at") || !state["created_at"].isIntegral()) {
        state["created_at"] = nowMillis();
    }
    return state;
}

Json::Value loadState(const fs::path& storageRoot, const std::string& chatId) {
    return normalizeState(readJsonFile(statePathForChat(storageRoot, chatId), Json::Value(Json::objectValue)), chatId);
}

bool saveState(const fs::path& storageRoot, const std::string& chatId, Json::Value state) {
    state = normalizeState(std::move(state), chatId);
    state["updated_at"] = nowMillis();
    return writeJsonFile(statePathForChat(storageRoot, chatId), state);
}

int findItemIndex(const Json::Value& array, const std::string& id) {
    if (!array.isArray() || id.empty()) {
        return -1;
    }
    for (Json::ArrayIndex index = 0; index < array.size(); ++index) {
        const Json::Value& item = array[index];
        if (item.isObject() && item.get("id", "").asString() == id) {
            return static_cast<int>(index);
        }
    }
    return -1;
}

bool isValidNoteCategory(const std::string& category) {
    static const std::set<std::string> kCategories = {
        "note",
        "plan",
        "decision",
        "preference",
        "context",
        "question",
    };
    return kCategories.find(category) != kCategories.end();
}

std::string normalizeNoteCategory(const std::string& value) {
    const std::string category = trimCopy(value);
    return isValidNoteCategory(category) ? category : "note";
}

bool isValidTodoStatus(const std::string& status) {
    static const std::set<std::string> kStatuses = {
        "pending",
        "in_progress",
        "done",
        "cancelled",
    };
    return kStatuses.find(status) != kStatuses.end();
}

bool isClosedStatus(const std::string& status) {
    return status == "done" || status == "cancelled";
}

std::string normalizeTodoStatus(const std::string& value) {
    const std::string status = trimCopy(value);
    return isValidTodoStatus(status) ? status : "pending";
}

bool isValidPriority(const std::string& priority) {
    static const std::set<std::string> kPriorities = {
        "low",
        "normal",
        "high",
    };
    return kPriorities.find(priority) != kPriorities.end();
}

std::string normalizePriority(const std::string& value) {
    const std::string priority = trimCopy(value);
    return isValidPriority(priority) ? priority : "normal";
}

Json::Value filteredNotes(const Json::Value& notes, const std::string& category, int limit, bool& truncated) {
    Json::Value result(Json::arrayValue);
    truncated = false;
    const int cappedLimit = std::clamp(limit <= 0 ? kDefaultResultLimit : limit, 1, kMaxNotes);
    if (!notes.isArray()) {
        return result;
    }

    for (const auto& note : notes) {
        if (!note.isObject()) {
            continue;
        }
        if (!category.empty() && note.get("category", "note").asString() != category) {
            continue;
        }
        if (static_cast<int>(result.size()) >= cappedLimit) {
            truncated = true;
            break;
        }
        result.append(note);
    }
    return result;
}

Json::Value filteredTodos(const Json::Value& todos, const std::string& status, int limit, bool& truncated) {
    Json::Value result(Json::arrayValue);
    truncated = false;
    const int cappedLimit = std::clamp(limit <= 0 ? kDefaultResultLimit : limit, 1, kMaxTodos);
    if (!todos.isArray()) {
        return result;
    }

    for (const auto& todo : todos) {
        if (!todo.isObject()) {
            continue;
        }
        if (!status.empty() && todo.get("status", "pending").asString() != status) {
            continue;
        }
        if (static_cast<int>(result.size()) >= cappedLimit) {
            truncated = true;
            break;
        }
        result.append(todo);
    }
    return result;
}

Json::Value notesResponse(
    const Json::Value& state,
    const std::string& action,
    const std::string& category,
    int limit) {
    bool truncated = false;
    Json::Value result(Json::objectValue);
    result["action"] = action;
    result["chat_id"] = state.get("chat_id", "");
    result["count"] = static_cast<int>(state["notes"].size());
    result["notes"] = filteredNotes(state["notes"], category, limit, truncated);
    result["truncated"] = truncated;
    return result;
}

Json::Value todosResponse(
    const Json::Value& state,
    const std::string& action,
    const std::string& status,
    int limit) {
    bool truncated = false;
    Json::Value result(Json::objectValue);
    result["action"] = action;
    result["chat_id"] = state.get("chat_id", "");
    result["count"] = static_cast<int>(state["todos"].size());
    result["todos"] = filteredTodos(state["todos"], status, limit, truncated);
    result["truncated"] = truncated;
    return result;
}

Json::Value validateChatContext(const fs::path& storageRoot, const std::string& chatId) {
    if (trimCopy(chatId).empty()) {
        return makeError("This tool requires an active chat_id so state can be scoped to one chat.");
    }
    if (storageRoot.empty()) {
        return makeError("Assistant workspace storage is not configured.");
    }
    return Json::Value();
}

Json::Value removeArrayIndex(Json::Value& array, int index) {
    Json::Value removed;
    if (!array.isArray() || index < 0 || index >= static_cast<int>(array.size())) {
        return removed;
    }
    array.removeIndex(static_cast<Json::ArrayIndex>(index), &removed);
    return removed;
}

Json::Value compactTodoFromInput(const Json::Value& item, Json::Int64 timestamp) {
    const std::string title = trimCopy(getStringArg(item, "title"));
    if (title.empty() || exceedsLimit(title, kMaxTitleLength)) {
        return makeError("Each replacement TODO item requires a non-empty title under 240 characters.");
    }

    const std::string details = getStringArg(item, "details");
    if (exceedsLimit(details, kMaxTodoDetailsLength)) {
        return makeError("TODO details must be under 12000 characters.");
    }

    Json::Value todo(Json::objectValue);
    todo["id"] = trimCopy(getStringArg(item, "item_id"));
    if (todo["id"].asString().empty()) {
        todo["id"] = makeId("todo");
    }
    todo["title"] = title;
    todo["details"] = details;
    todo["status"] = normalizeTodoStatus(getStringArg(item, "status", "pending"));
    todo["priority"] = normalizePriority(getStringArg(item, "priority", "normal"));
    todo["created_at"] = timestamp;
    todo["updated_at"] = timestamp;
    if (isClosedStatus(todo["status"].asString())) {
        todo["completed_at"] = timestamp;
    }
    return todo;
}

} // namespace

Json::Value assistant_workspace_tool::manageChatNotes(
    const Json::Value& arguments,
    const fs::path& storageRoot,
    const std::string& chatId) {
    if (const Json::Value contextError = validateChatContext(storageRoot, chatId); !contextError.isNull()) {
        return contextError;
    }

    const std::string action = trimCopy(getStringArg(arguments, "action"));
    const std::string requestedCategory = trimCopy(getStringArg(arguments, "category"));
    const std::string category = requestedCategory.empty() ? "" : normalizeNoteCategory(requestedCategory);
    const int limit = getIntArg(arguments, "max_notes", kDefaultResultLimit);

    std::lock_guard<std::mutex> lock(gStorageMutex);
    Json::Value state = loadState(storageRoot, chatId);

    if (action == "list") {
        return notesResponse(state, action, category, limit);
    }

    if (action == "upsert" || action == "set_plan") {
        if (static_cast<int>(state["notes"].size()) >= kMaxNotes && action != "set_plan") {
            return makeError("This chat already has the maximum number of notes.");
        }

        std::string noteId = action == "set_plan"
            ? "plan"
            : trimCopy(getStringArg(arguments, "note_id"));
        if (noteId.empty()) {
            noteId = makeId("note");
        }

        const int index = findItemIndex(state["notes"], noteId);
        if (index < 0 && static_cast<int>(state["notes"].size()) >= kMaxNotes) {
            return makeError("This chat already has the maximum number of notes.");
        }

        const bool hasContent = hasStringArg(arguments, "content");
        const bool hasTitle = hasStringArg(arguments, "title");
        const std::string content = getStringArg(arguments, "content");
        const std::string title = trimCopy(getStringArg(arguments, "title", action == "set_plan" ? "Plan" : ""));
        if ((action == "set_plan" || index < 0) && !hasContent) {
            return makeError(action == "set_plan" ? "content is required for set_plan." : "content is required when creating a note.");
        }
        if (hasTitle && (title.empty() || exceedsLimit(title, kMaxTitleLength))) {
            return makeError("title must be non-empty and under 240 characters.");
        }
        if (hasContent && exceedsLimit(content, kMaxNoteContentLength)) {
            return makeError("content must be under 24000 characters.");
        }

        const Json::Int64 timestamp = nowMillis();
        Json::Value note(Json::objectValue);
        if (index >= 0) {
            note = state["notes"][static_cast<Json::ArrayIndex>(index)];
        } else {
            note["id"] = noteId;
            note["created_at"] = timestamp;
        }

        if (hasTitle || !note.isMember("title")) {
            note["title"] = title.empty() ? "Untitled note" : title;
        }
        if (hasContent) {
            note["content"] = content;
        }
        note["category"] = action == "set_plan"
            ? "plan"
            : normalizeNoteCategory(getStringArg(arguments, "category", note.get("category", "note").asString()));
        note["updated_at"] = timestamp;

        if (index >= 0) {
            state["notes"][static_cast<Json::ArrayIndex>(index)] = note;
        } else {
            state["notes"].append(note);
        }

        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save chat notes.");
        }

        Json::Value result = notesResponse(state, action, "", limit);
        result["note"] = note;
        return result;
    }

    if (action == "delete") {
        const std::string noteId = trimCopy(getStringArg(arguments, "note_id"));
        if (noteId.empty()) {
            return makeError("note_id is required for delete.");
        }
        const int index = findItemIndex(state["notes"], noteId);
        if (index < 0) {
            return makeError("Note was not found.");
        }

        Json::Value removed = removeArrayIndex(state["notes"], index);
        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save chat notes.");
        }

        Json::Value result = notesResponse(state, action, "", limit);
        result["deleted"] = removed;
        return result;
    }

    if (action == "clear") {
        const std::string filterCategory = category;
        const int before = static_cast<int>(state["notes"].size());
        if (filterCategory.empty()) {
            state["notes"] = Json::Value(Json::arrayValue);
        } else {
            Json::Value kept(Json::arrayValue);
            for (const auto& note : state["notes"]) {
                if (!note.isObject() || note.get("category", "note").asString() != filterCategory) {
                    kept.append(note);
                }
            }
            state["notes"] = kept;
        }
        const int after = static_cast<int>(state["notes"].size());
        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save chat notes.");
        }

        Json::Value result = notesResponse(state, action, "", limit);
        result["cleared_count"] = before - after;
        return result;
    }

    return makeError("Unsupported notes action: " + action);
}

Json::Value assistant_workspace_tool::manageTodoList(
    const Json::Value& arguments,
    const fs::path& storageRoot,
    const std::string& chatId) {
    if (const Json::Value contextError = validateChatContext(storageRoot, chatId); !contextError.isNull()) {
        return contextError;
    }

    const std::string action = trimCopy(getStringArg(arguments, "action"));
    const std::string requestedStatus = trimCopy(getStringArg(arguments, "status"));
    const std::string statusFilter = requestedStatus.empty() ? "" : normalizeTodoStatus(requestedStatus);
    const int limit = getIntArg(arguments, "max_items", kDefaultResultLimit);

    std::lock_guard<std::mutex> lock(gStorageMutex);
    Json::Value state = loadState(storageRoot, chatId);

    if (action == "list") {
        return todosResponse(state, action, statusFilter, limit);
    }

    if (action == "add") {
        if (static_cast<int>(state["todos"].size()) >= kMaxTodos) {
            return makeError("This chat already has the maximum number of TODO items.");
        }

        const std::string title = trimCopy(getStringArg(arguments, "title"));
        const std::string details = getStringArg(arguments, "details");
        if (title.empty() || exceedsLimit(title, kMaxTitleLength)) {
            return makeError("title is required and must be under 240 characters.");
        }
        if (exceedsLimit(details, kMaxTodoDetailsLength)) {
            return makeError("details must be under 12000 characters.");
        }

        const Json::Int64 timestamp = nowMillis();
        Json::Value todo(Json::objectValue);
        todo["id"] = makeId("todo");
        todo["title"] = title;
        todo["details"] = details;
        todo["status"] = normalizeTodoStatus(getStringArg(arguments, "status", "pending"));
        todo["priority"] = normalizePriority(getStringArg(arguments, "priority", "normal"));
        todo["created_at"] = timestamp;
        todo["updated_at"] = timestamp;
        if (isClosedStatus(todo["status"].asString())) {
            todo["completed_at"] = timestamp;
        }
        state["todos"].append(todo);

        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save TODO list.");
        }

        Json::Value result = todosResponse(state, action, "", limit);
        result["item"] = todo;
        return result;
    }

    if (action == "update") {
        const std::string itemId = trimCopy(getStringArg(arguments, "item_id"));
        if (itemId.empty()) {
            return makeError("item_id is required for update.");
        }
        const int index = findItemIndex(state["todos"], itemId);
        if (index < 0) {
            return makeError("TODO item was not found.");
        }

        Json::Value todo = state["todos"][static_cast<Json::ArrayIndex>(index)];
        if (hasStringArg(arguments, "title")) {
            const std::string title = trimCopy(getStringArg(arguments, "title"));
            if (title.empty() || exceedsLimit(title, kMaxTitleLength)) {
                return makeError("title must be non-empty and under 240 characters.");
            }
            todo["title"] = title;
        }
        if (hasStringArg(arguments, "details")) {
            const std::string details = getStringArg(arguments, "details");
            if (exceedsLimit(details, kMaxTodoDetailsLength)) {
                return makeError("details must be under 12000 characters.");
            }
            todo["details"] = details;
        }
        if (hasStringArg(arguments, "priority")) {
            todo["priority"] = normalizePriority(getStringArg(arguments, "priority"));
        }
        if (hasStringArg(arguments, "status")) {
            const std::string nextStatus = normalizeTodoStatus(getStringArg(arguments, "status"));
            const bool wasClosed = isClosedStatus(todo.get("status", "pending").asString());
            const bool isClosed = isClosedStatus(nextStatus);
            todo["status"] = nextStatus;
            if (!wasClosed && isClosed) {
                todo["completed_at"] = nowMillis();
            } else if (wasClosed && !isClosed) {
                todo.removeMember("completed_at");
            }
        }
        todo["updated_at"] = nowMillis();
        state["todos"][static_cast<Json::ArrayIndex>(index)] = todo;

        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save TODO list.");
        }

        Json::Value result = todosResponse(state, action, "", limit);
        result["item"] = todo;
        return result;
    }

    if (action == "delete") {
        const std::string itemId = trimCopy(getStringArg(arguments, "item_id"));
        if (itemId.empty()) {
            return makeError("item_id is required for delete.");
        }
        const int index = findItemIndex(state["todos"], itemId);
        if (index < 0) {
            return makeError("TODO item was not found.");
        }

        Json::Value removed = removeArrayIndex(state["todos"], index);
        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save TODO list.");
        }

        Json::Value result = todosResponse(state, action, "", limit);
        result["deleted"] = removed;
        return result;
    }

    if (action == "clear" || action == "clear_completed") {
        const bool closedOnly = action == "clear_completed";
        const int before = static_cast<int>(state["todos"].size());
        Json::Value kept(Json::arrayValue);
        for (const auto& todo : state["todos"]) {
            if (!todo.isObject()) {
                continue;
            }
            const std::string itemStatus = todo.get("status", "pending").asString();
            const bool shouldRemove = closedOnly
                ? isClosedStatus(itemStatus)
                : (statusFilter.empty() || itemStatus == statusFilter);
            if (!shouldRemove) {
                kept.append(todo);
            }
        }
        state["todos"] = kept;
        const int after = static_cast<int>(state["todos"].size());
        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save TODO list.");
        }

        Json::Value result = todosResponse(state, action, "", limit);
        result["cleared_count"] = before - after;
        return result;
    }

    if (action == "replace_all") {
        const Json::Value items = arguments.get("items", Json::Value(Json::arrayValue));
        if (!items.isArray()) {
            return makeError("items must be an array for replace_all.");
        }
        if (static_cast<int>(items.size()) > kMaxTodos) {
            return makeError("replace_all exceeds the maximum number of TODO items.");
        }

        Json::Value replacement(Json::arrayValue);
        std::set<std::string> seenIds;
        const Json::Int64 timestamp = nowMillis();
        for (const auto& item : items) {
            if (!item.isObject()) {
                return makeError("Each replacement TODO item must be an object.");
            }
            Json::Value todo = compactTodoFromInput(item, timestamp);
            if (todo.isObject() && todo.isMember("error")) {
                return todo;
            }
            std::string id = todo["id"].asString();
            if (seenIds.find(id) != seenIds.end()) {
                id = makeId("todo");
                todo["id"] = id;
            }
            seenIds.insert(id);
            replacement.append(todo);
        }
        state["todos"] = replacement;

        if (!saveState(storageRoot, chatId, state)) {
            return makeError("Failed to save TODO list.");
        }

        return todosResponse(state, action, "", limit);
    }

    return makeError("Unsupported TODO action: " + action);
}
