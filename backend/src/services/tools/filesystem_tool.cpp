#include "services/tools/filesystem_tool.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr int kDefaultMaxEntries = 200;
constexpr int kMaxListEntries = 1000;
constexpr int kDefaultMaxDepth = 2;
constexpr int kMaxTreeDepth = 8;
constexpr int kMaxTreeEntries = 2000;

struct DirectoryEntry {
    fs::path path;
    std::string name;
    std::string type;
    std::uintmax_t size = 0;
};

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

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
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

fs::path normalizeWorkingDirectory(const fs::path& workingDirectory) {
    return workingDirectory.empty() ? fs::current_path() : workingDirectory;
}

fs::path resolvePath(const std::string& pathText, const fs::path& workingDirectory) {
    const fs::path inputPath(pathText.empty() ? "." : pathText);
    const fs::path baseDirectory = normalizeWorkingDirectory(workingDirectory);
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

std::string typeForStatus(const fs::file_status& status) {
    if (fs::is_symlink(status)) return "symlink";
    if (fs::is_directory(status)) return "directory";
    if (fs::is_regular_file(status)) return "file";
    if (fs::is_block_file(status)) return "block";
    if (fs::is_character_file(status)) return "character";
    if (fs::is_fifo(status)) return "fifo";
    if (fs::is_socket(status)) return "socket";
    return "other";
}

bool isHiddenName(const std::string& name) {
    return !name.empty() && name.front() == '.';
}

std::vector<DirectoryEntry> collectEntries(
    const fs::path& directory,
    bool includeHidden,
    bool dirsOnly,
    int collectionLimit) {
    std::vector<DirectoryEntry> entries;
    std::error_code ec;
    fs::directory_iterator iterator(
        directory,
        fs::directory_options::skip_permission_denied,
        ec);
    if (ec) {
        return entries;
    }

    const int cappedCollectionLimit = std::max(1, collectionLimit);
    for (const auto& entry : iterator) {
        if (static_cast<int>(entries.size()) >= cappedCollectionLimit) {
            break;
        }

        DirectoryEntry item;
        item.path = entry.path();
        item.name = item.path.filename().string();
        if (!includeHidden && isHiddenName(item.name)) {
            continue;
        }

        const fs::file_status status = entry.symlink_status(ec);
        if (ec) {
            ec.clear();
            continue;
        }
        item.type = typeForStatus(status);
        if (dirsOnly && item.type != "directory") {
            continue;
        }
        if (item.type == "file") {
            item.size = entry.file_size(ec);
            if (ec) {
                item.size = 0;
                ec.clear();
            }
        }
        entries.push_back(std::move(item));
    }

    std::sort(entries.begin(), entries.end(), [](const DirectoryEntry& left, const DirectoryEntry& right) {
        const bool leftDir = left.type == "directory";
        const bool rightDir = right.type == "directory";
        if (leftDir != rightDir) {
            return leftDir;
        }
        return toLower(left.name) < toLower(right.name);
    });
    return entries;
}

Json::Value validateDirectory(const fs::path& resolvedPath, const fs::path& workingDirectory, const std::string& originalPath) {
    std::error_code ec;
    if (!fs::exists(resolvedPath, ec) || ec) {
        Json::Value error = makeError("Directory does not exist");
        error["path"] = originalPath;
        error["resolved_path"] = resolvedPath.string();
        error["working_directory"] = workingDirectory.string();
        return error;
    }
    if (!fs::is_directory(resolvedPath, ec) || ec) {
        Json::Value error = makeError("Path is not a directory");
        error["path"] = originalPath;
        error["resolved_path"] = resolvedPath.string();
        error["working_directory"] = workingDirectory.string();
        return error;
    }
    return Json::Value();
}

Json::Value entryToJson(const DirectoryEntry& entry) {
    Json::Value json(Json::objectValue);
    json["name"] = entry.name;
    json["path"] = entry.path.string();
    json["type"] = entry.type;
    if (entry.type == "file") {
        json["size_bytes"] = static_cast<Json::UInt64>(entry.size);
    }
    return json;
}

} // namespace

Json::Value filesystem_tool::getWorkingDirectory(const fs::path& workingDirectory) {
    Json::Value result(Json::objectValue);
    result["working_directory"] = normalizeWorkingDirectory(workingDirectory).string();
    return result;
}

Json::Value filesystem_tool::changeWorkingDirectory(const Json::Value& arguments, const fs::path& workingDirectory) {
    const fs::path baseDirectory = normalizeWorkingDirectory(workingDirectory);
    const std::string pathText = trimCopy(getStringArg(arguments, "path"));
    if (pathText.empty()) {
        return makeError("path is required");
    }

    const fs::path resolvedPath = resolvePath(pathText, baseDirectory);
    Json::Value validation = validateDirectory(resolvedPath, baseDirectory, pathText);
    if (!validation.isNull()) {
        return validation;
    }

    Json::Value result(Json::objectValue);
    result["previous_working_directory"] = baseDirectory.string();
    result["working_directory"] = resolvedPath.string();
    return result;
}

Json::Value filesystem_tool::listDirectory(const Json::Value& arguments, const fs::path& workingDirectory) {
    const fs::path baseDirectory = normalizeWorkingDirectory(workingDirectory);
    const std::string pathText = trimCopy(getStringArg(arguments, "path", "."));
    const bool includeHidden = getBoolArg(arguments, "include_hidden", false);
    const bool dirsOnly = getBoolArg(arguments, "dirs_only", false);
    const int maxEntries = std::clamp(getIntArg(arguments, "max_entries", kDefaultMaxEntries), 1, kMaxListEntries);
    const fs::path resolvedPath = resolvePath(pathText, baseDirectory);

    Json::Value validation = validateDirectory(resolvedPath, baseDirectory, pathText);
    if (!validation.isNull()) {
        return validation;
    }

    std::vector<DirectoryEntry> entries = collectEntries(resolvedPath, includeHidden, dirsOnly, maxEntries + 1);
    const bool truncated = static_cast<int>(entries.size()) > maxEntries;
    if (truncated) {
        entries.resize(static_cast<std::size_t>(maxEntries));
    }

    Json::Value result(Json::objectValue);
    result["path"] = pathText.empty() ? "." : pathText;
    result["resolved_path"] = resolvedPath.string();
    result["working_directory"] = baseDirectory.string();
    result["include_hidden"] = includeHidden;
    result["dirs_only"] = dirsOnly;
    result["max_entries"] = maxEntries;
    result["truncated"] = truncated;
    result["entry_count"] = static_cast<int>(entries.size());
    result["entries"] = Json::Value(Json::arrayValue);
    for (const auto& entry : entries) {
        result["entries"].append(entryToJson(entry));
    }
    return result;
}

Json::Value filesystem_tool::directoryTree(const Json::Value& arguments, const fs::path& workingDirectory) {
    const fs::path baseDirectory = normalizeWorkingDirectory(workingDirectory);
    const std::string pathText = trimCopy(getStringArg(arguments, "path", "."));
    const bool includeHidden = getBoolArg(arguments, "include_hidden", false);
    const bool dirsOnly = getBoolArg(arguments, "dirs_only", false);
    const int maxDepth = std::clamp(getIntArg(arguments, "max_depth", kDefaultMaxDepth), 0, kMaxTreeDepth);
    const int maxEntries = std::clamp(getIntArg(arguments, "max_entries", kDefaultMaxEntries), 1, kMaxTreeEntries);
    const fs::path resolvedPath = resolvePath(pathText, baseDirectory);

    Json::Value validation = validateDirectory(resolvedPath, baseDirectory, pathText);
    if (!validation.isNull()) {
        return validation;
    }

    std::ostringstream tree;
    tree << resolvedPath.string() << "\n";

    int emitted = 0;
    bool truncated = false;

    std::function<void(const fs::path&, const std::string&, int)> walk =
        [&](const fs::path& directory, const std::string& prefix, int depth) {
            if (truncated || depth >= maxDepth) {
                return;
            }

            const int remaining = maxEntries - emitted;
            if (remaining <= 0) {
                truncated = true;
                return;
            }

            std::vector<DirectoryEntry> entries = collectEntries(directory, includeHidden, dirsOnly, remaining + 1);
            bool trimmedEntries = false;
            if (static_cast<int>(entries.size()) > remaining) {
                entries.resize(static_cast<std::size_t>(remaining));
                trimmedEntries = true;
            }

            for (std::size_t index = 0; index < entries.size(); ++index) {
                const DirectoryEntry& entry = entries[index];
                const bool last = index + 1 == entries.size();
                tree << prefix << (last ? "`-- " : "|-- ") << entry.name;
                if (entry.type == "directory") {
                    tree << "/";
                } else if (entry.type != "file") {
                    tree << " [" << entry.type << "]";
                }
                tree << "\n";
                ++emitted;

                if (entry.type == "directory") {
                    if (depth + 1 < maxDepth && emitted >= maxEntries) {
                        truncated = true;
                        return;
                    }
                    walk(entry.path, prefix + (last ? "    " : "|   "), depth + 1);
                    if (truncated) {
                        return;
                    }
                }
            }

            if (trimmedEntries) {
                truncated = true;
            }
        };

    walk(resolvedPath, "", 0);
    if (truncated) {
        tree << "[truncated]\n";
    }

    Json::Value result(Json::objectValue);
    result["path"] = pathText.empty() ? "." : pathText;
    result["resolved_path"] = resolvedPath.string();
    result["working_directory"] = baseDirectory.string();
    result["max_depth"] = maxDepth;
    result["max_entries"] = maxEntries;
    result["include_hidden"] = includeHidden;
    result["dirs_only"] = dirsOnly;
    result["entry_count"] = emitted;
    result["truncated"] = truncated;
    result["tree"] = tree.str();
    return result;
}
