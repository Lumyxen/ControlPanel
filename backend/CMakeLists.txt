cmake_minimum_required(VERSION 3.16)

project(ctrlpanel CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Mac ARM (Apple Silicon) support
if(APPLE)
    set(CMAKE_OSX_ARCHITECTURES "x86_64;arm64" CACHE STRING "Build architectures for Mac OS X" FORCE)
endif()

include(FetchContent)

# ── Detect cross-compilation ──────────────────────────────────────────────────
# When using the aarch64 toolchain file, CMAKE_CROSSCOMPILING will be TRUE
if(CMAKE_CROSSCOMPILING)
    message(STATUS "Cross-compiling for ${CMAKE_SYSTEM_PROCESSOR} — using FetchContent for deps")

    set(BUILD_SHARED_LIBS OFF)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(JSONCPP_WITH_TESTS OFF CACHE BOOL "" FORCE)
    set(JSONCPP_WITH_POST_BUILD_UNITTEST OFF CACHE BOOL "" FORCE)

    FetchContent_Declare(
        jsoncpp
        GIT_REPOSITORY https://github.com/open-source-parsers/jsoncpp.git
        GIT_TAG        1.9.6
    )
    FetchContent_MakeAvailable(jsoncpp)

    # Disable pkg-config so curl can't find host x86 libs
    set(PKG_CONFIG_EXECUTABLE "pkg-config-notfound" CACHE FILEPATH "" FORCE)

    set(BUILD_CURL_EXE      OFF CACHE BOOL "" FORCE)
    set(CURL_USE_OPENSSL    OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBPSL     OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBSSH2    OFF CACHE BOOL "" FORCE)
    set(USE_LIBIDN2         OFF CACHE BOOL "" FORCE)
    set(USE_NGHTTP2         OFF CACHE BOOL "" FORCE)
    set(USE_NGHTTP3         OFF CACHE BOOL "" FORCE)
    set(USE_QUICHE          OFF CACHE BOOL "" FORCE)
    set(USE_NGTCP2          OFF CACHE BOOL "" FORCE)
    set(CURL_ZLIB           OFF CACHE BOOL "" FORCE)
    set(CURL_BROTLI         OFF CACHE BOOL "" FORCE)
    set(CURL_ZSTD           OFF CACHE BOOL "" FORCE)
    set(ENABLE_UNIX_SOCKETS OFF CACHE BOOL "" FORCE)
    set(CURL_CA_BUNDLE      "none" CACHE STRING "" FORCE)
    set(CURL_CA_PATH        "none" CACHE STRING "" FORCE)
    FetchContent_Declare(
        curl
        GIT_REPOSITORY https://github.com/curl/curl.git
        GIT_TAG        curl-8_11_0
    )
    FetchContent_MakeAvailable(curl)

    # ── llama.cpp (ARM cross-compile) ─────────────────────────────────────────
    option(ENABLE_LLAMACPP "Enable llama.cpp local inference" ON)

    if(ENABLE_LLAMACPP)
        message(STATUS "llama.cpp: enabled for ARM cross-compile")

        set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
        set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)

        # CPU only — NEON will be auto-detected for aarch64
        set(GGML_CUDA    OFF CACHE BOOL "" FORCE)
        set(GGML_METAL   OFF CACHE BOOL "" FORCE)
        set(GGML_VULKAN  OFF CACHE BOOL "" FORCE)
        set(GGML_OPENCL  OFF CACHE BOOL "" FORCE)
        set(GGML_SYCL    OFF CACHE BOOL "" FORCE)
        set(GGML_HIPBLAS OFF CACHE BOOL "" FORCE)
        # Disable OpenMP to avoid libgomp.so runtime dependency
        set(GGML_OPENMP  OFF CACHE BOOL "" FORCE)

        FetchContent_Declare(
            llama_cpp
            GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
            GIT_TAG        b8252
            GIT_SHALLOW    TRUE
        )
        FetchContent_MakeAvailable(llama_cpp)
    else()
        message(STATUS "llama.cpp: disabled (ENABLE_LLAMACPP=OFF)")
    endif()

else()
    # Native build — use system libs as before
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(JSONCPP REQUIRED jsoncpp)
    pkg_check_modules(LIBCURL REQUIRED libcurl)

    # ── llama.cpp (native Linux only, optional) ───────────────────────────────
    option(ENABLE_LLAMACPP "Enable llama.cpp local inference" ON)

    if(ENABLE_LLAMACPP)
        message(STATUS "llama.cpp: enabled — fetching via FetchContent")

        set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
        set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)

        # Force CPU-only build — no CUDA, Metal, Vulkan, etc.
        set(GGML_CUDA    OFF CACHE BOOL "" FORCE)
        set(GGML_METAL   OFF CACHE BOOL "" FORCE)
        set(GGML_VULKAN  OFF CACHE BOOL "" FORCE)
        set(GGML_OPENCL  OFF CACHE BOOL "" FORCE)
        set(GGML_SYCL    OFF CACHE BOOL "" FORCE)
        set(GGML_HIPBLAS OFF CACHE BOOL "" FORCE)
        # Disable OpenMP to avoid libgomp.so runtime dependency
        set(GGML_OPENMP  OFF CACHE BOOL "" FORCE)

        FetchContent_Declare(
            llama_cpp
            GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
            GIT_TAG        b8277
            GIT_SHALLOW    TRUE
        )
        FetchContent_MakeAvailable(llama_cpp)
    else()
        message(STATUS "llama.cpp: disabled (ENABLE_LLAMACPP=OFF)")
    endif()
endif()

find_package(Python3 REQUIRED COMPONENTS Interpreter)

include_directories(${CMAKE_SOURCE_DIR}/include)
include_directories(${CMAKE_SOURCE_DIR}/src)

set(HTTPLIB_DIR "${CMAKE_SOURCE_DIR}/third_party/httplib")
include_directories(${HTTPLIB_DIR})

set(EMBED_H   "${CMAKE_BINARY_DIR}/embedded_frontend.h")
set(EMBED_CPP "${CMAKE_BINARY_DIR}/embedded_frontend.cpp")

file(GLOB_RECURSE FRONTEND_FILES "${CMAKE_SOURCE_DIR}/../ctrlpanel/*")
add_custom_command(
    OUTPUT ${EMBED_H} ${EMBED_CPP}
    COMMAND Python3::Interpreter
            "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py"
            "${CMAKE_SOURCE_DIR}/../ctrlpanel" "${EMBED_H}" "${EMBED_CPP}"
    DEPENDS "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py" ${FRONTEND_FILES}
    COMMENT "Embedding frontend files into standalone binary..."
)
include_directories("${CMAKE_BINARY_DIR}")

set(SOURCES
    src/main.cpp

    # Services
    src/services/lmstudio_service.cpp
    src/services/llamacpp_service.cpp
    src/services/mcp_service.cpp
    src/services/mcp_client.cpp
    src/services/mcp_stdio_client.cpp
    src/services/mcp_registry.cpp

    # Controllers
    src/controllers/lmstudio_controller.cpp
    src/controllers/config_controller.cpp
    src/controllers/chat_controller.cpp
    src/controllers/mcp_controller.cpp

    ${EMBED_CPP}
)

if(CMAKE_CROSSCOMPILING)
    # ── ARM binary only ───────────────────────────────────────────────────────
    add_executable(ctrlpanel_arm ${SOURCES})
    target_include_directories(ctrlpanel_arm PRIVATE
        "${jsoncpp_SOURCE_DIR}/include"
        "${curl_SOURCE_DIR}/include"
    )
    target_link_libraries(ctrlpanel_arm
        jsoncpp_static libcurl pthread)

    if(ENABLE_LLAMACPP)
        target_include_directories(ctrlpanel_arm PRIVATE
            ${llama_cpp_SOURCE_DIR}
            ${llama_cpp_SOURCE_DIR}/include
            ${llama_cpp_SOURCE_DIR}/ggml/include
        )
        target_link_libraries(ctrlpanel_arm llama)
        target_compile_definitions(ctrlpanel_arm PRIVATE LLAMA_CPP_AVAILABLE)
    endif()

    install(TARGETS ctrlpanel_arm DESTINATION bin)

else()
    # ── Linux binary ──────────────────────────────────────────────────────────
    include_directories(${JSONCPP_INCLUDE_DIRS})
    include_directories(${LIBCURL_INCLUDE_DIRS})

    add_executable(ctrlpanel ${SOURCES})
    target_link_libraries(ctrlpanel
        ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

    if(ENABLE_LLAMACPP)
        # llama.cpp may place llama.h under include/ (newer) or root (older)
        target_include_directories(ctrlpanel PRIVATE
            ${llama_cpp_SOURCE_DIR}
            ${llama_cpp_SOURCE_DIR}/include
            ${llama_cpp_SOURCE_DIR}/ggml/include
        )
        target_link_libraries(ctrlpanel llama)
        target_compile_definitions(ctrlpanel PRIVATE LLAMA_CPP_AVAILABLE)
    endif()

    # ── Windows .exe binary ───────────────────────────────────────────────────
    # llama.cpp is Linux-only for now; Windows support can be added later.
    add_executable(ctrlpanel_exe ${SOURCES})
    set_target_properties(ctrlpanel_exe PROPERTIES
        OUTPUT_NAME "ctrlpanel" SUFFIX ".exe")
    target_link_libraries(ctrlpanel_exe
        ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

    install(TARGETS ctrlpanel ctrlpanel_exe DESTINATION bin)
endif()