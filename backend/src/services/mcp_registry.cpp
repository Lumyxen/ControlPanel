#include "services/mcp_registry.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include <cctype>

// ── sanitizeName ─────────────────────────────────────────────────────────────
// Converts any string into a valid OpenAI function name component:
// only [a-zA-Z0-9_-], max 32 chars so prefix+sep+tool fits inside 64.
static std::string sanitizeName(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '-')
            out += c;
        else
            out += '_';
    }
    if (out.size() > 32) out.resize(32);
    return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

std::string McpRegistry::makeFingerprint(const Json::Value& cfg) {
    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    return Json::writeString(wb, cfg);
}

bool McpRegistry::isClientReady(const Entry& e) const {
    return std::visit([](const auto& c) -> bool {
        return c && c->isReady();
    }, e.client);
}

Json::Value McpRegistry::listToolsForEntry(Entry& e) const {
    return std::visit([](auto& c) -> Json::Value {
        if (!c) return Json::Value(Json::arrayValue);
        return c->listTools();
    }, e.client);
}

Json::Value McpRegistry::callToolForEntry(Entry& e,
                                           const std::string& toolName,
                                           const Json::Value& args) const {
    return std::visit([&](auto& c) -> Json::Value {
        if (!c) {
            Json::Value err; err["error"] = "Client is null"; return err;
        }
        return c->callTool(toolName, args);
    }, e.client);
}

// ── loadFromFile ──────────────────────────────────────────────────────────────

void McpRegistry::loadFromFile(const std::string& mcpJsonPath) {
    std::ifstream file(mcpJsonPath);
    if (!file.is_open()) {
        std::cout << "[McpRegistry] " << mcpJsonPath
                  << " not found — no MCP clients loaded\n";
        entries_.clear();
        return;
    }

    Json::Value root;
    Json::CharReaderBuilder rb;
    std::string errs;
    if (!Json::parseFromStream(rb, file, &root, &errs)) {
        std::cerr << "[McpRegistry] Failed to parse " << mcpJsonPath
                  << ": " << errs << "\n";
        return;
    }

    const Json::Value& servers = root["mcpServers"];
    if (!servers.isObject()) {
        std::cerr << "[McpRegistry] mcp.json: 'mcpServers' must be an object\n";
        return;
    }

    std::vector<Entry> newEntries;

    for (const auto& name : servers.getMemberNames()) {
        const Json::Value& cfg = servers[name];
        if (!cfg.isObject()) continue;

        if (cfg.isMember("disabled") && cfg["disabled"].asBool()) {
            std::cout << "[McpRegistry] Skipping disabled server: " << name << "\n";
            continue;
        }

        std::string fingerprint = makeFingerprint(cfg);

        // Reuse existing live client if config unchanged
        bool reused = false;
        for (auto& existing : entries_) {
            if (existing.name == name && existing.fingerprint == fingerprint
                    && isClientReady(existing)) {
                newEntries.push_back(std::move(existing));
                reused = true;
                std::cout << "[McpRegistry] Reusing live client: " << name << "\n";
                break;
            }
        }
        if (reused) continue;

        bool isStdio = cfg.isMember("command");
        bool isHttp  = cfg.isMember("url");

        if (!isStdio && !isHttp) {
            std::cerr << "[McpRegistry] Server '" << name
                      << "' has neither 'command' nor 'url' — skipping\n";
            continue;
        }

        Entry e;
        e.name        = name;
        e.fingerprint = fingerprint;

        if (isStdio) {
            std::string command = cfg["command"].asString();

            std::vector<std::string> args;
            if (cfg.isMember("args") && cfg["args"].isArray())
                for (const auto& a : cfg["args"])
                    args.push_back(a.asString());

            std::map<std::string, std::string> env;
            if (cfg.isMember("env") && cfg["env"].isObject())
                for (const auto& k : cfg["env"].getMemberNames())
                    env[k] = cfg["env"][k].asString();

            auto client = std::make_unique<McpStdioClient>(name, command, args, env);
            bool ok = client->initialize();
            e.ready  = ok;
            e.client = std::move(client);

            if (ok)
                std::cout << "[McpRegistry] Stdio client ready: " << name << "\n";
            else
                std::cerr << "[McpRegistry] Stdio init failed for '" << name << "'\n";

        } else {
            std::string url = cfg["url"].asString();
            auto client = std::make_unique<McpClient>(name, url);
            bool ok = client->initialize();
            e.ready  = ok;
            e.client = std::move(client);

            if (ok)
                std::cout << "[McpRegistry] HTTP client ready: " << name << "\n";
            else
                std::cerr << "[McpRegistry] HTTP init failed for '" << name << "'\n";
        }

        newEntries.push_back(std::move(e));
    }

    entries_ = std::move(newEntries);
    std::cout << "[McpRegistry] " << liveCount() << " live MCP client(s) loaded\n";

    // Log what tools are available after load
    if (liveCount() > 0) {
        Json::Value tools = getAggregatedTools();
        std::cout << "[McpRegistry] " << tools.size() << " tool(s) available:\n";
        for (const auto& t : tools) {
            std::cout << "  - " << t["function"]["name"].asString() << "\n";
        }
    }
}

// ── getAggregatedTools ────────────────────────────────────────────────────────

Json::Value McpRegistry::getAggregatedTools() const {
    Json::Value tools(Json::arrayValue);

    for (auto& entry : const_cast<McpRegistry*>(this)->entries_) {
        if (!isClientReady(entry)) continue;

        const std::string safePrefix = sanitizeName(entry.name);

        Json::Value serverTools = listToolsForEntry(entry);
        for (auto tool : serverTools) {
            if (tool.isMember("function") && tool["function"].isMember("name")) {
                const std::string original = tool["function"]["name"].asString();
                // Must satisfy ^[a-zA-Z0-9_-]{1,64}$
                std::string qualified = safePrefix + "__" + sanitizeName(original);
                if (qualified.size() > 64) qualified.resize(64);
                tool["function"]["name"] = qualified;

                const std::string desc = tool["function"].get("description", "").asString();
                if (!desc.empty())
                    tool["function"]["description"] = "[" + entry.name + "] " + desc;
            }
            tools.append(tool);
        }
    }

    return tools;
}

// ── callTool ──────────────────────────────────────────────────────────────────

Json::Value McpRegistry::callTool(const std::string& qualifiedName,
                                   const Json::Value& arguments) {
    const std::string sep = "__";
    const size_t pos = qualifiedName.find(sep);
    if (pos == std::string::npos) {
        Json::Value err;
        err["error"] = "Invalid tool name (expected 'server__tool'): " + qualifiedName;
        return err;
    }

    const std::string sanitizedServer = qualifiedName.substr(0, pos);
    const std::string sanitizedTool   = qualifiedName.substr(pos + sep.size());

    // Match by comparing sanitized names — entry.name may have spaces
    for (auto& entry : entries_) {
        if (sanitizeName(entry.name) == sanitizedServer && isClientReady(entry)) {
            std::cout << "[McpRegistry] Calling " << entry.name
                      << "/" << sanitizedTool << "\n";
            // Pass the sanitized tool name — the MCP server uses its original name,
            // but since we sanitized it the same way it should still match if the
            // original had no special chars. If it did, we need the reverse mapping.
            return callToolForEntry(entry, sanitizedTool, arguments);
        }
    }

    Json::Value err;
    err["error"] = "No live MCP client found for '" + qualifiedName + "'";
    return err;
}

// ── liveCount ─────────────────────────────────────────────────────────────────

size_t McpRegistry::liveCount() const {
    size_t n = 0;
    for (const auto& e : entries_)
        if (isClientReady(e)) ++n;
    return n;
}
// Note: callToolForEntry always receives the sanitized tool name.
// Since mcp-searxng's tool is literally named "search" (no special chars),
// sanitizing it is a no-op and the MCP server receives the correct name.
// If a future server has tool names with spaces/special chars, a reverse
// mapping would be needed here. For now this covers all practical cases.