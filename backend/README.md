# Control Panel Backend

A C++23 backend server for the control panel with OpenRouter API integration.

## Requirements

- C++23 compatible compiler
- CMake 3.16+
- jsoncpp
- libcurl
- OpenSSL
- Git (for downloading httplib)

## Setup & Building

```bash
# Run setup script to download httplib
cd backend
chmod +x scripts/setup.sh
./scripts/setup.sh

# Create build directory
mkdir build && cd build

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
    "openRouterApiKey": "your-encrypted-api-key",
    "encryptionKey": "your-32-byte-key",
    "port": 8080,
    "host": "0.0.0.0"
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

 ## Certificate Troubleshooting

If you see SSL certificate warnings in your browser, the mkcert CA needs to be installed.

### Quick Fix

```bash
# Install certutil if not present
sudo apt install libnss3-tools  # Debian/Ubuntu
sudo pacman -S nss              # Arch

# Run the installation script
./scripts/install-mkcert-ca.sh

# For system-wide trust (requires sudo)
sudo ./scripts/install-mkcert-ca.sh
```

### Manual Installation

1. **Find the CA root:**
   ```bash
   mkcert -CAROOT  # Shows location, e.g., /home/user/.local/share/mkcert
   ```

2. **Install into browser (Chrome/Chromium/Firefox):**
   ```bash
   certutil -A -n "mkcert development CA" -t "C,," -i ~/.local/share/mkcert/rootCA.pem -d sql:$HOME/.pki/nssdb
   ```

3. **Install system-wide (requires sudo):**
   ```bash
   # Debian/Ubuntu
   sudo cp ~/.local/share/mkcert/rootCA.pem /usr/local/share/ca-certificates/mkcert-rootCA.crt
   sudo update-ca-certificates

   # Fedora/RHEL/CentOS
   sudo cp ~/.local/share/mkcert/rootCA.pem /etc/pki/ca-trust/source/anchors/mkcert-rootCA.crt
   sudo update-ca-trust extract
   ```

4. **Restart your browser** after installation

### Verify Installation

```bash
# Check if CA is in NSS database
certutil -L -d sql:$HOME/.pki/nssdb | grep mkcert

# Verify certificate
openssl verify -CAfile ~/.local/share/mkcert/rootCA.pem certs/localhost+2.pem
```

## Available Models

- `stepfun/step-3.5-flash:free` (256K context)
- `arcee-ai/trinity-large-preview:free` (131K context)
- `upstage/solar-pro-3:free` (128K context)
- `liquid/lfm-2.5-1.2b-thinking:free` (32K context)
- `nvidia/nemotron-3-nano-30b-a3b:free` (256K context)
