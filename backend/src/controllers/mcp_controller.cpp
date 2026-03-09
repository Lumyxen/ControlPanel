#include "controllers/mcp_controller.h"
#include <iostream>
#include <sstream>
#include <json/json.h>

// ── POST /mcp ─────────────────────────────────────────────────────────────────
// Accepts a single JSON-RPC 2.0 request (or a JSON array of batched requests).
// Responds with a JSON-RPC 2.0 response (or array), or 202 for pure notifications.

void handleMcpPost(const httplib::Request& req, httplib::Response& res,
                   McpService& mcpService) {

    // ── Parse body ────────────────────────────────────────────────────────────
    Json::CharReaderBuilder builder;
    Json::Value body;
    std::string errors;
    std::istringstream stream(req.body);

    if (!Json::parseFromStream(builder, stream, &body, &errors)) {
        Json::Value errResp;
        errResp["jsonrpc"] = "2.0";
        errResp["id"]      = Json::Value();
        Json::Value err;
        err["code"]    = -32700;
        err["message"] = "Parse error: " + errors;
        errResp["error"] = err;

        Json::StreamWriterBuilder w;
        res.set_content(Json::writeString(w, errResp), "application/json");
        res.status = 400;
        return;
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────
    Json::StreamWriterBuilder writer;

    // Batch request (JSON array)
    if (body.isArray()) {
        Json::Value responses(Json::arrayValue);
        for (const auto& item : body) {
            Json::Value resp = mcpService.dispatch(item);
            if (!resp.isNull()) responses.append(resp);
        }
        if (responses.empty()) {
            res.status = 202; // all were notifications
            return;
        }
        res.set_content(Json::writeString(writer, responses), "application/json");
        return;
    }

    // Single request
    Json::Value resp = mcpService.dispatch(body);
    if (resp.isNull()) {
        // Pure notification – no body in response
        res.status = 202;
        return;
    }

    res.set_content(Json::writeString(writer, resp), "application/json");
}

// ── GET /mcp ──────────────────────────────────────────────────────────────────
// SSE channel for server-initiated messages (stub).
// Clients that open this will receive a keep-alive comment every 30 s.
// Real server→client notifications (e.g. tools/list_changed) will be sent here.

void handleMcpGet(const httplib::Request& /*req*/, httplib::Response& res) {
    res.set_header("Content-Type",  "text/event-stream");
    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection",    "keep-alive");

    // Stub: send a single SSE comment so the client knows we're alive, then close.
    // Replace with a proper chunked/streaming response when server-push is needed.
    res.set_content(": MCP SSE channel open (stub)\n\n", "text/event-stream");
    std::cout << "[MCP] SSE GET /mcp – stub response sent\n";
}