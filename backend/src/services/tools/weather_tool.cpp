#include "services/tools/weather_tool.h"

#include "config/config.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cctype>
#include <ctime>
#include <iomanip>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include <curl/curl.h>

namespace {

size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    const size_t total = size * nmemb;
    auto* buffer = static_cast<std::string*>(userp);
    buffer->append(static_cast<char*>(contents), total);
    return total;
}

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string getStringArg(const Json::Value& value, const std::string& key, const std::string& fallback = "") {
    if (value.isObject() && value.isMember(key) && value[key].isString()) {
        return value[key].asString();
    }
    return fallback;
}

Json::Value makeError(const std::string& message) {
    Json::Value error(Json::objectValue);
    error["error"] = message;
    return error;
}

std::string urlEncode(const std::string& input) {
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl) {
        return input;
    }
    char* escaped = curl_easy_escape(curl.get(), input.c_str(), static_cast<int>(input.size()));
    if (!escaped) {
        return input;
    }
    std::string output(escaped);
    curl_free(escaped);
    return output;
}

Json::Value parseJson(const std::string& body, const std::string& source) {
    Json::Value root;
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(body);
    if (!Json::parseFromStream(reader, stream, &root, &errors)) {
        Json::Value error(Json::objectValue);
        error["error"] = "Weather service returned invalid JSON from " + source;
        error["details"] = errors;
        return error;
    }
    return root;
}

Json::Value httpGetJson(const std::string& url, const std::string& source) {
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), curl_easy_cleanup);
    if (!curl) {
        return makeError("Failed to initialize HTTP client for weather request");
    }

    std::string response;
    curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(curl.get(), CURLOPT_USERAGENT, "ctrlpanel-weather/1.0");

    const CURLcode result = curl_easy_perform(curl.get());
    if (result != CURLE_OK) {
        return makeError(std::string("Weather HTTP request failed: ") + curl_easy_strerror(result));
    }

    long status = 0;
    curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
    if (status < 200 || status >= 300) {
        Json::Value error(Json::objectValue);
        error["error"] = "Weather service returned HTTP " + std::to_string(status);
        error["body"] = response.substr(0, 1000);
        return error;
    }

    return parseJson(response, source);
}

std::string todayIsoDate() {
    const auto now = std::chrono::system_clock::now();
    const std::time_t nowTime = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &nowTime);
#else
    gmtime_r(&nowTime, &tm);
#endif
    std::ostringstream stream;
    stream << std::put_time(&tm, "%Y-%m-%d");
    return stream.str();
}

bool looksLikeIsoDate(const std::string& value) {
    if (value.size() != 10) {
        return false;
    }
    return std::isdigit(static_cast<unsigned char>(value[0])) &&
        std::isdigit(static_cast<unsigned char>(value[1])) &&
        std::isdigit(static_cast<unsigned char>(value[2])) &&
        std::isdigit(static_cast<unsigned char>(value[3])) &&
        value[4] == '-' &&
        std::isdigit(static_cast<unsigned char>(value[5])) &&
        std::isdigit(static_cast<unsigned char>(value[6])) &&
        value[7] == '-' &&
        std::isdigit(static_cast<unsigned char>(value[8])) &&
        std::isdigit(static_cast<unsigned char>(value[9]));
}

std::optional<int> daysFromIsoDate(const std::string& value) {
    if (!looksLikeIsoDate(value)) {
        return std::nullopt;
    }

    int year = 0;
    int month = 0;
    int day = 0;
    try {
        year = std::stoi(value.substr(0, 4));
        month = std::stoi(value.substr(5, 2));
        day = std::stoi(value.substr(8, 2));
    } catch (...) {
        return std::nullopt;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return std::nullopt;
    }

    year -= month <= 2 ? 1 : 0;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(year - era * 400);
    const unsigned monthPrime = static_cast<unsigned>(month + (month > 2 ? -3 : 9));
    const unsigned doy = (153 * monthPrime + 2) / 5 + static_cast<unsigned>(day) - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int>(doe) - 719468;
}

Json::Value unitSettings(const Config* config) {
    const std::string system = config ? config->getWeatherMeasurementSystem() : "metric";
    Json::Value units(Json::objectValue);
    if (system == "imperial") {
        units["temperature"] = "fahrenheit";
        units["windSpeed"] = "mph";
        units["precipitation"] = "inch";
    } else if (system == "mixed") {
        units["temperature"] = "celsius";
        units["windSpeed"] = "mph";
        units["precipitation"] = "mm";
    } else if (system == "custom") {
        units = config ? config->getWeatherCustomUnits() : Config::normalizeWeatherCustomUnits(Json::Value(Json::objectValue));
    } else {
        units["temperature"] = "celsius";
        units["windSpeed"] = "kmh";
        units["precipitation"] = "mm";
    }
    units["system"] = system;
    return units;
}

std::string unitQuery(const Json::Value& units) {
    return "&temperature_unit=" + units.get("temperature", "celsius").asString() +
        "&wind_speed_unit=" + units.get("windSpeed", "kmh").asString() +
        "&precipitation_unit=" + units.get("precipitation", "mm").asString();
}

Json::Value resolveLocation(const std::string& location) {
    const std::string url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
        urlEncode(location);
    Json::Value geocode = httpGetJson(url, "geocoding");
    if (geocode.isMember("error")) {
        return geocode;
    }

    const Json::Value results = geocode.get("results", Json::Value(Json::arrayValue));
    if (!results.isArray() || results.empty() || !results[0].isObject()) {
        return makeError("No weather location match found for \"" + location + "\"");
    }

    return results[0];
}

std::string joinVariables(std::initializer_list<const char*> variables) {
    std::string output;
    for (const char* variable : variables) {
        if (!output.empty()) {
            output += ",";
        }
        output += variable;
    }
    return output;
}

Json::Value getArrayItem(const Json::Value& object, const std::string& key, Json::ArrayIndex index) {
    if (!object.isObject() || !object.isMember(key) || !object[key].isArray() || index >= object[key].size()) {
        return Json::Value();
    }
    return object[key][index];
}

std::string weatherCodeLabel(int code) {
    switch (code) {
        case 0: return "clear";
        case 1: return "mainly clear";
        case 2: return "partly cloudy";
        case 3: return "overcast";
        case 45:
        case 48: return "fog";
        case 51:
        case 53:
        case 55: return "drizzle";
        case 56:
        case 57: return "freezing drizzle";
        case 61:
        case 63:
        case 65: return "rain";
        case 66:
        case 67: return "freezing rain";
        case 71:
        case 73:
        case 75: return "snow";
        case 77: return "snow grains";
        case 80:
        case 81:
        case 82: return "rain showers";
        case 85:
        case 86: return "snow showers";
        case 95: return "thunderstorms";
        case 96:
        case 99: return "thunderstorms with hail";
        default: return "weather code " + std::to_string(code);
    }
}

std::string formatNumber(double value, int decimals = 1) {
    if (std::abs(value) < 0.05) {
        value = 0.0;
    }
    std::ostringstream stream;
    stream << std::fixed << std::setprecision(decimals) << value;
    std::string output = stream.str();
    while (output.size() > 2 && output.back() == '0') {
        output.pop_back();
    }
    if (!output.empty() && output.back() == '.') {
        output.pop_back();
    }
    return output;
}

std::string unitFor(const Json::Value& units, const std::string& key, const std::string& fallback = "") {
    if (units.isObject() && units[key].isString()) {
        return units[key].asString();
    }
    return fallback;
}

std::string locationLabel(const Json::Value& location, const std::string& configuredLocation) {
    std::vector<std::string> parts;
    const std::string name = location.get("name", configuredLocation).asString();
    if (!name.empty()) {
        parts.push_back(name);
    }
    if (location["admin1"].isString()) {
        parts.push_back(location["admin1"].asString());
    }
    if (location["country_code"].isString()) {
        parts.push_back(location["country_code"].asString());
    } else if (location["country"].isString()) {
        parts.push_back(location["country"].asString());
    }

    std::string output;
    for (const auto& part : parts) {
        if (!output.empty()) {
            output += ", ";
        }
        output += part;
    }
    return output.empty() ? configuredLocation : output;
}

std::string compactForecastText(
    const std::string& configuredLocation,
    const Json::Value& matchedLocation,
    const std::string& startDate,
    const std::string& endDate,
    bool archiveRequest,
    const Json::Value& forecast) {
    const Json::Value current = forecast.get("current", Json::Value(Json::objectValue));
    const Json::Value currentUnits = forecast.get("current_units", Json::Value(Json::objectValue));
    const Json::Value daily = forecast.get("daily", Json::Value(Json::objectValue));
    const Json::Value dailyUnits = forecast.get("daily_units", Json::Value(Json::objectValue));

    std::ostringstream out;
    out << "Weather for " << locationLabel(matchedLocation, configuredLocation);
    const std::string timezone = forecast.get("timezone", "").asString();
    if (!timezone.empty()) {
        out << " (" << timezone << ")";
    }
    out << ". ";

    if (!archiveRequest && current.isObject()) {
        const double temp = current.get("temperature_2m", 0.0).asDouble();
        const double feels = current.get("apparent_temperature", temp).asDouble();
        const double wind = current.get("wind_speed_10m", 0.0).asDouble();
        const double gust = current.get("wind_gusts_10m", 0.0).asDouble();
        const int humidity = current.get("relative_humidity_2m", 0).asInt();
        const int code = current.get("weather_code", -1).asInt();
        out << "Current " << current.get("time", "").asString() << ": "
            << weatherCodeLabel(code) << ", "
            << formatNumber(temp) << unitFor(currentUnits, "temperature_2m")
            << " feels " << formatNumber(feels) << unitFor(currentUnits, "apparent_temperature")
            << ", humidity " << humidity << "%, wind " << formatNumber(wind)
            << unitFor(currentUnits, "wind_speed_10m");
        if (gust > wind) {
            out << " gust " << formatNumber(gust) << unitFor(currentUnits, "wind_gusts_10m");
        }
        const double precip = current.get("precipitation", 0.0).asDouble();
        if (precip > 0.0) {
            out << ", precipitation " << formatNumber(precip) << unitFor(currentUnits, "precipitation");
        }
        out << ". ";
    }

    if (daily.isObject() && daily["time"].isArray()) {
        const Json::ArrayIndex available = daily["time"].size();
        const Json::ArrayIndex maxDays = startDate.empty()
            ? std::min<Json::ArrayIndex>(available, 3)
            : std::min<Json::ArrayIndex>(available, 7);
        out << (archiveRequest ? "Daily history: " : "Daily outlook: ");
        for (Json::ArrayIndex index = 0; index < maxDays; ++index) {
            if (index > 0) {
                out << " | ";
            }
            const std::string date = getArrayItem(daily, "time", index).asString();
            const int code = getArrayItem(daily, "weather_code", index).asInt();
            const double high = getArrayItem(daily, "temperature_2m_max", index).asDouble();
            const double low = getArrayItem(daily, "temperature_2m_min", index).asDouble();
            const double precip = getArrayItem(daily, "precipitation_sum", index).asDouble();
            const Json::Value precipProbability = getArrayItem(daily, "precipitation_probability_max", index);
            const double wind = getArrayItem(daily, "wind_speed_10m_max", index).asDouble();
            out << date << " " << weatherCodeLabel(code)
                << ", high " << formatNumber(high) << unitFor(dailyUnits, "temperature_2m_max")
                << "/low " << formatNumber(low) << unitFor(dailyUnits, "temperature_2m_min")
                << ", precip " << formatNumber(precip) << unitFor(dailyUnits, "precipitation_sum");
            if (!precipProbability.isNull()) {
                out << " (" << precipProbability.asInt() << "%)";
            }
            out << ", wind up to " << formatNumber(wind) << unitFor(dailyUnits, "wind_speed_10m_max");
        }
        if (available > maxDays) {
            out << ". Additional days omitted.";
        }
    }

    if (!startDate.empty()) {
        out << " Requested range: " << startDate << " to " << endDate << ".";
    }
    return out.str();
}

} // namespace

namespace weather_tool {

Json::Value getWeather(const Json::Value& arguments, const Config* config) {
    const std::string configuredLocation = config ? trimCopy(config->getWeatherLocation()) : "";
    if (configuredLocation.empty()) {
        return makeError("Weather location is not configured. Ask the user to set Tools > Weather Location in settings before using this tool.");
    }

    const std::string startDate = trimCopy(getStringArg(arguments, "start_date"));
    const std::string endDate = trimCopy(getStringArg(arguments, "end_date", startDate));
    if ((!startDate.empty() && !looksLikeIsoDate(startDate)) || (!endDate.empty() && !looksLikeIsoDate(endDate))) {
        return makeError("start_date and end_date must use YYYY-MM-DD format");
    }
    if (!startDate.empty() && !endDate.empty() && endDate < startDate) {
        return makeError("end_date must be on or after start_date");
    }
    if (!startDate.empty() && !endDate.empty()) {
        const auto startDay = daysFromIsoDate(startDate);
        const auto endDay = daysFromIsoDate(endDate);
        if (!startDay.has_value() || !endDay.has_value()) {
            return makeError("start_date and end_date must be valid calendar dates");
        }
        if ((*endDay - *startDay) > 6) {
            return makeError("Weather date ranges are limited to 7 days to keep tool output within model context. Request a narrower range.");
        }
    }

    Json::Value location = resolveLocation(configuredLocation);
    if (location.isMember("error")) {
        return location;
    }
    if (!location.isMember("latitude") || !location.isMember("longitude")) {
        return makeError("Weather geocoding result did not include coordinates");
    }

    const Json::Value units = unitSettings(config);
    const std::string latitude = std::to_string(location["latitude"].asDouble());
    const std::string longitude = std::to_string(location["longitude"].asDouble());
    const std::string today = todayIsoDate();
    if (!startDate.empty() && startDate < today && endDate >= today) {
        return makeError("Weather date ranges cannot cross historical and forecast data. Use a past-only or today/future-only range.");
    }

    const bool archiveRequest = !startDate.empty() && endDate < today;

    const std::string currentVariables = joinVariables({
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "is_day",
        "precipitation",
        "rain",
        "showers",
        "snowfall",
        "weather_code",
        "cloud_cover",
        "surface_pressure",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m"
    });
    const std::string forecastDailyVariables = joinVariables({
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "sunrise",
        "sunset",
        "daylight_duration",
        "precipitation_sum",
        "rain_sum",
        "showers_sum",
        "snowfall_sum",
        "precipitation_probability_max",
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
        "wind_direction_10m_dominant",
        "uv_index_max"
    });
    const std::string archiveDailyVariables = joinVariables({
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "precipitation_sum",
        "rain_sum",
        "snowfall_sum",
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
        "wind_direction_10m_dominant"
    });

    const std::string baseUrl = archiveRequest
        ? "https://archive-api.open-meteo.com/v1/archive"
        : "https://api.open-meteo.com/v1/forecast";
    const std::string dailyVariables = archiveRequest ? archiveDailyVariables : forecastDailyVariables;

    std::string url = baseUrl + "?latitude=" + urlEncode(latitude) +
        "&longitude=" + urlEncode(longitude) +
        "&daily=" + urlEncode(dailyVariables) +
        "&timezone=auto" +
        unitQuery(units);
    if (!archiveRequest) {
        url += "&current=" + urlEncode(currentVariables);
    }
    if (!startDate.empty()) {
        url += "&start_date=" + urlEncode(startDate) + "&end_date=" + urlEncode(endDate);
    } else if (!archiveRequest) {
        url += "&forecast_days=7";
    }

    Json::Value forecast = httpGetJson(url, archiveRequest ? "weather archive" : "weather forecast");
    if (forecast.isMember("error")) {
        return forecast;
    }

    const std::string output = compactForecastText(
        configuredLocation,
        location,
        startDate,
        endDate,
        archiveRequest,
        forecast);

    Json::Value result(Json::objectValue);
    result["output"] = output;
    return result;
}

} // namespace weather_tool
