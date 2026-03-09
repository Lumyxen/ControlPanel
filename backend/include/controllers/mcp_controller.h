#ifndef MCP_CONTROLLER_H
#define MCP_CONTROLLER_H

#include "httplib.h"
#include "services/mcp_service.h"

/**
 * MCP HTTP endpoint handlers.
 *
 * Route registration (add to main.cpp):
 *   POST /mcp  → handleMcpPost
 *   GET  /mcp  → handleMcpGet   (SSE channel – stub for now)
 */
void handleMcpPost(const httplib::Request& req, httplib::Response& res,
                   McpService& mcpService);

void handleMcpGet (const httplib::Request& req, httplib::Response& res);

#endif // MCP_CONTROLLER_H