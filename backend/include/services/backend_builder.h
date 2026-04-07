#pragma once
// backend/include/services/backend_builder.h
//
// Builds a llama.cpp backend shared library entirely from within the running
// binary. No external shell script required — everything that was in
// build_backend.sh now lives here.
//
// Each backend is built into its own subdirectory:
//   data/libs/cpu/       libllama.so  libggml*.so
//   data/libs/rocm/      libllama.so  libggml*.so  libggml-hip.so
//   data/libs/vulkan/    libllama.so  libggml*.so  libggml-vulkan.so
//   data/libs/cuda/      libllama.so  libggml*.so  libggml-cuda.so
//
// All shared libs in a subdir have RPATH=$ORIGIN so they find each other
// when dlopen() loads libllama.so.

#include <string>

class BackendBuilder {
public:
    // Build libllama.so (+ ggml deps) into libsDir/<backend>/.
    //
    //   backend        : "cpu" | "cuda" | "rocm" | "vulkan"
    //   libsDir        : e.g. "data/libs"
    //   buildCacheDir  : cmake build dirs (e.g. "data/build-cache") —
    //                    preserved between calls for incremental rebuilds
    //   logPath        : all build output is appended here
    //   llamaTag       : llama.cpp git tag (e.g. "b8683")
    //
    // Returns 0 on success, non-zero on failure.
    static int build(const std::string& backend,
                     const std::string& libsDir,
                     const std::string& buildCacheDir,
                     const std::string& logPath,
                     const std::string& llamaTag = "b8683");

    // Returns an empty string if all tools needed for this backend are
    // present, otherwise an error message describing what is missing.
    static std::string checkPrerequisites(const std::string& backend);

private:
    // Write the inner CMakeLists.txt and return the path.
    static std::string writeCMakeLists(const std::string& buildDir,
                                       const std::string& backend,
                                       const std::string& llamaTag);

    // Extra -D... args for cmake configure, per backend.
    static std::string cmakeArgs(const std::string& backend);

    // Extra environment/compiler overrides prepended to cmake commands.
    // For ROCm: CC=<rocm-clang> to avoid gcc rejecting Clang-only warning flags.
    static std::string compilerEnv(const std::string& backend);

    // Best clang binary from the ROCm LLVM stack for use as C compiler.
    static std::string findRocmClang();
};