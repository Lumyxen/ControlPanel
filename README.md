# Control Panel
A highly personal web interface to give me the information and tools I need all in 1 place

## Features
- An optimised and complex AI chat-box/harness to give it the suite of tools it needs, because nobody else seems to be making good AI harnesses.

## Installation
1. Download the source code
2. Ensure you have an LM Studio Server running
3. Build the app (commands down below)
4. Navigate to the build folder `backend/build/` and run the build file
- **Linux**, run `ctrlpanel_backend`
- **Windows**, run `ctrlpanel_backend.exe`
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
    "defaultModel" : "arcee-ai/trinity-large-preview:free",
    "fallbackMaxOutputTokens" : 8192,
    "host" : "0.0.0.0",
    "port" : 1024,
    "systemPrompt" : "",
    "temperature" : 0.69999999999999996
}
```

## API Endpoints
- `GET /api/auth/verify` - Verify API key
- `POST /api/openrouter/chat` - Send chat message
- `GET /api/openrouter/streaming` - Streaming chat
- `GET /api/openrouter/models` - List available models
- `GET /api/openrouter/pricing` - Get pricing info
- `GET /api/config/settings` - Get settings
- `PUT /api/config/settings` - Update settings

## AI Usage
I do use AI heavily on this project to program.

This does not mean that design choices are dictated by the AI models. This means I'm the one fine tuning and deciding on the UI aspects. If something with the UI is like that, it's either a bug or because I wanted it like that.

I personally care about the result than the code itself. This does not mean I like unoptimised slop. If something doesn't work, that's bad. If something does work, that's good. If a function is optimised to levels that are good, I do not care if it was or wasn't written by AI, I care that it exists. If it works, it works. If it works well, it works well. This is a personal project. I'm not forcing you to use it.
