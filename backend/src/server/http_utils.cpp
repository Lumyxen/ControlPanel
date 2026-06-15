#include "server/http_utils.h"

#include <sstream>

void addSecurityHeaders(httplib::Response& res) {
    res.set_header("X-Frame-Options", "DENY");
    res.set_header("X-Content-Type-Options", "nosniff");
    res.set_header(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob: https:; "
        "font-src 'self' https://cdn.jsdelivr.net; "
        "connect-src 'self' http://127.0.0.1:8080; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
    res.set_header("X-XSS-Protection", "1; mode=block");
    res.set_header("Referrer-Policy", "strict-origin-when-cross-origin");
}

bool isProtectedApiPath(std::string_view path) {
    return path.starts_with("/api/") || path == "/mcp" || path.starts_with("/mcp/");
}

std::string extractOriginFromUrl(const std::string& value) {
    const std::size_t schemePos = value.find("://");
    if (schemePos == std::string::npos) {
        return "";
    }

    const std::size_t originEnd = value.find_first_of("/?#", schemePos + 3);
    if (originEnd == std::string::npos) {
        return value;
    }
    return value.substr(0, originEnd);
}

bool isAllowedFrontendRequest(const httplib::Request& req) {
    const std::string origin = req.get_header_value("Origin");
    if (!origin.empty()) {
        return origin == kAllowedFrontendOrigin;
    }

    const std::string referer = req.get_header_value("Referer");
    if (!referer.empty()) {
        return extractOriginFromUrl(referer) == kAllowedFrontendOrigin;
    }

    return false;
}

void addCorsHeaders(httplib::Response& res, const httplib::Request& req) {
    const std::string origin = req.get_header_value("Origin");
    if (origin == kAllowedFrontendOrigin) {
        res.set_header("Access-Control-Allow-Origin", origin);
    }

    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set_header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Chunk-Offset, X-Panel-Reauth-Token");
    res.set_header("Access-Control-Max-Age", "86400");
}

std::string getMimeType(const std::string& path) {
    if (path.ends_with(".html")) return "text/html";
    if (path.ends_with(".css")) return "text/css";
    if (path.ends_with(".js")) return "application/javascript";
    if (path.ends_with(".json")) return "application/json";
    if (path.ends_with(".png")) return "image/png";
    if (path.ends_with(".jpg") || path.ends_with(".jpeg")) return "image/jpeg";
    if (path.ends_with(".svg")) return "image/svg+xml";
    if (path.ends_with(".xpi")) return "application/x-xpinstall";
    return "application/octet-stream";
}

std::string writeJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

void setJson(httplib::Response& res, const Json::Value& value, int status) {
    res.status = status;
    res.set_content(writeJson(value), "application/json");
}

void setJsonError(httplib::Response& res, int status, const std::string& message) {
    Json::Value error;
    error["error"] = message;
    setJson(res, error, status);
}

bool parseJsonBody(const std::string& body, Json::Value& out, httplib::Response& res) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(body);
    if (!Json::parseFromStream(reader, stream, &out, &errors)) {
        setJsonError(res, 400, "Invalid JSON");
        return false;
    }
    return true;
}
