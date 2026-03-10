cmake_minimum_required(VERSION 3.16)
project(ctrlpanel_backend CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)
pkg_check_modules(LIBCURL REQUIRED libcurl)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

include_directories(${JSONCPP_INCLUDE_DIRS})
include_directories(${LIBCURL_INCLUDE_DIRS})
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
    src/services/mcp_service.cpp          # MCP server — built-in tools
    src/services/mcp_client.cpp           # HTTP transport client
    src/services/mcp_stdio_client.cpp     # Stdio transport client (subprocess)
    src/services/mcp_registry.cpp         # Multi-server registry, parses mcp.json

    # Controllers
    src/controllers/lmstudio_controller.cpp
    src/controllers/config_controller.cpp
    src/controllers/chat_controller.cpp
    src/controllers/mcp_controller.cpp

    ${EMBED_CPP}
)

# ── Linux binary ──────────────────────────────────────────────────────────────
add_executable(ctrlpanel_backend ${SOURCES})
target_link_libraries(ctrlpanel_backend
    ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

# ── Windows .exe binary ───────────────────────────────────────────────────────
add_executable(ctrlpanel_backend_exe ${SOURCES})
set_target_properties(ctrlpanel_backend_exe PROPERTIES
    OUTPUT_NAME "ctrlpanel_backend" SUFFIX ".exe")
target_link_libraries(ctrlpanel_backend_exe
    ${JSONCPP_LIBRARIES} ${LIBCURL_LIBRARIES} pthread)

install(TARGETS ctrlpanel_backend ctrlpanel_backend_exe DESTINATION bin)