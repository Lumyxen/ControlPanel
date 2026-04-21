#ifndef MCP_CONTROLLER_H
#define MCP_CONTROLLER_H

#include "httplib.h"
#include "services/mcp_service.h"

void handleMcpPost(const httplib::Request& req, httplib::Response& res, McpService& mcpService);
void handleMcpGet(const httplib::Request& req, httplib::Response& res);

#endif // MCP_CONTROLLER_H
