#include "services/mcp_stdio_client.h"
#include <iostream>
#include <sstream>
#include <chrono>
#include <thread>

#ifndef _WIN32
// ── POSIX-only includes ───────────────────────────────────────────────────────
#include <unistd.h>
#include <sys/wait.h>
#include <sys/select.h>
#include <signal.h>
#include <errno.h>
#include <cstring>
#include <fcntl.h>
extern char** environ;
#endif

// ─────────────────────────────────────────────────────────────────────────────

McpStdioClient::McpStdioClient(const std::string& name,
                               const std::string& command,
                               const std::vector<std::string>& args,
                               const std::map<std::string, std::string>& env)
    : name_(name), command_(command), args_(args), env_(env) {}

McpStdioClient::~McpStdioClient() {
    ready_ = false;

#ifndef _WIN32
    // Close our end of stdin first — the child gets EOF and should exit on its
    // own (this is the polite shutdown path).
    if (stdinFd_ >= 0) { close(stdinFd_);  stdinFd_  = -1; }
    if (stdoutFd_ >= 0) { close(stdoutFd_); stdoutFd_ = -1; }

    if (pid_ > 0) {
        // Wait up to ~1 s for the child to exit after EOF on its stdin.
        int status = 0;
        for (int i = 0; i < 10; ++i) {
            pid_t ret = waitpid(pid_, &status, WNOHANG);
            if (ret == pid_ || ret < 0) {
                // Reaped or already gone.
                pid_ = -1;
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Child is still alive — escalate to SIGTERM.
        kill(pid_, SIGTERM);

        for (int i = 0; i < 10; ++i) {
            pid_t ret = waitpid(pid_, &status, WNOHANG);
            if (ret == pid_ || ret < 0) {
                pid_ = -1;
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // Last resort: SIGKILL then blocking wait to reap the zombie.
        kill(pid_, SIGKILL);
        waitpid(pid_, &status, 0);
        pid_ = -1;
    }
#else
    closePipes();
#endif
}

// ── Public API ────────────────────────────────────────────────────────────────

bool McpStdioClient::initialize() {
#ifdef _WIN32
    std::cerr << "[McpStdioClient:" << name_ << "] stdio transport not supported on Windows yet\n";
    return false;
#else
    if (!spawnProcess()) return false;

    // Send initialize request
    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "initialize";

    Json::Value params;
    params["protocolVersion"] = "2024-11-05";
    Json::Value ci;
    ci["name"]             = "ControlPanel";
    ci["version"]          = "1.0.0";
    params["clientInfo"]   = ci;
    params["capabilities"] = Json::Value(Json::objectValue);
    req["params"]          = params;

    Json::Value resp = sendRequest(req);
    if (resp.isNull() || resp.isMember("error")) {
        std::cerr << "[McpStdioClient:" << name_ << "] initialize failed\n";
        return false;
    }

    // Send notifications/initialized (no response expected)
    Json::Value notif;
    notif["jsonrpc"] = "2.0";
    notif["method"]  = "notifications/initialized";
    notif["params"]  = Json::Value(Json::objectValue);

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string line = Json::writeString(wb, notif) + "\n";
    if (write(stdinFd_, line.c_str(), line.size()) < 0) {
        std::cerr << "[McpStdioClient:" << name_ << "] write notification failed\n";
    }

    ready_ = true;
    std::cout << "[McpStdioClient:" << name_ << "] initialized OK\n";
    return true;
#endif
}

Json::Value McpStdioClient::listTools() {
    if (!ready_) return Json::Value(Json::arrayValue);

    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "tools/list";
    req["params"]  = Json::Value(Json::objectValue);

    Json::Value resp = sendRequest(req);
    if (resp.isNull() || resp.isMember("error") || !resp.isMember("result"))
        return Json::Value(Json::arrayValue);

    const Json::Value& mcpTools = resp["result"].get("tools", Json::Value(Json::arrayValue));
    Json::Value openAiTools(Json::arrayValue);

    for (const auto& tool : mcpTools) {
        Json::Value fn;
        fn["name"]        = tool.get("name", "");
        fn["description"] = tool.get("description", "");

        if (tool.isMember("inputSchema"))
            fn["parameters"] = tool["inputSchema"];
        else {
            Json::Value s;
            s["type"]       = "object";
            s["properties"] = Json::Value(Json::objectValue);
            fn["parameters"] = s;
        }

        Json::Value entry;
        entry["type"]     = "function";
        entry["function"] = fn;
        openAiTools.append(entry);
    }

    return openAiTools;
}

Json::Value McpStdioClient::callTool(const std::string& toolName,
                                      const Json::Value& arguments) {
    if (!ready_) {
        Json::Value err; err["error"] = "Client not initialized"; return err;
    }

    Json::Value params;
    params["name"]      = toolName;
    params["arguments"] = arguments;

    Json::Value req;
    req["jsonrpc"] = "2.0";
    req["id"]      = nextId_++;
    req["method"]  = "tools/call";
    req["params"]  = params;

    Json::Value resp = sendRequest(req);
    if (resp.isNull()) {
        Json::Value err; err["error"] = "No response from MCP server"; return err;
    }
    if (resp.isMember("error")) return resp["error"];

    return resp["result"].get("content", Json::Value(Json::arrayValue));
}

// ── Private ───────────────────────────────────────────────────────────────────

#ifndef _WIN32

bool McpStdioClient::spawnProcess() {
    // stdin pipe:  parent writes → child reads
    // stdout pipe: child writes → parent reads
    int stdinPipe[2], stdoutPipe[2];
    if (pipe(stdinPipe) != 0 || pipe(stdoutPipe) != 0) {
        std::cerr << "[McpStdioClient:" << name_ << "] pipe() failed: "
                  << strerror(errno) << "\n";
        return false;
    }

    // Build argv: command + args
    std::vector<const char*> argv;
    argv.push_back(command_.c_str());
    for (const auto& a : args_) argv.push_back(a.c_str());
    argv.push_back(nullptr);

    // Build environment: inherit current env, then overlay custom vars
    int envCount = 0;
    for (char** e = environ; *e; ++e) ++envCount;

    std::vector<std::string> envStrings;
    // Copy existing env, skip keys we'll override
    for (char** e = environ; *e; ++e) {
        std::string entry(*e);
        std::string key = entry.substr(0, entry.find('='));
        if (env_.find(key) == env_.end())
            envStrings.push_back(entry);
    }
    // Add custom vars
    for (const auto& [k, v] : env_)
        envStrings.push_back(k + "=" + v);

    std::vector<const char*> envp;
    for (const auto& s : envStrings) envp.push_back(s.c_str());
    envp.push_back(nullptr);

    pid_ = fork();
    if (pid_ < 0) {
        std::cerr << "[McpStdioClient:" << name_ << "] fork() failed: "
                  << strerror(errno) << "\n";
        close(stdinPipe[0]);  close(stdinPipe[1]);
        close(stdoutPipe[0]); close(stdoutPipe[1]);
        return false;
    }

    if (pid_ == 0) {
        // ── Child process ─────────────────────────────────────────────────────
        //
        // Put the child in its own session so that terminal signals (Ctrl+C →
        // SIGINT) are NOT forwarded to it. The parent will shut it down cleanly
        // by closing the stdin pipe (child gets EOF) or by sending SIGTERM from
        // the destructor. Without setsid(), every Ctrl+C also kills the child,
        // which produces ugly Python tracebacks and leaves the parent in an
        // inconsistent state when it later tries to talk to a dead pipe.
        setsid();

        dup2(stdinPipe[0],  STDIN_FILENO);
        dup2(stdoutPipe[1], STDOUT_FILENO);
        // Leave stderr open so the child can log
        close(stdinPipe[1]);
        close(stdoutPipe[0]);

        execvpe(command_.c_str(),
                const_cast<char* const*>(argv.data()),
                const_cast<char* const*>(envp.data()));

        // execvpe only returns on error
        std::cerr << "[McpStdioClient:" << name_ << "] execvpe failed: "
                  << strerror(errno) << "\n";
        _exit(1);
    }

    // ── Parent process ────────────────────────────────────────────────────────
    close(stdinPipe[0]);   // parent doesn't read child's stdin
    close(stdoutPipe[1]);  // parent doesn't write to child's stdout

    stdinFd_  = stdinPipe[1];   // parent writes here
    stdoutFd_ = stdoutPipe[0];  // parent reads here

    // Set stdout pipe to non-blocking for readLine()
    int flags = fcntl(stdoutFd_, F_GETFL, 0);
    fcntl(stdoutFd_, F_SETFL, flags | O_NONBLOCK);

    std::cout << "[McpStdioClient:" << name_ << "] spawned PID " << pid_ << ": "
              << command_;
    for (const auto& a : args_) std::cout << " " << a;
    std::cout << "\n";

    return true;
}

std::string McpStdioClient::readLine(int timeoutMs) {
    std::string line;
    auto deadline = std::chrono::steady_clock::now()
                  + std::chrono::milliseconds(timeoutMs);

    while (true) {
        char c;
        ssize_t n = read(stdoutFd_, &c, 1);
        if (n == 1) {
            if (c == '\n') return line;
            line += c;
            continue;
        }

        if (n == 0) {
            // EOF — child closed stdout
            std::cerr << "[McpStdioClient:" << name_ << "] child stdout EOF\n";
            return "";
        }

        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            std::cerr << "[McpStdioClient:" << name_ << "] read error: "
                      << strerror(errno) << "\n";
            return "";
        }

        // Would block — wait with select()
        if (std::chrono::steady_clock::now() >= deadline) {
            std::cerr << "[McpStdioClient:" << name_ << "] readLine timeout\n";
            return "";
        }

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(stdoutFd_, &rfds);

        auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) {
            std::cerr << "[McpStdioClient:" << name_ << "] readLine timeout\n";
            return "";
        }

        struct timeval tv;
        tv.tv_sec  = remaining / 1'000'000;
        tv.tv_usec = remaining % 1'000'000;

        int ret = select(stdoutFd_ + 1, &rfds, nullptr, nullptr, &tv);
        if (ret <= 0) {
            std::cerr << "[McpStdioClient:" << name_ << "] readLine timeout/error\n";
            return "";
        }
        // Data available — loop back to read
    }
}

void McpStdioClient::closePipes() {
    if (stdinFd_  >= 0) { close(stdinFd_);  stdinFd_  = -1; }
    if (stdoutFd_ >= 0) { close(stdoutFd_); stdoutFd_ = -1; }
}

Json::Value McpStdioClient::sendRequest(const Json::Value& request) {
    if (stdinFd_ < 0 || stdoutFd_ < 0) return Json::Value();

    Json::StreamWriterBuilder wb;
    wb["indentation"] = "";
    std::string line = Json::writeString(wb, request) + "\n";

    // write() returns -1/EPIPE if the child is gone; SIGPIPE is suppressed
    // globally (SIG_IGN in main) so we only need to check the return value.
    ssize_t written = write(stdinFd_, line.c_str(), line.size());
    if (written < 0) {
        std::cerr << "[McpStdioClient:" << name_ << "] write failed: "
                  << strerror(errno) << "\n";
        return Json::Value();
    }

    // Check if this is a notification (no id) — no response expected
    if (!request.isMember("id")) return Json::Value(Json::objectValue);

    const Json::Value& expectedId = request["id"];

    // Read lines until we find the response with matching id
    // (skips server-sent notifications that arrive before the response)
    for (int attempts = 0; attempts < 10; ++attempts) {
        std::string responseLine = readLine(15000);
        if (responseLine.empty()) return Json::Value();

        Json::Value parsed;
        Json::CharReaderBuilder rb;
        std::string errs;
        std::istringstream ss(responseLine);
        if (!Json::parseFromStream(rb, ss, &parsed, &errs)) {
            std::cerr << "[McpStdioClient:" << name_ << "] parse error: " << errs << "\n";
            continue;
        }

        // Skip notifications (no id)
        if (!parsed.isMember("id")) continue;

        // Check id matches
        if (parsed["id"] == expectedId) return parsed;

        std::cout << "[McpStdioClient:" << name_ << "] skipping message with id "
                  << parsed["id"].asString() << "\n";
    }

    return Json::Value();
}

#else // _WIN32 stubs

bool McpStdioClient::spawnProcess() { return false; }
std::string McpStdioClient::readLine(int) { return ""; }
void McpStdioClient::closePipes() {}
Json::Value McpStdioClient::sendRequest(const Json::Value&) { return Json::Value(); }

#endif