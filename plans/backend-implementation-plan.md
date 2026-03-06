# C++23 Backend Implementation Plan for Control Panel

## Project Overview
This backend will serve as the server and general backend for the control panel, using C++23 with OpenRouter API integration. The system will primarily operate locally with occasional online connections requiring robust security measures. Since this is a single-user system, authentication and user management will be simplified.

## Architecture Summary
- **Language**: C++23 with modern asynchronous patterns
- **Framework**: Drogon (high-performance, coroutine-based)
- **Database**: PostgreSQL with async drivers
- **Authentication**: JWT-based stateless authentication
- **Security**: Encrypted API keys at rest, rate limiting, OpenTelemetry tracing
- **API Integration**: OpenRouter streaming via SSE

## File Structure
```
backend/
├── src/
│   ├── main.cpp                    # Application entry point
│   ├── controllers/                # API endpoint handlers
│   │   ├── auth_controller.cpp    # JWT authentication
│   │   ├── openrouter_controller.cpp # OpenRouter API proxy
│   │   ├── user_controller.cpp    # User management
│   │   └── config_controller.cpp  # Configuration endpoints
│   ├── models/                    # Data models and ORM
│   │   ├── user.cpp              # User model
│   │   ├── api_key.cpp           # Encrypted API key storage
│   │   └── config.cpp            # Configuration model
│   ├── services/                  # Business logic
│   │   ├── openrouter_service.cpp # OpenRouter API client
│   │   ├── auth_service.cpp      # Authentication logic
│   │   └── rate_limiter.cpp      # Rate limiting implementation
│   ├── utils/                     # Utility functions
│   │   ├── encryption.cpp        # Encryption utilities
│   │   ├── logging.cpp           # Structured logging
│   │   └── validation.cpp        # Input validation
│   ├── middleware/                # Request middleware
│   │   ├── auth_middleware.cpp   # JWT validation middleware
│   │   └── rate_limit_middleware.cpp # Rate limiting middleware
│   └── config/                    # Configuration files
│       ├── config.h               # Configuration constants
│       └── database.h             # Database configuration
├── include/
│   ├── controllers/               # Controller headers
│   ├── models/                    # Model headers
│   ├── services/                  # Service headers
│   ├── utils/                     # Utility headers
│   └── middleware/                # Middleware headers
├── tests/                          # Unit and integration tests
│   ├── controllers/
│   ├── services/
│   └── utils/
├── scripts/                        # Build and deployment scripts
│   ├── build.sh                  # Build script
│   ├── setup_database.sh         # Database setup
│   └── deploy.sh                 # Deployment script
├── CMakeLists.txt                  # CMake build configuration
├── .env.example                    # Environment variables template
└── README.md                       # Project documentation
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login with JWT token generation
- `POST /api/auth/refresh` - JWT token refresh
- `POST /api/auth/logout` - User logout

### User Management
- `GET /api/users/me` - Get current user info
- `PUT /api/users/me` - Update user profile
- `GET /api/users/settings` - Get user settings
- `PUT /api/users/settings` - Update user settings

### OpenRouter Integration
- `POST /api/openrouter/chat` - Send chat message to OpenRouter
- `GET /api/openrouter/streaming` - Server-sent events for chat responses
- `GET /api/openrouter/models` - List available models
- `GET /api/openrouter/pricing` - Get pricing information

### Available Models (Free Tier)
- `stepfun/step-3.5-flash:free` - StepFun-3.5 Flash
- `arcee-ai/trinity-large-preview:free` - Arcee AI Trinity Large Preview
- `upstage/solar-pro-3:free` - Upstage Solar Pro 3
- `liquid/lfm-2.5-1.2b-thinking:free` - Liquid LFM 2.5 1.2B Thinking
- `nvidia/nemotron-3-nano-30b-a3b:free` - Nvidia Nemotron 3 Nano 30B A3B

### Configuration
- `GET /api/config/prompt-templates` - Get available prompt templates
- `POST /api/config/prompt-templates` - Create new prompt template
- `PUT /api/config/prompt-templates/{id}` - Update prompt template
- `DELETE /api/config/prompt-templates/{id}` - Delete prompt template

## Security Implementation

### Authentication Flow
1. Single user configuration stored locally
2. API key stored encrypted in configuration file
3. No JWT tokens needed - simple API key validation
4. All endpoints protected by API key verification

### API Key Security
- OpenRouter API key encrypted at rest using libsodium
- Decryption only occurs during API requests
- Key stored in secure configuration file
- Automatic key rotation support

### Rate Limiting
- Token-bucket algorithm per user
- Configurable limits per endpoint
- Redis-backed for distributed consistency
- Exponential backoff for repeated violations

## Database Schema

### Users Table
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### API Keys Table
```sql
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    encrypted_key BYTEA NOT NULL,
    iv BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);
```

### Configurations Table
```sql
CREATE TABLE configurations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    key VARCHAR(255) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## C++23 Features Utilization

### Modern Error Handling
- `std::expected<T, E>` for HTTP client errors
- Structured bindings for tuple returns
- Concepts for type-safe interfaces

### Performance Optimizations
- Coroutines for async I/O
- `std::format` for zero-allocation logging
- `std::mdspan` for potential embedding operations
- Ranges for efficient data transformations

### Memory Management
- Smart pointers (`std::unique_ptr`, `std::shared_ptr`)
- RAII for resource management
- Move semantics for performance

## Build and Deployment

### Dependencies
- Drogon framework
- PostgreSQL client library
- libsodium for encryption
- JWT-CPP for authentication
- Redis client for rate limiting
- OpenTelemetry for observability

### Build Process
```bash
# Install dependencies
./scripts/setup_dependencies.sh

# Configure build
mkdir build && cd build
cmake ..

# Build
make -j$(nproc)

# Run tests
make test

# Deploy
./scripts/deploy.sh
```

## Monitoring and Observability

### Metrics Collection
- Request latency and throughput
- Error rates and types
- OpenRouter API response times
- Database query performance

### Logging Strategy
- Structured JSON logging
- Log levels (DEBUG, INFO, WARN, ERROR)
- Correlation IDs for request tracing
- Asynchronous logging with spdlog

### Health Checks
- `/health` endpoint for basic health
- Database connectivity check
- OpenRouter API connectivity check
- Memory and CPU usage monitoring

## Next Steps
1. Set up development environment with required dependencies
2. Implement database schema and models
3. Create authentication system with JWT
4. Implement OpenRouter API client with streaming support
5. Build API endpoints with proper validation
6. Add comprehensive testing
7. Implement security measures and rate limiting
8. Set up monitoring and logging
9. Performance optimization and load testing
10. Deployment and documentation

## Success Criteria
- All API endpoints functional and tested
- Security measures properly implemented
- Performance meets requirements (sub-100ms response times)
- Comprehensive logging and monitoring in place
- Documentation complete and up-to-date
- Deployment process automated and reliable
