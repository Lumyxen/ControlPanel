#include "services/tools/file_edit_tool.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

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

int getIntArg(const Json::Value& value, const std::string& key, int fallback = 0) {
    if (value.isObject() && value.isMember(key) && value[key].isInt()) {
        return value[key].asInt();
    }
    return fallback;
}

bool hasStringArg(const Json::Value& value, const std::string& key) {
    return value.isObject() && value.isMember(key) && value[key].isString();
}

bool hasIntArg(const Json::Value& value, const std::string& key) {
    return value.isObject() && value.isMember(key) && value[key].isInt();
}

struct TextLine {
    std::size_t begin = 0;
    std::size_t bodyEnd = 0;
    std::size_t end = 0;
    std::string body;
    std::string ending;
};

std::vector<TextLine> parseLines(const std::string& content) {
    std::vector<TextLine> lines;
    std::size_t position = 0;

    while (position < content.size()) {
        TextLine line;
        line.begin = position;

        const std::size_t newline = content.find('\n', position);
        if (newline == std::string::npos) {
            line.bodyEnd = content.size();
            line.end = content.size();
            line.body = content.substr(position);
            lines.push_back(std::move(line));
            break;
        }

        line.bodyEnd = newline;
        line.end = newline + 1;
        line.ending = "\n";
        if (line.bodyEnd > line.begin && content[line.bodyEnd - 1] == '\r') {
            --line.bodyEnd;
            line.ending = "\r\n";
        }
        line.body = content.substr(line.begin, line.bodyEnd - line.begin);
        lines.push_back(std::move(line));
        position = newline + 1;
    }

    return lines;
}

std::size_t countLogicalLines(const std::string& content) {
    return parseLines(content).size();
}

std::string formatVersion(std::uint64_t hash, std::uintmax_t size) {
    std::ostringstream stream;
    stream << "fnv1a64:" << std::hex << std::setw(16) << std::setfill('0') << hash
           << ":" << std::dec << size;
    return stream.str();
}

std::string versionForContent(const std::string& content) {
    constexpr std::uint64_t kFnvOffset = 14695981039346656037ULL;
    constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

    std::uint64_t hash = kFnvOffset;
    for (unsigned char byte : content) {
        hash ^= static_cast<std::uint64_t>(byte);
        hash *= kFnvPrime;
    }
    return formatVersion(hash, static_cast<std::uintmax_t>(content.size()));
}

std::string preferredLineEnding(const std::vector<TextLine>& lines) {
    for (const auto& line : lines) {
        if (!line.ending.empty()) {
            return line.ending;
        }
    }
    return "\n";
}

std::string makeInsertedLineBlock(const std::string& content, const std::string& lineEnding) {
    if (content.empty()) {
        return lineEnding;
    }
    if (!content.empty() && content.back() == '\n') {
        return content;
    }
    return content + lineEnding;
}

std::string normalizeLineEndings(std::string_view text, const std::string& lineEnding) {
    std::string normalized;
    normalized.reserve(text.size());

    for (std::size_t index = 0; index < text.size(); ++index) {
        const char ch = text[index];
        if (ch == '\r') {
            if (index + 1 < text.size() && text[index + 1] == '\n') {
                ++index;
            }
            normalized += lineEnding;
        } else if (ch == '\n') {
            normalized += lineEnding;
        } else {
            normalized.push_back(ch);
        }
    }
    return normalized;
}

std::string makeAppendedLineBlock(
    const std::string& currentContent,
    const std::string& content,
    const std::string& lineEnding) {
    std::string block;
    if (!currentContent.empty() && currentContent.back() != '\n') {
        block += lineEnding;
    }

    block += normalizeLineEndings(content, lineEnding);
    if (block.empty() || block.back() != '\n') {
        block += lineEnding;
    }
    return block;
}

std::string convertDocumentLineEndings(const std::string& content, const std::string& lineEnding) {
    const std::vector<TextLine> lines = parseLines(content);
    if (lines.empty()) {
        return content;
    }

    std::string converted;
    converted.reserve(content.size());
    for (const auto& line : lines) {
        converted.append(content, line.begin, line.bodyEnd - line.begin);
        if (!line.ending.empty()) {
            converted += lineEnding;
        }
    }
    return converted;
}

int lineNumberForOffset(const std::string& content, std::size_t offset) {
    offset = std::min(offset, content.size());
    int line = 1;
    for (std::size_t index = 0; index < offset; ++index) {
        if (content[index] == '\n') {
            ++line;
        }
    }
    return line;
}

Json::Value missingLineArgument(const std::string& key, const std::string& operation) {
    return makeError(key + " is required for " + operation + " operations");
}

Json::Value invalidLineNumber(
    const std::string& key,
    int requestedLine,
    std::size_t lineCount,
    const std::string& operation) {
    Json::Value error = makeError(key + " is outside the editable line range for " + operation);
    error[key] = requestedLine;
    error["line_count"] = static_cast<Json::UInt64>(lineCount);
    return error;
}

struct Position {
    int line = 0;
    int column = 0;
};

struct NormalizedEdit {
    std::size_t startOffset = 0;
    std::size_t endOffset = 0;
    std::string text;
    std::string op;
};

bool readPosition(const Json::Value& value, Position& position, std::string& error) {
    if (!value.isObject()) {
        error = "position must be an object";
        return false;
    }
    if (!value.isMember("line") || !value["line"].isInt()) {
        error = "position.line is required and must be an integer";
        return false;
    }
    if (!value.isMember("column") || !value["column"].isInt()) {
        error = "position.column is required and must be an integer";
        return false;
    }
    position.line = value["line"].asInt();
    position.column = value["column"].asInt();
    return true;
}

bool positionToOffset(
    const std::string& content,
    const std::vector<TextLine>& lines,
    const Position& position,
    std::size_t& offset,
    std::string& error) {
    if (position.line < 1 || position.column < 0) {
        error = "positions use 1-based line and 0-based column values";
        return false;
    }

    if (lines.empty()) {
        if (position.line == 1 && position.column == 0) {
            offset = 0;
            return true;
        }
        error = "position is outside the empty document";
        return false;
    }

    if (static_cast<std::size_t>(position.line) == lines.size() + 1) {
        const TextLine& last = lines.back();
        if (!last.ending.empty() && position.column == 0) {
            offset = content.size();
            return true;
        }
    }

    if (static_cast<std::size_t>(position.line) > lines.size()) {
        error = "position.line is outside the document";
        return false;
    }

    const TextLine& line = lines[static_cast<std::size_t>(position.line - 1)];
    const std::size_t lineBodyBytes = line.bodyEnd - line.begin;
    if (static_cast<std::size_t>(position.column) > lineBodyBytes) {
        error = "position.column is outside the line body; use the start of the next line to include a line break";
        return false;
    }

    offset = line.begin + static_cast<std::size_t>(position.column);
    return true;
}

Json::Value makeRangeError(const std::string& message, Json::ArrayIndex editIndex) {
    Json::Value error = makeError(message);
    error["edit_index"] = static_cast<Json::UInt>(editIndex);
    return error;
}

Json::Value expectedTextMismatch(const std::string& expected, const std::string& actual) {
    Json::Value error = makeError("expected_old_text did not match the current file content at the requested location");
    error["expected_old_text"] = expected;
    error["actual_old_text"] = actual;
    return error;
}

void addEditMetrics(
    Json::Value& value,
    std::size_t linesBefore,
    std::size_t linesAfter,
    int affectedStartLine,
    int affectedEndLine,
    bool changed) {
    value["changed"] = changed;
    value["line_count_before"] = static_cast<Json::UInt64>(linesBefore);
    value["line_count_after"] = static_cast<Json::UInt64>(linesAfter);
    value["line_delta"] = static_cast<Json::Int64>(
        static_cast<long long>(linesAfter) - static_cast<long long>(linesBefore));
    if (affectedStartLine > 0) {
        value["affected_start_line"] = affectedStartLine;
    }
    if (affectedEndLine > 0) {
        value["affected_end_line"] = affectedEndLine;
    }
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
    bool allowParentDirectoryCreation,
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
        if (allowParentDirectoryCreation) {
            fs::create_directories(parent, ec);
            if (ec) {
                Json::Value error = makeError("Failed to create parent directories: " + ec.message());
                error["path"] = pathText;
                return error;
            }
        } else {
            parent = normalizedParent;
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
    bool createdFile,
    const std::string& previousVersion,
    const std::string& nextVersion,
    std::size_t linesBefore,
    std::size_t linesAfter,
    int affectedStartLine,
    int affectedEndLine) {
    Json::Value editedFile(Json::objectValue);
    editedFile["path"] = relativePath.generic_string();
    editedFile["resolved_path"] = resolvedPath.string();
    editedFile["workspace_directory"] = workspaceRoot.string();
    editedFile["operation"] = operation;
    editedFile["created_file"] = createdFile;
    editedFile["bytes_before"] = static_cast<Json::UInt64>(bytesBefore);
    editedFile["bytes_after"] = static_cast<Json::UInt64>(bytesAfter);
    editedFile["previous_version"] = previousVersion;
    editedFile["version"] = nextVersion;
    editedFile["replacements"] = static_cast<Json::UInt64>(replacements);
    editedFile["checkpoint"] = checkpoint;
    editedFile["rollback_available"] = true;
    addEditMetrics(editedFile, linesBefore, linesAfter, affectedStartLine, affectedEndLine, true);
    return editedFile;
}

Json::Value normalizeRangeEdits(
    const Json::Value& editValues,
    const std::string& currentContent,
    const std::vector<TextLine>& currentLines,
    const std::string& lineEnding,
    std::vector<NormalizedEdit>& edits) {
    if (!editValues.isArray() || editValues.empty()) {
        return makeError("edits must be a non-empty array for edit operations");
    }

    for (Json::ArrayIndex index = 0; index < editValues.size(); ++index) {
        const Json::Value& item = editValues[index];
        if (!item.isObject()) {
            return makeRangeError("each edit must be an object", index);
        }

        const std::string op = getStringArg(item, "op");
        if (op != "insert" && op != "replace" && op != "delete") {
            return makeRangeError("edit op must be one of: insert, replace, delete", index);
        }

        NormalizedEdit edit;
        edit.op = op;
        std::string positionError;

        if (op == "insert") {
            if (!item.isMember("at")) {
                return makeRangeError("insert edits require at", index);
            }
            if (!hasStringArg(item, "text")) {
                return makeRangeError("insert edits require text", index);
            }
            Position at;
            if (!readPosition(item["at"], at, positionError) ||
                !positionToOffset(currentContent, currentLines, at, edit.startOffset, positionError)) {
                return makeRangeError(positionError, index);
            }
            edit.endOffset = edit.startOffset;
            edit.text = normalizeLineEndings(getStringArg(item, "text"), lineEnding);
        } else {
            if (!item.isMember("range") || !item["range"].isObject()) {
                return makeRangeError("replace and delete edits require range", index);
            }
            Position start;
            Position end;
            if (!item["range"].isMember("start") || !item["range"].isMember("end")) {
                return makeRangeError("range.start and range.end are required", index);
            }
            if (!readPosition(item["range"]["start"], start, positionError) ||
                !positionToOffset(currentContent, currentLines, start, edit.startOffset, positionError)) {
                return makeRangeError(positionError, index);
            }
            if (!readPosition(item["range"]["end"], end, positionError) ||
                !positionToOffset(currentContent, currentLines, end, edit.endOffset, positionError)) {
                return makeRangeError(positionError, index);
            }
            if (edit.endOffset < edit.startOffset) {
                return makeRangeError("range.end must be after or equal to range.start", index);
            }
            if (op == "replace") {
                if (!hasStringArg(item, "text")) {
                    return makeRangeError("replace edits require text", index);
                }
                edit.text = normalizeLineEndings(getStringArg(item, "text"), lineEnding);
            }
        }

        edits.push_back(std::move(edit));
    }

    std::vector<NormalizedEdit> sorted = edits;
    std::sort(sorted.begin(), sorted.end(), [](const NormalizedEdit& left, const NormalizedEdit& right) {
        if (left.startOffset != right.startOffset) {
            return left.startOffset < right.startOffset;
        }
        return left.endOffset < right.endOffset;
    });

    std::size_t previousEnd = 0;
    bool havePrevious = false;
    for (const auto& edit : sorted) {
        if (havePrevious && edit.startOffset < previousEnd) {
            return makeError("edits must not overlap");
        }
        previousEnd = edit.endOffset;
        havePrevious = true;
    }

    return Json::Value();
}

std::string applyNormalizedEdits(const std::string& currentContent, std::vector<NormalizedEdit> edits) {
    std::sort(edits.begin(), edits.end(), [](const NormalizedEdit& left, const NormalizedEdit& right) {
        if (left.startOffset != right.startOffset) {
            return left.startOffset > right.startOffset;
        }
        return left.endOffset > right.endOffset;
    });

    std::string nextContent = currentContent;
    for (const auto& edit : edits) {
        nextContent.replace(edit.startOffset, edit.endOffset - edit.startOffset, edit.text);
    }
    return nextContent;
}

Json::Value editFileInternal(const Json::Value& arguments, const fs::path& workspaceDirectory, bool commitChanges) {
    const std::string pathText = trimCopy(getStringArg(arguments, "path"));
    const std::string operation = trimCopy(getStringArg(arguments, "operation"));
    const bool createIfMissing = getBoolArg(arguments, "create_if_missing", operation == "write" || operation == "append");
    const bool createParentDirectories = getBoolArg(arguments, "create_parent_directories", false);
    const bool replaceAll = getBoolArg(arguments, "replace_all", false);

    const bool lineOperation =
        operation == "set_line" ||
        operation == "replace_line" ||
        operation == "replace_lines" ||
        operation == "insert_before" ||
        operation == "insert_before_line" ||
        operation == "insert_after" ||
        operation == "insert_after_line" ||
        operation == "delete_line" ||
        operation == "delete_lines";

    if (operation != "write" &&
        operation != "append" &&
        operation != "replace" &&
        operation != "edit" &&
        operation != "set_end_of_line" &&
        !lineOperation) {
        return makeError(
            "operation must be one of: write, append, replace, edit, set_line, replace_line, replace_lines, insert_before, insert_before_line, insert_after, insert_after_line, delete_line, delete_lines, set_end_of_line");
    }

    fs::path workspaceRoot;
    fs::path resolvedPath;
    fs::path relativePath;
    Json::Value resolvedError = resolveEditablePath(
        pathText,
        workspaceDirectory,
        createParentDirectories,
        commitChanges,
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
    int affectedStartLine = 0;
    int affectedEndLine = 0;
    const std::vector<TextLine> currentLines = parseLines(currentContent);
    const std::size_t linesBefore = currentLines.size();
    const std::string currentVersion = exists ? versionForContent(currentContent) : "missing";
    const std::string expectedVersion = getStringArg(arguments, "expected_version");
    const bool expectedOldTextProvided = hasStringArg(arguments, "expected_old_text");
    const std::string expectedOldText = getStringArg(arguments, "expected_old_text");

    if (expectedVersion.empty()) {
        Json::Value error = makeError("expected_version is required for file edits; read_file first or use expected_version \"missing\" when creating a new file");
        error["current_version"] = currentVersion;
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }
    if (expectedVersion != currentVersion) {
        Json::Value error = makeError("expected_version does not match the current file version; re-read the file and retry");
        error["expected_version"] = expectedVersion;
        error["current_version"] = currentVersion;
        error["stale"] = true;
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    if (operation == "write") {
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for write operations");
        }
        nextContent = getStringArg(arguments, "content");
        affectedStartLine = 1;
        affectedEndLine = static_cast<int>(std::max(linesBefore, countLogicalLines(nextContent)));
    } else if (operation == "append") {
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for append operations");
        }
        const std::string appendedText = makeAppendedLineBlock(
            currentContent,
            getStringArg(arguments, "content"),
            preferredLineEnding(currentLines));
        nextContent = currentContent + appendedText;
        if (!appendedText.empty()) {
            affectedStartLine = lineNumberForOffset(currentContent, currentContent.size());
            affectedEndLine = static_cast<int>(std::max<std::size_t>(
                static_cast<std::size_t>(affectedStartLine),
                countLogicalLines(nextContent)));
        }
    } else if (operation == "edit") {
        std::vector<NormalizedEdit> edits;
        const Json::Value normalizeError = normalizeRangeEdits(
            arguments["edits"],
            currentContent,
            currentLines,
            preferredLineEnding(currentLines),
            edits);
        if (!normalizeError.isNull()) {
            return normalizeError;
        }

        std::size_t firstOffset = currentContent.size();
        std::size_t lastOffset = 0;
        for (const auto& edit : edits) {
            firstOffset = std::min(firstOffset, edit.startOffset);
            lastOffset = std::max(lastOffset, edit.endOffset);
        }
        nextContent = applyNormalizedEdits(currentContent, edits);
        replacements = edits.size();
        affectedStartLine = lineNumberForOffset(currentContent, firstOffset);
        affectedEndLine = lineNumberForOffset(currentContent, lastOffset);
    } else if (operation == "set_end_of_line") {
        const std::string requestedEol = getStringArg(arguments, "eol");
        std::string lineEnding;
        if (requestedEol == "lf") {
            lineEnding = "\n";
        } else if (requestedEol == "crlf") {
            lineEnding = "\r\n";
        } else {
            return makeError("eol must be one of: lf, crlf");
        }
        nextContent = convertDocumentLineEndings(currentContent, lineEnding);
        replacements = linesBefore;
        affectedStartLine = linesBefore > 0 ? 1 : 0;
        affectedEndLine = static_cast<int>(linesBefore);
    } else if (operation == "replace") {
        const std::string oldText = getStringArg(arguments, "old_text");
        const std::string newText = getStringArg(arguments, "new_text");
        if (oldText.empty()) {
            return makeError("old_text is required for replace operations");
        }
        if (!exists) {
            return makeError("replace operations require an existing file");
        }
        std::size_t firstOccurrence = std::string::npos;
        std::size_t lastOccurrenceEnd = 0;
        std::size_t scanPosition = 0;
        while ((scanPosition = currentContent.find(oldText, scanPosition)) != std::string::npos) {
            if (firstOccurrence == std::string::npos) {
                firstOccurrence = scanPosition;
            }
            lastOccurrenceEnd = scanPosition + oldText.size();
            ++replacements;
            scanPosition += oldText.size();
        }
        if (replacements == 0) {
            return makeError("old_text was not found in the file");
        }
        if (replacements > 1 && !replaceAll) {
            Json::Value error = makeError("old_text occurs more than once; set replace_all to true or provide a more specific old_text");
            error["occurrences"] = static_cast<Json::UInt64>(replacements);
            return error;
        }
        affectedStartLine = lineNumberForOffset(currentContent, firstOccurrence);
        affectedEndLine = lineNumberForOffset(
            currentContent,
            replaceAll ? lastOccurrenceEnd : firstOccurrence + oldText.size());

        nextContent = currentContent;
        std::size_t pos = 0;
        while ((pos = nextContent.find(oldText, pos)) != std::string::npos) {
            nextContent.replace(pos, oldText.size(), newText);
            pos += newText.size();
            if (!replaceAll) {
                break;
            }
        }
    } else if (operation == "set_line" || operation == "replace_line") {
        if (!hasIntArg(arguments, "line")) {
            return missingLineArgument("line", operation);
        }
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for set_line operations");
        }

        const int line = getIntArg(arguments, "line");
        if (line < 1 || static_cast<std::size_t>(line) > linesBefore) {
            return invalidLineNumber("line", line, linesBefore, operation);
        }

        const std::string newLineBody = getStringArg(arguments, "content");
        if (newLineBody.find('\n') != std::string::npos || newLineBody.find('\r') != std::string::npos) {
            return makeError("content for set_line must be a single line body without line breaks; use replace_lines for multi-line edits");
        }

        const TextLine& target = currentLines[static_cast<std::size_t>(line - 1)];
        if (expectedOldTextProvided && expectedOldText != target.body) {
            return expectedTextMismatch(expectedOldText, target.body);
        }

        nextContent = currentContent.substr(0, target.begin) +
            newLineBody +
            target.ending +
            currentContent.substr(target.end);
        replacements = 1;
        affectedStartLine = line;
        affectedEndLine = line;
    } else if (operation == "replace_lines" || operation == "delete_lines" || operation == "delete_line") {
        const bool deleteSingleLine = operation == "delete_line";
        if (!hasIntArg(arguments, deleteSingleLine ? "line" : "start_line")) {
            if (deleteSingleLine) {
                return missingLineArgument("line", operation);
            }
            return missingLineArgument("start_line", operation);
        }
        if (operation == "replace_lines" && !hasStringArg(arguments, "content")) {
            return makeError("content is required for replace_lines operations");
        }

        const int startLine = deleteSingleLine ? getIntArg(arguments, "line") : getIntArg(arguments, "start_line");
        const int endLine = deleteSingleLine
            ? startLine
            : hasIntArg(arguments, "end_line")
            ? getIntArg(arguments, "end_line")
            : startLine;
        if (startLine < 1 || endLine < startLine) {
            Json::Value error = makeError("start_line and end_line must describe a forward 1-based inclusive line range");
            error["start_line"] = startLine;
            error["end_line"] = endLine;
            return error;
        }
        if (static_cast<std::size_t>(endLine) > linesBefore) {
            Json::Value error = invalidLineNumber("end_line", endLine, linesBefore, operation);
            error["start_line"] = startLine;
            return error;
        }

        const TextLine& first = currentLines[static_cast<std::size_t>(startLine - 1)];
        const TextLine& last = currentLines[static_cast<std::size_t>(endLine - 1)];
        const std::string oldRange = currentContent.substr(first.begin, last.end - first.begin);
        if (expectedOldTextProvided && expectedOldText != oldRange) {
            return expectedTextMismatch(expectedOldText, oldRange);
        }

        const std::string replacementText = operation == "replace_lines"
            ? normalizeLineEndings(getStringArg(arguments, "content"), preferredLineEnding(currentLines))
            : "";
        nextContent = currentContent.substr(0, first.begin) +
            replacementText +
            currentContent.substr(last.end);
        replacements = 1;
        affectedStartLine = startLine;
        affectedEndLine = endLine;
    } else if (operation == "insert_before" ||
        operation == "insert_before_line" ||
        operation == "insert_after" ||
        operation == "insert_after_line") {
        if (!hasIntArg(arguments, "line")) {
            return missingLineArgument("line", operation);
        }
        if (!hasStringArg(arguments, "content")) {
            return makeError("content is required for insert_before and insert_after operations");
        }

        const int line = getIntArg(arguments, "line");
        std::size_t insertOffset = 0;
        std::string anchorText;
        const TextLine* targetLine = nullptr;

        if (linesBefore == 0) {
            if ((operation != "insert_before" && operation != "insert_before_line") || line != 1) {
                return invalidLineNumber("line", line, linesBefore, operation);
            }
        } else {
            if (line < 1 || static_cast<std::size_t>(line) > linesBefore) {
                return invalidLineNumber("line", line, linesBefore, operation);
            }
            const TextLine& target = currentLines[static_cast<std::size_t>(line - 1)];
            targetLine = &target;
            const bool beforeLine = operation == "insert_before" || operation == "insert_before_line";
            insertOffset = beforeLine ? target.begin : target.end;
            anchorText = target.body;
        }

        if (expectedOldTextProvided && expectedOldText != anchorText) {
            return expectedTextMismatch(expectedOldText, anchorText);
        }

        const std::string fileLineEnding = preferredLineEnding(currentLines);
        const std::string insertedText = makeInsertedLineBlock(getStringArg(arguments, "content"), fileLineEnding);
        const bool afterLine = operation == "insert_after" || operation == "insert_after_line";
        const bool insertsAfterUnterminatedLine = afterLine &&
            targetLine != nullptr &&
            targetLine->ending.empty();
        const std::string separator = insertsAfterUnterminatedLine
            ? fileLineEnding
            : "";
        nextContent = currentContent.substr(0, insertOffset) +
            separator +
            insertedText +
            currentContent.substr(insertOffset);
        const std::size_t insertedLines = countLogicalLines(separator + insertedText);
        affectedStartLine = afterLine && !insertsAfterUnterminatedLine
            ? line + 1
            : line;
        affectedEndLine = affectedStartLine + static_cast<int>(insertedLines == 0 ? 0 : insertedLines - 1);
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

    const std::size_t linesAfter = countLogicalLines(nextContent);
    const std::string nextVersion = versionForContent(nextContent);
    if (exists && nextContent == currentContent) {
        Json::Value result(Json::objectValue);
        result["path"] = pathText;
        result["resolved_path"] = resolvedPath.string();
        result["workspace_directory"] = workspaceRoot.string();
        result["operation"] = operation;
        result["created_file"] = false;
        result["bytes_before"] = static_cast<Json::UInt64>(currentContent.size());
        result["bytes_after"] = static_cast<Json::UInt64>(nextContent.size());
        result["previous_version"] = currentVersion;
        result["version"] = currentVersion;
        result["replacements"] = static_cast<Json::UInt64>(replacements);
        result["checkpoint"] = Json::Value(Json::nullValue);
        result["rollback_available"] = false;
        result["edited_files"] = Json::Value(Json::arrayValue);
        addEditMetrics(result, linesBefore, linesAfter, affectedStartLine, affectedEndLine, false);
        result["output"] = "No file changes were needed; target content already matched the request.";
        return result;
    }

    if (!commitChanges) {
        return Json::Value();
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
        !exists,
        currentVersion,
        nextVersion,
        linesBefore,
        linesAfter,
        affectedStartLine,
        affectedEndLine);
    Json::Value editedFiles(Json::arrayValue);
    editedFiles.append(editedFile);

    result["path"] = pathText;
    result["resolved_path"] = resolvedPath.string();
    result["workspace_directory"] = workspaceRoot.string();
    result["operation"] = operation;
    result["created_file"] = !exists;
    result["bytes_before"] = static_cast<Json::UInt64>(currentContent.size());
    result["bytes_after"] = static_cast<Json::UInt64>(nextContent.size());
    result["previous_version"] = currentVersion;
    result["version"] = nextVersion;
    result["replacements"] = static_cast<Json::UInt64>(replacements);
    result["checkpoint"] = checkpoint;
    result["rollback_available"] = true;
    result["edited_files"] = editedFiles;
    addEditMetrics(result, linesBefore, linesAfter, affectedStartLine, affectedEndLine, true);
    result["output"] = "File edit completed with checkpoint " + checkpoint["id"].asString();
    return result;
}

} // namespace

Json::Value file_edit_tool::preflightEditFile(const Json::Value& arguments, const fs::path& workspaceDirectory) {
    return editFileInternal(arguments, workspaceDirectory, false);
}

Json::Value file_edit_tool::editFile(const Json::Value& arguments, const fs::path& workspaceDirectory) {
    return editFileInternal(arguments, workspaceDirectory, true);
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
