cmake_minimum_required(VERSION 3.16)
project(ctrlpanel_backend CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find dependencies
find_package(PkgConfig REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp)
pkg_check_modules(LIBCURL REQUIRED libcurl)
pkg_check_modules(OPENSSL REQUIRED openssl)

# Include directories
include_directories(${JSONCPP_INCLUDE_DIRS})
include_directories(${LIBCURL_INCLUDE_DIRS})
include_directories(${OPENSSL_INCLUDE_DIRS})
include_directories(${CMAKE_SOURCE_DIR}/include)
include_directories(${CMAKE_SOURCE_DIR}/src)

# httplib is header-only, just include the path
set(HTTPLIB_DIR "${CMAKE_SOURCE_DIR}/third_party/httplib")
include_directories(${HTTPLIB_DIR})



# Source files
set(SOURCES
    src/main.cpp
    src/config/config.h
    src/utils/encryption.cpp
    src/services/openrouter_service.cpp
    src/controllers/auth_controller.cpp
    src/controllers/openrouter_controller.cpp
    src/controllers/config_controller.cpp
)

# Create executable
add_executable(ctrlpanel_backend ${SOURCES})

# Link libraries
target_link_libraries(ctrlpanel_backend
    ${JSONCPP_LIBRARIES}
    ${LIBCURL_LIBRARIES}
    ${OPENSSL_LIBRARIES}
    pthread
)

# Create a copy of the binary with a .exe extension alongside the original
if(NOT CMAKE_EXECUTABLE_SUFFIX STREQUAL ".exe")
    add_custom_command(TARGET ctrlpanel_backend POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:ctrlpanel_backend>
        $<TARGET_FILE_DIR:ctrlpanel_backend>/ctrlpanel_backend.exe
        COMMENT "Creating .exe copy of the executable"
    )
endif()

# Install target
install(TARGETS ctrlpanel_backend DESTINATION bin)