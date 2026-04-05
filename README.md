# Control Panel
A highly personal web interface to give me the information and tools I need all in 1 place

## Features
- An optimised and complex AI chat-box/harness to give it the suite of tools it needs, because nobody else seems to be making good AI harnesses.

## Installation
1. Download the source code
2. Ensure you have an LM Studio Server running
3. Build the app (commands down below)
4. Navigate to the build folder `backend/build/` and run the build file
- **Linux x64**, run `ctrlpanel`
- **Linux ARM**, run `ctrlpanel_arm`
- **Windows**, run `ctrlpanel.exe`
5. In your browser, visit http://127.0.0.1:8080/

## About
I just wanted a local web interface to do things in.

### AI chat-box
I started this part of the control panel because corporations are greedy, want your data, want you to pay monthly, and make their AI chat-bots and/or harnesses bad to make you think you need the best of the AI models. On-top of this, I'm seeing a concerningly large amount of movement and acceptance towards age verification and digital ID verification, and I personally feel it wouldn't be long until those are applied to even the AI services that you have to use because you are hooked into their AI ecosystem they make just good enough to make you stay.

I just want a place to use AI that is safe, private, and uses the AI to its full potential.

## Requirements
- C++23 compatible compiler
- CMake 3.16+
- jsoncpp
- libcurl

## Building
### Linux
```bash
# Create build directory
mkdir -p backend/build/
cd backend/build/

# Configure
cmake ..

# Build
make -j$(nproc)
```

### Windows
I don't know man, I don't use Windows. Figure it out yourself.

### Mac
Good luck.

## Configuration

Edit `data/settings.json` with your settings:

```json
{
    "defaultModel" : "lmstudio::llama-3-8b-instruct",
    "fallbackMaxOutputTokens" : 8192,
    "host" : "0.0.0.0",
    "port" : 8080,
    "systemPrompt" : "",
    "temperature" : 0.69999999999999996
}
```

## API Endpoints

**General**
- `GET /health` - Check backend health status

**Chat & Models**
- `POST /api/chat` - Send a non-streaming chat message
- `POST /api/chat/stream` - Send a streaming chat message (SSE)
- `POST /api/chat/stop` - Stop an active chat stream
- `GET /api/models` - List available models (LM Studio & local llama.cpp)
- `GET /api/chats` - Get saved chat history/threads
- `PUT /api/chats` - Save/Update chat history/threads

**Configuration**
- `GET /api/config/settings` - Get current control panel settings
- `PUT /api/config/settings` - Update control panel settings

**llama.cpp Management**
- `GET /api/llamacpp/backend` - Get backend info (available, hardware, active)
- `POST /api/llamacpp/backend` - Switch the active llama.cpp backend
- `POST /api/llamacpp/reload-model` - Unload and reload the model (applies config changes)
- `POST /api/llamacpp/build` - Start building a new backend shared library
- `GET /api/llamacpp/build/status` - Get the status of the current build
- `GET /api/llamacpp/build/log` - Get the latest log lines for the active build
- `POST /api/llamacpp/backend/dismiss` - Dismiss the GPU backend suggestion

**MCP (Model Context Protocol)**
- `GET /api/mcp/tools` - List aggregated tools from all live MCP servers
- `POST /api/mcp/reload` - Reload `mcp.json` configuration
- `POST /mcp` - Dispatch a JSON-RPC 2.0 request to an MCP server
- `GET /mcp` - MCP Server-Sent Events (SSE) channel stub

## Attribution

This project uses icons from [Lucide](https://lucide.dev/), a clean & consistent icon toolkit made by the Lucide community. Thank you to the Lucide team and contributors for providing high-quality, open-source icons that enhance the user interface.

## AI Usage
I do use AI heavily on this project to program.

This does not mean that design choices are dictated by the AI models. This means I'm the one fine tuning and deciding on the UI aspects. If something with the UI is like that, it's either a bug or because I wanted it like that.

I personally care about the result than the code itself. This does not mean I like unoptimised slop. If something doesn't work, that's bad. If something does work, that's good. If a function is optimised to levels that are good, I do not care if it was or wasn't written by AI, I care that it exists. If it works, it works. If it works well, it works well. This is a personal project. I'm not forcing you to use it.