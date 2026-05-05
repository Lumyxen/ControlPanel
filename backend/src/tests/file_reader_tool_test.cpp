#include "services/tools/file_reader_tool.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;

namespace {

class ScopedDir {
public:
    ScopedDir() {
        path_ = fs::temp_directory_path() / ("ctrlpanel-file-reader-test-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path_);
    }

    ~ScopedDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }

    const fs::path& path() const {
        return path_;
    }

private:
    fs::path path_;
};

void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void writeFile(const fs::path& path, const std::string& body) {
    std::ofstream file(path, std::ios::binary);
    expect(file.is_open(), "Failed to create test file");
    file << body;
}

void testLineWindowIsPlainByDefault() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "sample.txt";
    writeFile(filePath, "alpha\nbeta\ngamma\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["start_line"] = 2;
    args["max_lines"] = 1;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "readFile returned an unexpected error");
    expect(result["content"].asString() == "beta\n", "content should not include synthetic line numbers");
    expect(!result.isMember("numbered_content"), "numbered_content should be omitted unless requested");
    expect(result["content_format"].asString() == "plain", "content should be reported as plain file text");
    expect(result["content_is_exact_file_text"].asBool(), "content should be marked as exact file text");
    expect(result["lines_read"].asInt() == 1, "lines_read should be 1");
    expect(result["truncated_by_lines"].asBool(), "result should be line-truncated");
    expect(result["next_start_line"].asInt() == 3, "next_start_line should point at line 3");
}

void testNumberedViewIsSeparateFromContent() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "numbered.txt";
    writeFile(filePath, "alpha\nbeta\ngamma\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["start_line"] = 2;
    args["max_lines"] = 1;
    args["view"] = "numbered";

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "numbered view read returned an unexpected error");
    expect(result["content"].asString() == "beta\n", "content should stay exact when numbered view is requested");
    expect(result["view"].asString() == "numbered", "readFile should report the requested numbered view");
    expect(result["numbered_content"].asString() == "2 | beta\n", "numbered_content should contain the rendered numbered view");
}

void testCrLfContentIsPreserved() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "crlf-content.txt";
    writeFile(filePath, "alpha\r\nbeta\r\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["include_numbered_view"] = true;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "CRLF content read returned an unexpected error");
    expect(result["content"].asString() == "alpha\r\nbeta\r\n", "content should preserve CRLF bytes");
    expect(result["numbered_content"].asString() == "1 | alpha\r\n2 | beta\r\n", "numbered view should preserve CRLF line endings");
}

void testReadReturnsDocumentState() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "state.txt";
    writeFile(filePath, "one\ntwo");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "document state read returned an unexpected error");
    expect(result["version"].isString(), "readFile should return a document version");
    expect(result["encoding"].asString() == "utf-8", "readFile should report UTF-8 text encoding");
    expect(result["eol"].asString() == "lf", "readFile should report document EOL style");
    expect(!result["has_trailing_newline"].asBool(), "readFile should report missing trailing newline");
    expect(result["start_line"].asInt() == 1, "readFile should report start_line");
    expect(result["end_line"].asInt() == 2, "readFile should report end_line");
}

void testPlainTextWindow() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "plain.txt";
    writeFile(filePath, "one\ntwo\nthree\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["max_lines"] = 2;
    args["include_line_numbers"] = false;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "plain read returned an unexpected error");
    expect(result["content"].asString() == "one\ntwo\n", "plain content did not match");
    expect(result["lines_read"].asInt() == 2, "plain read should return two lines");
}

void testCompactLineMetadataPreservesEmptyLines() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "empty-line.txt";
    writeFile(filePath, "alpha\n\nomega\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["max_lines"] = 3;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "compact metadata read returned an unexpected error");
    expect(!result.isMember("lines"), "readFile should not duplicate every line as JSON objects");
    expect(result["line_metadata"].isObject(), "readFile should return compact line metadata");
    expect(result["line_metadata"]["first_line"].asInt() == 1, "line metadata should report the first line");
    expect(result["line_metadata"]["last_line"].asInt() == 3, "line metadata should report the last line");
    expect(result["line_metadata"]["blank_line_ranges"].asString() == "2", "empty line should be represented compactly");
    expect(result["line_metadata"]["line_endings"]["dominant"].asString() == "lf", "LF should be the dominant line ending");
}

void testCompactLineMetadataReportsCrLfEndings() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "crlf.txt";
    writeFile(filePath, "alpha\r\nbeta\r\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["max_lines"] = 2;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "CRLF read returned an unexpected error");
    expect(!result.isMember("lines"), "CRLF read should not duplicate line text");
    expect(result["line_metadata"]["line_endings"]["dominant"].asString() == "crlf", "CRLF should be the dominant line ending");
    expect(result["line_metadata"]["line_endings"]["crlf"].asInt() == 2, "CRLF line ending count should be reported");
    expect(!result["line_metadata"]["line_endings"]["mixed"].asBool(), "uniform CRLF file should not be marked mixed");
}

void testMissingFileErrorIncludesResolvedPath() {
    ScopedDir temp;

    Json::Value args(Json::objectValue);
    args["path"] = (temp.path() / "missing.txt").string();

    const Json::Value result = file_reader_tool::readFile(args);
    expect(result.isMember("error"), "missing file should return an error");
    expect(result.isMember("resolved_path"), "missing file error should include resolved_path");
}

void testBinaryFileRejected() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "binary.dat";
    writeFile(filePath, std::string("abc\0def", 7));

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();

    const Json::Value result = file_reader_tool::readFile(args);
    expect(result.isMember("error"), "binary file should return an error");
    expect(result["error"].asString().find("binary") != std::string::npos, "binary error should explain the rejection");
}

void testInvalidUtf8IsReplaced() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "invalid.txt";
    writeFile(filePath, std::string("ok ") + std::string(1, static_cast<char>(0xFF)) + "\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["include_line_numbers"] = false;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "invalid UTF-8 should be sanitized, not rejected");
    expect(result["utf8_replacements"].asBool(), "invalid UTF-8 should report replacements");
}

} // namespace

int main() {
    try {
        testLineWindowIsPlainByDefault();
        testNumberedViewIsSeparateFromContent();
        testCrLfContentIsPreserved();
        testReadReturnsDocumentState();
        testPlainTextWindow();
        testCompactLineMetadataPreservesEmptyLines();
        testCompactLineMetadataReportsCrLfEndings();
        testMissingFileErrorIncludesResolvedPath();
        testBinaryFileRejected();
        testInvalidUtf8IsReplaced();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "file_reader_tool_test failed: " << exception.what() << "\n";
        return 1;
    }
}
