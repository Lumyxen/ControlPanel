#ifndef MCP_CLIENT_H
#define MCP_CLIENT_H

#include <string>
#include <json/json.h>

/**
 * McpClient — thin HTTP client for the MCP Streamable-HTTP transport.
 *
 * Each instance talks to exactly one MCP server.
 * Call initialize() once before listTools() / callTool().
 */
class McpClient {
public:
    McpClient(const std::string& name, const std::string& baseUrl);

    const std::string& getName()    const { return name_; }
    const std::string& getBaseUrl() const { return baseUrl_; }
    bool               isReady()    const { return initialized_; }

    /** Perform the MCP handshake. Returns true on success. */
    bool initialize();

    /**
     * Fetch the server's tool list.
     * Returns a JSON array in OpenAI tool-object format:
     *   [ { "type": "function",
     *       "function": { "name", "description", "parameters" } }, ... ]
     * Returns an empty array on failure.
     */
    Json::Value listTools();

    /**
     * Call a single tool.
     * @param toolName   Name of the tool to invoke.
     * @param arguments  JSON object matching the tool's input schema.
     * @returns          The "content" array from the MCP tools/call result,
     *                   or an error object on failure.
     */
    Json::Value callTool(const std::string& toolName,
                         const Json::Value& arguments);

private:
    std::string name_;
    std::string baseUrl_;
    bool        initialized_ = false;
    int         nextId_      = 1;

    /** POST a JSON-RPC 2.0 request; returns the parsed response or null. */
    Json::Value sendRequest(const Json::Value& request);
};

#endif // MCP_CLIENT_H