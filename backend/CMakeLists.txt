# backend/CMakeLists.txt
cmake_minimum_required(VERSION 3.16)
project(ctrlpanel CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE)
    set(CMAKE_OSX_ARCHITECTURES "x86_64;arm64" CACHE STRING "" FORCE)
endif()

include(FetchContent)

# =============================================================================
# Dependencies
# =============================================================================

if(CMAKE_CROSSCOMPILING)
    message(STATUS "Cross-compiling for ${CMAKE_SYSTEM_PROCESSOR}")
    set(BUILD_SHARED_LIBS OFF)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(JSONCPP_WITH_TESTS OFF CACHE BOOL "" FORCE)
    set(JSONCPP_WITH_POST_BUILD_UNITTEST OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(jsoncpp 
        DOWNLOAD_EXTRACT_TIMESTAMP true
        URL https://github.com/open-source-parsers/jsoncpp/archive/1.9.6.tar.gz
    )
    FetchContent_MakeAvailable(jsoncpp)

    set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
    set(CURL_USE_OPENSSL OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBPSL OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBSSH2 OFF CACHE BOOL "" FORCE)
    set(USE_LIBIDN2 OFF CACHE BOOL "" FORCE)
    set(USE_NGHTTP2 OFF CACHE BOOL "" FORCE)
    set(USE_NGHTTP3 OFF CACHE BOOL "" FORCE)
    set(USE_QUICHE OFF CACHE BOOL "" FORCE)
    set(USE_NGTCP2 OFF CACHE BOOL "" FORCE)
    set(CURL_ZLIB OFF CACHE BOOL "" FORCE)
    set(CURL_BROTLI OFF CACHE BOOL "" FORCE)
    set(CURL_ZSTD OFF CACHE BOOL "" FORCE)
    set(ENABLE_UNIX_SOCKETS OFF CACHE BOOL "" FORCE)
    set(CURL_CA_BUNDLE "none" CACHE STRING "" FORCE)
    set(CURL_CA_PATH "none" CACHE STRING "" FORCE)
    FetchContent_Declare(curl 
        DOWNLOAD_EXTRACT_TIMESTAMP true
        URL https://github.com/curl/curl/archive/curl-8_11_0.tar.gz
    )
    FetchContent_MakeAvailable(curl)

    # OpenSSL for CryptoService (target architecture)
    # Prefer target-arch library paths; headers can come from either target
    # sysroot include or generic /usr/include (headers are arch-independent).
    find_path(OPENSSL_INCLUDE_DIR
        NAMES openssl/evp.h
        PATHS
            /usr/aarch64-linux-gnu/include
            /usr/include
    )
    find_library(OPENSSL_SSL_LIBRARY
        NAMES ssl libssl
        PATHS
            /usr/aarch64-linux-gnu/lib
            /usr/lib/aarch64-linux-gnu
        NO_DEFAULT_PATH
    )
    find_library(OPENSSL_CRYPTO_LIBRARY
        NAMES crypto libcrypto
        PATHS
            /usr/aarch64-linux-gnu/lib
            /usr/lib/aarch64-linux-gnu
        NO_DEFAULT_PATH
    )

    if(NOT OPENSSL_INCLUDE_DIR OR NOT OPENSSL_SSL_LIBRARY OR NOT OPENSSL_CRYPTO_LIBRARY)
        message(FATAL_ERROR
            "OpenSSL for aarch64 was not found. Install target OpenSSL dev packages "
            "(for example: libssl-dev-arm64-cross or libssl-dev:arm64), then retry.")
    endif()
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(JSONCPP REQUIRED jsoncpp)
    pkg_check_modules(LIBCURL REQUIRED libcurl)
endif()

# =============================================================================
# Embed frontend
# =============================================================================

find_package(Python3 REQUIRED COMPONENTS Interpreter)

# Fetch cpp-httplib if the directory is empty/stripped
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/third_party/httplib/httplib.h")
    message(STATUS "httplib.h not found in third_party, downloading cpp-httplib v0.38.0...")
    file(MAKE_DIRECTORY "${CMAKE_SOURCE_DIR}/third_party/httplib")
    file(DOWNLOAD "https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.38.0/httplib.h"
         "${CMAKE_SOURCE_DIR}/third_party/httplib/httplib.h"
         STATUS DOWNLOAD_STATUS)
    list(GET DOWNLOAD_STATUS 0 DOWNLOAD_CODE)
    if(NOT DOWNLOAD_CODE EQUAL 0)
        message(FATAL_ERROR "Failed to download httplib.h: ${DOWNLOAD_STATUS}")
    endif()
endif()

include_directories(${CMAKE_SOURCE_DIR}/include)
include_directories(${CMAKE_SOURCE_DIR}/src)
include_directories("${CMAKE_SOURCE_DIR}/third_party/httplib")
include_directories("${CMAKE_BINARY_DIR}/_deps/llama_cpp_headers-src/include")
include_directories("${CMAKE_BINARY_DIR}/_deps/llama_cpp_headers-src/ggml/include")

set(EMBED_H   "${CMAKE_BINARY_DIR}/embedded_frontend.h")
set(EMBED_CPP "${CMAKE_BINARY_DIR}/embedded_frontend.cpp")
file(GLOB_RECURSE FRONTEND_FILES "${CMAKE_SOURCE_DIR}/../www/*")
add_custom_command(
    OUTPUT ${EMBED_H} ${EMBED_CPP}
    COMMAND Python3::Interpreter
            "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py"
            "${CMAKE_SOURCE_DIR}/../www" "${EMBED_H}" "${EMBED_CPP}"
    DEPENDS "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py" ${FRONTEND_FILES}
    COMMENT "Embedding frontend files...")
include_directories("${CMAKE_BINARY_DIR}")
set(TOOLPACKS_SOURCE_DIR "${CMAKE_SOURCE_DIR}/toolpacks")
set(EMBED_TOOLPACKS_H   "${CMAKE_BINARY_DIR}/embedded_toolpacks.h")
set(EMBED_TOOLPACKS_CPP "${CMAKE_BINARY_DIR}/embedded_toolpacks.cpp")
file(GLOB_RECURSE TOOLPACK_FILES CONFIGURE_DEPENDS "${TOOLPACKS_SOURCE_DIR}/*")
add_custom_command(
    OUTPUT ${EMBED_TOOLPACKS_H} ${EMBED_TOOLPACKS_CPP}
    COMMAND Python3::Interpreter
            "${CMAKE_SOURCE_DIR}/scripts/embed_directory.py"
            "${TOOLPACKS_SOURCE_DIR}"
            "${EMBED_TOOLPACKS_H}"
            "${EMBED_TOOLPACKS_CPP}"
            "embedded_toolpacks.h"
            "embedded_toolpack_files"
    DEPENDS "${CMAKE_SOURCE_DIR}/scripts/embed_directory.py" ${TOOLPACK_FILES}
    COMMENT "Embedding tool pack files...")

set(SOURCES
    src/main.cpp
    src/app/server_app.cpp
    src/services/lmstudio_service.cpp
    src/services/llamacpp_service.cpp
    src/services/huggingface_service.cpp
    src/services/backend_builder.cpp
    src/services/mcp_service.cpp
    src/services/mcp_client.cpp
    src/services/mcp_stdio_client.cpp
    src/services/mcp_registry.cpp
    src/services/tools/calculator_tool.cpp
    src/services/tools/tool_argument_validator.cpp
    src/services/tools/tool_system.cpp
    src/services/crypto_service.cpp
    src/server/http_utils.cpp
    src/server/api_routes.cpp
    src/controllers/lmstudio_controller.cpp
    src/controllers/config_controller.cpp
    src/controllers/auth_controller.cpp
    src/controllers/chat_controller.cpp
    src/controllers/mcp_controller.cpp
    src/controllers/generation_task_manager.cpp
    ${EMBED_CPP}
    ${EMBED_TOOLPACKS_CPP}
)

# =============================================================================
# Targets
# =============================================================================

if(CMAKE_CROSSCOMPILING)
    add_executable(ctrlpanel_arm ${SOURCES})
    target_include_directories(ctrlpanel_arm PRIVATE
        "${jsoncpp_SOURCE_DIR}/include"
        "${curl_SOURCE_DIR}/include"
        "${OPENSSL_INCLUDE_DIR}")
    target_link_libraries(ctrlpanel_arm
        jsoncpp_static
        libcurl
        pthread
        dl
        "${OPENSSL_SSL_LIBRARY}"
        "${OPENSSL_CRYPTO_LIBRARY}")
    install(TARGETS ctrlpanel_arm DESTINATION bin)

else()
    include_directories(${JSONCPP_INCLUDE_DIRS})
    include_directories(${LIBCURL_INCLUDE_DIRS})

    # Linux
    add_executable(ctrlpanel ${SOURCES})
    target_link_libraries(ctrlpanel ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread dl ssl crypto)

    # Windows (dl stub is a no-op on Windows; service gracefully reports unavailable)
    add_executable(ctrlpanel_exe ${SOURCES})
    set_target_properties(ctrlpanel_exe PROPERTIES OUTPUT_NAME "ctrlpanel" SUFFIX ".exe")
    target_link_libraries(ctrlpanel_exe ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread dl)
    # Try to link OpenSSL on Windows if available
    find_package(OpenSSL QUIET)
    if(OPENSSL_FOUND)
        target_link_libraries(ctrlpanel_exe OpenSSL::SSL OpenSSL::Crypto)
    endif()

    install(TARGETS ctrlpanel ctrlpanel_exe DESTINATION bin)
endif()
