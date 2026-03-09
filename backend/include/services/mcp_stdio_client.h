#ifndef MCP_STDIO_CLIENT_H
#define MCP_STDIO_CLIENT_H

#include <string>
#include <vector>
#include <map>
#include <json/json.h>

/**
 * McpStdioClient — MCP client using the stdio transport.
 *
 * Spawns a subprocess (e.g. "uvx mcp-searxng") and communicates with it
 * using JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
 *
 * Linux: implemented with POSIX pipe() + fork() + execvp().
 * Windows: stub — logs a warning and reports not ready.
 */
class McpStdioClient {
public:
    McpStdioClient(const std::string& name,
                   const std::string& command,
                   const std::vector<std::string>& args,
                   const std::map<std::string, std::string>& env);

    ~McpStdioClient();

    // Non-copyable
    McpStdioClient(const McpStdioClient&)            = delete;
    McpStdioClient& operator=(const McpStdioClient&) = delete;

    const std::string& getName() const { return name_; }
    bool               isReady() const { return ready_; }

    bool       initialize();
    Json::Value listTools();
    Json::Value callTool(const std::string& toolName, const Json::Value& arguments);

private:
    std::string                        name_;
    std::string                        command_;
    std::vector<std::string>           args_;
    std::map<std::string, std::string> env_;
    bool                               ready_ = false;
    int                                nextId_ = 1;

#ifndef _WIN32
    pid_t pid_      = -1;
    int   stdinFd_  = -1;   // we write here  → child stdin
    int   stdoutFd_ = -1;   // we read here   ← child stdout
#endif

    bool        spawnProcess();
    Json::Value sendRequest(const Json::Value& request);
    std::string readLine(int timeoutMs = 15000);
    void        closePipes();
};

#endif // MCP_STDIO_CLIENT_H