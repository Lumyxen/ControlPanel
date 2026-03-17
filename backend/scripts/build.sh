#!/usr/bin/env bash
# To force a clean rebuild: ./build.sh --clean

set -euo pipefail
cd "$(dirname "$0")/.."   # cd into backend/

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

# ── Main binary ───────────────────────────────────────────────────────────────
echo "=== Building ctrlpanel ==="
mkdir -p build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target ctrlpanel     -j"$(nproc)"
cmake --build build --target ctrlpanel_exe -j"$(nproc)"

# ── ARM cross-compile (optional — requires aarch64-linux-gnu-g++) ─────────────
if command -v aarch64-linux-gnu-g++ &>/dev/null; then
    echo ""
    echo "=== Building ARM64 target ==="
    mkdir -p build-arm
    cmake -B build-arm \
        -DCMAKE_TOOLCHAIN_FILE=cmake/aarch64-toolchain.cmake \
        -DCMAKE_BUILD_TYPE=Release
    cmake --build build-arm --target ctrlpanel_arm -j"$(nproc)"
    cp build-arm/ctrlpanel_arm build/ctrlpanel_arm
    rm -rf build-arm
fi

echo ""
echo "=== Done ==="
echo "  build/ctrlpanel      (Linux x86)"
echo "  build/ctrlpanel.exe  (Windows)"
[[ -f "build/ctrlpanel_arm" ]] && echo "  build/ctrlpanel_arm  (ARM64)"
echo ""
