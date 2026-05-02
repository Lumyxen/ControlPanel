#ifndef FILE_EDIT_TOOL_H
#define FILE_EDIT_TOOL_H

#include <filesystem>

#include <json/json.h>

namespace file_edit_tool {

Json::Value editFile(const Json::Value& arguments, const std::filesystem::path& workspaceDirectory);
Json::Value rollbackCheckpoint(const Json::Value& arguments);

} // namespace file_edit_tool

#endif // FILE_EDIT_TOOL_H
