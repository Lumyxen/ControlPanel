#include "services/tools/file_edit_tool.h"
#include "services/tools/file_reader_tool.h"
#include "services/tools/filesystem_tool.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
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

std::string readRawFile(const fs::path& path) {
    std::ifstream file(path, std::ios::binary);
    expect(file.is_open(), "Failed to open test file");
    return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

std::string readVersion(const fs::path& workspace, const std::string& path) {
    Json::Value args(Json::objectValue);
    args["path"] = path;
    const Json::Value result = file_reader_tool::readFile(args, workspace);
    expect(!result.isMember("error"), "readVersion returned an unexpected error");
    expect(result["version"].isString(), "readFile should return a version");
    return result["version"].asString();
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

void testEditFileWritesCheckpoint() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "before\n");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "replace";
    args["old_text"] = "before";
    args["new_text"] = "after";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "editFile returned an unexpected error");
    expect(result["checkpoint"].isObject(), "editFile should return checkpoint metadata");
    expect(fs::exists(result["checkpoint"]["content_path"].asString()), "checkpoint should include previous file content");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "note.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "after\n", "edited file content did not match");

    Json::Value checkpointRead(Json::objectValue);
    checkpointRead["path"] = result["checkpoint"]["content_path"].asString();
    checkpointRead["include_line_numbers"] = false;
    const Json::Value checkpointResult = file_reader_tool::readFile(checkpointRead);
    expect(checkpointResult["content"].asString() == "before\n", "checkpoint content did not match previous content");

    Json::Value rollbackArgs(Json::objectValue);
    rollbackArgs["checkpoint_id"] = result["checkpoint"]["id"].asString();
    rollbackArgs["workspace_directory"] = temp.path().string();
    rollbackArgs["path"] = "note.txt";
    const Json::Value rollbackResult = file_edit_tool::rollbackCheckpoint(rollbackArgs);
    expect(!rollbackResult.isMember("error"), "rollbackCheckpoint returned an unexpected error");

    const Json::Value restoredReadResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(restoredReadResult["content"].asString() == "before\n", "rollback should restore previous content");
}

void testEditFileAppendAddsLineBoundariesByDefault() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "alpha");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "append";
    args["content"] = "beta";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "append should accept content");
    expect(result["changed"].asBool(), "append should report a file change");
    expect(result["affected_start_line"].asInt() == 1, "append should report the unterminated line as affected");
    expect(result["affected_end_line"].asInt() == 2, "append should report the appended line as affected");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "note.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "alpha\nbeta\n", "append should add a line boundary and trailing newline");
}

void testEditFileAppendUsesDocumentLineEnding() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "alpha\r\nbeta");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "append";
    args["content"] = "gamma\n";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "append should handle CRLF files");
    expect(readRawFile(temp.path() / "note.txt") == "alpha\r\nbeta\r\ngamma\r\n", "append should normalize automatic line endings to the document EOL");
}

void testEditFileCanSetAnEmptyLineByNumber() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "alpha\n\nomega\n");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "set_line";
    args["line"] = 2;
    args["content"] = "beta";
    args["expected_old_text"] = "";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "set_line should edit an empty line by line number");
    expect(result["changed"].asBool(), "set_line should report that it changed the file");
    expect(result["affected_start_line"].asInt() == 2, "set_line should report the affected line");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "note.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "alpha\nbeta\nomega\n", "set_line should replace the empty line body");
}

void testEditFileSetLinePreservesCrLfEndings() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "alpha\r\n\r\nomega\r\n");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "set_line";
    args["line"] = 2;
    args["content"] = "beta";
    args["expected_old_text"] = "";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "set_line should edit CRLF files");

    std::ifstream file(temp.path() / "note.txt", std::ios::binary);
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    expect(content == "alpha\r\nbeta\r\nomega\r\n", "set_line should preserve the target line ending");
}

void testEditFileLineRangeOperations() {
    ScopedDir temp;
    writeFile(temp.path() / "script.txt", "one\ntwo\nthree\nfour\n");

    Json::Value replaceArgs(Json::objectValue);
    replaceArgs["path"] = "script.txt";
    replaceArgs["operation"] = "replace_lines";
    replaceArgs["start_line"] = 2;
    replaceArgs["end_line"] = 3;
    replaceArgs["expected_old_text"] = "two\nthree\n";
    replaceArgs["content"] = "dos\ntres\n";
    replaceArgs["expected_version"] = readVersion(temp.path(), "script.txt");

    const Json::Value replaceResult = file_edit_tool::editFile(replaceArgs, temp.path());
    expect(!replaceResult.isMember("error"), "replace_lines should replace an inclusive line range");

    Json::Value insertArgs(Json::objectValue);
    insertArgs["path"] = "script.txt";
    insertArgs["operation"] = "insert_after";
    insertArgs["line"] = 1;
    insertArgs["expected_old_text"] = "one";
    insertArgs["content"] = "one-point-five\n";
    insertArgs["expected_version"] = readVersion(temp.path(), "script.txt");

    const Json::Value insertResult = file_edit_tool::editFile(insertArgs, temp.path());
    expect(!insertResult.isMember("error"), "insert_after should insert content after an anchor line");

    Json::Value deleteArgs(Json::objectValue);
    deleteArgs["path"] = "script.txt";
    deleteArgs["operation"] = "delete_lines";
    deleteArgs["start_line"] = 5;
    deleteArgs["expected_version"] = readVersion(temp.path(), "script.txt");

    const Json::Value deleteResult = file_edit_tool::editFile(deleteArgs, temp.path());
    expect(!deleteResult.isMember("error"), "delete_lines should delete a single line when end_line is omitted");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "script.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "one\none-point-five\ndos\ntres\n", "line range operations should produce the expected file");
}

void testEditFileAppliesVersionedRangeEdits() {
    ScopedDir temp;
    writeFile(temp.path() / "range.txt", "alpha\n\nomega\n");

    Json::Value replaceEdit(Json::objectValue);
    replaceEdit["op"] = "replace";
    replaceEdit["range"]["start"]["line"] = 2;
    replaceEdit["range"]["start"]["column"] = 0;
    replaceEdit["range"]["end"]["line"] = 3;
    replaceEdit["range"]["end"]["column"] = 0;
    replaceEdit["text"] = "beta\n";

    Json::Value args(Json::objectValue);
    args["path"] = "range.txt";
    args["operation"] = "edit";
    args["expected_version"] = readVersion(temp.path(), "range.txt");
    args["edits"].append(replaceEdit);

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "range edit should replace an empty line by range");
    expect(result["previous_version"].isString(), "range edit should report previous_version");
    expect(result["version"].isString(), "range edit should report the new version");
    expect(result["version"].asString() != result["previous_version"].asString(), "range edit should change the version");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "range.txt";
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "alpha\nbeta\nomega\n", "range edit content did not match");
}

void testEditFileRejectsStaleVersion() {
    ScopedDir temp;
    writeFile(temp.path() / "version.txt", "one\n");
    const std::string staleVersion = readVersion(temp.path(), "version.txt");
    writeFile(temp.path() / "version.txt", "two\n");

    Json::Value args(Json::objectValue);
    args["path"] = "version.txt";
    args["operation"] = "replace_line";
    args["line"] = 1;
    args["content"] = "three";
    args["expected_version"] = staleVersion;

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(result.isMember("error"), "stale expected_version should reject the edit");
    expect(result["stale"].asBool(), "stale version error should be marked stale");
}

void testEditFileSetEndOfLineIsExplicit() {
    ScopedDir temp;
    writeFile(temp.path() / "eol.txt", "alpha\r\nbeta\r\n");

    Json::Value args(Json::objectValue);
    args["path"] = "eol.txt";
    args["operation"] = "set_end_of_line";
    args["eol"] = "lf";
    args["expected_version"] = readVersion(temp.path(), "eol.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "set_end_of_line should convert CRLF to LF");

    std::ifstream file(temp.path() / "eol.txt", std::ios::binary);
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    expect(content == "alpha\nbeta\n", "set_end_of_line should convert document line endings");
}

void testEditFileInsertAfterFinalLineAddsLineBoundary() {
    ScopedDir temp;
    writeFile(temp.path() / "tail.txt", "last");

    Json::Value args(Json::objectValue);
    args["path"] = "tail.txt";
    args["operation"] = "insert_after";
    args["line"] = 1;
    args["content"] = "new";
    args["expected_version"] = readVersion(temp.path(), "tail.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(!result.isMember("error"), "insert_after should handle final lines without a newline");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "tail.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "last\nnew\n", "insert_after should not glue inserted text to the final line");
}

void testEditFileExpectedOldTextRejectsStaleLineEdit() {
    ScopedDir temp;
    writeFile(temp.path() / "note.txt", "alpha\nbeta\n");

    Json::Value args(Json::objectValue);
    args["path"] = "note.txt";
    args["operation"] = "set_line";
    args["line"] = 2;
    args["content"] = "changed";
    args["expected_old_text"] = "stale";
    args["expected_version"] = readVersion(temp.path(), "note.txt");

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(result.isMember("error"), "set_line should reject stale expected_old_text");

    Json::Value readArgs(Json::objectValue);
    readArgs["path"] = "note.txt";
    readArgs["include_line_numbers"] = false;
    const Json::Value readResult = file_reader_tool::readFile(readArgs, temp.path());
    expect(readResult["content"].asString() == "alpha\nbeta\n", "failed line edit should leave file unchanged");
}

void testEditFileRejectsWorkspaceEscape() {
    ScopedDir temp;
    ScopedDir outside;
    writeFile(outside.path() / "outside.txt", "outside\n");

    Json::Value args(Json::objectValue);
    args["path"] = (outside.path() / "outside.txt").string();
    args["operation"] = "write";
    args["content"] = "changed\n";
    args["expected_version"] = "missing";

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(result.isMember("error"), "editFile should reject paths outside workspace");
}

void testEditFileCreatesRemoteLikeWorkspaceFiles() {
    ScopedDir temp;
    const fs::path mountedProject = temp.path() / "mnt" / "duyfken" / "project";
    fs::create_directories(mountedProject);

    Json::Value args(Json::objectValue);
    args["path"] = "src/generated.txt";
    args["operation"] = "write";
    args["content"] = "remote workspace\n";
    args["create_parent_directories"] = true;
    args["expected_version"] = "missing";

    const Json::Value result = file_edit_tool::editFile(args, mountedProject);
    expect(!result.isMember("error"), "editFile should support any configured workspace directory");
    expect(result["workspace_directory"].asString() == mountedProject.string(), "workspace directory should be preserved");
    expect(fs::exists(mountedProject / "src" / "generated.txt"), "editFile should create file under workspace");

    Json::Value rollbackArgs(Json::objectValue);
    rollbackArgs["checkpoint_id"] = result["checkpoint"]["id"].asString();
    rollbackArgs["workspace_directory"] = mountedProject.string();
    rollbackArgs["path"] = "src/generated.txt";
    const Json::Value rollbackResult = file_edit_tool::rollbackCheckpoint(rollbackArgs);
    expect(!rollbackResult.isMember("error"), "rollbackCheckpoint should remove files created by edits");
    expect(!fs::exists(mountedProject / "src" / "generated.txt"), "rollback should delete file created by edit");
}

void testEditFileRequiresContentForWrites() {
    ScopedDir temp;

    Json::Value args(Json::objectValue);
    args["path"] = "empty.txt";
    args["operation"] = "write";
    args["expected_version"] = "missing";

    const Json::Value result = file_edit_tool::editFile(args, temp.path());
    expect(result.isMember("error"), "write without content should fail instead of silently writing an empty file");
}

void testEditFilePreflightRejectsInvalidWriteWithoutCreatingParents() {
    ScopedDir temp;

    Json::Value args(Json::objectValue);
    args["path"] = "missing/empty.txt";
    args["operation"] = "write";
    args["expected_version"] = "missing";
    args["create_parent_directories"] = true;

    const Json::Value result = file_edit_tool::preflightEditFile(args, temp.path());
    expect(result.isMember("error"), "preflight should reject an invalid write");
    expect(!fs::exists(temp.path() / "missing"), "preflight should not create parent directories");
}

void testEditFilePreflightAllowsValidWriteWithoutChangingFilesystem() {
    ScopedDir temp;

    Json::Value args(Json::objectValue);
    args["path"] = "src/generated.txt";
    args["operation"] = "write";
    args["content"] = "generated\n";
    args["expected_version"] = "missing";
    args["create_parent_directories"] = true;

    const Json::Value result = file_edit_tool::preflightEditFile(args, temp.path());
    expect(result.isNull(), "valid edits that would change a file should continue to approval");
    expect(!fs::exists(temp.path() / "src"), "preflight should not create directories for valid writes");
    expect(!fs::exists(temp.path() / "src" / "generated.txt"), "preflight should not write files");
}

void testEditFilePreflightReturnsNoopResult() {
    ScopedDir temp;
    writeFile(temp.path() / "same.txt", "same\n");

    Json::Value args(Json::objectValue);
    args["path"] = "same.txt";
    args["operation"] = "write";
    args["content"] = "same\n";
    args["expected_version"] = readVersion(temp.path(), "same.txt");

    const Json::Value result = file_edit_tool::preflightEditFile(args, temp.path());
    expect(!result.isMember("error"), "no-op preflight should not fail");
    expect(!result["changed"].asBool(), "no-op preflight should report no change");
    expect(!result["rollback_available"].asBool(), "no-op preflight should not create a rollback checkpoint");
}

} // namespace

int main() {
    try {
        testWorkingDirectoryAndRelativeRead();
        testDirectoryListingSkipsHiddenByDefault();
        testDirectoryTreeIsBounded();
        testDirectoryErrors();
        testEditFileWritesCheckpoint();
        testEditFileAppendAddsLineBoundariesByDefault();
        testEditFileAppendUsesDocumentLineEnding();
        testEditFileCanSetAnEmptyLineByNumber();
        testEditFileSetLinePreservesCrLfEndings();
        testEditFileLineRangeOperations();
        testEditFileAppliesVersionedRangeEdits();
        testEditFileRejectsStaleVersion();
        testEditFileSetEndOfLineIsExplicit();
        testEditFileInsertAfterFinalLineAddsLineBoundary();
        testEditFileExpectedOldTextRejectsStaleLineEdit();
        testEditFileRejectsWorkspaceEscape();
        testEditFileCreatesRemoteLikeWorkspaceFiles();
        testEditFileRequiresContentForWrites();
        testEditFilePreflightRejectsInvalidWriteWithoutCreatingParents();
        testEditFilePreflightAllowsValidWriteWithoutChangingFilesystem();
        testEditFilePreflightReturnsNoopResult();
        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "filesystem_tool_test failed: " << exception.what() << "\n";
        return 1;
    }
}
