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

void testLineWindowWithNumbers() {
    ScopedDir temp;
    const fs::path filePath = temp.path() / "sample.txt";
    writeFile(filePath, "alpha\nbeta\ngamma\n");

    Json::Value args(Json::objectValue);
    args["path"] = filePath.string();
    args["start_line"] = 2;
    args["max_lines"] = 1;

    const Json::Value result = file_reader_tool::readFile(args);
    expect(!result.isMember("error"), "readFile returned an unexpected error");
    expect(result["content"].asString() == "2 | beta\n", "line-numbered content did not match");
    expect(result["lines_read"].asInt() == 1, "lines_read should be 1");
    expect(result["truncated_by_lines"].asBool(), "result should be line-truncated");
    expect(result["next_start_line"].asInt() == 3, "next_start_line should point at line 3");
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
        testLineWindowWithNumbers();
        testPlainTextWindow();
        testMissingFileErrorIncludesResolvedPath();
        testBinaryFileRejected();
        testInvalidUtf8IsReplaced();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "file_reader_tool_test failed: " << exception.what() << "\n";
        return 1;
    }
}
