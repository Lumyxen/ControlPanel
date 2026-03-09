#include "services/mcp_service.h"
#include <iostream>

McpService::McpService(Config& config) : config_(config) {}

// ── Public ────────────────────────────────────────────────────────────────────

Json::Value McpService::dispatch(const Json::Value& request) {
    if (!request.isMember("jsonrpc") || request["jsonrpc"].asString() != "2.0")
        return makeError(Json::Value(), -32600, "Invalid JSON-RPC version");

    const std::string method = request.get("method", "").asString();
    const Json::Value params = request.get("params", Json::Value());
    const Json::Value id     = request.get("id", Json::Value());

    std::cout << "[MCP] dispatch: " << method << "\n";

    // Notifications — no response
    if (!request.isMember("id")) {
        if (method == "notifications/initialized")
            std::cout << "[MCP] Client initialized notification received\n";
        return Json::Value();
    }

    if (method == "initialize")      return handleInitialize   (params, id);
    if (method == "tools/list")      return handleToolsList    (params, id);
    if (method == "tools/call")      return handleToolsCall    (params, id);
    if (method == "resources/list")  return handleResourcesList(params, id);
    if (method == "prompts/list")    return handlePromptsList  (params, id);
    if (method == "ping")            return handlePing         (params, id);

    return makeError(id, -32601, "Method not found: " + method);
}

// ── Method handlers ───────────────────────────────────────────────────────────

Json::Value McpService::handleInitialize(const Json::Value& params,
                                          const Json::Value& id) {
    if (params.isMember("clientInfo")) {
        std::cout << "[MCP] Client: "
                  << params["clientInfo"].get("name",    "unknown").asString() << " "
                  << params["clientInfo"].get("version", "").asString()        << "\n";
    }

    Json::Value capabilities;
    capabilities["tools"]     = Json::Value(Json::objectValue);
    capabilities["resources"] = Json::Value(Json::objectValue);
    capabilities["prompts"]   = Json::Value(Json::objectValue);

    Json::Value serverInfo;
    serverInfo["name"]    = "ControlPanel MCP";
    serverInfo["version"] = "0.2.0";

    Json::Value result;
    result["protocolVersion"] = "2024-11-05";
    result["capabilities"]    = capabilities;
    result["serverInfo"]      = serverInfo;

    return makeResponse(id, result);
}

Json::Value McpService::handleToolsList(const Json::Value& /*params*/,
                                         const Json::Value& id) {
    Json::Value result;
    result["tools"] = builtinToolSchemas();
    return makeResponse(id, result);
}

Json::Value McpService::handleToolsCall(const Json::Value& params,
                                         const Json::Value& id) {
    const std::string toolName = params.get("name", "").asString();
    const Json::Value args     = params.get("arguments", Json::Value(Json::objectValue));

    std::cout << "[MCP] tools/call: " << toolName << "\n";

    Json::Value content;
    if      (toolName == "get_config") content = toolGetConfig(args);
    else if (toolName == "set_config") content = toolSetConfig(args);
    else return makeError(id, -32601, "Unknown tool: " + toolName);

    Json::Value result;
    result["content"] = content;
    result["isError"] = false;
    return makeResponse(id, result);
}

Json::Value McpService::handleResourcesList(const Json::Value& /*params*/,
                                             const Json::Value& id) {
    Json::Value result;
    result["resources"] = Json::Value(Json::arrayValue);
    return makeResponse(id, result);
}

Json::Value McpService::handlePromptsList(const Json::Value& /*params*/,
                                           const Json::Value& id) {
    Json::Value result;
    result["prompts"] = Json::Value(Json::arrayValue);
    return makeResponse(id, result);
}

Json::Value McpService::handlePing(const Json::Value& /*params*/,
                                    const Json::Value& id) {
    return makeResponse(id, Json::Value(Json::objectValue));
}

// ── Built-in tools ────────────────────────────────────────────────────────────

Json::Value McpService::toolGetConfig(const Json::Value& /*args*/) {
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "    ";
    std::string text = Json::writeString(wb, config_.toJson());
    return makeTextContent(text);
}

Json::Value McpService::toolSetConfig(const Json::Value& args) {
    // args is a JSON object with the same shape as the settings REST body
    try {
        config_.updateFromJson(args);
        Json::StreamWriterBuilder wb;
        wb["indentation"] = "    ";
        std::string text = Json::writeString(wb, config_.toJson());
        return makeTextContent("Settings updated:\n" + text);
    } catch (const std::exception& e) {
        Json::Value content = makeTextContent(std::string("Error: ") + e.what());
        // Caller will set isError=true if needed; for now just return message
        return content;
    }
}

// ── Schema ────────────────────────────────────────────────────────────────────

Json::Value McpService::builtinToolSchemas() {
    Json::Value tools(Json::arrayValue);

    // ─── get_config ───────────────────────────────────────────────────────────
    {
        Json::Value schema;
        schema["type"]                 = "object";
        schema["properties"]           = Json::Value(Json::objectValue);
        schema["required"]             = Json::Value(Json::arrayValue);
        schema["additionalProperties"] = false;

        Json::Value tool;
        tool["name"]        = "get_config";
        tool["description"] = "Returns the current ControlPanel server configuration "
                              "(model, temperature, max tokens, system prompt, port, MCP servers).";
        tool["inputSchema"] = schema;
        tools.append(tool);
    }

    // ─── set_config ───────────────────────────────────────────────────────────
    {
        Json::Value props;

        props["defaultModel"]["type"]        = "string";
        props["defaultModel"]["description"] = "Default model identifier (e.g. openai/gpt-4o)";

        props["temperature"]["type"]        = "number";
        props["temperature"]["description"] = "Sampling temperature (0 – 2)";
        props["temperature"]["minimum"]     = 0.0;
        props["temperature"]["maximum"]     = 2.0;

        props["fallbackMaxOutputTokens"]["type"]        = "integer";
        props["fallbackMaxOutputTokens"]["description"] = "Fallback max output tokens";

        props["systemPrompt"]["type"]        = "string";
        props["systemPrompt"]["description"] = "Master system prompt";

        Json::Value schema;
        schema["type"]                 = "object";
        schema["properties"]           = props;
        schema["required"]             = Json::Value(Json::arrayValue); // all optional
        schema["additionalProperties"] = false;

        Json::Value tool;
        tool["name"]        = "set_config";
        tool["description"] = "Partially updates ControlPanel server configuration. "
                              "Only the provided fields are changed.";
        tool["inputSchema"] = schema;
        tools.append(tool);
    }

    return tools;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

Json::Value McpService::makeResponse(const Json::Value& id,
                                      const Json::Value& result) const {
    Json::Value resp;
    resp["jsonrpc"] = "2.0";
    resp["id"]      = id;
    resp["result"]  = result;
    return resp;
}

Json::Value McpService::makeError(const Json::Value& id, int code,
                                   const std::string& msg) const {
    Json::Value err;
    err["code"]    = code;
    err["message"] = msg;

    Json::Value resp;
    resp["jsonrpc"] = "2.0";
    resp["id"]      = id;
    resp["error"]   = err;
    return resp;
}

Json::Value McpService::makeTextContent(const std::string& text) {
    Json::Value content(Json::arrayValue);
    Json::Value item;
    item["type"] = "text";
    item["text"] = text;
    content.append(item);
    return content;
}