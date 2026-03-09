#ifndef MCP_SERVICE_H
#define MCP_SERVICE_H

#include <string>
#include <json/json.h>
#include "config/config.h"

/**
 * McpService — MCP server implementation for ControlPanel.
 *
 * Handles JSON-RPC 2.0 requests on POST /mcp.
 *
 * Built-in tools exposed to MCP clients:
 *   get_config    – returns the current settings (read-only)
 *   set_config    – partial-updates settings (same fields as the REST API)
 *
 * Protocol: MCP 2024-11-05, Streamable HTTP transport.
 */
class McpService {
public:
    /** Config reference is used by the built-in config tools. */
    explicit McpService(Config& config);

    /**
     * Dispatch a JSON-RPC request and return the response object.
     * Returns an empty Value for pure notifications (no id).
     */
    Json::Value dispatch(const Json::Value& request);

private:
    Config& config_;

    // ── Method handlers ──────────────────────────────────────────────────────
    Json::Value handleInitialize   (const Json::Value& params, const Json::Value& id);
    Json::Value handleToolsList    (const Json::Value& params, const Json::Value& id);
    Json::Value handleToolsCall    (const Json::Value& params, const Json::Value& id);
    Json::Value handleResourcesList(const Json::Value& params, const Json::Value& id);
    Json::Value handlePromptsList  (const Json::Value& params, const Json::Value& id);
    Json::Value handlePing         (const Json::Value& params, const Json::Value& id);

    // ── Built-in tool implementations ────────────────────────────────────────
    Json::Value toolGetConfig  (const Json::Value& args);
    Json::Value toolSetConfig  (const Json::Value& args);

    // ── Tool schema helpers ───────────────────────────────────────────────────
    static Json::Value builtinToolSchemas();

    // ── JSON-RPC helpers ─────────────────────────────────────────────────────
    Json::Value makeResponse(const Json::Value& id, const Json::Value& result) const;
    Json::Value makeError   (const Json::Value& id, int code, const std::string& msg) const;
    static Json::Value makeTextContent(const std::string& text);
};

#endif // MCP_SERVICE_H