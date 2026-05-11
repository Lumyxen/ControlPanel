#ifndef ASSISTANT_WORKSPACE_TOOL_H
#define ASSISTANT_WORKSPACE_TOOL_H

#include <filesystem>
#include <string>

#include <json/json.h>

namespace assistant_workspace_tool {

Json::Value manageChatNotes(
    const Json::Value& arguments,
    const std::filesystem::path& storageRoot,
    const std::string& chatId);

Json::Value manageTodoList(
    const Json::Value& arguments,
    const std::filesystem::path& storageRoot,
    const std::string& chatId);

} // namespace assistant_workspace_tool

#endif // ASSISTANT_WORKSPACE_TOOL_H
