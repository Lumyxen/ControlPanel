// backend/src/services/backend_builder.cpp
#include "services/backend_builder.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <cstdlib>
#include <cstdint>
#include <curl/curl.h>

#ifndef _WIN32
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

static bool hasCommand(const std::string& cmd) {
#ifdef _WIN32
    return system(("where " + cmd + " > NUL 2>&1").c_str()) == 0;
#else
    return system(("command -v " + cmd + " > /dev/null 2>&1").c_str()) == 0;
#endif
}

struct DownloadCtx {
    std::ofstream* logStream;
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
        // Log every 2% to make the progress bar smooth while preventing IO spam
        if (percent != ctx->lastPercent && (percent % 2 == 0 || percent == 100)) {
            if (ctx->logStream && ctx->logStream->is_open()) {
                *(ctx->logStream) << "[download " << percent << "% complete]\n";
                ctx->logStream->flush();
            }
            ctx->lastPercent = percent;
        }
    }
    return 0;
}

static int downloadWithProgress(const std::string& url, const std::string& outputPath, const std::string& logPath) {
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
    const fs::path tarPath  = srcDir / ("llama.cpp-" + llamaTag + ".tar.gz");
    const std::string url   = "https://github.com/ggml-org/llama.cpp/archive/" + llamaTag + ".tar.gz";

    fs::create_directories(srcDir);
    fs::create_directories(outDir);

    {
        std::ofstream log(logPath, std::ios::trunc);
        log << "==============================\n"
            << "[BackendBuilder] Building : " << backend << "\n"
            << "[BackendBuilder] Tag      : " << llamaTag << "\n"
            << "==============================\n";
    }

    // ── Download source ───────────────────────────────────────────────────────
    if (!fs::exists(tarPath)) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Downloading source from " << url << "\n";
        if (downloadWithProgress(url, tarPath.string(), logPath) != 0) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Download failed\n";
            return 1;
        }
    } else {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Using cached source archive\n";
    }

    // ── Extract source ────────────────────────────────────────────────────────
    const fs::path extractDir = srcDir / ("llama.cpp-" + llamaTag);
    if (!fs::exists(extractDir)) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Extracting source\n";
        if (runCmd("tar -xzf \"" + tarPath.string() + "\" -C \"" + srcDir.string() + "\"", logPath) != 0) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Extraction failed\n";
            return 1;
        }
    } else {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Using cached extracted source\n";
    }

    // Move the extracted directory to a standard name
    const fs::path llamaSrcDir = srcDir / "llama_src";
    if (!fs::exists(llamaSrcDir)) {
        try {
            fs::rename(extractDir, llamaSrcDir);
        } catch (const std::exception& e) {
            std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Failed to rename extracted directory: " << e.what() << "\n";
            return 1;
        }
    }

    if (writeCMakeLists(srcDir.string(), backend, llamaTag).empty()) {
        std::ofstream(logPath, std::ios::app) << "[BackendBuilder] Failed to write CMakeLists.txt\n";
        return 1;
    }

    // ── cmake configure ───────────────────────────────────────────────────────
    int ret = runCmd(
        "cd \"" + srcDir.string() + "\" && cmake -B \"" + cmakeBin.string() + "\""
        " -S \""       + srcDir.string()  + "\""
        " -DCMAKE_BUILD_TYPE=Release"
        " "            + cmakeArgs(backend)
        +                compilerEnv(backend),
        logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake configure failed\n"; return ret; }

    // ── cmake build (memory and CPU aware parallel) ────────────────────────
    const int optimalJobs = calculateOptimalJobs();
    std::cout << "[BackendBuilder] Building with " << optimalJobs << " parallel jobs\n";
    ret = runCmd("cmake --build \"" + cmakeBin.string() + "\" --target llama --parallel " + std::to_string(optimalJobs), logPath);
    if (ret != 0) { std::cerr << "[BackendBuilder] cmake build failed\n"; return ret; }

    // ── Copy libraries natively using C++ filesystem ──────────────────────────
    try {
        for (const auto& entry : fs::recursive_directory_iterator(cmakeBin)) {
            if (entry.is_regular_file() || entry.is_symlink()) {
                const std::string ext = entry.path().extension().string();
                if (ext == ".so" || ext == ".dll" || ext == ".dylib") {
                    // Ignore transient cmake check files
                    if (entry.path().string().find("CMakeFiles") == std::string::npos) {
                        fs::path dest = outDir / entry.path().filename();
                        
                        // Explicitly unlink the destination first to prevent 
                        // segmentations faults if the library is currently dlopen'd.
                        if (fs::exists(dest)) {
                            fs::remove(dest);
                        }
                        
                        fs::copy_file(entry.path(), dest, fs::copy_options::overwrite_existing);
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

    try {
        fs::remove_all(fs::path(buildCacheDir));
    } catch (const std::exception& e) {
        std::cerr << "[BackendBuilder] Warning: could not remove build cache: " << e.what() << "\n";
    }

    return 0;
}
