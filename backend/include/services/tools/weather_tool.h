#ifndef WEATHER_TOOL_H
#define WEATHER_TOOL_H

#include <json/json.h>

class Config;

namespace weather_tool {

Json::Value getWeather(const Json::Value& arguments, const Config* config);

} // namespace weather_tool

#endif // WEATHER_TOOL_H
