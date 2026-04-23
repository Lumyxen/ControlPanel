#ifndef TOOL_ARGUMENT_VALIDATOR_H
#define TOOL_ARGUMENT_VALIDATOR_H

#include <optional>
#include <string>

#include <json/json.h>

namespace tool_argument_validator {

std::optional<std::string> validate(const Json::Value& schema, const Json::Value& value);

} // namespace tool_argument_validator

#endif // TOOL_ARGUMENT_VALIDATOR_H
