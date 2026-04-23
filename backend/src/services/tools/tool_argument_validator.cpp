#include "services/tools/tool_argument_validator.h"

#include <algorithm>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::string jsonToCompactString(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

std::string describeTypes(const std::vector<std::string>& types) {
    std::ostringstream stream;
    for (std::size_t index = 0; index < types.size(); ++index) {
        if (index > 0) {
            stream << ", ";
        }
        stream << types[index];
    }
    return stream.str();
}

std::vector<std::string> collectTypes(const Json::Value& schema) {
    std::vector<std::string> types;
    if (!schema.isObject() || !schema.isMember("type")) {
        return types;
    }

    const Json::Value& typeValue = schema["type"];
    if (typeValue.isString()) {
        types.push_back(typeValue.asString());
        return types;
    }

    if (!typeValue.isArray()) {
        return types;
    }

    for (const auto& item : typeValue) {
        if (item.isString()) {
            types.push_back(item.asString());
        }
    }
    return types;
}

bool matchesType(const std::string& type, const Json::Value& value) {
    if (type == "null") return value.isNull();
    if (type == "object") return value.isObject();
    if (type == "array") return value.isArray();
    if (type == "string") return value.isString();
    if (type == "boolean") return value.isBool();
    if (type == "integer") return value.isIntegral();
    if (type == "number") return value.isNumeric();
    return true;
}

std::optional<std::string> validateNode(const Json::Value& schema, const Json::Value& value, const std::string& path) {
    if (!schema.isObject()) {
        return std::nullopt;
    }

    const std::vector<std::string> types = collectTypes(schema);
    if (!types.empty()) {
        bool matched = false;
        for (const auto& type : types) {
            if (matchesType(type, value)) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            if (types.size() == 1) {
                return path + " must be a " + types.front();
            }
            return path + " must be one of: " + describeTypes(types);
        }
    }

    if (schema.isMember("enum") && schema["enum"].isArray()) {
        bool matched = false;
        for (const auto& candidate : schema["enum"]) {
            if (candidate == value) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            return path + " must be one of " + jsonToCompactString(schema["enum"]);
        }
    }

    if (value.isNumeric()) {
        const double numericValue = value.asDouble();
        if (schema.isMember("minimum") && schema["minimum"].isNumeric()) {
            const double minimum = schema["minimum"].asDouble();
            if (numericValue < minimum) {
                return path + " must be >= " + jsonToCompactString(schema["minimum"]);
            }
        }
        if (schema.isMember("maximum") && schema["maximum"].isNumeric()) {
            const double maximum = schema["maximum"].asDouble();
            if (numericValue > maximum) {
                return path + " must be <= " + jsonToCompactString(schema["maximum"]);
            }
        }
    }

    if (value.isArray()) {
        if (schema.isMember("minItems") && schema["minItems"].isInt()) {
            if (static_cast<int>(value.size()) < schema["minItems"].asInt()) {
                return path + " must contain at least " + std::to_string(schema["minItems"].asInt()) + " item(s)";
            }
        }
        if (schema.isMember("maxItems") && schema["maxItems"].isInt()) {
            if (static_cast<int>(value.size()) > schema["maxItems"].asInt()) {
                return path + " must contain at most " + std::to_string(schema["maxItems"].asInt()) + " item(s)";
            }
        }
        if (schema.isMember("items")) {
            for (Json::ArrayIndex index = 0; index < value.size(); ++index) {
                const auto error = validateNode(
                    schema["items"],
                    value[index],
                    path + "[" + std::to_string(index) + "]");
                if (error.has_value()) {
                    return error;
                }
            }
        }
    }

    if (value.isObject()) {
        const Json::Value properties = schema.get("properties", Json::Value(Json::objectValue));
        const Json::Value required = schema.get("required", Json::Value(Json::arrayValue));

        if (required.isArray()) {
            for (const auto& item : required) {
                if (!item.isString()) {
                    continue;
                }
                const std::string key = item.asString();
                if (!value.isMember(key)) {
                    return path + "." + key + " is required";
                }
            }
        }

        if (schema.isMember("additionalProperties") &&
            schema["additionalProperties"].isBool() &&
            !schema["additionalProperties"].asBool()) {
            const std::vector<std::string> propertyNames = properties.getMemberNames();
            for (const auto& key : value.getMemberNames()) {
                if (std::find(propertyNames.begin(), propertyNames.end(), key) == propertyNames.end()) {
                    return path + "." + key + " is not allowed";
                }
            }
        }

        if (properties.isObject()) {
            for (const auto& key : properties.getMemberNames()) {
                if (!value.isMember(key)) {
                    continue;
                }
                const auto error = validateNode(properties[key], value[key], path + "." + key);
                if (error.has_value()) {
                    return error;
                }
            }
        }
    }

    return std::nullopt;
}

} // namespace

std::optional<std::string> tool_argument_validator::validate(const Json::Value& schema, const Json::Value& value) {
    return validateNode(schema, value, "$");
}
