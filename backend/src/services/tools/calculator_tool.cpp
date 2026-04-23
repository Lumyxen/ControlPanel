#include "services/tools/calculator_tool.h"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <limits>
#include <numbers>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr long double kPi = std::numbers::pi_v<long double>;
constexpr long double kTau = std::numbers::pi_v<long double> * 2.0L;
constexpr long double kE = std::numbers::e_v<long double>;

struct CalculationOptions {
    std::string angleUnit = "radian";
    bool hasAngleUnit = false;
    int decimals = 0;
    bool hasDecimals = false;
};

Json::Value makeError(const std::string& message) {
    Json::Value error(Json::objectValue);
    error["error"] = message;
    return error;
}

bool isNearlyInteger(const long double value) {
    const long double rounded = std::round(value);
    const long double tolerance = 1e-12L * std::max(1.0L, std::fabs(value));
    return std::fabs(value - rounded) <= tolerance;
}

long double normalizeNumber(long double value) {
    if (std::fabs(value) <= 1e-15L) {
        value = 0.0L;
    }
    if (isNearlyInteger(value)) {
        value = std::round(value);
    }
    return value;
}

Json::Value makeJsonNumber(long double value) {
    const long double normalized = normalizeNumber(value);
    if (isNearlyInteger(normalized) &&
        normalized >= static_cast<long double>(std::numeric_limits<Json::Int64>::min()) &&
        normalized <= static_cast<long double>(std::numeric_limits<Json::Int64>::max())) {
        return Json::Value(static_cast<Json::Int64>(std::llround(normalized)));
    }
    return Json::Value(static_cast<double>(normalized));
}

std::string formatNumber(long double value) {
    const long double normalized = normalizeNumber(value);
    if (isNearlyInteger(normalized)) {
        std::ostringstream integerStream;
        integerStream << std::llround(normalized);
        return integerStream.str();
    }

    std::ostringstream stream;
    stream << std::setprecision(15) << std::defaultfloat << static_cast<double>(normalized);
    return stream.str();
}

long double toRadians(long double value, const std::string& angleUnit) {
    return angleUnit == "degree" ? value * (kPi / 180.0L) : value;
}

long double fromRadians(long double value, const std::string& angleUnit) {
    return angleUnit == "degree" ? value * (180.0L / kPi) : value;
}

bool supportsAngleUnit(const std::string& operation) {
    return operation == "sin" || operation == "cos" || operation == "tan" ||
           operation == "asin" || operation == "acos" || operation == "atan" ||
           operation == "atan2";
}

bool supportsDecimals(const std::string& operation) {
    return operation == "round";
}

std::optional<CalculationOptions> parseOptions(const Json::Value& arguments, std::string& errorOut) {
    CalculationOptions options;
    const Json::Value optionsValue = arguments.get("options", Json::Value(Json::objectValue));
    if (optionsValue.isNull()) {
        return options;
    }
    if (!optionsValue.isObject()) {
        errorOut = "options must be an object";
        return std::nullopt;
    }

    if (optionsValue.isMember("angle_unit")) {
        if (!optionsValue["angle_unit"].isString()) {
            errorOut = "options.angle_unit must be a string";
            return std::nullopt;
        }
        options.angleUnit = optionsValue["angle_unit"].asString();
        options.hasAngleUnit = true;
    }

    if (optionsValue.isMember("decimals")) {
        if (!optionsValue["decimals"].isInt()) {
            errorOut = "options.decimals must be an integer";
            return std::nullopt;
        }
        options.decimals = optionsValue["decimals"].asInt();
        options.hasDecimals = true;
    }

    return options;
}

std::optional<std::vector<long double>> parseArgs(const Json::Value& arguments, std::string& errorOut) {
    const Json::Value argsValue = arguments.get("args", Json::Value(Json::arrayValue));
    if (argsValue.isNull()) {
        return std::vector<long double>{};
    }
    if (!argsValue.isArray()) {
        errorOut = "args must be an array";
        return std::nullopt;
    }

    std::vector<long double> args;
    args.reserve(argsValue.size());
    for (Json::ArrayIndex index = 0; index < argsValue.size(); ++index) {
        if (!argsValue[index].isNumeric()) {
            errorOut = "args[" + std::to_string(index) + "] must be numeric";
            return std::nullopt;
        }
        args.push_back(static_cast<long double>(argsValue[index].asDouble()));
    }
    return args;
}

Json::Value buildResult(
    const std::string& operation,
    const Json::Value& rawArgs,
    const CalculationOptions& options,
    long double value) {
    if (!std::isfinite(static_cast<double>(value))) {
        return makeError(operation + " produced a non-finite result");
    }

    Json::Value result(Json::objectValue);
    result["operation"] = operation;
    result["args"] = rawArgs.isArray() ? rawArgs : Json::Value(Json::arrayValue);
    result["value"] = makeJsonNumber(value);
    result["output"] = formatNumber(value);
    result["metadata"]["angle_unit"] = options.angleUnit;
    if (options.hasDecimals || operation == "round") {
        result["metadata"]["decimals"] = options.decimals;
    }
    return result;
}

std::optional<long double> requireExactArity(
    const std::string& operation,
    const std::vector<long double>& args,
    std::size_t expected,
    std::string& errorOut) {
    if (args.size() != expected) {
        errorOut = operation + " requires exactly " + std::to_string(expected) + " arguments";
        return std::nullopt;
    }
    return 0.0L;
}

std::optional<long double> requireMinimumArity(
    const std::string& operation,
    const std::vector<long double>& args,
    std::size_t expected,
    std::string& errorOut) {
    if (args.size() < expected) {
        errorOut = operation + " requires at least " + std::to_string(expected) + " arguments";
        return std::nullopt;
    }
    return 0.0L;
}

} // namespace

Json::Value calculator_tool::executeCalculation(const Json::Value& arguments) {
    const std::string operation = arguments.get("op", "").asString();
    if (operation.empty()) {
        return makeError("op is required");
    }

    std::string error;
    const auto parsedOptions = parseOptions(arguments, error);
    if (!parsedOptions.has_value()) {
        return makeError(error);
    }
    const CalculationOptions options = *parsedOptions;

    const auto parsedArgs = parseArgs(arguments, error);
    if (!parsedArgs.has_value()) {
        return makeError(error);
    }
    const std::vector<long double> args = *parsedArgs;
    const Json::Value rawArgs = arguments.get("args", Json::Value(Json::arrayValue));

    if (options.hasAngleUnit && !supportsAngleUnit(operation)) {
        return makeError("options.angle_unit is only valid for trigonometric operations");
    }
    if (options.hasDecimals && !supportsDecimals(operation)) {
        return makeError("options.decimals is only valid for round");
    }

    if ((operation == "pi" || operation == "tau" || operation == "e") && !args.empty()) {
        return makeError(operation + " does not accept arguments");
    }
    if (operation != "pi" && operation != "tau" && operation != "e" && args.empty()) {
        return makeError(operation + " requires arguments");
    }

    auto exactArity = [&](std::size_t expected) -> bool {
        return requireExactArity(operation, args, expected, error).has_value();
    };
    auto minimumArity = [&](std::size_t expected) -> bool {
        return requireMinimumArity(operation, args, expected, error).has_value();
    };

    long double value = 0.0L;

    if (operation == "pi") {
        value = kPi;
    } else if (operation == "tau") {
        value = kTau;
    } else if (operation == "e") {
        value = kE;
    } else if (operation == "add") {
        if (!minimumArity(2)) return makeError(error);
        for (const auto argument : args) value += argument;
    } else if (operation == "subtract") {
        if (!exactArity(2)) return makeError(error);
        value = args[0] - args[1];
    } else if (operation == "multiply") {
        if (!minimumArity(2)) return makeError(error);
        value = 1.0L;
        for (const auto argument : args) value *= argument;
    } else if (operation == "divide") {
        if (!exactArity(2)) return makeError(error);
        if (args[1] == 0.0L) return makeError("divide by zero");
        value = args[0] / args[1];
    } else if (operation == "mod") {
        if (!exactArity(2)) return makeError(error);
        if (args[1] == 0.0L) return makeError("mod by zero");
        value = std::fmod(args[0], args[1]);
    } else if (operation == "power") {
        if (!exactArity(2)) return makeError(error);
        if (args[0] == 0.0L && args[1] <= 0.0L) return makeError("power is undefined for base 0 with a non-positive exponent");
        if (args[0] < 0.0L && !isNearlyInteger(args[1])) {
            return makeError("power with a negative base requires an integer exponent");
        }
        value = std::pow(args[0], args[1]);
    } else if (operation == "root") {
        if (!exactArity(2)) return makeError(error);
        const long double radicand = args[0];
        const long double degree = args[1];
        if (degree == 0.0L) return makeError("root degree cannot be zero");
        if (radicand == 0.0L && degree < 0.0L) return makeError("root is undefined for radicand 0 with a negative degree");
        if (radicand < 0.0L) {
            if (!isNearlyInteger(degree)) {
                return makeError("root of a negative radicand requires an odd integer degree");
            }
            const auto roundedDegree = static_cast<long long>(std::llround(degree));
            if (roundedDegree % 2 == 0) {
                return makeError("root of a negative radicand requires an odd integer degree");
            }
            value = -std::pow(-radicand, 1.0L / degree);
        } else {
            value = std::pow(radicand, 1.0L / degree);
        }
    } else if (operation == "sqrt") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] < 0.0L) return makeError("sqrt is undefined for negative values");
        value = std::sqrt(args[0]);
    } else if (operation == "abs") {
        if (!exactArity(1)) return makeError(error);
        value = std::fabs(args[0]);
    } else if (operation == "negate") {
        if (!exactArity(1)) return makeError(error);
        value = -args[0];
    } else if (operation == "exp") {
        if (!exactArity(1)) return makeError(error);
        value = std::exp(args[0]);
    } else if (operation == "ln") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] <= 0.0L) return makeError("ln is defined only for positive values");
        value = std::log(args[0]);
    } else if (operation == "log10") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] <= 0.0L) return makeError("log10 is defined only for positive values");
        value = std::log10(args[0]);
    } else if (operation == "log2") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] <= 0.0L) return makeError("log2 is defined only for positive values");
        value = std::log2(args[0]);
    } else if (operation == "sin") {
        if (!exactArity(1)) return makeError(error);
        value = std::sin(toRadians(args[0], options.angleUnit));
    } else if (operation == "cos") {
        if (!exactArity(1)) return makeError(error);
        value = std::cos(toRadians(args[0], options.angleUnit));
    } else if (operation == "tan") {
        if (!exactArity(1)) return makeError(error);
        const long double angle = toRadians(args[0], options.angleUnit);
        if (std::fabs(std::cos(angle)) <= 1e-15L) {
            return makeError("tan is undefined for this angle");
        }
        value = std::tan(angle);
    } else if (operation == "asin") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] < -1.0L || args[0] > 1.0L) return makeError("asin is defined only for values in [-1, 1]");
        value = fromRadians(std::asin(args[0]), options.angleUnit);
    } else if (operation == "acos") {
        if (!exactArity(1)) return makeError(error);
        if (args[0] < -1.0L || args[0] > 1.0L) return makeError("acos is defined only for values in [-1, 1]");
        value = fromRadians(std::acos(args[0]), options.angleUnit);
    } else if (operation == "atan") {
        if (!exactArity(1)) return makeError(error);
        value = fromRadians(std::atan(args[0]), options.angleUnit);
    } else if (operation == "atan2") {
        if (!exactArity(2)) return makeError(error);
        value = fromRadians(std::atan2(args[0], args[1]), options.angleUnit);
    } else if (operation == "floor") {
        if (!exactArity(1)) return makeError(error);
        value = std::floor(args[0]);
    } else if (operation == "ceil") {
        if (!exactArity(1)) return makeError(error);
        value = std::ceil(args[0]);
    } else if (operation == "trunc") {
        if (!exactArity(1)) return makeError(error);
        value = std::trunc(args[0]);
    } else if (operation == "round") {
        if (!exactArity(1)) return makeError(error);
        long double factor = 1.0L;
        if (options.decimals > 0) {
            factor = std::pow(10.0L, static_cast<long double>(options.decimals));
        }
        value = std::round(args[0] * factor) / factor;
    } else if (operation == "min") {
        if (!minimumArity(1)) return makeError(error);
        value = *std::min_element(args.begin(), args.end());
    } else if (operation == "max") {
        if (!minimumArity(1)) return makeError(error);
        value = *std::max_element(args.begin(), args.end());
    } else if (operation == "sum") {
        if (!minimumArity(1)) return makeError(error);
        for (const auto argument : args) value += argument;
    } else if (operation == "avg") {
        if (!minimumArity(1)) return makeError(error);
        for (const auto argument : args) value += argument;
        value /= static_cast<long double>(args.size());
    } else {
        return makeError("Unknown calculator operation: " + operation);
    }

    return buildResult(operation, rawArgs, options, value);
}
