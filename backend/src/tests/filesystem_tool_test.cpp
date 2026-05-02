#include "services/tools/file_reader_tool.h"
#include "services/tools/filesystem_tool.h"

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
        path_ = fs::temp_directory_path() / ("ctrlpanel-filesystem-test-" + std::to_string(
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

void testWorkingDirectoryAndRelativeRead() {
    ScopedDir temp;
    fs::create_directories(temp.path() / "project" / "src");
    writeFile(temp.path() / "project" / "src" / "main.txt", "hello\n");

    Json::Value cdArgs(Json::objectValue);
    cdArgs["path"] = "project";
    const Json::Value cdResult = filesystem_tool::changeWorkingDirectory(cdArgs, temp.path());
    expect(!cdResult.isMember("error"), "changeWorkingDirectory returned an unexpected error");
    expect(cdResult["working_directory"].asString() == (temp.path() / "project").string(), "working directory did not change");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "src/main.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, fs::path(cdResult["working_directory"].asString()));
    expect(!readResult.isMember("error"), "relative read returned an unexpected error");
    expect(readResult["content"].asString() == "hello\n", "relative read content did not match");
}

void testDirectoryListingSkipsHiddenByDefault() {
    ScopedDir temp;
    fs::create_directories(temp.path() / "visible_dir");
    writeFile(temp.path() / "visible.txt", "visible");
    writeFile(temp.path() / ".hidden.txt", "hidden");

    Json::Value args(Json::objectValue);
    args["path"] = ".";
    const Json::Value result = filesystem_tool::listDirectory(args, temp.path());
    expect(!result.isMember("error"), "listDirectory returned an unexpected error");

    bool sawVisible = false;
    bool sawHidden = false;
    for (const auto& entry : result["entries"]) {
        if (entry["name"].asString() == "visible.txt") sawVisible = true;
        if (entry["name"].asString() == ".hidden.txt") sawHidden = true;
    }
    expect(sawVisible, "directory listing should include visible file");
    expect(!sawHidden, "directory listing should hide dotfiles by default");
}

void testDirectoryTreeIsBounded() {
    ScopedDir temp;
    fs::create_directories(temp.path() / "a" / "b");
    writeFile(temp.path() / "a" / "b" / "deep.txt", "deep");
    writeFile(temp.path() / "root.txt", "root");

    Json::Value args(Json::objectValue);
    args["path"] = ".";
    args["max_depth"] = 1;
    const Json::Value result = filesystem_tool::directoryTree(args, temp.path());
    expect(!result.isMember("error"), "directoryTree returned an unexpected error");
    const std::string tree = result["tree"].asString();
    expect(tree.find("a/") != std::string::npos, "tree should include first-level directory");
    expect(tree.find("deep.txt") == std::string::npos, "tree should respect max_depth");
}

void testDirectoryErrors() {
    ScopedDir temp;
    writeFile(temp.path() / "file.txt", "not a directory");

    Json::Value args(Json::objectValue);
    args["path"] = "file.txt";
    const Json::Value result = filesystem_tool::changeWorkingDirectory(args, temp.path());
    expect(result.isMember("error"), "changing to a file should return an error");
}

} // namespace

int main() {
    try {
        testWorkingDirectoryAndRelativeRead();
        testDirectoryListingSkipsHiddenByDefault();
        testDirectoryTreeIsBounded();
        testDirectoryErrors();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "filesystem_tool_test failed: " << exception.what() << "\n";
        return 1;
    }
}
