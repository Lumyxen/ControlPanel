#ifndef SERVER_HTTP_UTILS_H
#define SERVER_HTTP_UTILS_H

#include <string>
#include <string_view>
#include <json/json.h>
#include "httplib.h"

inline constexpr const char* kAllowedFrontendOrigin = "http://127.0.0.1:8080";

void addSecurityHeaders(httplib::Response& res);
void addCorsHeaders(httplib::Response& res, const httplib::Request& req);
bool isProtectedApiPath(std::string_view path);
bool isAllowedFrontendRequest(const httplib::Request& req);
std::string extractOriginFromUrl(const std::string& value);

std::string getMimeType(const std::string& path);
std::string writeJson(const Json::Value& value);

void setJson(httplib::Response& res, const Json::Value& value, int status = 200);
void setJsonError(httplib::Response& res, int status, const std::string& message);

bool parseJsonBody(const std::string& body, Json::Value& out, httplib::Response& res);

#endif // SERVER_HTTP_UTILS_H
