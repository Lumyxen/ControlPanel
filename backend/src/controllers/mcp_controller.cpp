#include "controllers/mcp_controller.h"

#include <sstream>

#include "server/http_utils.h"

void handleMcpPost(const httplib::Request& req, httplib::Response& res, McpService& mcpService) {
    Json::CharReaderBuilder reader;
    std::string errors;
    std::istringstream stream(req.body);
    Json::Value body;

    if (!Json::parseFromStream(reader, stream, &body, &errors)) {
        Json::Value error(Json::objectValue);
        error["jsonrpc"] = "2.0";
        error["id"] = Json::Value();
        error["error"]["code"] = -32700;
        error["error"]["message"] = "Parse error: " + errors;
        setJson(res, error, 400);
        return;
    }

    if (body.isArray()) {
        Json::Value responses(Json::arrayValue);
        for (const auto& item : body) {
            Json::Value response = mcpService.dispatch(item);
            if (!response.isNull()) {
                responses.append(response);
            }
        }

        if (responses.empty()) {
            res.status = 202;
            return;
        }

        setJson(res, responses);
        return;
    }

    Json::Value response = mcpService.dispatch(body);
    if (response.isNull()) {
        res.status = 202;
        return;
    }

    setJson(res, response);
}

void handleMcpGet(const httplib::Request&, httplib::Response& res) {
    res.set_header("Content-Type", "text/event-stream");
    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    res.set_content(": MCP SSE channel open (stub)\n\n", "text/event-stream");
}
