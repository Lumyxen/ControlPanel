#!/usr/bin/env bash
# To force a clean rebuild: ./build.sh --clean
# To build only the Linux x86 binary: ./build.sh --test
#
# Build parallelism is automatically adjusted based on available system memory
# and CPU cores to prevent OOM crashes while maintaining good build speeds.

set -euo pipefail
cd "$(dirname "$0")/.."   # cd into backend/

# Calculate optimal number of parallel jobs based on memory and CPU
# Uses a memory-first approach: ~1.5GB per job, leaves 2GB for system
calculate_jobs() {
    local cores
    cores=$(nproc)
    
    # Get available memory in MB (Linux)
    local mem_available_mb=0
    if [[ -f /proc/meminfo ]]; then
        local mem_available_kb
        mem_available_kb=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
        mem_available_mb=$((mem_available_kb / 1024))
    fi
    
    # Calculate jobs based on memory (leave 2GB for system)
    local mem_based_jobs=2
    if [[ $mem_available_mb -gt 2048 ]]; then
        local usable_mb=$((mem_available_mb - 2048))
        mem_based_jobs=$((usable_mb / 1500))
    fi
    
    # Calculate jobs based on CPU (leave 1 core for system)
    local cpu_based_jobs=$((cores - 1))
    [[ $cpu_based_jobs -lt 2 ]] && cpu_based_jobs=2
    
    # Use minimum but cap based on available memory
    local jobs=$((mem_based_jobs < cpu_based_jobs ? mem_based_jobs : cpu_based_jobs))
    
    # Cap at memory-based maximum (2GB per job)
    local mem_cap=$((mem_available_mb / 2048))
    [[ $mem_cap -lt 2 ]] && mem_cap=2
    [[ $mem_cap -gt 16 ]] && mem_cap=16
    
    [[ $jobs -gt $mem_cap ]] && jobs=$mem_cap
    [[ $jobs -lt 2 ]] && jobs=2
    
    echo "$jobs"
}

BUILD_JOBS=$(calculate_jobs)
echo "=== Using $BUILD_JOBS parallel build jobs ==="

for arg in "$@"; do
    if [[ "${arg}" == "--clean" ]]; then
        echo "=== --clean: removing build directory ==="
        rm -rf build build-arm
    fi
done

# ── Ensure httplib is present ─────────────────────────────────────────────────
if [ ! -f "third_party/httplib/httplib.h" ]; then
    echo "=== Fetching cpp-httplib (missing from third_party) ==="
    mkdir -p third_party/httplib
    if command -v curl &>/dev/null; then
        curl -sL "https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.38.0/httplib.h" -o "third_party/httplib/httplib.h"
    elif command -v wget &>/dev/null; then
        wget -qO "third_party/httplib/httplib.h" "https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.38.0/httplib.h"
    else
        echo "ERROR: Neither curl nor wget is available to download httplib.h"
        exit 1
    fi
fi

# Check if --test flag is provided
TEST_BUILD=false
for arg in "$@"; do
    if [[ "${arg}" == "--test" ]]; then
        TEST_BUILD=true
    fi
done

# ── Main binary ───────────────────────────────────────────────────────────────
echo "=== Building ctrlpanel ==="
mkdir -p build
cmake -B build -DCMAKE_BUILD_TYPE=Release

if [[ "$TEST_BUILD" == true ]]; then
    echo "=== --test: building only Linux x86 binary ==="
    cmake --build build --target ctrlpanel -j"$BUILD_JOBS"
else
    cmake --build build --target ctrlpanel     -j"$BUILD_JOBS"
    cmake --build build --target ctrlpanel_exe -j"$BUILD_JOBS"

    # ── ARM cross-compile (optional — requires aarch64-linux-gnu-g++) ─────────────
    if command -v aarch64-linux-gnu-g++ &>/dev/null; then
        echo ""
        echo "=== Building ARM64 target ==="
        mkdir -p build-arm
        cmake -B build-arm \
            -DCMAKE_TOOLCHAIN_FILE=cmake/aarch64-toolchain.cmake \
            -DCMAKE_BUILD_TYPE=Release
        cmake --build build-arm --target ctrlpanel_arm -j"$BUILD_JOBS"
        cp build-arm/ctrlpanel_arm build/ctrlpanel_arm
        rm -rf build-arm
    fi
fi

echo ""
echo "=== Done ==="
if [[ "$TEST_BUILD" == true ]]; then
    echo "  build/ctrlpanel      (Linux x86 - test build)"
else
    echo "  build/ctrlpanel      (Linux x86)"
    echo "  build/ctrlpanel.exe  (Windows)"
    [[ -f "build/ctrlpanel_arm" ]] && echo "  build/ctrlpanel_arm  (ARM64)"
fi
echo ""
