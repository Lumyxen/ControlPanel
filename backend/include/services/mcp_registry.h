#ifndef MCP_REGISTRY_H
#define MCP_REGISTRY_H

#include "services/mcp_client.h"
#include "services/mcp_stdio_client.h"
#include <string>
#include <vector>
#include <memory>
#include <variant>
#include <json/json.h>

/**
 * McpRegistry — manages a pool of MCP client instances.
 *
 * Reads the standard MCP client config format from mcp.json:
 *
 *   {
 *     "mcpServers": {
 *       "My Server": {
 *         "command": "uvx",           // stdio transport
 *         "args": ["mcp-searxng"],
 *         "env":  { "SEARXNG_URL": "http://..." }
 *       },
 *       "Other Server": {
 *         "url": "http://localhost:3001/mcp"  // HTTP transport
 *       }
 *     }
 *   }
 *
 * Tool names are namespaced as "<server_name>__<tool_name>" so calls
 * can be routed back to the right client.
 */
class McpRegistry {
public:
    McpRegistry() = default;
    ~McpRegistry() = default;

    /**
     * (Re)parse mcp.json and (re)initialize any new/changed servers.
     * Existing live clients whose config hasn't changed are kept alive.
     */
    void loadFromFile(const std::string& mcpJsonPath);

    /** OpenAI-format tools array aggregated from all live servers. */
    Json::Value getAggregatedTools() const;

    /**
     * Route a tool call to the owning server.
     * @param qualifiedName  "<server_name>__<tool_name>"
     * @param arguments      JSON object of tool arguments
     */
    Json::Value callTool(const std::string& qualifiedName,
                         const Json::Value& arguments);

    size_t liveCount() const;

private:
    // A client is either HTTP or stdio
    using AnyClient = std::variant<
        std::unique_ptr<McpClient>,
        std::unique_ptr<McpStdioClient>
    >;

    struct Entry {
        std::string name;
        // Fingerprint used to detect config changes between reloads
        std::string fingerprint;
        AnyClient   client;
        bool        ready = false;
    };

    std::vector<Entry> entries_;

    // Helpers
    static std::string makeFingerprint(const Json::Value& serverCfg);
    bool               isClientReady(const Entry& e) const;
    Json::Value        listToolsForEntry(Entry& e) const;
    Json::Value        callToolForEntry(Entry& e,
                                        const std::string& toolName,
                                        const Json::Value& args) const;
};

#endif // MCP_REGISTRY_H