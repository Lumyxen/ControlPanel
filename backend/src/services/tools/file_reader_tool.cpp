#include "services/tools/file_reader_tool.h"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <string_view>

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

fs::path resolvePath(const std::string& pathText) {
    const fs::path inputPath(pathText);
    const fs::path absolutePath = inputPath.is_absolute()
        ? inputPath
        : fs::current_path() / inputPath;

    std::error_code ec;
    const fs::path resolved = fs::weakly_canonical(absolutePath, ec);
    if (!ec) {
        return resolved;
    }
    return absolutePath.lexically_normal();
}

} // namespace

Json::Value file_reader_tool::readFile(const Json::Value& arguments) {
    const std::string pathText = trimCopy(getStringArg(arguments, "path"));
    if (pathText.empty()) {
        return makeError("path is required");
    }

    const int startLine = std::max(1, getIntArg(arguments, "start_line", 1));
    const int maxLines = std::clamp(getIntArg(arguments, "max_lines", kDefaultMaxLines), 1, kMaxLinesLimit);
    const int maxChars = std::clamp(getIntArg(arguments, "max_chars", kDefaultMaxChars), 1, kMaxCharsLimit);
    const bool includeLineNumbers = getBoolArg(arguments, "include_line_numbers", true);

    const fs::path resolvedPath = resolvePath(pathText);
    std::error_code ec;
    if (!fs::exists(resolvedPath, ec) || ec) {
        Json::Value error = makeError("File does not exist");
        error["path"] = pathText;
        error["resolved_path"] = resolvedPath.string();
        error["working_directory"] = fs::current_path().string();
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
        if (!includeLineNumbers) {
            return true;
        }
        const std::string prefix = std::to_string(currentLine) + " | ";
        return appendRaw(prefix);
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

        if (ch != '\r' && !appendRaw(std::string_view(&ch, 1))) {
            nextStartLine = currentLine;
            break;
        }

        endedWithNewline = ch == '\n';
        if (ch == '\n') {
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
        ++linesRead;
    }

    bool replacedInvalidUtf8 = false;
    bool escapedControlBytes = false;
    const std::string content = sanitizeUtf8(rawContent, replacedInvalidUtf8, escapedControlBytes);

    Json::Value result(Json::objectValue);
    result["path"] = pathText;
    result["resolved_path"] = resolvedPath.string();
    result["working_directory"] = fs::current_path().string();
    result["size_bytes"] = static_cast<Json::UInt64>(fileSize);
    result["start_line"] = startLine;
    result["lines_read"] = linesRead;
    result["max_lines"] = maxLines;
    result["max_chars"] = maxChars;
    result["include_line_numbers"] = includeLineNumbers;
    result["content"] = content;
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
