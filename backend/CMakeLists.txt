cmake_minimum_required(VERSION 3.16)
project(ctrlpanel_backend CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find dependencies
find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)
pkg_check_modules(LIBCURL REQUIRED libcurl)
pkg_check_modules(OPENSSL REQUIRED openssl)

# Find Python for the embedder script
find_package(Python3 REQUIRED COMPONENTS Interpreter)

# Include directories
include_directories(${JSONCPP_INCLUDE_DIRS})
include_directories(${LIBCURL_INCLUDE_DIRS})
include_directories(${OPENSSL_INCLUDE_DIRS})
include_directories(${CMAKE_SOURCE_DIR}/include)
include_directories(${CMAKE_SOURCE_DIR}/src)

# httplib is header-only, just include the path
set(HTTPLIB_DIR "${CMAKE_SOURCE_DIR}/third_party/httplib")
include_directories(${HTTPLIB_DIR})

# Define output paths for the generated headers and cpp files
set(EMBED_H "${CMAKE_BINARY_DIR}/embedded_frontend.h")
set(EMBED_CPP "${CMAKE_BINARY_DIR}/embedded_frontend.cpp")

# Glob the frontend directory so cmake knows to re-run if files are added or changed
file(GLOB_RECURSE FRONTEND_FILES "${CMAKE_SOURCE_DIR}/../ctrlpanel/*")

# Custom command to run the python embedder at build time
add_custom_command(
    OUTPUT ${EMBED_H} ${EMBED_CPP}
    COMMAND Python3::Interpreter "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py" "${CMAKE_SOURCE_DIR}/../ctrlpanel" "${EMBED_H}" "${EMBED_CPP}"
    DEPENDS "${CMAKE_SOURCE_DIR}/scripts/embed_frontend.py" ${FRONTEND_FILES}
    COMMENT "Embedding frontend files into standalone binary..."
)

include_directories("${CMAKE_BINARY_DIR}")

# Source files
set(SOURCES
    src/main.cpp
    src/utils/encryption.cpp
    src/services/openrouter_service.cpp
    src/controllers/auth_controller.cpp
    src/controllers/openrouter_controller.cpp
    src/controllers/config_controller.cpp
    ${EMBED_CPP}
)

# 1. Standard Linux/Native Binary Target
add_executable(ctrlpanel_backend ${SOURCES})
target_link_libraries(ctrlpanel_backend
    ${JSONCPP_LIBRARIES}
    ${LIBCURL_LIBRARIES}
    ${OPENSSL_LIBRARIES}
    pthread
)

# 2. Windows .exe Target
add_executable(ctrlpanel_backend_exe ${SOURCES})
set_target_properties(ctrlpanel_backend_exe PROPERTIES 
    OUTPUT_NAME "ctrlpanel_backend" 
    SUFFIX ".exe"
)
target_link_libraries(ctrlpanel_backend_exe
    ${JSONCPP_LIBRARIES}
    ${LIBCURL_LIBRARIES}
    ${OPENSSL_LIBRARIES}
    pthread
)

# Install targets
install(TARGETS ctrlpanel_backend ctrlpanel_backend_exe DESTINATION bin)