# Control Panel Backend

A C++23 backend server for the control panel with OpenRouter API integration.

## Requirements

- C++23 compatible compiler
- CMake 3.16+
- jsoncpp
- libcurl
- OpenSSL

## Building
(Linux)
```bash
# Create build directory
mkdir -p build
cd backend/build/

# Configure
cmake ..

# Build
make -j$(nproc)

# Run
./ctrlpanel_backend
```

## Configuration

Edit `config.json` with your settings:

```json
{
    "port": 1024,
    "frontendPort": 1025,
    "host": "0.0.0.0",
    "frontendDir": "../../ctrlpanel"
}
```

## API Endpoints

- `GET /api/auth/verify` - Verify API key
- `POST /api/openrouter/chat` - Send chat message
- `GET /api/openrouter/streaming` - Streaming chat
- `GET /api/openrouter/models` - List available models
- `GET /api/openrouter/pricing` - Get pricing info
- `GET /api/config/prompt-templates` - Get prompt templates
- `POST /api/config/prompt-templates` - Create prompt template
- `PUT /api/config/prompt-templates/{id}` - Update prompt template
- `DELETE /api/config/prompt-templates/{id}` - Delete prompt template
- `GET /api/config/settings` - Get settings
- `PUT /api/config/settings` - Update settings
