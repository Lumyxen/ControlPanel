// backend/src/services/backend_builder.cpp
#include "services/backend_builder.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <cstdlib>
#include <unistd.h>

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

std::string BackendBuilder::findRocmClang() {
    for (const char* c : {"/opt/rocm/llvm/bin/clang", "/opt/rocm/bin/clang"})
        if (access(c, X_OK) == 0) return c;
    if (system("command -v clang > /dev/null 2>&1") == 0) return "clang";
    return "";
}

std::string BackendBuilder::checkPrerequisites(const std::string& backend) {
    if (system("command -v cmake > /dev/null 2>&1") != 0)
        return "cmake not found";
    if (system("command -v git > /dev/null 2>&1") != 0)
        return "git not found — required for FetchContent";
    if (backend == "cuda") {
        if (system("command -v nvcc > /dev/null 2>&1") != 0)
            return "nvcc not found — install the NVIDIA CUDA toolkit";
    } else if (backend == "rocm") {
        if (system("command -v hipcc > /dev/null 2>&1") != 0)
            return "hipcc not found — install ROCm";
        if (findRocmClang().empty())
            return "clang not found — install /opt/rocm/llvm or system clang";
    } else if (backend == "vulkan") {
        if (system("command -v glslc > /dev/null 2>&1") != 0 &&
            system("command -v glslangValidator > /dev/null 2>&1") != 0)
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

    // Truncate log so stale cmake % lines from a previous run don't bleed
    // into fresh polls from the frontend.
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

    // ── cmake build ───────────────────────────────────────────────────────────
    ret = runCmd("cmake --build \"" + cmakeBin.string() + "\" --target llama -j$(nproc)", logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake build failed\n"; return ret; }

    // ── Copy plain .so files (not versioned .so.0 / .so.0.x.y) ──────────────
    // -name "*.so" matches only exact .so suffixes — find does NOT match
    // "libggml.so.0" with -name "*.so" because the name has a trailing ".0".
    runCmd(
        "find \"" + cmakeBin.string() + "\""
        " ! -path \"*/CMakeFiles/*\""
        " -name \"*.so\""
        " -exec cp -L {} \"" + outDir.string() + "/\" \\;",
        logPath);

    // ── Rename libllama.so → libllama_<backend>.so ────────────────────────────
    const fs::path rawSo     = outDir / "libllama.so";
    const fs::path renamedSo = outDir / ("libllama_" + backend + ".so");

    if (!fs::exists(rawSo)) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] ERROR: libllama.so missing\n";
        return 1;
    }
    // Remove old build of same backend if present
    if (fs::exists(renamedSo)) fs::remove(renamedSo);
    fs::rename(rawSo, renamedSo);

    // ── Fix versioned SONAME dependencies ────────────────────────────────────
    //
    // Problem: cmake sets SOVERSION on ggml libs so their internal SONAME is
    // e.g. "libggml.so.0".  libllama.so is built with NEEDED entries pointing
    // to those versioned SONAMEs.  When we cp -L libggml.so we get the real
    // binary but under the plain name; the dynamic linker can't find it because
    // it's looking for "libggml.so.0".
    //
    // Fix: use patchelf --replace-needed to rewrite every versioned NEEDED
    // entry in libllama_<backend>.so to its plain .so equivalent.
    // After this change dlopen needs only the plain .so files we already have.
    //
    // We also set RPATH=$ORIGIN so the loader finds ggml siblings in the same
    // flat data/libs/ directory without needing LD_LIBRARY_PATH.
    const std::string patchScript =
        "LIB=\"" + renamedSo.string() + "\"\n"
        "if command -v patchelf > /dev/null 2>&1; then\n"
        "  for dep in $(patchelf --print-needed \"$LIB\" 2>/dev/null | grep -E '\\.so\\.[0-9]'); do\n"
        "    plain=$(echo \"$dep\" | sed -E 's/\\.so\\.[0-9].*/\\.so/')\n"
        "    patchelf --replace-needed \"$dep\" \"$plain\" \"$LIB\" 2>/dev/null\n"
        "    echo \"[patchelf] replaced NEEDED: $dep -> $plain\"\n"
        "  done\n"
        "  patchelf --set-rpath '$ORIGIN' \"$LIB\" 2>/dev/null\n"
        "  echo '[patchelf] RPATH set to $ORIGIN'\n"
        "elif command -v chrpath > /dev/null 2>&1; then\n"
        "  chrpath -r '$ORIGIN' \"$LIB\" 2>/dev/null\n"
        "else\n"
        "  echo '[patchelf] WARNING: neither patchelf nor chrpath found — dlopen may fail'\n"
        "fi\n";
    runCmd("bash -c '" + patchScript + "'", logPath);

    {
        std::ofstream log(logPath, std::ios::app);
        log << "[BackendBuilder] Success: " << renamedSo.string() << "\n";
    }
    std::cout << "[BackendBuilder] Built: " << renamedSo.string() << "\n";

    // ── Delete entire build-cache directory ───────────────────────────────────
    // Deletes the whole buildCacheDir (not just the backend subdir inside it)
    // so the directory entry itself is also gone.
    std::cout << "[BackendBuilder] Removing build cache: " << buildCacheDir << "\n";
    try {
        fs::remove_all(fs::path(buildCacheDir));
    } catch (const std::exception& e) {
        std::cerr << "[BackendBuilder] Warning: could not remove build cache: " << e.what() << "\n";
    }

    return 0;
}