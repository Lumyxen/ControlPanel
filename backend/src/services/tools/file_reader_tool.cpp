#include "services/tools/file_reader_tool.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr int kDefaultMaxLines = 400;
constexpr int kMaxLinesLimit = 5000;
constexpr int kDefaultMaxChars = 60000;
constexpr int kMaxCharsLimit = 200000;
constexpr std::uintmax_t kScanByteLimit = 100ULL * 1024ULL * 1024ULL;

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

bool getBoolArg(const Json::Value& value, const std::string& key, bool fallback) {
    if (value.isObject() && value.isMember(key) && value[key].isBool()) {
        return value[key].asBool();
    }
    return fallback;
}

struct ReadLineMeta {
    int number = 0;
    std::string lineEnding;
    bool empty = true;
    bool truncated = false;
};

struct DocumentInfo {
    std::string version;
    std::string eol = "none";
    bool hasTrailingNewline = false;
    int lfLineEndings = 0;
    int crlfLineEndings = 0;
    int otherLineEndings = 0;
    std::string error;
    std::uintmax_t errorByteOffset = 0;
};

std::string byteOffsetMessage(const std::string& prefix, std::uintmax_t byteOffset) {
    return prefix + " at byte offset " + std::to_string(byteOffset);
}

bool hasContinuationBytes(const std::string& input, std::size_t index, std::size_t count) {
    if (index + count >= input.size()) {
        return false;
    }
    for (std::size_t offset = 1; offset <= count; ++offset) {
        const auto ch = static_cast<unsigned char>(input[index + offset]);
        if ((ch & 0xC0U) != 0x80U) {
            return false;
        }
    }
    return true;
}

void appendEscapedByte(std::string& out, unsigned char ch) {
    std::ostringstream stream;
    stream << "\\x" << std::uppercase << std::hex << std::setw(2) << std::setfill('0')
           << static_cast<int>(ch);
    out += stream.str();
}

std::string sanitizeUtf8(const std::string& input, bool& replacedInvalidUtf8, bool& escapedControlBytes) {
    std::string output;
    output.reserve(input.size());

    for (std::size_t index = 0; index < input.size();) {
        const auto ch = static_cast<unsigned char>(input[index]);
        if (ch < 0x80U) {
            if (ch < 0x20U && ch != '\n' && ch != '\r' && ch != '\t') {
                appendEscapedByte(output, ch);
                escapedControlBytes = true;
            } else {
                output.push_back(static_cast<char>(ch));
            }
            ++index;
            continue;
        }

        std::size_t length = 0;
        bool valid = false;
        if (ch >= 0xC2U && ch <= 0xDFU) {
            length = 2;
            valid = hasContinuationBytes(input, index, 1);
        } else if (ch == 0xE0U) {
            length = 3;
            valid = index + 2 < input.size() &&
                    static_cast<unsigned char>(input[index + 1]) >= 0xA0U &&
                    static_cast<unsigned char>(input[index + 1]) <= 0xBFU &&
                    (static_cast<unsigned char>(input[index + 2]) & 0xC0U) == 0x80U;
        } else if (ch >= 0xE1U && ch <= 0xECU) {
            length = 3;
            valid = hasContinuationBytes(input, index, 2);
        } else if (ch == 0xEDU) {
            length = 3;
            valid = index + 2 < input.size() &&
                    static_cast<unsigned char>(input[index + 1]) >= 0x80U &&
                    static_cast<unsigned char>(input[index + 1]) <= 0x9FU &&
                    (static_cast<unsigned char>(input[index + 2]) & 0xC0U) == 0x80U;
        } else if (ch >= 0xEEU && ch <= 0xEFU) {
            length = 3;
            valid = hasContinuationBytes(input, index, 2);
        } else if (ch == 0xF0U) {
            length = 4;
            valid = index + 3 < input.size() &&
                    static_cast<unsigned char>(input[index + 1]) >= 0x90U &&
                    static_cast<unsigned char>(input[index + 1]) <= 0xBFU &&
                    (static_cast<unsigned char>(input[index + 2]) & 0xC0U) == 0x80U &&
                    (static_cast<unsigned char>(input[index + 3]) & 0xC0U) == 0x80U;
        } else if (ch >= 0xF1U && ch <= 0xF3U) {
            length = 4;
            valid = hasContinuationBytes(input, index, 3);
        } else if (ch == 0xF4U) {
            length = 4;
            valid = index + 3 < input.size() &&
                    static_cast<unsigned char>(input[index + 1]) >= 0x80U &&
                    static_cast<unsigned char>(input[index + 1]) <= 0x8FU &&
                    (static_cast<unsigned char>(input[index + 2]) & 0xC0U) == 0x80U &&
                    (static_cast<unsigned char>(input[index + 3]) & 0xC0U) == 0x80U;
        }

        if (valid) {
            output.append(input, index, length);
            index += length;
            continue;
        }

        output += "\xEF\xBF\xBD";
        replacedInvalidUtf8 = true;
        ++index;
    }

    return output;
}

std::string formatVersion(std::uint64_t hash, std::uintmax_t size) {
    std::ostringstream stream;
    stream << "fnv1a64:" << std::hex << std::setw(16) << std::setfill('0') << hash
           << ":" << std::dec << size;
    return stream.str();
}

std::string chooseEol(int lfCount, int crlfCount, int otherCount) {
    const int kinds = (lfCount > 0) + (crlfCount > 0) + (otherCount > 0);
    if (kinds == 0) {
        return "none";
    }
    if (kinds > 1) {
        return "mixed";
    }
    if (crlfCount > 0) {
        return "crlf";
    }
    if (lfCount > 0) {
        return "lf";
    }
    return "other";
}

DocumentInfo inspectDocument(const fs::path& path, std::uintmax_t fileSize) {
    constexpr std::uint64_t kFnvOffset = 14695981039346656037ULL;
    constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

    DocumentInfo info;
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {
        info.error = "Failed to open file for document inspection";
        return info;
    }

    std::uint64_t hash = kFnvOffset;
    std::uintmax_t byteOffset = 0;
    bool pendingCarriageReturn = false;
    bool sawAnyByte = false;
    unsigned char lastByte = 0;

    char ch = '\0';
    while (file.get(ch)) {
        const auto byte = static_cast<unsigned char>(ch);
        sawAnyByte = true;
        lastByte = byte;
        hash ^= static_cast<std::uint64_t>(byte);
        hash *= kFnvPrime;

        if (byte == 0) {
            info.error = byteOffsetMessage("Refusing to read likely binary file; found NUL byte", byteOffset);
            info.errorByteOffset = byteOffset;
            return info;
        }

        if (pendingCarriageReturn) {
            if (byte == '\n') {
                ++info.crlfLineEndings;
                pendingCarriageReturn = false;
                ++byteOffset;
                continue;
            }
            ++info.otherLineEndings;
            pendingCarriageReturn = false;
        }

        if (byte == '\r') {
            pendingCarriageReturn = true;
        } else if (byte == '\n') {
            ++info.lfLineEndings;
        }

        ++byteOffset;
    }

    if (pendingCarriageReturn) {
        ++info.otherLineEndings;
    }

    info.version = formatVersion(hash, fileSize);
    info.eol = chooseEol(info.lfLineEndings, info.crlfLineEndings, info.otherLineEndings);
    info.hasTrailingNewline = sawAnyByte && (lastByte == '\n' || lastByte == '\r');
    return info;
}

std::string lineEndingCode(const std::string& lineEnding) {
    if (lineEnding == "\r\n") {
        return "crlf";
    }
    if (lineEnding == "\n") {
        return "lf";
    }
    if (lineEnding.empty()) {
        return "none";
    }
    return "other";
}

std::string compressLineRanges(const std::vector<int>& lineNumbers) {
    if (lineNumbers.empty()) {
        return "";
    }

    std::ostringstream stream;
    int rangeStart = lineNumbers.front();
    int previous = rangeStart;
    bool firstRange = true;

    auto appendRange = [&]() {
        if (!firstRange) {
            stream << ",";
        }
        firstRange = false;
        stream << rangeStart;
        if (previous != rangeStart) {
            stream << "-" << previous;
        }
    };

    for (std::size_t index = 1; index < lineNumbers.size(); ++index) {
        const int lineNumber = lineNumbers[index];
        if (lineNumber == previous + 1) {
            previous = lineNumber;
            continue;
        }
        appendRange();
        rangeStart = lineNumber;
        previous = lineNumber;
    }
    appendRange();
    return stream.str();
}

std::string joinLineEndingOverrides(
    const std::vector<ReadLineMeta>& lines,
    const std::string& dominantLineEnding,
    bool& truncated) {
    constexpr std::size_t kMaxOverrides = 100;

    std::ostringstream stream;
    std::size_t emitted = 0;
    bool first = true;
    for (const auto& line : lines) {
        const std::string code = lineEndingCode(line.lineEnding);
        if (code == dominantLineEnding) {
            continue;
        }
        if (emitted >= kMaxOverrides) {
            truncated = true;
            break;
        }
        if (!first) {
            stream << ",";
        }
        first = false;
        stream << line.number << ":" << code;
        ++emitted;
    }
    return stream.str();
}

Json::Value buildLineMetadata(const std::vector<ReadLineMeta>& lines) {
    Json::Value metadata(Json::objectValue);
    if (lines.empty()) {
        return metadata;
    }

    int lfCount = 0;
    int crlfCount = 0;
    int noneCount = 0;
    int otherCount = 0;
    std::vector<int> blankLines;
    std::vector<int> truncatedLines;

    for (const auto& line : lines) {
        const std::string code = lineEndingCode(line.lineEnding);
        if (code == "lf") {
            ++lfCount;
        } else if (code == "crlf") {
            ++crlfCount;
        } else if (code == "none") {
            ++noneCount;
        } else {
            ++otherCount;
        }
        if (line.empty) {
            blankLines.push_back(line.number);
        }
        if (line.truncated) {
            truncatedLines.push_back(line.number);
        }
    }

    std::string dominant = "lf";
    int dominantCount = lfCount;
    if (crlfCount > dominantCount) {
        dominant = "crlf";
        dominantCount = crlfCount;
    }
    if (noneCount > dominantCount) {
        dominant = "none";
        dominantCount = noneCount;
    }
    if (otherCount > dominantCount) {
        dominant = "other";
    }

    metadata["first_line"] = lines.front().number;
    metadata["last_line"] = lines.back().number;
    const std::string blankLineRanges = compressLineRanges(blankLines);
    if (!blankLineRanges.empty()) {
        metadata["blank_line_ranges"] = blankLineRanges;
    }
    const std::string truncatedLineRanges = compressLineRanges(truncatedLines);
    if (!truncatedLineRanges.empty()) {
        metadata["truncated_line_ranges"] = truncatedLineRanges;
    }

    Json::Value lineEndings(Json::objectValue);
    const int lineEndingKinds =
        (lfCount > 0) + (crlfCount > 0) + (noneCount > 0) + (otherCount > 0);
    lineEndings["dominant"] = dominant;
    lineEndings["mixed"] = lineEndingKinds > 1;
    if (lfCount > 0) {
        lineEndings["lf"] = lfCount;
    }
    if (crlfCount > 0) {
        lineEndings["crlf"] = crlfCount;
    }
    if (noneCount > 0) {
        lineEndings["none"] = noneCount;
    }
    if (otherCount > 0) {
        lineEndings["other"] = otherCount;
    }
    if (lineEndings["mixed"].asBool()) {
        bool overridesTruncated = false;
        const std::string overrides = joinLineEndingOverrides(lines, dominant, overridesTruncated);
        if (!overrides.empty()) {
            lineEndings["non_dominant_lines"] = overrides;
            lineEndings["non_dominant_lines_truncated"] = overridesTruncated;
        }
    }
    metadata["line_endings"] = lineEndings;
    return metadata;
}

std::string buildNumberedContent(const std::string& content, int startLine) {
    std::ostringstream stream;
    int lineNumber = startLine;
    std::size_t position = 0;

    while (position < content.size()) {
        stream << lineNumber << " | ";
        const std::size_t newline = content.find('\n', position);
        if (newline == std::string::npos) {
            stream << content.substr(position);
            break;
        }
        stream << content.substr(position, newline - position + 1);
        position = newline + 1;
        ++lineNumber;
    }

    return stream.str();
}

fs::path resolvePath(const std::string& pathText, const fs::path& workingDirectory) {
    const fs::path inputPath(pathText);
    const fs::path baseDirectory = workingDirectory.empty() ? fs::current_path() : workingDirectory;
    const fs::path absolutePath = inputPath.is_absolute()
        ? inputPath
        : baseDirectory / inputPath;

    std::error_code ec;
    const fs::path resolved = fs::weakly_canonical(absolutePath, ec);
    if (!ec) {
        return resolved;
    }
    return absolutePath.lexically_normal();
}

} // namespace

Json::Value file_reader_tool::readFile(const Json::Value& arguments) {
    return readFile(arguments, fs::current_path());
}

Json::Value file_reader_tool::readFile(const Json::Value& arguments, const fs::path& workingDirectory) {
    const std::string pathText = trimCopy(getStringArg(arguments, "path"));
    if (pathText.empty()) {
        return makeError("path is required");
    }

    const int startLine = std::max(1, getIntArg(arguments, "start_line", 1));
    const int maxLines = std::clamp(getIntArg(arguments, "max_lines", kDefaultMaxLines), 1, kMaxLinesLimit);
    const int maxChars = std::clamp(getIntArg(arguments, "max_chars", kDefaultMaxChars), 1, kMaxCharsLimit);
    const std::string view = getStringArg(arguments, "view", "plain");
    if (view != "plain" && view != "numbered") {
        return makeError("view must be one of: plain, numbered");
    }
    const bool includeNumberedView =
        view == "numbered" ||
        getBoolArg(arguments, "include_numbered_view", false) ||
        getBoolArg(arguments, "include_line_numbers", false);
    const fs::path baseDirectory = workingDirectory.empty() ? fs::current_path() : workingDirectory;

    const fs::path resolvedPath = resolvePath(pathText, baseDirectory);
    std::error_code ec;
    if (!fs::exists(resolvedPath, ec) || ec) {
        Json::Value error = makeError("File does not exist");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        error["working_directory"] = baseDirectory.string();
        return error;
    }
    if (!fs::is_regular_file(resolvedPath, ec) || ec) {
        Json::Value error = makeError("Path is not a regular file");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    const std::uintmax_t fileSize = fs::file_size(resolvedPath, ec);
    if (ec) {
        Json::Value error = makeError("Failed to read file metadata: " + ec.message());
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    const DocumentInfo documentInfo = inspectDocument(resolvedPath, fileSize);
    if (!documentInfo.error.empty()) {
        Json::Value error = makeError(documentInfo.error);
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        error["size_bytes"] = static_cast<Json::UInt64>(fileSize);
        if (documentInfo.errorByteOffset > 0) {
            error["byte_offset"] = static_cast<Json::UInt64>(documentInfo.errorByteOffset);
        }
        return error;
    }

    std::ifstream file(resolvedPath, std::ios::binary);
    if (!file.is_open()) {
        Json::Value error = makeError("Failed to open file");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        return error;
    }

    std::string rawContent;
    rawContent.reserve(static_cast<std::size_t>(std::min(maxChars, 65536)));

    int currentLine = 1;
    int linesRead = 0;
    bool sawAnyByte = false;
    bool endedWithNewline = false;
    bool lineStarted = false;
    bool truncatedByLines = false;
    bool truncatedByChars = false;
    bool scanLimitReached = false;
    std::uintmax_t byteOffset = 0;
    int nextStartLine = 0;
    std::vector<ReadLineMeta> readLineMetadata;
    bool currentLineEmpty = true;
    bool pendingReadableCarriageReturn = false;

    auto appendRaw = [&](std::string_view text) -> bool {
        if (rawContent.size() >= static_cast<std::size_t>(maxChars)) {
            truncatedByChars = true;
            return false;
        }
        const std::size_t remaining = static_cast<std::size_t>(maxChars) - rawContent.size();
        if (text.size() > remaining) {
            rawContent.append(text.substr(0, remaining));
            truncatedByChars = true;
            return false;
        }
        rawContent.append(text);
        return true;
    };

    auto beginReadableLine = [&]() -> bool {
        if (lineStarted) {
            return true;
        }
        lineStarted = true;
        return true;
    };

    auto finishReadableLine = [&](const std::string& lineEnding, bool lineWasTruncated) {
        ReadLineMeta line;
        line.number = currentLine;
        line.lineEnding = lineEnding;
        line.empty = currentLineEmpty;
        line.truncated = lineWasTruncated;
        readLineMetadata.push_back(std::move(line));
        currentLineEmpty = true;
    };

    char ch = '\0';
    while (file.get(ch)) {
        sawAnyByte = true;
        ++byteOffset;

        if (ch == '\0') {
            Json::Value error = makeError(byteOffsetMessage("Refusing to read likely binary file; found NUL byte", byteOffset - 1));
            error["path"] = pathText;
            error["resolved_path"] = resolvedPath.string();
            error["size_bytes"] = static_cast<Json::UInt64>(fileSize);
            return error;
        }

        if (byteOffset > kScanByteLimit && currentLine < startLine) {
            scanLimitReached = true;
            break;
        }

        if (currentLine < startLine) {
            endedWithNewline = ch == '\n';
            if (ch == '\n') {
                ++currentLine;
            }
            continue;
        }

        if (!beginReadableLine()) {
            nextStartLine = currentLine;
            break;
        }

        if (ch != '\n' && ch != '\r') {
            currentLineEmpty = false;
        }
        if (!appendRaw(std::string_view(&ch, 1))) {
            finishReadableLine("", true);
            nextStartLine = currentLine;
            break;
        }

        if (ch == '\r') {
            pendingReadableCarriageReturn = true;
        }

        endedWithNewline = ch == '\n';
        if (ch == '\n') {
            finishReadableLine(pendingReadableCarriageReturn ? "\r\n" : "\n", false);
            pendingReadableCarriageReturn = false;
            ++linesRead;
            lineStarted = false;
            ++currentLine;
            if (linesRead >= maxLines) {
                if (file.peek() != std::ifstream::traits_type::eof()) {
                    truncatedByLines = true;
                    nextStartLine = currentLine;
                }
                break;
            }
        } else if (ch != '\r') {
            pendingReadableCarriageReturn = false;
        }
    }

    if (scanLimitReached) {
        Json::Value error = makeError("start_line was not reached before the scan limit");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        error["start_line"] = startLine;
        error["last_scanned_line"] = currentLine;
        error["scan_limit_bytes"] = static_cast<Json::UInt64>(kScanByteLimit);
        return error;
    }

    const bool reachedEof = file.eof();
    if (lineStarted && !truncatedByChars && !truncatedByLines) {
        finishReadableLine("", false);
        ++linesRead;
    }

    bool replacedInvalidUtf8 = false;
    bool escapedControlBytes = false;
    const std::string content = sanitizeUtf8(rawContent, replacedInvalidUtf8, escapedControlBytes);

    Json::Value result(Json::objectValue);
    result["path"] = pathText;
    result["resolved_path"] = resolvedPath.string();
    result["working_directory"] = baseDirectory.string();
    result["size_bytes"] = static_cast<Json::UInt64>(fileSize);
    result["version"] = documentInfo.version;
    result["encoding"] = "utf-8";
    result["eol"] = documentInfo.eol;
    result["has_trailing_newline"] = documentInfo.hasTrailingNewline;
    result["start_line"] = startLine;
    result["end_line"] = linesRead > 0 ? startLine + linesRead - 1 : startLine - 1;
    result["lines_read"] = linesRead;
    result["max_lines"] = maxLines;
    result["max_chars"] = maxChars;
    result["content_format"] = "plain";
    result["content_is_exact_file_text"] = true;
    result["content"] = content;
    if (includeNumberedView) {
        result["view"] = "numbered";
        result["numbered_content"] = buildNumberedContent(content, startLine);
    } else {
        result["view"] = "plain";
    }
    result["line_metadata"] = buildLineMetadata(readLineMetadata);
    result["truncated"] = truncatedByLines || truncatedByChars;
    result["truncated_by_lines"] = truncatedByLines;
    result["truncated_by_chars"] = truncatedByChars;
    result["utf8_replacements"] = replacedInvalidUtf8;
    result["control_bytes_escaped"] = escapedControlBytes;
    if (nextStartLine > 0) {
        result["next_start_line"] = nextStartLine;
    }
    if (reachedEof) {
        int totalLines = 0;
        if (sawAnyByte) {
            totalLines = endedWithNewline ? currentLine - 1 : currentLine;
        }
        result["total_lines_known"] = true;
        result["total_lines"] = totalLines;
    } else {
        result["total_lines_known"] = false;
    }
    return result;
}
