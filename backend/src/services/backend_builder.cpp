// backend/src/services/backend_builder.cpp
#include "services/backend_builder.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <cstdlib>
#include <cstdint>
#include <vector>
#include <curl/curl.h>

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

// Get available system memory in MB
static uint64_t getAvailableMemoryMB() {
#ifdef _WIN32
    return 0; // Windows fallback - use default
#else
    // Try to read from /proc/meminfo on Linux
    std::ifstream meminfo("/proc/meminfo");
    if (meminfo.is_open()) {
        std::string line;
        while (std::getline(meminfo, line)) {
            if (line.rfind("MemAvailable:", 0) == 0) {
                // Parse the value (in kB)
                size_t pos = line.find_first_of("0123456789");
                if (pos != std::string::npos) {
                    uint64_t kb = std::stoull(line.substr(pos));
                    return kb / 1024; // Convert to MB
                }
            }
        }
    }
    // Fallback: try sysctl on macOS
    #ifdef __APPLE__
    int mib[2] = {CTL_HW, HW_MEMSIZE};
    uint64_t memsize;
    size_t len = sizeof(memsize);
    if (sysctl(mib, 2, &memsize, &len, NULL, 0) == 0) {
        return memsize / (1024 * 1024);
    }
    #endif
    return 0; // Unknown
#endif
}

// Get number of CPU cores
static int getCpuCores() {
#ifdef _WIN32
    return 4; // Windows fallback
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? static_cast<int>(n) : 4;
#endif
}

// Calculate optimal parallel jobs based on memory and CPU cores
// This prevents OOM crashes while still utilizing available resources
static int calculateOptimalJobs() {
    const uint64_t memMB = getAvailableMemoryMB();
    const int cores = getCpuCores();
    
    // Estimate ~1.5GB per parallel compilation job (conservative)
    // Leave 2GB for system + other needs
    uint64_t usableMemMB = (memMB > 2048) ? (memMB - 2048) : 0;
    int memBasedJobs = static_cast<int>(usableMemMB / 1500);
    
    // CPU-based: leave 1 core for system, use the rest
    int cpuBasedJobs = cores - 1;
    
    // Use the minimum but cap at a reasonable maximum
    // For high-end machines (16+ cores, 32GB+ RAM), allow more parallelism
    int optimal = std::min(memBasedJobs, cpuBasedJobs);
    
    // Ensure minimum of 2 jobs for parallel builds
    if (optimal < 2) optimal = 2;
    
    // Cap based on memory: more memory = higher cap
    // 8GB RAM: cap at 4
    // 16GB RAM: cap at 8  
    // 32GB+ RAM: cap at 12
    int memCap = static_cast<int>(std::min(usableMemMB, static_cast<uint64_t>(32768)) / 2048);
    if (optimal > memCap) optimal = memCap;
    
    // Absolute cap at 16 jobs (too many parallel compiles can hurt I/O)
    if (optimal > 16) optimal = 16;
    
    return optimal;
}

static const char* CMAKE_TEMPLATE = R"CMAKE(
cmake_minimum_required(VERSION 3.18)
project(llama_backend_build CXX C)

set(BUILD_SHARED_LIBS    ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON   ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_WEBUI    OFF CACHE BOOL "" FORCE)
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

add_subdirectory(llama_src)
)CMAKE";

static std::string strReplace(std::string s, const std::string& from, const std::string& to) {
    size_t pos = s.find(from);
    if (pos != std::string::npos) s.replace(pos, from.size(), to);
    return s;
}

static int runCmd(const std::string& cmd, const std::string& logPath) {
    return system((cmd + " >> \"" + logPath + "\" 2>&1").c_str());
}

static int runCmdStreaming(const std::string& cmd,
                           const std::string& logPath,
                           const std::function<void(const std::string&)>& onLine = {}) {
#ifdef _WIN32
    FILE* pipe = _popen((cmd + " 2>&1").c_str(), "r");
#else
    FILE* pipe = popen((cmd + " 2>&1").c_str(), "r");
#endif
    if (!pipe) {
        std::ofstream(logPath, std::ios::app)
            << "[BackendBuilder] Failed to spawn command: " << cmd << "\n";
        return 1;
    }

    std::ofstream log(logPath, std::ios::app);
    char buffer[4096];
    std::string pending;
    while (std::fgets(buffer, static_cast<int>(sizeof(buffer)), pipe)) {
        pending += buffer;
        std::size_t newlinePos = std::string::npos;
        while ((newlinePos = pending.find('\n')) != std::string::npos) {
            std::string line = pending.substr(0, newlinePos + 1);
            pending.erase(0, newlinePos + 1);
            if (log.is_open()) {
                log << line;
                log.flush();
            }
            if (onLine) {
                while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) {
                    line.pop_back();
                }
                onLine(line);
            }
        }
    }

    if (!pending.empty()) {
        if (log.is_open()) {
            log << pending;
            log.flush();
        }
        if (onLine) {
            while (!pending.empty() && (pending.back() == '\n' || pending.back() == '\r')) {
                pending.pop_back();
            }
            onLine(pending);
        }
    }

#ifdef _WIN32
    return _pclose(pipe);
#else
    const int status = pclose(pipe);
    if (status == -1) return 1;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return status;
#endif
}

static bool hasCommand(const std::string& cmd) {
#ifdef _WIN32
    return system(("where " + cmd + " > NUL 2>&1").c_str()) == 0;
#else
    return system(("command -v " + cmd + " > /dev/null 2>&1").c_str()) == 0;
#endif
}

struct DownloadCtx {
    std::ofstream* logStream;
    std::function<void(int)> onPercent;
    int lastPercent = -1;
};

static size_t DownloadWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    std::ofstream* out = static_cast<std::ofstream*>(userp);
    out->write(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

static int DownloadProgressCallback(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t ultotal, curl_off_t ulnow) {
    DownloadCtx* ctx = static_cast<DownloadCtx*>(clientp);
    if (dltotal > 0) {
        int percent = static_cast<int>((dlnow * 100) / dltotal);
        if (percent != ctx->lastPercent) {
            if (ctx->onPercent) ctx->onPercent(percent);
        }
        // Log every 2% to make the progress bar smooth while preventing IO spam
        if (percent != ctx->lastPercent && (percent % 2 == 0 || percent == 100)) {
            if (ctx->logStream && ctx->logStream->is_open()) {
                *(ctx->logStream) << "[download " << percent << "% complete]\n";
                ctx->logStream->flush();
            }
        }
        if (percent != ctx->lastPercent) ctx->lastPercent = percent;
    }
    return 0;
}

static int downloadWithProgress(const std::string& url,
                                const std::string& outputPath,
                                const std::string& logPath,
                                const std::function<void(int)>& onPercent = {}) {
    CURL* curl = curl_easy_init();
    if (!curl) return 1;

    std::ofstream outFile(outputPath, std::ios::binary);
    if (!outFile.is_open()) {
        curl_easy_cleanup(curl);
        return 1;
    }

    std::ofstream logFile(logPath, std::ios::app);
    DownloadCtx ctx;
    ctx.logStream = &logFile;
    ctx.onPercent = onPercent;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, DownloadWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &outFile);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, DownloadProgressCallback);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "ControlPanel/1.0");

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        if (logFile.is_open()) {
            logFile << "[BackendBuilder] CURL error: " << curl_easy_strerror(res) << "\n";
        }
        return 1;
    }
    return 0;
}

static int clampPercent(int value) {
    return std::clamp(value, 0, 100);
}

static int interpolatePercent(int start, int end, int percent) {
    const int clamped = clampPercent(percent);
    return start + ((end - start) * clamped + 50) / 100;
}

static int parseBuildProgressLine(const std::string& line) {
    const std::size_t open = line.find('[');
    if (open == std::string::npos) return -1;
    const std::size_t close = line.find(']', open + 1);
    if (close == std::string::npos) return -1;

    const std::size_t pct = line.find('%', open + 1);
    if (pct != std::string::npos && pct < close) {
        const std::size_t digitsStart = line.find_first_of("0123456789", open + 1);
        if (digitsStart != std::string::npos && digitsStart < pct) {
            try {
                const int parsed = std::stoi(line.substr(digitsStart, pct - digitsStart));
                if (parsed >= 0 && parsed <= 100) return parsed;
            } catch (...) {}
        }
    }

    const std::size_t slash = line.find('/', open + 1);
    if (slash != std::string::npos && slash < close) {
        const std::size_t currentStart = line.find_first_of("0123456789", open + 1);
        const std::size_t currentEnd = currentStart == std::string::npos
            ? std::string::npos
            : line.find_first_not_of("0123456789", currentStart);
        const std::size_t totalStart = line.find_first_of("0123456789", slash + 1);
        const std::size_t totalEnd = totalStart == std::string::npos
            ? std::string::npos
            : line.find_first_not_of("0123456789", totalStart);
        if (currentStart != std::string::npos && totalStart != std::string::npos) {
            try {
                const int current = std::stoi(line.substr(currentStart, currentEnd - currentStart));
                const int total = std::stoi(line.substr(totalStart, totalEnd - totalStart));
                if (current >= 0 && total > 0) {
                    return clampPercent((current * 100) / total);
                }
            } catch (...) {}
        }
    }

    return -1;
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

// Detect the package manager available on this Linux system.
static std::string detectPkgManager() {
    for (const char* pm : {"apt-get", "pacman", "dnf", "yum", "zypper", "emerge", "apk"})
        if (hasCommand(pm)) return pm;
    return "";
}

// Build a human-friendly, distro-aware install hint for a set of package names.
// packagesByPm maps package-manager name → package list string.
// Falls back to a generic message when the package manager isn't recognised.
static std::string installHint(
    const std::string& what,
    const std::map<std::string, std::string>& packagesByPm,
    const std::string& windowsMsg = "")
{
#ifdef _WIN32
    return what + " not found" + (windowsMsg.empty() ? "" : " — " + windowsMsg);
#else
    const std::string pm = detectPkgManager();
    auto it = packagesByPm.find(pm);
    if (it != packagesByPm.end()) {
        // Known package manager
        std::string cmd;
        if (pm == "apt-get") cmd = "sudo apt install " + it->second;
        else if (pm == "pacman") cmd = "sudo pacman -S " + it->second;
        else if (pm == "dnf" || pm == "yum") cmd = "sudo " + pm + " install " + it->second;
        else if (pm == "zypper") cmd = "sudo zypper install " + it->second;
        else if (pm == "emerge") cmd = "sudo emerge " + it->second;
        else if (pm == "apk") cmd = "sudo apk add " + it->second;
        else cmd = it->second;
        return what + " not found — run: " + cmd;
    }
    // Unknown / no package manager detected — show all options
    std::string msg = what + " not found. Install it:\n";
    for (const auto& kv : packagesByPm) {
        const auto& p = kv.first;
        std::string cmd;
        if (p == "apt-get")      cmd = "sudo apt install " + kv.second;
        else if (p == "pacman")  cmd = "sudo pacman -S " + kv.second;
        else if (p == "dnf")     cmd = "sudo dnf install " + kv.second;
        else if (p == "zypper")  cmd = "sudo zypper install " + kv.second;
        else if (p == "emerge")  cmd = "sudo emerge " + kv.second;
        else if (p == "apk")     cmd = "sudo apk add " + kv.second;
        else                     cmd = kv.second;
        msg += "  " + cmd + "\n";
    }
    if (!windowsMsg.empty()) msg += "  Windows: " + windowsMsg + "\n";
    return msg;
#endif
}

// Auto-detect the Vulkan SDK root directory.
// Returns the SDK root when headers live under a non-standard path that
// CMake won't find on its own, or an empty string when the system paths
// are sufficient (e.g. after `sudo apt install libvulkan-dev`).
static std::string findVulkanSdk() {
#ifndef _WIN32
    // 1. Honour the official env var set by the LunarG SDK sourcing script
    if (const char* sdkEnv = std::getenv("VULKAN_SDK")) {
        if (sdkEnv[0] != '\0') {
            fs::path sdk(sdkEnv);
            if (fs::exists(sdk / "include" / "vulkan" / "vulkan.h"))
                return sdk.string();
        }
    }

    // 2. Standard system paths — if headers are already there CMake's
    //    find_package(Vulkan) works without any hints.
    for (const char* inc : {"/usr/include/vulkan/vulkan.h",
                             "/usr/local/include/vulkan/vulkan.h"}) {
        if (fs::exists(inc)) return "";
    }

    // 3. Scan ~/VulkanSDK/<version>/<arch> (LunarG installer default)
    if (const char* home = std::getenv("HOME")) {
        fs::path vkHome = fs::path(home) / "VulkanSDK";
        if (fs::exists(vkHome)) {
            for (const auto& verEntry : fs::directory_iterator(vkHome)) {
                if (!verEntry.is_directory()) continue;
                for (const auto& archEntry : fs::directory_iterator(verEntry.path())) {
                    if (!archEntry.is_directory()) continue;
                    if (fs::exists(archEntry.path() / "include" / "vulkan" / "vulkan.h"))
                        return archEntry.path().string();
                }
                if (fs::exists(verEntry.path() / "include" / "vulkan" / "vulkan.h"))
                    return verEntry.path().string();
            }
        }
    }
#else
    // Windows: VK_SDK_PATH or VULKAN_SDK set by the LunarG installer
    for (const char* var : {"VK_SDK_PATH", "VULKAN_SDK"}) {
        if (const char* sdkEnv = std::getenv(var)) {
            if (sdkEnv[0] != '\0') {
                fs::path sdk(sdkEnv);
                if (fs::exists(sdk / "Include" / "vulkan" / "vulkan.h"))
                    return sdk.string();
            }
        }
    }
#endif
    return "";
}

std::string BackendBuilder::checkPrerequisites(const std::string& backend) {
    if (!hasCommand("cmake"))
        return installHint("cmake",
            {{"apt-get", "cmake"},
             {"pacman",  "cmake"},
             {"dnf",     "cmake"},
             {"zypper",  "cmake"},
             {"emerge",  "dev-build/cmake"},
             {"apk",     "cmake"}},
            "install CMake from https://cmake.org/download/");

    if (backend == "cuda") {
        if (!hasCommand("nvcc"))
            return installHint("nvcc (NVIDIA CUDA compiler)",
                {{"apt-get", "nvidia-cuda-toolkit"},
                 {"pacman",  "cuda"},
                 {"dnf",     "cuda-compiler"},
                 {"zypper",  "cuda"},
                 {"emerge",  "dev-util/nvidia-cuda-toolkit"},
                 {"apk",     "cuda"}},
                "install the NVIDIA CUDA Toolkit from https://developer.nvidia.com/cuda-downloads");

    } else if (backend == "rocm") {
#ifndef _WIN32
        if (!hasCommand("hipcc"))
            return installHint("hipcc (ROCm HIP compiler)",
                {{"apt-get", "hip-dev rocm-dev"},
                 {"pacman",  "rocm-hip-sdk"},
                 {"dnf",     "rocm-hip-devel"},
                 {"zypper",  "rocm-hip-devel"},
                 {"emerge",  "dev-util/hip"},
                 {"apk",     "rocm-hip"}},
                "ROCm is Linux-only; see https://rocm.docs.amd.com/en/latest/deploy/linux/index.html");
#endif
        if (findRocmClang().empty())
            return installHint("ROCm clang",
                {{"apt-get", "rocm-llvm-dev"},
                 {"pacman",  "rocm-llvm"},
                 {"dnf",     "rocm-llvm-devel"},
                 {"zypper",  "rocm-llvm-devel"},
                 {"emerge",  "sys-devel/rocm-llvm"},
                 {"apk",     "rocm-llvm"}},
                "ROCm is Linux-only");

    } else if (backend == "vulkan") {
        // ── GLSL compiler ────────────────────────────────────────────────────
        if (!hasCommand("glslc") && !hasCommand("glslangValidator"))
            return installHint("GLSL compiler (glslc / glslangValidator)",
                {{"apt-get", "glslang-tools"},
                 {"pacman",  "glslang"},
                 {"dnf",     "glslang"},
                 {"zypper",  "glslang-devel"},
                 {"emerge",  "dev-util/glslang"},
                 {"apk",     "glslang"}},
                "install the LunarG Vulkan SDK from https://vulkan.lunarg.com/sdk/home");

        // ── Vulkan headers ────────────────────────────────────────────────────
        bool headersFound = false;
#ifndef _WIN32
        for (const char* p : {"/usr/include/vulkan/vulkan.h",
                               "/usr/local/include/vulkan/vulkan.h"}) {
            if (fs::exists(p)) { headersFound = true; break; }
        }
#endif
        if (!headersFound) {
            const std::string sdk = findVulkanSdk();
            if (!sdk.empty()) {
                headersFound = fs::exists(fs::path(sdk) / "include" / "vulkan" / "vulkan.h")
#ifdef _WIN32
                            || fs::exists(fs::path(sdk) / "Include" / "vulkan" / "vulkan.h")
#endif
                            ;
            }
        }
        if (!headersFound)
            return installHint("Vulkan headers (vulkan/vulkan.h)",
                {{"apt-get", "libvulkan-dev"},
                 {"pacman",  "vulkan-headers"},
                 {"dnf",     "vulkan-headers"},
                 {"zypper",  "vulkan-devel"},
                 {"emerge",  "dev-util/vulkan-headers"},
                 {"apk",     "vulkan-headers"}},
                "install the LunarG Vulkan SDK from https://vulkan.lunarg.com/sdk/home");

    } else if (backend != "cpu") {
        return "Unknown backend: " + backend;
    }
    return "";
}

std::string BackendBuilder::cmakeArgs(const std::string& backend) {
    if (backend == "cuda")   return "-DGGML_CUDA=ON -DGGML_HIPBLAS=OFF -DGGML_VULKAN=OFF";
    if (backend == "rocm")   return "-DGGML_HIPBLAS=ON -DGGML_CUDA=OFF -DGGML_VULKAN=OFF";
    if (backend == "vulkan") {
        std::string args = "-DGGML_VULKAN=ON -DGGML_CUDA=OFF -DGGML_HIPBLAS=OFF";
        // Inject SDK paths only when headers aren't in a standard location
        // that CMake already searches (findVulkanSdk returns "" in that case).
        const std::string sdk = findVulkanSdk();
        if (!sdk.empty()) {
#ifndef _WIN32
            const std::string inc = sdk + "/include";
            std::string lib;
            for (const char* c : {"lib/libvulkan.so.1", "lib/libvulkan.so",
                                  "lib64/libvulkan.so.1", "lib64/libvulkan.so"}) {
                if (fs::exists(fs::path(sdk) / c)) { lib = sdk + "/" + c; break; }
            }
            args += " -DVulkan_INCLUDE_DIR=\"" + inc + "\"";
            if (!lib.empty()) args += " -DVulkan_LIBRARY=\"" + lib + "\"";
#else
            const std::string inc = sdk + "/Include";
            std::string lib;
            for (const char* c : {"Lib/vulkan-1.lib", "Lib32/vulkan-1.lib"}) {
                if (fs::exists(fs::path(sdk) / c)) { lib = sdk + "/" + c; break; }
            }
            args += " -DVulkan_INCLUDE_DIR=\"" + inc + "\"";
            if (!lib.empty()) args += " -DVulkan_LIBRARY=\"" + lib + "\"";
#endif
        }
        return args;
    }
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
                            const std::string& llamaTag,
                            ProgressCallback progressCallback) {
    struct StageDef {
        const char* key;
        const char* label;
        int index;
        int startPercent;
        int endPercent;
    };

    const StageDef prepareStage      {"prepare", "Preparing build",      1,  0,   5};
    const StageDef downloadStage     {"download","Downloading source",   2,  5,  25};
    const StageDef extractStage      {"extract", "Extracting source",    3, 25,  35};
    const StageDef sourceStage       {"source",  "Preparing source tree",4, 35,  45};
    const StageDef configureStage    {"configure","Configuring build",   5, 45,  60};
    const StageDef buildStage        {"build",   "Compiling llama.cpp",  6, 60,  95};
    const StageDef installStage      {"install", "Installing runtime",   7, 95, 100};

    const auto emitStage = [&](const StageDef& stage,
                               int stagePercent = -1,
                               bool determinate = false,
                               const std::string& labelOverride = std::string()) {
        if (!progressCallback) return;
        BackendBuildProgress progress;
        progress.stage = stage.key;
        progress.stageLabel = labelOverride.empty() ? stage.label : labelOverride;
        progress.stageIndex = stage.index;
        progress.stageCount = kBackendBuildStageCount;
        progress.stagePercent = determinate ? clampPercent(stagePercent) : -1;
        progress.overallPercent = determinate && progress.stagePercent >= 0
            ? interpolatePercent(stage.startPercent, stage.endPercent, progress.stagePercent)
            : stage.startPercent;
        progress.determinate = determinate;
        progressCallback(progress);
    };

    emitStage(prepareStage);

    const std::string prereqErr = checkPrerequisites(backend);
    if (!prereqErr.empty()) {
        std::ofstream log(logPath, std::ios::trunc);
        log << "[BackendBuilder] Prerequisite failed: " << prereqErr << "\n";
        std::cerr << "[BackendBuilder] " << prereqErr << "\n";
        return 1;
    }

    const fs::path srcDir   = fs::path(buildCacheDir) / backend;
    const fs::path cmakeBin = srcDir / "cmake_build";
    const fs::path outDir   = fs::path(libsDir) / backend;
    const fs::path tarPath  = srcDir / ("llama.cpp-" + llamaTag + ".tar.gz");
    const std::string url   = "https://github.com/ggml-org/llama.cpp/archive/" + llamaTag + ".tar.gz";

    fs::create_directories(srcDir);
    fs::create_directories(outDir);
    emitStage(prepareStage, 100, true);

    {
        std::ofstream log(logPath, std::ios::trunc);
        log << "==============================\n"
            << "[BackendBuilder] Building : " << backend << "\n"
            << "[BackendBuilder] Tag      : " << llamaTag << "\n"
            << "==============================\n";
    }

    // ── Download source ───────────────────────────────────────────────────────
    if (!fs::exists(tarPath)) {
        emitStage(downloadStage, 0, true);
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Downloading source from " << url << "\n";
        if (downloadWithProgress(url, tarPath.string(), logPath, [&](int percent) {
            emitStage(downloadStage, percent, true);
        }) != 0) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Download failed\n";
            return 1;
        }
        emitStage(downloadStage, 100, true, "Source download complete");
    } else {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Using cached source archive\n";
        emitStage(downloadStage, 100, true, "Using cached source archive");
    }

    // ── Extract source ────────────────────────────────────────────────────────
    const fs::path extractDir = srcDir / ("llama.cpp-" + llamaTag);
    if (!fs::exists(extractDir)) {
        emitStage(extractStage);
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Extracting source\n";
        if (runCmd("tar -xzf \"" + tarPath.string() + "\" -C \"" + srcDir.string() + "\"", logPath) != 0) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Extraction failed\n";
            return 1;
        }
        emitStage(extractStage, 100, true, "Source extracted");
    } else {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Using cached extracted source\n";
        emitStage(extractStage, 100, true, "Using cached extracted source");
    }

    // Move the extracted directory to a standard name
    const fs::path llamaSrcDir = srcDir / "llama_src";
    emitStage(sourceStage);
    if (!fs::exists(llamaSrcDir)) {
        try {
            fs::rename(extractDir, llamaSrcDir);
        } catch (const std::exception& e) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Failed to rename extracted directory: " << e.what() << "\n";
            return 1;
        }
    }
    emitStage(sourceStage, 50, true);

    if (writeCMakeLists(srcDir.string(), backend, llamaTag).empty()) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Failed to write CMakeLists.txt\n";
        return 1;
    }
    emitStage(sourceStage, 100, true, "Source tree ready");

    // ── cmake configure ───────────────────────────────────────────────────────
    emitStage(configureStage);
    int ret = runCmd(
        "cd \"" + srcDir.string() + "\" && cmake -B \"" + cmakeBin.string() + "\""
        " -S \""       + srcDir.string()  + "\""
        " -DCMAKE_BUILD_TYPE=Release"
        " "            + cmakeArgs(backend)
        +                compilerEnv(backend),
        logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake configure failed\n"; return ret; }
    emitStage(configureStage, 100, true, "Build configured");

    // ── cmake build (memory and CPU aware parallel) ────────────────────────
    const int optimalJobs = calculateOptimalJobs();
    std::cout << "[BackendBuilder] Building with " << optimalJobs << " parallel jobs\n";
    emitStage(buildStage, 0, true);
    ret = runCmdStreaming(
        "cmake --build \"" + cmakeBin.string() + "\" --target llama-server --parallel " +
        std::to_string(optimalJobs),
        logPath,
        [&](const std::string& line) {
            const int percent = parseBuildProgressLine(line);
            if (percent >= 0) emitStage(buildStage, percent, true);
        });
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake build failed\n"; return ret; }
    emitStage(buildStage, 100, true, "Compilation complete");

    // ── Copy runtime natively using C++ filesystem ───────────────────────────
    try {
        emitStage(installStage, 0, true);
        if (fs::exists(outDir)) {
            fs::remove_all(outDir);
        }
        fs::create_directories(outDir);
        emitStage(installStage, 5, true);

        std::vector<fs::path> filesToCopy;
        filesToCopy.reserve(64);

        for (const auto& entry : fs::recursive_directory_iterator(cmakeBin)) {
            if (entry.is_regular_file() || entry.is_symlink()) {
                const fs::path filePath = entry.path();
                const std::string fileName = filePath.filename().string();
                const std::string ext = filePath.extension().string();

                if (filePath.string().find("CMakeFiles") != std::string::npos) {
                    continue;
                }

                const bool isSharedLib = ext == ".so" || ext == ".dll" || ext == ".dylib";
                const bool isServerBinary = fileName == "llama-server" || fileName == "llama-server.exe";
                if (!isSharedLib && !isServerBinary) {
                    continue;
                }
                filesToCopy.push_back(filePath);
            }
        }

        bool binaryFound = false;
        const std::size_t totalFiles = filesToCopy.size();
        std::size_t copiedFiles = 0;
        for (const auto& filePath : filesToCopy) {
            const std::string fileName = filePath.filename().string();
            fs::path dest = outDir / fileName;
            if (fs::exists(dest)) {
                fs::remove(dest);
            }
            fs::copy_file(filePath, dest, fs::copy_options::overwrite_existing);
            if (fileName == "llama-server" || fileName == "llama-server.exe") {
                binaryFound = true;
            }
            copiedFiles += 1;
            const int percent = totalFiles == 0
                ? 100
                : 10 + static_cast<int>((copiedFiles * 90) / totalFiles);
            emitStage(installStage, percent, true);
        }

        if (!binaryFound) {
            std::ofstream(logPath, std::ios::app)
                << "[BackendBuilder] ERROR: llama-server binary file missing\n";
            return 1;
        }
    } catch (const std::exception& e) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] File copy failed: " << e.what() << "\n";
        return 1;
    }

    {
        std::ofstream log(logPath, std::ios::app);
        log << "[BackendBuilder] Success: " << outDir.string() << "\n";
    }

    if (progressCallback) {
        progressCallback(BackendBuildProgress{
            .stage = "complete",
            .stageLabel = "Build complete",
            .stageIndex = kBackendBuildStageCount,
            .stageCount = kBackendBuildStageCount,
            .stagePercent = 100,
            .overallPercent = 100,
            .determinate = true,
        });
    }

    try {
        fs::remove_all(fs::path(buildCacheDir));
    } catch (const std::exception& e) {
        std::cerr << "[BackendBuilder] Warning: could not remove build cache: " << e.what() << "\n";
    }

    return 0;
}
