#ifndef INTERNET_TESTING_TOOL_H
#define INTERNET_TESTING_TOOL_H

#include <functional>

#include <json/json.h>

namespace internet_testing_tool {

Json::Value runTest(const Json::Value& arguments, std::function<bool()> cancelCheck = nullptr);

} // namespace internet_testing_tool

#endif // INTERNET_TESTING_TOOL_H
