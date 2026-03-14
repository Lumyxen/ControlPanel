# backend/CMakeLists.txt
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
    option(ENABLE_LLAMACPP        "Enable llama.cpp local inference"         ON)
    option(ENABLE_LLAMACPP_VISION "Enable vision/multimodal support (llava)" OFF)

    if(ENABLE_LLAMACPP)
        message(STATUS "llama.cpp: enabled for ARM cross-compile")

        set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)

        set(GGML_CUDA    OFF CACHE BOOL "" FORCE)
        set(GGML_METAL   OFF CACHE BOOL "" FORCE)
        set(GGML_VULKAN  OFF CACHE BOOL "" FORCE)
        set(GGML_OPENCL  OFF CACHE BOOL "" FORCE)
        set(GGML_SYCL    OFF CACHE BOOL "" FORCE)
        set(GGML_HIPBLAS OFF CACHE BOOL "" FORCE)
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
    # ── Native build ──────────────────────────────────────────────────────────
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(JSONCPP REQUIRED jsoncpp)
    pkg_check_modules(LIBCURL REQUIRED libcurl)

    option(ENABLE_LLAMACPP        "Enable llama.cpp local inference"         ON)
    option(ENABLE_LLAMACPP_VISION "Enable vision/multimodal support (llava)" OFF)

    if(ENABLE_LLAMACPP)
        message(STATUS "llama.cpp: enabled — fetching via FetchContent")

        set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)

        set(GGML_CUDA    OFF CACHE BOOL "" FORCE)
        set(GGML_METAL   OFF CACHE BOOL "" FORCE)
        set(GGML_VULKAN  OFF CACHE BOOL "" FORCE)
        set(GGML_OPENCL  OFF CACHE BOOL "" FORCE)
        set(GGML_SYCL    OFF CACHE BOOL "" FORCE)
        set(GGML_HIPBLAS OFF CACHE BOOL "" FORCE)
        set(GGML_OPENMP  OFF CACHE BOOL "" FORCE)

        FetchContent_Declare(
            llama_cpp
            GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
            GIT_TAG        b8337
            GIT_SHALLOW    TRUE
        )
        FetchContent_MakeAvailable(llama_cpp)
    else()
        message(STATUS "llama.cpp: disabled (ENABLE_LLAMACPP=OFF)")
    endif()
endif()

# ── Vision: locate headers and collect sources ────────────────────────────────
if(ENABLE_LLAMACPP AND ENABLE_LLAMACPP_VISION)
    # Locate clip.h
    if(EXISTS "${llama_cpp_SOURCE_DIR}/tools/mtmd/clip.h")
        set(LLAVA_INCLUDE_DIR "${llama_cpp_SOURCE_DIR}/tools/mtmd")
    elseif(EXISTS "${llama_cpp_SOURCE_DIR}/examples/llava/clip.h")
        set(LLAVA_INCLUDE_DIR "${llama_cpp_SOURCE_DIR}/examples/llava")
    else()
        message(FATAL_ERROR
            "ENABLE_LLAMACPP_VISION=ON but clip.h was not found.\n"
            "Searched:\n"
            "  ${llama_cpp_SOURCE_DIR}/tools/mtmd\n"
            "  ${llama_cpp_SOURCE_DIR}/examples/llava")
    endif()
    message(STATUS "Vision: clip.h from ${LLAVA_INCLUDE_DIR}")

    # Locate stb_image.h
    find_file(STB_IMAGE_H stb_image.h
        PATHS
            "${llama_cpp_SOURCE_DIR}/vendor/stb"
            "${llama_cpp_SOURCE_DIR}/common"
            "${llama_cpp_SOURCE_DIR}/ggml/src/ggml-cpu"
            "${llama_cpp_SOURCE_DIR}/thirdparty"
            "${llama_cpp_SOURCE_DIR}/third_party/stb"
        NO_DEFAULT_PATH
    )
    if(STB_IMAGE_H)
        get_filename_component(STB_IMAGE_DIR "${STB_IMAGE_H}" DIRECTORY)
        message(STATUS "Vision: stb_image.h from ${STB_IMAGE_DIR}")
    else()
        file(GLOB_RECURSE STB_IMAGE_CANDIDATES "${llama_cpp_SOURCE_DIR}/*/stb_image.h")
        if(STB_IMAGE_CANDIDATES)
            list(GET STB_IMAGE_CANDIDATES 0 STB_IMAGE_H)
            get_filename_component(STB_IMAGE_DIR "${STB_IMAGE_H}" DIRECTORY)
            message(STATUS "Vision: stb_image.h (fallback search) from ${STB_IMAGE_DIR}")
        else()
            message(FATAL_ERROR "stb_image.h not found in the llama.cpp source tree.")
        endif()
    endif()

    # Collect vision .cpp files, excluding CLI tools and deprecation-warning
    file(GLOB LLAVA_SOURCES_ROOT "${LLAVA_INCLUDE_DIR}/*.cpp")
    file(GLOB LLAVA_SOURCES_MODELS "${LLAVA_INCLUDE_DIR}/models/*.cpp")
    set(LLAVA_SOURCES_ALL ${LLAVA_SOURCES_ROOT} ${LLAVA_SOURCES_MODELS})

    set(LLAVA_SOURCES "")
    foreach(src ${LLAVA_SOURCES_ALL})
        get_filename_component(fname "${src}" NAME)
        if(fname MATCHES ".*-cli\\.cpp$" OR fname STREQUAL "mtmd-helper.cpp" OR fname STREQUAL "deprecation-warning.cpp")
            message(STATUS "Vision: skipping ${fname}")
        else()
            list(APPEND LLAVA_SOURCES "${src}")
            message(STATUS "Vision: including ${fname}")
        endif()
    endforeach()

    # Global includes
    include_directories(${LLAVA_INCLUDE_DIR})
    if(EXISTS "${LLAVA_INCLUDE_DIR}/models")
        include_directories(${LLAVA_INCLUDE_DIR}/models)
    endif()
    include_directories(${STB_IMAGE_DIR})
    include_directories(
        ${llama_cpp_SOURCE_DIR}
        ${llama_cpp_SOURCE_DIR}/include
        ${llama_cpp_SOURCE_DIR}/ggml/include
    )
    
    # Silence the annoying ggml_scale_mode deprecation warnings in clip-graph.h
    add_compile_options(-Wno-deprecated-enum-enum-conversion)
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

if(ENABLE_LLAMACPP AND ENABLE_LLAMACPP_VISION)
    list(APPEND SOURCES ${LLAVA_SOURCES})
endif()

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
        # Link both llama AND ggml
        target_link_libraries(ctrlpanel_arm llama ggml)
        target_compile_definitions(ctrlpanel_arm PRIVATE LLAMA_CPP_AVAILABLE)

        if(ENABLE_LLAMACPP_VISION)
            target_compile_definitions(ctrlpanel_arm PRIVATE LLAMA_CPP_VISION_AVAILABLE)
        endif()
    endif()

    install(TARGETS ctrlpanel_arm DESTINATION bin)

else()
    # ── Linux & Windows native builds ─────────────────────────────────────────
    include_directories(${JSONCPP_INCLUDE_DIRS})
    include_directories(${LIBCURL_INCLUDE_DIRS})

    # Create Linux Binary
    add_executable(ctrlpanel ${SOURCES})
    target_link_libraries(ctrlpanel
        ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

    # Create Windows Binary (compiling locally via dummy .exe extension)
    add_executable(ctrlpanel_exe ${SOURCES})
    set_target_properties(ctrlpanel_exe PROPERTIES
        OUTPUT_NAME "ctrlpanel" SUFFIX ".exe")
    target_link_libraries(ctrlpanel_exe
        ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

    # Setup llama.cpp for BOTH binaries
    if(ENABLE_LLAMACPP)
        # Apply to Linux binary
        target_include_directories(ctrlpanel PRIVATE
            ${llama_cpp_SOURCE_DIR}
            ${llama_cpp_SOURCE_DIR}/include
            ${llama_cpp_SOURCE_DIR}/ggml/include
        )
        # Link both llama AND ggml
        target_link_libraries(ctrlpanel llama ggml)
        target_compile_definitions(ctrlpanel PRIVATE LLAMA_CPP_AVAILABLE)

        # Apply to Windows binary
        target_include_directories(ctrlpanel_exe PRIVATE
            ${llama_cpp_SOURCE_DIR}
            ${llama_cpp_SOURCE_DIR}/include
            ${llama_cpp_SOURCE_DIR}/ggml/include
        )
        # Link both llama AND ggml
        target_link_libraries(ctrlpanel_exe llama ggml)
        target_compile_definitions(ctrlpanel_exe PRIVATE LLAMA_CPP_AVAILABLE)

        # Handle Vision Definitions for both
        if(ENABLE_LLAMACPP_VISION)
            target_compile_definitions(ctrlpanel PRIVATE LLAMA_CPP_VISION_AVAILABLE)
            target_compile_definitions(ctrlpanel_exe PRIVATE LLAMA_CPP_VISION_AVAILABLE)
        endif()
    endif()

    install(TARGETS ctrlpanel ctrlpanel_exe DESTINATION bin)
endif()