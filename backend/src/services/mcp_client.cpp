#include "services/mcp_client.h"
#include <curl/curl.h>
#include <sstream>
#include <iostream>

// ── libcurl write helper ──────────────────────────────────────────────────────
static size_t mcpWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

// ── Constructor ───────────────────────────────────────────────────────────────
McpClient::McpClient(const std::string& name, const std::string& baseUrl)
    : name_(name), baseUrl_(baseUrl) {}

// ── Public API ────────────────────────────────────────────────────────────────

bool McpClient::initialize() {
    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "initialize";

    Json::Value params;
    params["protocolVersion"] = "2024-11-05";

    Json::Value clientInfo;
    clientInfo["name"]    = "ControlPanel";
    clientInfo["version"] = "1.0.0";
    params["clientInfo"]  = clientInfo;

    Json::Value caps;
    params["capabilities"] = caps;
    req["params"]          = params;

    Json::Value resp = sendRequest(req);
    if (resp.isNull() || resp.isMember("error")) {
        std::cerr << "[McpClient:" << name_ << "] initialize failed\n";
        return false;
    }

    // Send notifications/initialized (no response expected)
    Json::Value notif;
    notif["jsonrpc"] = "2.0";
    notif["method"]  = "notifications/initialized";
    sendRequest(notif); // ignore response

    initialized_ = true;
    std::cout << "[McpClient:" << name_ << "] initialized OK\n";
    return true;
}

Json::Value McpClient::listTools() {
    if (!initialized_) {
        std::cerr << "[McpClient:" << name_ << "] listTools called before initialize\n";
        return Json::Value(Json::arrayValue);
    }

    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "tools/list";
    req["params"]  = Json::Value(Json::objectValue);

    Json::Value resp = sendRequest(req);
    if (resp.isNull() || resp.isMember("error") || !resp.isMember("result")) {
        return Json::Value(Json::arrayValue);
    }

    const Json::Value& mcpTools = resp["result"].get("tools", Json::Value(Json::arrayValue));
    Json::Value openAiTools(Json::arrayValue);

    // Convert MCP tool schema → OpenAI tool schema
    for (const auto& tool : mcpTools) {
        Json::Value fn;
        fn["name"]        = tool.get("name", "");
        fn["description"] = tool.get("description", "");

        // MCP uses "inputSchema"; OpenAI uses "parameters"
        if (tool.isMember("inputSchema")) {
            fn["parameters"] = tool["inputSchema"];
        } else {
            Json::Value emptySchema;
            emptySchema["type"]       = "object";
            emptySchema["properties"] = Json::Value(Json::objectValue);
            fn["parameters"]          = emptySchema;
        }

        Json::Value entry;
        entry["type"]     = "function";
        entry["function"] = fn;
        openAiTools.append(entry);
    }

    return openAiTools;
}

Json::Value McpClient::callTool(const std::string& toolName,
                                 const Json::Value& arguments) {
    if (!initialized_) {
        Json::Value err;
        err["error"] = "McpClient not initialized";
        return err;
    }

    Json::Value params;
    params["name"]      = toolName;
    params["arguments"] = arguments;

    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "tools/call";
    req["params"]  = params;

    Json::Value resp = sendRequest(req);
    if (resp.isNull()) {
        Json::Value err;
        err["error"] = "No response from MCP server";
        return err;
    }
    if (resp.isMember("error")) {
        return resp["error"];
    }

    // Return the content array (MCP tools/call result)
    return resp["result"].get("content", Json::Value(Json::arrayValue));
}

// ── Private ───────────────────────────────────────────────────────────────────

Json::Value McpClient::sendRequest(const Json::Value& request) {
    CURL* curl = curl_easy_init();
    if (!curl) return Json::Value();

    std::string url = baseUrl_;

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string body = Json::writeString(wb, request);

    std::string responseStr;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");

    curl_easy_setopt(curl, CURLOPT_URL,           url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST,           1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,     body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,  (long)body.size());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,     headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  mcpWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &responseStr);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT,        15L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    CURLcode res = curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        std::cerr << "[McpClient:" << name_ << "] CURL error: "
                  << curl_easy_strerror(res) << "\n";
        return Json::Value();
    }

    Json::Value parsed;
    Json::CharReaderBuilder rb;
    std::string errs;
    std::istringstream ss(responseStr);
    if (!Json::parseFromStream(rb, ss, &parsed, &errs)) {
        std::cerr << "[McpClient:" << name_ << "] JSON parse error: " << errs << "\n";
        return Json::Value();
    }

    return parsed;
}