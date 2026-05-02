#ifndef FILESYSTEM_TOOL_H
#define FILESYSTEM_TOOL_H

#include <filesystem>

#include <json/json.h>

namespace filesystem_tool {

Json::Value getWorkingDirectory(const std::filesystem::path& workingDirectory);
Json::Value changeWorkingDirectory(const Json::Value& arguments, const std::filesystem::path& workingDirectory);
Json::Value listDirectory(const Json::Value& arguments, const std::filesystem::path& workingDirectory);
Json::Value directoryTree(const Json::Value& arguments, const std::filesystem::path& workingDirectory);

} // namespace filesystem_tool

#endif // FILESYSTEM_TOOL_H
