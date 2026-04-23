#ifndef CALCULATOR_TOOL_H
#define CALCULATOR_TOOL_H

#include <json/json.h>

namespace calculator_tool {

Json::Value executeCalculation(const Json::Value& arguments);

} // namespace calculator_tool

#endif // CALCULATOR_TOOL_H
