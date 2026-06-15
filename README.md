# Control Panel
A highly personal web interface to give me the information and tools I need all in 1 place

## Features
- Password-gated local web UI with encrypted stored chat data and bearer-authenticated APIs
- AI chat harness with threaded chats, background task streaming, exact context metering, inline tool-call rendering, settings, themes, and model management
- Supports LM Studio, built-in `llama-server` backends from llama.cpp, HuggingFace GGUF downloads, and a schema-first tool system with pack discovery, approvals, MCP bridging, and bundled calculator, web-search, file-reading, filesystem, sandboxed CLI, weather, and assistant-workspace packs
- Detailed shipped feature breakdown: [FEATURES.md](FEATURES.md)

## Installation
1. Download the source code
2. Install the requirements listed below
3. Build the app
4. Navigate to `backend/build/` and run the binary there
- Main Linux build: `ctrlpanel`
- Optional ARM build: `ctrlpanel_arm` (only produced when the cross-toolchain is available)
- `ctrlpanel.exe` is also emitted by the current CMake/build setup, but the helper script is Linux-first
5. In your browser, visit http://127.0.0.1:8080/
6. On first launch, create a password, then either point the app at LM Studio or use the built-in llama.cpp / model manager settings

## About
I just wanted a local web interface to do things in.

### AI chat-box
I started this part of the control panel because corporations are greedy, want your data, want you to pay monthly, and make their AI chat-bots and/or harnesses bad to make you think you need the best of the AI models. On-top of this, I'm seeing a concerningly large amount of movement and acceptance towards age verification and digital ID verification, and I personally feel it wouldn't be long until those are applied to even the AI services that you have to use because you are hooked into their AI ecosystem they make just good enough to make you stay.

I just want a place to use AI that is safe, private, and uses the AI to its full potential.

## Requirements
- C++23 compatible compiler
- CMake 3.16+
- Python 3
- pkg-config
- jsoncpp
- libcurl
- sqlite3
- OpenSSL
- Internet access on first configure/build to fetch `httplib.h`, and when building llama.cpp backends to download llama.cpp source

## Building
### Recommended
```bash
cd backend
./scripts/build.sh
```

This builds `build/ctrlpanel`, `build/ctrlpanel.exe`, and, when the aarch64 toolchain plus target OpenSSL libraries are installed, `build/ctrlpanel_arm`.

### Manual CMake
```bash
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build --target ctrlpanel -j$(nproc)
```

### Windows
There is a Windows target in CMake, but the current helper script is Linux-first.

### Mac
There is no maintained macOS build guide yet.

## Configuration

The app creates runtime state next to the binary on first start:

- `data/settings.json`
- `data/mcp.json`
- `data/tooling.json`
- `data/chats/`, `data/models/`, `data/libs/`, `data/logs/`, `data/build-cache/`, `data/web-search/`, and `data/assistant-workspace/`
- `toolpacks/` for system packs and `data/toolpacks/` for user packs

Fresh installs bundle system `calculator`, `websearch`, `file_reader`, `filesystem`, `cli`, `weather`, `local_ecosystem`, and `assistant_workspace` packs in `toolpacks/`, alongside the synthetic internal control-plane pack used for deferred tool discovery and schema loading.
Bundled source packs live under `backend/toolpacks/`, are embedded into the backend binary at build time, and are synced into runtime `toolpacks/` on startup.

The authenticated frontend is restricted to the exact origin `http://127.0.0.1:8080`. Protected `/api/*` and `/mcp` requests are rejected unless `Origin` or `Referer` resolve to that exact frontend base URL. `/health` remains exempt for local startup and smoke checks.

The bundled `websearch` pack stores its crawl/index state under `data/web-search/` and exposes:
- `search_web` for BM25-ranked local web search with snippets and site filters
- `open_result` for opening stored cleaned page text by `doc_id`
- `fetch_url` for robots-aware fetching, indexing, canonicalisation, and deduplication
- `related_results` for graph- and host-based neighbors
- `search_status` for index, queue, and worker health

The bundled `file_reader` pack exposes a `read_file` tool for reading bounded exact-text slices from local text files by path, including document versions, EOL state, and compact line metadata for targeted follow-up edits.
The bundled `filesystem` pack exposes tools for listing directories, rendering bounded directory trees, inspecting/changing the AI tool working directory, and checkpointed file editing with version-guarded range, line, and whole-file operations. New tool sessions start in the configured default AI working directory, which defaults to the user's home directory.
The bundled `cli` pack exposes a sandboxed `run_command` tool rooted at the active AI working directory, with automatic approval prompts for touchy commands such as `rm`, output redirects, metadata changes, destructive git operations, and network-enabled runs.
The bundled `assistant_workspace` pack stores per-chat assistant notes and TODO lists under `data/assistant-workspace/`; it exposes `chat_notes` for durable notes and quick `set_plan` planning, plus `todo_list` for chat-scoped task tracking.

The backend watches `settings.json`, `mcp.json`, `tooling.json`, and tool-pack manifests for changes. The Settings page also polls for external `settings.json` edits so updates show up without restarting the server.

Representative `data/settings.json` keys:

```json
{
    "defaultModel": "",
    "fallbackMaxOutputTokens": 8192,
    "host": "0.0.0.0",
    "port": 8080,
    "lmStudioUrl": "http://localhost:1234",
    "systemPrompt": "You are in an advanced AI harness with access to a deferred internal tool system.",
    "temperature": 0.7,
    "logprobHighlightLow": true,
    "messageTimestamps24Hour": true,
    "aiTitleEnabled": true,
    "aiToolsDefaultWorkingDirectory": "/home/alice",
    "panelLoginRateLimitPerMinute": 5,
    "aiTitleModel": "",
    "aiTitleSystemPrompt": "Describe the chat in 1-3 words. Output only the title text. No quotes. No explanation.",
    "llamacppBackend": "auto",
    "llamacppTag": "b8846",
    "llamacppConcurrentGeneration": true,
    "llamacppMaxConcurrentInstances": 4,
    "llamacppMaxLoadedModels": 2,
    "llamacppIdleTimeoutSeconds": 300
}
```

Additional llama.cpp tuning fields are also stored there and can be changed from the Settings page. The Settings page also exposes full backend lifecycle controls so the server can be restarted or stopped without using a terminal.

## API Endpoints

Unless noted otherwise, protected `/api/*` routes and `/mcp` require `Authorization: Bearer <sessionToken>`. Public exceptions are `GET /health`, `GET /api/auth`, `POST /api/auth/setup`, `POST /api/auth/login`, and `GET /api/auth/validate`.

**General**
- `GET /health` - Check backend health status (public)

**Authentication**
- `GET /api/auth` - Check whether a password has been set up (public)
- `POST /api/auth/setup` - Set up the initial panel password using PBKDF2-HMAC-SHA256 at 600,000 iterations (public, fails if already set up)
- `POST /api/auth/login` - Log in with an existing password and receive a session token (public, rate-limited)
- `POST /api/auth/logout` - Revoke the current session
- `GET /api/auth/validate` - Validate a supplied session token and return whether it is still valid (public)
- `POST /api/auth/reauth` - Verify the panel password again and return a short-lived reauth token for protected settings changes

**Legacy Chat**
- `POST /api/chat` - Legacy non-streaming LM Studio chat endpoint
- `POST /api/chat/token-count` - Count prompt tokens for a prepared message list or prompt/system-prompt combo
- `POST /api/chat/stream` - Legacy streaming chat endpoint
- `POST /api/chat/stop` - Stop an active chat stream
- `POST /api/chat/generate-title` - Generate a title for a chat thread

**Task-Based Generation**
- `POST /api/tasks/generate` - Create an async generation task
- `GET /api/tasks` - List all tasks with their statuses
- `GET /api/tasks/by-chat` - Get the most recent task for a given `chat_id`
- `GET /api/tasks/:id` - Get the status/result for a specific task
- `GET /api/tasks/:id/wait` - Wait for a specific task to complete, then return the result
- `GET /api/tasks/:id/stream` - SSE stream that replays accumulated chunks and continues live generation
- `POST /api/tasks/:id/cancel` - Cancel a pending or running task

**Chats**
- `GET /api/chats` - Get the chat index (`chats` summaries plus `currentChatId` and `pins`) without full thread payloads
- `PUT /api/chats` - Save/merge the chat index metadata and chat summaries
- `GET /api/chats/:id` - Get one full saved chat thread
- `PUT /api/chats/:id` - Save/merge one full chat thread
- `DELETE /api/chats/:id` - Delete one saved chat thread

**Models**
- `GET /api/models` - List available models (LM Studio & local llama.cpp)
- `DELETE /api/models` - Delete a downloaded model from disk (body: `model_id`)
- `GET /api/lmstudio/models` - List models from LM Studio only

**Configuration**
- `GET /api/config/settings` - Get current control panel settings
- `PUT /api/config/settings` - Update control panel settings, with panel-password reauth for `panelLoginRateLimitPerMinute`

**Application Backend**
- `GET /api/app/backend/status` - Get full backend lifecycle state plus managed llama.cpp router status
- `POST /api/app/backend/restart` - Restart the entire backend process after the current response completes
- `POST /api/app/backend/stop` - Stop the entire backend process after the current response completes

**Tools / Harness**
- `GET /api/tools/catalog` - Search the tool catalog for in-scope tool descriptors (`query`, `limit`, `enabled_pack_ids`)
- `GET /api/tools/packs` - List discovered/synthetic tool packs plus executor/sandbox health
- `POST /api/tools/reload` - Reload tool packs after on-disk config changes
- `GET /api/tools/approvals` - List tool approvals (`task_id` optional)
- `POST /api/tools/approvals/:id/approve` - Approve a pending tool action
- `POST /api/tools/approvals/:id/deny` - Deny a pending tool action
- `POST /api/tools/file-edits/rollback` - Restore a filesystem tool edit from a checkpoint descriptor

**llama.cpp Management**
- `GET /api/llamacpp/backend` - Get backend info (available, hardware, active, suggestions)
- `POST /api/llamacpp/backend` - Switch the active llama.cpp backend
- `DELETE /api/llamacpp/backend/:backend` - Remove a built backend runtime from disk (`cpu`, `cuda`, `rocm`, or `vulkan`)
- `POST /api/llamacpp/reload-model` - Reload the managed llama.cpp model/router so config changes apply
- `POST /api/llamacpp/build` - Start building a new backend-specific `llama-server` runtime
- `GET /api/llamacpp/build/status` - Get the status of the current build
- `GET /api/llamacpp/build/log` - Get the latest build log chunk and tail lines (`lines` / `offset` query params supported)
- `POST /api/llamacpp/backend/dismiss` - Dismiss the GPU backend suggestion
- `GET /api/llamacpp/pool/status` - Get managed llama.cpp router status

**HuggingFace Model Hub**
- `GET /api/huggingface/search` - Search HuggingFace for models
- `GET /api/huggingface/model-info` - Get metadata for a specific HuggingFace model (`model_id`)
- `GET /api/huggingface/files` - List GGUF, mmproj, and tokenizer files for a HuggingFace model (`model_id`)
- `POST /api/huggingface/download` - Start an async download of a HuggingFace model
- `GET /api/huggingface/download-status` - Check one download job (`job_id`) or list current known download jobs when omitted
- `POST /api/huggingface/cancel-download` - Cancel an active download
- `POST /api/huggingface/install-tokenizer` - Install tokenizer files into an existing model directory

**MCP (Model Context Protocol)**
- `GET /api/mcp/tools` - List aggregated tools from all live MCP servers
- `POST /api/mcp/reload` - Reload `data/mcp.json` configuration
- `POST /mcp` - Dispatch a JSON-RPC 2.0 request to an MCP server
- `GET /mcp` - MCP Server-Sent Events (SSE) channel stub

## Attribution

This project uses icons from [Lucide](https://lucide.dev/), a clean & consistent icon toolkit made by the Lucide community. Thank you to the Lucide team and contributors for providing high-quality, open-source icons that enhance the user interface.

## AI Usage
I do use AI heavily on this project to program.

This does not mean that design choices are dictated by the AI models. This means I'm the one fine tuning and deciding on the UI aspects. If something with the UI is like that, it's either a bug or because I wanted it like that.

I personally care about the result than the code itself. This does not mean I like unoptimised slop. If something doesn't work, that's bad. If something does work, that's good. If a function is optimised to levels that are good, I do not care if it was or wasn't written by AI, I care that it exists. If it works, it works. If it works well, it works well. This is a personal project. I'm not forcing you to use it.
