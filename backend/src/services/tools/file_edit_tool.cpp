#include "services/tools/file_edit_tool.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>

namespace fs = std::filesystem;

namespace {

constexpr std::uintmax_t kMaxExistingFileBytes = 5ULL * 1024ULL * 1024ULL;
constexpr std::size_t kMaxInputContentBytes = 5ULL * 1024ULL * 1024ULL;

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

bool getBoolArg(const Json::Value& value, const std::string& key, bool fallback = false) {
    if (value.isObject() && value.isMember(key) && value[key].isBool()) {
        return value[key].asBool();
    }
    return fallback;
}

bool hasStringArg(const Json::Value& value, const std::string& key) {
    return value.isObject() && value.isMember(key) && value[key].isString();
}

std::string sanitizePathForCheckpoint(const fs::path& relativePath) {
    std::string value = relativePath.generic_string();
    if (value.empty() || value == ".") {
        value = "root";
    }
    for (char& ch : value) {
        const bool allowed = std::isalnum(static_cast<unsigned char>(ch)) || ch == '-' || ch == '_' || ch == '.';
        if (!allowed) {
            ch = '_';
        }
    }
    return value;
}

std::string timestampMillis() {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

std::string checkpointIdForPath(const fs::path& relativePath) {
    static std::atomic_uint64_t sequence{0};
    return timestampMillis() + "-" + std::to_string(sequence.fetch_add(1, std::memory_order_relaxed)) +
        "-" + sanitizePathForCheckpoint(relativePath);
}

bool isSafeCheckpointId(const std::string& checkpointId) {
    if (checkpointId.empty() || checkpointId == "." || checkpointId == "..") {
        return false;
    }
    for (char ch : checkpointId) {
        const bool allowed = std::isalnum(static_cast<unsigned char>(ch)) ||
            ch == '-' || ch == '_' || ch == '.';
        if (!allowed) {
            return false;
        }
    }
    return true;
}

fs::path canonicalDirectory(const fs::path& path) {
    std::error_code ec;
    const fs::path canonical = fs::weakly_canonical(path, ec);
    if (!ec) {
        return canonical;
    }
    return fs::absolute(path).lexically_normal();
}

bool isInsideDirectory(const fs::path& candidate, const fs::path& root) {
    const fs::path normalizedCandidate = candidate.lexically_normal();
    const fs::path normalizedRoot = root.lexically_normal();

    auto candidateIt = normalizedCandidate.begin();
    auto rootIt = normalizedRoot.begin();
    for (; rootIt != normalizedRoot.end(); ++rootIt, ++candidateIt) {
        if (candidateIt == normalizedCandidate.end() || *candidateIt != *rootIt) {
            return false;
        }
    }
    return true;
}

Json::Value resolveEditablePath(
    const std::string& pathText,
    const fs::path& workspaceDirectory,
    bool createParentDirectories,
    fs::path& workspaceRoot,
    fs::path& resolvedPath,
    fs::path& relativePath) {
    if (pathText.empty()) {
        return makeError("path is required");
    }

    workspaceRoot = canonicalDirectory(workspaceDirectory.empty() ? fs::current_path() : workspaceDirectory);
    std::error_code ec;
    if (!fs::exists(workspaceRoot, ec) || ec || !fs::is_directory(workspaceRoot, ec) || ec) {
        Json::Value error = makeError("Workspace directory does not exist or is not a directory");
        error["workspace_directory"] = workspaceRoot.string();
        return error;
    }

    const fs::path inputPath(pathText);
    const fs::path absolutePath = inputPath.is_absolute() ? inputPath : workspaceRoot / inputPath;

    fs::path parent = absolutePath.parent_path();
    if (parent.empty()) {
        parent = workspaceRoot;
    }

    if (!fs::exists(parent, ec) || ec) {
        if (!createParentDirectories) {
            Json::Value error = makeError("Parent directory does not exist");
            error["path"] = pathText;
            error["parent_path"] = parent.lexically_normal().string();
            error["workspace_directory"] = workspaceRoot.string();
            return error;
        }
        const fs::path normalizedParent = fs::absolute(parent).lexically_normal();
        if (!isInsideDirectory(normalizedParent, workspaceRoot)) {
            Json::Value error = makeError("Refusing to create parent directory outside the workspace");
            error["path"] = pathText;
            error["workspace_directory"] = workspaceRoot.string();
            return error;
        }
        fs::create_directories(parent, ec);
        if (ec) {
            Json::Value error = makeError("Failed to create parent directories: " + ec.message());
            error["path"] = pathText;
            return error;
        }
    }

    const fs::path canonicalParent = canonicalDirectory(parent);
    if (!isInsideDirectory(canonicalParent, workspaceRoot)) {
        Json::Value error = makeError("Refusing to edit outside the workspace directory");
        error["path"] = pathText;
        error["resolved_parent"] = canonicalParent.string();
        error["workspace_directory"] = workspaceRoot.string();
        return error;
    }

    resolvedPath = (canonicalParent / absolutePath.filename()).lexically_normal();
    if (!isInsideDirectory(resolvedPath, workspaceRoot)) {
        Json::Value error = makeError("Refusing to edit outside the workspace directory");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        error["workspace_directory"] = workspaceRoot.string();
        return error;
    }
    if (fs::exists(resolvedPath, ec) && !ec) {
        resolvedPath = canonicalDirectory(resolvedPath);
        if (!isInsideDirectory(resolvedPath, workspaceRoot)) {
            Json::Value error = makeError("Refusing to edit a path that resolves outside the workspace directory");
            error["path"] = pathText;
            error["resolved_path"] = resolvedPath.string();
            error["workspace_directory"] = workspaceRoot.string();
            return error;
        }
    }

    const fs::path checkpointRoot = workspaceRoot / ".ctrlpanel" / "checkpoints";
    if (isInsideDirectory(resolvedPath, checkpointRoot)) {
        Json::Value error = makeError("Refusing to edit checkpoint storage");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    relativePath = fs::relative(resolvedPath, workspaceRoot, ec);
    if (ec) {
        relativePath = resolvedPath.filename();
    }
    return Json::Value();
}

Json::Value readWholeFile(const fs::path& path, std::string& content) {
    std::error_code ec;
    const std::uintmax_t fileSize = fs::file_size(path, ec);
    if (ec) {
        return makeError("Failed to read file metadata: " + ec.message());
    }
    if (fileSize > kMaxExistingFileBytes) {
        Json::Value error = makeError("Refusing to edit file larger than the edit limit");
        error["size_bytes"] = static_cast<Json::UInt64>(fileSize);
        error["max_size_bytes"] = static_cast<Json::UInt64>(kMaxExistingFileBytes);
        return error;
    }

    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return makeError("Failed to open file for reading");
    }
    std::ostringstream buffer;
    buffer << file.rdbuf();
    content = buffer.str();
    if (content.find('\0') != std::string::npos) {
        return makeError("Refusing to edit likely binary file; found NUL byte");
    }
    return Json::Value();
}

Json::Value writeWholeFile(const fs::path& path, std::string_view content) {
    const fs::path tempPath = path.parent_path() / (path.filename().string() + ".ctrlpanel-tmp-" + timestampMillis());
    {
        std::ofstream file(tempPath, std::ios::binary | std::ios::trunc);
        if (!file.is_open()) {
            return makeError("Failed to open temporary file for writing");
        }
        file.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!file.good()) {
            return makeError("Failed while writing temporary file");
        }
    }

    std::error_code ec;
    fs::rename(tempPath, path, ec);
    if (ec) {
        fs::remove(tempPath, ec);
        return makeError("Failed to replace file: " + ec.message());
    }
    return Json::Value();
}

Json::Value readJsonFile(const fs::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        return makeError("Failed to open checkpoint metadata");
    }

    Json::CharReaderBuilder reader;
    std::string errors;
    Json::Value root;
    if (!Json::parseFromStream(reader, file, &root, &errors)) {
        return makeError("Failed to parse checkpoint metadata");
    }
    return root;
}

Json::Value createCheckpoint(
    const fs::path& workspaceRoot,
    const fs::path& targetPath,
    const fs::path& relativePath,
    const std::string& operation) {
    const std::string createdAt = timestampMillis();
    const std::string checkpointId = checkpointIdForPath(relativePath);
    const fs::path checkpointDirectory = workspaceRoot / ".ctrlpanel" / "checkpoints" / checkpointId;

    std::error_code ec;
    fs::create_directories(checkpointDirectory, ec);
    if (ec) {
        return makeError("Failed to create checkpoint directory: " + ec.message());
    }

    const bool existed = fs::exists(targetPath, ec) && !ec;
    if (existed) {
        fs::copy_file(targetPath, checkpointDirectory / "before", fs::copy_options::overwrite_existing, ec);
        if (ec) {
            return makeError("Failed to write checkpoint copy: " + ec.message());
        }
    }

    Json::Value metadata(Json::objectValue);
    metadata["id"] = checkpointId;
    metadata["operation"] = operation;
    metadata["workspace_directory"] = workspaceRoot.string();
    metadata["path"] = relativePath.generic_string();
    metadata["resolved_path"] = targetPath.string();
    metadata["existed_before"] = existed;
    metadata["created_at_ms"] = static_cast<Json::Int64>(std::stoll(createdAt));

    std::ofstream metadataFile(checkpointDirectory / "metadata.json", std::ios::binary | std::ios::trunc);
    if (!metadataFile.is_open()) {
        return makeError("Failed to write checkpoint metadata");
    }
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "    ";
    std::unique_ptr<Json::StreamWriter> writer(builder.newStreamWriter());
    writer->write(metadata, &metadataFile);

    Json::Value checkpoint(Json::objectValue);
    checkpoint["id"] = checkpointId;
    checkpoint["directory"] = checkpointDirectory.string();
    checkpoint["metadata_path"] = (checkpointDirectory / "metadata.json").string();
    checkpoint["content_path"] = existed ? (checkpointDirectory / "before").string() : "";
    checkpoint["existed_before"] = existed;
    return checkpoint;
}

Json::Value buildEditedFileResult(
    const fs::path& workspaceRoot,
    const fs::path& resolvedPath,
    const fs::path& relativePath,
    const std::string& operation,
    const Json::Value& checkpoint,
    std::size_t bytesBefore,
    std::size_t bytesAfter,
    std::size_t replacements,
    bool createdFile) {
    Json::Value editedFile(Json::objectValue);
    editedFile["path"] = relativePath.generic_string();
    editedFile["resolved_path"] = resolvedPath.string();
    editedFile["workspace_directory"] = workspaceRoot.string();
    editedFile["operation"] = operation;
    editedFile["created_file"] = createdFile;
    editedFile["bytes_before"] = static_cast<Json::UInt64>(bytesBefore);
    editedFile["bytes_after"] = static_cast<Json::UInt64>(bytesAfter);
    editedFile["replacements"] = static_cast<Json::UInt64>(replacements);
    editedFile["checkpoint"] = checkpoint;
    editedFile["rollback_available"] = true;
    return editedFile;
}

std::size_t countOccurrences(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) {
        return 0;
    }
    std::size_t count = 0;
    std::size_t pos = 0;
    while ((pos = haystack.find(needle, pos)) != std::string::npos) {
        ++count;
        pos += needle.size();
    }
    return count;
}

} // namespace

Json::Value file_edit_tool::editFile(const Json::Value& arguments, const fs::path& workspaceDirectory) {
    const std::string pathText = trimCopy(getStringArg(arguments, "path"));
    const std::string operation = trimCopy(getStringArg(arguments, "operation"));
    const bool createIfMissing = getBoolArg(arguments, "create_if_missing", operation == "write" || operation == "append");
    const bool createParentDirectories = getBoolArg(arguments, "create_parent_directories", false);
    const bool replaceAll = getBoolArg(arguments, "replace_all", false);

    if (operation != "write" && operation != "append" && operation != "replace") {
        return makeError("operation must be one of: write, append, replace");
    }

    fs::path workspaceRoot;
    fs::path resolvedPath;
    fs::path relativePath;
    Json::Value resolvedError = resolveEditablePath(
        pathText,
        workspaceDirectory,
        createParentDirectories,
        workspaceRoot,
        resolvedPath,
        relativePath);
    if (!resolvedError.isNull()) {
        return resolvedError;
    }

    std::error_code ec;
    const bool exists = fs::exists(resolvedPath, ec) && !ec;
    if (exists && (!fs::is_regular_file(resolvedPath, ec) || ec)) {
        Json::Value error = makeError("Path is not a regular file");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }
    if (!exists && !createIfMissing) {
        Json::Value error = makeError("File does not exist and create_if_missing is false");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    std::string currentContent;
    if (exists) {
        Json::Value readError = readWholeFile(resolvedPath, currentContent);
        if (!readError.isNull()) {
            readError["path"] = pathText;
            readError["resolved_path"] = resolvedPath.string();
            return readError;
        }
    }

    std::string nextContent;
    std::size_t replacements = 0;
    if (operation == "write") {
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for write operations");
        }
        nextContent = getStringArg(arguments, "content");
    } else if (operation == "append") {
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for append operations");
        }
        nextContent = currentContent + getStringArg(arguments, "content");
    } else {
        const std::string oldText = getStringArg(arguments, "old_text");
        const std::string newText = getStringArg(arguments, "new_text");
        if (oldText.empty()) {
            return makeError("old_text is required for replace operations");
        }
        if (!exists) {
            return makeError("replace operations require an existing file");
        }
        replacements = countOccurrences(currentContent, oldText);
        if (replacements == 0) {
            return makeError("old_text was not found in the file");
        }
        if (replacements > 1 && !replaceAll) {
            Json::Value error = makeError("old_text occurs more than once; set replace_all to true or provide a more specific old_text");
            error["occurrences"] = static_cast<Json::UInt64>(replacements);
            return error;
        }

        nextContent = currentContent;
        std::size_t pos = 0;
        while ((pos = nextContent.find(oldText, pos)) != std::string::npos) {
            nextContent.replace(pos, oldText.size(), newText);
            pos += newText.size();
            if (!replaceAll) {
                break;
            }
        }
    }

    if (nextContent.size() > kMaxInputContentBytes) {
        Json::Value error = makeError("Refusing to write content larger than the edit limit");
        error["size_bytes"] = static_cast<Json::UInt64>(nextContent.size());
        error["max_size_bytes"] = static_cast<Json::UInt64>(kMaxInputContentBytes);
        return error;
    }
    if (nextContent.find('\0') != std::string::npos) {
        return makeError("Refusing to write content containing NUL bytes");
    }

    Json::Value checkpoint = createCheckpoint(workspaceRoot, resolvedPath, relativePath, operation);
    if (checkpoint.isObject() && checkpoint.isMember("error")) {
        checkpoint["path"] = pathText;
        checkpoint["resolved_path"] = resolvedPath.string();
        return checkpoint;
    }

    Json::Value writeError = writeWholeFile(resolvedPath, nextContent);
    if (!writeError.isNull()) {
        writeError["path"] = pathText;
        writeError["resolved_path"] = resolvedPath.string();
        writeError["checkpoint"] = checkpoint;
        return writeError;
    }

    Json::Value result(Json::objectValue);
    Json::Value editedFile = buildEditedFileResult(
        workspaceRoot,
        resolvedPath,
        relativePath,
        operation,
        checkpoint,
        currentContent.size(),
        nextContent.size(),
        replacements,
        !exists);
    Json::Value editedFiles(Json::arrayValue);
    editedFiles.append(editedFile);

    result["path"] = pathText;
    result["resolved_path"] = resolvedPath.string();
    result["workspace_directory"] = workspaceRoot.string();
    result["operation"] = operation;
    result["created_file"] = !exists;
    result["bytes_before"] = static_cast<Json::UInt64>(currentContent.size());
    result["bytes_after"] = static_cast<Json::UInt64>(nextContent.size());
    result["replacements"] = static_cast<Json::UInt64>(replacements);
    result["checkpoint"] = checkpoint;
    result["edited_files"] = editedFiles;
    result["output"] = "File edit completed with checkpoint " + checkpoint["id"].asString();
    return result;
}

Json::Value file_edit_tool::rollbackCheckpoint(const Json::Value& arguments) {
    const std::string checkpointId = trimCopy(getStringArg(arguments, "checkpoint_id"));
    const std::string workspaceText = trimCopy(getStringArg(arguments, "workspace_directory"));
    const std::string expectedPath = trimCopy(getStringArg(arguments, "path"));

    if (!isSafeCheckpointId(checkpointId)) {
        return makeError("checkpoint_id is required and must be a safe checkpoint identifier");
    }
    if (workspaceText.empty()) {
        return makeError("workspace_directory is required");
    }

    const fs::path workspaceRoot = canonicalDirectory(fs::path(workspaceText));
    std::error_code ec;
    if (!fs::exists(workspaceRoot, ec) || ec || !fs::is_directory(workspaceRoot, ec) || ec) {
        Json::Value error = makeError("Workspace directory does not exist or is not a directory");
        error["workspace_directory"] = workspaceRoot.string();
        return error;
    }

    const fs::path checkpointRoot = workspaceRoot / ".ctrlpanel" / "checkpoints";
    const fs::path checkpointDirectory = (checkpointRoot / checkpointId).lexically_normal();
    if (!isInsideDirectory(checkpointDirectory, checkpointRoot)) {
        return makeError("Checkpoint path escapes checkpoint storage");
    }

    Json::Value metadata = readJsonFile(checkpointDirectory / "metadata.json");
    if (metadata.isObject() && metadata.isMember("error")) {
        metadata["checkpoint_id"] = checkpointId;
        return metadata;
    }
    if (!metadata.isObject()) {
        return makeError("Checkpoint metadata is invalid");
    }

    const std::string metadataPath = metadata.get("path", "").asString();
    if (!expectedPath.empty() && expectedPath != metadataPath) {
        Json::Value error = makeError("Checkpoint path does not match the requested file");
        error["requested_path"] = expectedPath;
        error["checkpoint_path"] = metadataPath;
        return error;
    }

    fs::path targetPath = fs::path(metadata.get("resolved_path", "").asString());
    if (targetPath.empty()) {
        targetPath = workspaceRoot / metadataPath;
    }
    targetPath = targetPath.is_absolute()
        ? targetPath.lexically_normal()
        : (workspaceRoot / targetPath).lexically_normal();
    if (!isInsideDirectory(targetPath, workspaceRoot)) {
        Json::Value error = makeError("Refusing to roll back a path outside the workspace directory");
        error["resolved_path"] = targetPath.string();
        error["workspace_directory"] = workspaceRoot.string();
        return error;
    }

    const bool existedBefore = metadata.get("existed_before", false).asBool();
    bool deletedCreatedFile = false;
    bool restoredPreviousContent = false;
    if (existedBefore) {
        const fs::path beforePath = checkpointDirectory / "before";
        if (!fs::exists(beforePath, ec) || ec || !fs::is_regular_file(beforePath, ec) || ec) {
            Json::Value error = makeError("Checkpoint content is missing");
            error["checkpoint_id"] = checkpointId;
            return error;
        }
        fs::create_directories(targetPath.parent_path(), ec);
        if (ec) {
            Json::Value error = makeError("Failed to create rollback parent directory: " + ec.message());
            error["resolved_path"] = targetPath.string();
            return error;
        }
        fs::copy_file(beforePath, targetPath, fs::copy_options::overwrite_existing, ec);
        if (ec) {
            Json::Value error = makeError("Failed to restore checkpoint content: " + ec.message());
            error["resolved_path"] = targetPath.string();
            return error;
        }
        restoredPreviousContent = true;
    } else if (fs::exists(targetPath, ec) && !ec) {
        if (!fs::is_regular_file(targetPath, ec) || ec) {
            Json::Value error = makeError("Rollback target is not a regular file");
            error["resolved_path"] = targetPath.string();
            return error;
        }
        fs::remove(targetPath, ec);
        if (ec) {
            Json::Value error = makeError("Failed to delete file created by edit: " + ec.message());
            error["resolved_path"] = targetPath.string();
            return error;
        }
        deletedCreatedFile = true;
    }

    Json::Value result(Json::objectValue);
    result["checkpoint_id"] = checkpointId;
    result["path"] = metadataPath;
    result["resolved_path"] = targetPath.string();
    result["workspace_directory"] = workspaceRoot.string();
    result["existed_before"] = existedBefore;
    result["restored_previous_content"] = restoredPreviousContent;
    result["deleted_created_file"] = deletedCreatedFile;
    result["rolled_back_at_ms"] = static_cast<Json::Int64>(std::stoll(timestampMillis()));
    result["output"] = "Rolled back " + metadataPath + " using checkpoint " + checkpointId;
    return result;
}
