#ifndef FILE_READER_TOOL_H
#define FILE_READER_TOOL_H

#include <json/json.h>

namespace file_reader_tool {

Json::Value readFile(const Json::Value& arguments);

} // namespace file_reader_tool

#endif // FILE_READER_TOOL_H
