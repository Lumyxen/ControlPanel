#pragma once
// backend/include/services/backend_builder.h
//
// Builds a backend-specific llama-server runtime entirely from within the
// running binary. No external shell script required.
//
// Each backend is installed into its own subdirectory:
//   data/libs/cpu/       llama-server  libggml*.so
//   data/libs/rocm/      llama-server  libggml*.so  libggml-hip.so
//   data/libs/vulkan/    llama-server  libggml*.so  libggml-vulkan.so
//   data/libs/cuda/      llama-server  libggml*.so  libggml-cuda.so
//
// The binary and its shared libs live side-by-side so the application can
// switch backends by launching the matching backend-local server binary.

#include <functional>
#include <string>

inline constexpr int kBackendBuildStageCount = 7;

struct BackendBuildProgress {
    std::string stage;
    std::string stageLabel;
    int stageIndex = 0;
    int stageCount = kBackendBuildStageCount;
    int stagePercent = -1;
    int overallPercent = 0;
    bool determinate = false;
};

class BackendBuilder {
public:
    using ProgressCallback = std::function<void(const BackendBuildProgress&)>;

    // Build llama-server (+ ggml deps) into libsDir/<backend>/.
    //
    //   backend        : "cpu" | "cuda" | "rocm" | "vulkan"
    //   libsDir        : e.g. "data/libs"
    //   buildCacheDir  : cmake build dirs (e.g. "data/build-cache") —
    //                    preserved between calls for incremental rebuilds
    //   logPath        : all build output is appended here
    //   llamaTag       : llama.cpp git tag (e.g. "b8846")
    //
    // Returns 0 on success, non-zero on failure.
    static int build(const std::string& backend,
                     const std::string& libsDir,
                     const std::string& buildCacheDir,
                     const std::string& logPath,
                     const std::string& llamaTag = "b8846",
                     ProgressCallback progressCallback = {});

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
