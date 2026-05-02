#ifndef FILE_READER_TOOL_H
#define FILE_READER_TOOL_H

#include <filesystem>

#include <json/json.h>

namespace file_reader_tool {

Json::Value readFile(const Json::Value& arguments);
Json::Value readFile(const Json::Value& arguments, const std::filesystem::path& workingDirectory);

} // namespace file_reader_tool

#endif // FILE_READER_TOOL_H
