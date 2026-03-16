// backend/src/services/backend_builder.cpp
#include "services/backend_builder.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <cstdlib>

#ifndef _WIN32
#include <unistd.h>
#endif

namespace fs = std::filesystem;

static const char* CMAKE_TEMPLATE = R"CMAKE(
cmake_minimum_required(VERSION 3.18)
project(llama_backend_build CXX C)
include(FetchContent)

set(BUILD_SHARED_LIBS    ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GGML_METAL           OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL          OFF CACHE BOOL "" FORCE)
set(GGML_SYCL            OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)

# Set RPATH natively via CMake and disable versioned SO suffixes (.so.0)
# This completely prevents needing external tools like patchelf or chrpath.
set(CMAKE_BUILD_WITH_INSTALL_RPATH TRUE CACHE BOOL "" FORCE)
set(CMAKE_INSTALL_RPATH "$ORIGIN" CACHE STRING "" FORCE)
set(CMAKE_PLATFORM_NO_VERSIONED_SONAME ON CACHE BOOL "" FORCE)

@BACKEND_FLAGS@

FetchContent_Declare(llama_cpp
    GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
    GIT_TAG        @LLAMA_TAG@
    GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(llama_cpp)
)CMAKE";

static std::string strReplace(std::string s, const std::string& from, const std::string& to) {
    size_t pos = s.find(from);
    if (pos != std::string::npos) s.replace(pos, from.size(), to);
    return s;
}

static int runCmd(const std::string& cmd, const std::string& logPath) {
    return system((cmd + " >> \"" + logPath + "\" 2>&1").c_str());
}

static bool hasCommand(const std::string& cmd) {
#ifdef _WIN32
    return system(("where " + cmd + " > NUL 2>&1").c_str()) == 0;
#else
    return system(("command -v " + cmd + " > /dev/null 2>&1").c_str()) == 0;
#endif
}

std::string BackendBuilder::findRocmClang() {
#ifndef _WIN32
    for (const char* c : {"/opt/rocm/llvm/bin/clang", "/opt/rocm/bin/clang"}) {
        if (access(c, X_OK) == 0) return c;
    }
#endif
    if (hasCommand("clang")) return "clang";
    return "";
}

std::string BackendBuilder::checkPrerequisites(const std::string& backend) {
    if (!hasCommand("cmake"))
        return "cmake not found";
    if (!hasCommand("git"))
        return "git not found — required for FetchContent";
    if (backend == "cuda") {
        if (!hasCommand("nvcc"))
            return "nvcc not found — install the NVIDIA CUDA toolkit";
    } else if (backend == "rocm") {
#ifndef _WIN32
        if (!hasCommand("hipcc"))
            return "hipcc not found — install ROCm";
#endif
        if (findRocmClang().empty())
            return "clang not found — install /opt/rocm/llvm or system clang";
    } else if (backend == "vulkan") {
        if (!hasCommand("glslc") && !hasCommand("glslangValidator"))
            return "glslc / glslangValidator not found — install Vulkan SDK";
    } else if (backend != "cpu") {
        return "Unknown backend: " + backend;
    }
    return "";
}

std::string BackendBuilder::cmakeArgs(const std::string& backend) {
    if (backend == "cuda")   return "-DGGML_CUDA=ON -DGGML_HIPBLAS=OFF -DGGML_VULKAN=OFF";
    if (backend == "rocm")   return "-DGGML_HIPBLAS=ON -DGGML_CUDA=OFF -DGGML_VULKAN=OFF";
    if (backend == "vulkan") return "-DGGML_VULKAN=ON -DGGML_CUDA=OFF -DGGML_HIPBLAS=OFF";
    return "-DGGML_CUDA=OFF -DGGML_HIPBLAS=OFF -DGGML_VULKAN=OFF";
}

std::string BackendBuilder::compilerEnv(const std::string& backend) {
    if (backend != "rocm") return "";
    const std::string clang = findRocmClang();
    return clang.empty() ? "" : " -DCMAKE_CXX_COMPILER=hipcc -DCMAKE_C_COMPILER=" + clang;
}

std::string BackendBuilder::writeCMakeLists(const std::string& buildDir,
                                             const std::string& backend,
                                             const std::string& llamaTag) {
    std::string flags;
    if (backend == "cuda")
        flags = "set(GGML_CUDA    ON  CACHE BOOL \"\" FORCE)\n"
                "set(GGML_HIPBLAS OFF CACHE BOOL \"\" FORCE)\n"
                "set(GGML_VULKAN  OFF CACHE BOOL \"\" FORCE)";
    else if (backend == "rocm")
        flags = "set(GGML_HIPBLAS ON  CACHE BOOL \"\" FORCE)\n"
                "set(GGML_CUDA    OFF CACHE BOOL \"\" FORCE)\n"
                "set(GGML_VULKAN  OFF CACHE BOOL \"\" FORCE)";
    else if (backend == "vulkan")
        flags = "set(GGML_VULKAN  ON  CACHE BOOL \"\" FORCE)\n"
                "set(GGML_CUDA    OFF CACHE BOOL \"\" FORCE)\n"
                "set(GGML_HIPBLAS OFF CACHE BOOL \"\" FORCE)";
    else
        flags = "set(GGML_CUDA    OFF CACHE BOOL \"\" FORCE)\n"
                "set(GGML_HIPBLAS OFF CACHE BOOL \"\" FORCE)\n"
                "set(GGML_VULKAN  OFF CACHE BOOL \"\" FORCE)";

    std::string content = strReplace(strReplace(CMAKE_TEMPLATE, "@LLAMA_TAG@", llamaTag),
                                     "@BACKEND_FLAGS@", flags);
    const std::string path = (fs::path(buildDir) / "CMakeLists.txt").string();
    std::ofstream f(path);
    if (!f.is_open()) return "";
    f << content;
    return path;
}

int BackendBuilder::build(const std::string& backend,
                           const std::string& libsDir,
                           const std::string& buildCacheDir,
                           const std::string& logPath,
                           const std::string& llamaTag) {

    const std::string prereqErr = checkPrerequisites(backend);
    if (!prereqErr.empty()) {
        std::ofstream log(logPath, std::ios::trunc);
        log << "[BackendBuilder] Prerequisite failed: " << prereqErr << "\n";
        std::cerr << "[BackendBuilder] " << prereqErr << "\n";
        return 1;
    }

    const fs::path srcDir   = fs::path(buildCacheDir) / backend;
    const fs::path cmakeBin = srcDir / "cmake_build";
    const fs::path outDir   = fs::path(libsDir);

    fs::create_directories(srcDir);
    fs::create_directories(outDir);

    {
        std::ofstream log(logPath, std::ios::trunc);
        log << "==============================\n"
            << "[BackendBuilder] Building : " << backend << "\n"
            << "[BackendBuilder] Tag      : " << llamaTag << "\n"
            << "==============================\n";
    }
    std::cout << "[BackendBuilder] Building " << backend << " (tag " << llamaTag << ")\n";

    if (writeCMakeLists(srcDir.string(), backend, llamaTag).empty()) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Failed to write CMakeLists.txt\n";
        return 1;
    }

    // ── cmake configure ───────────────────────────────────────────────────────
    int ret = runCmd(
        "cmake -B \"" + cmakeBin.string() + "\""
        " -S \""       + srcDir.string()  + "\""
        " -DCMAKE_BUILD_TYPE=Release"
        " "            + cmakeArgs(backend)
        +                compilerEnv(backend),
        logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake configure failed\n"; return ret; }

    // ── cmake build (Native OS multi-core parallel) ───────────────────────────
    ret = runCmd("cmake --build \"" + cmakeBin.string() + "\" --target llama --parallel", logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake build failed\n"; return ret; }

    // ── Copy libraries natively using C++ filesystem ──────────────────────────
    try {
        for (const auto& entry : fs::recursive_directory_iterator(cmakeBin)) {
            if (entry.is_regular_file() || entry.is_symlink()) {
                const std::string ext = entry.path().extension().string();
                if (ext == ".so" || ext == ".dll" || ext == ".dylib") {
                    // Ignore transient cmake check files
                    if (entry.path().string().find("CMakeFiles") == std::string::npos) {
                        fs::copy_file(entry.path(), outDir / entry.path().filename(), fs::copy_options::overwrite_existing);
                    }
                }
            }
        }
    } catch (const std::exception& e) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] File copy failed: " << e.what() << "\n";
        return 1;
    }

    // ── Rename libllama library ───────────────────────────────────────────────
    // This allows multiple backends to exist without overwriting the core llama lib.
    fs::path rawLib;
    fs::path renamedLib;
    
    for (const char* ext : {".so", ".dll", ".dylib"}) {
        if (fs::exists(outDir / ("libllama" + std::string(ext)))) {
            rawLib = outDir / ("libllama" + std::string(ext));
            renamedLib = outDir / ("libllama_" + backend + ext);
            break;
        } else if (fs::exists(outDir / ("llama" + std::string(ext)))) { 
            // Windows/MSVC sometimes outputs without the 'lib' prefix
            rawLib = outDir / ("llama" + std::string(ext));
            renamedLib = outDir / ("libllama_" + backend + ext);
            break;
        }
    }

    if (!rawLib.empty()) {
        if (fs::exists(renamedLib)) fs::remove(renamedLib);
        fs::rename(rawLib, renamedLib);
    } else {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] ERROR: libllama library file missing\n";
        return 1;
    }

    {
        std::ofstream log(logPath, std::ios::app);
        log << "[BackendBuilder] Success: " << renamedLib.string() << "\n";
    }
    std::cout << "[BackendBuilder] Built: " << renamedLib.string() << "\n";

    // ── Clean up build cache ──────────────────────────────────────────────────
    std::cout << "[BackendBuilder] Removing build cache: " << buildCacheDir << "\n";
    try {
        fs::remove_all(fs::path(buildCacheDir));
    } catch (const std::exception& e) {
        std::cerr << "[BackendBuilder] Warning: could not remove build cache: " << e.what() << "\n";
    }

    return 0;
}