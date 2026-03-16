#!/usr/bin/env bash
# backend/scripts/build.sh
#
# Builds the ctrlpanel binary ONLY.
#
# The binary has zero link-time dependency on llama.cpp. GPU backends are
# separate shared libraries in data/libs/ that are built on-demand — either
# manually via build_backend.sh or through the in-app prompt that appears
# on first launch when the server detects usable GPU hardware.
#
# To force a clean rebuild: ./build.sh --clean

set -euo pipefail
cd "$(dirname "$0")/.."   # cd into backend/

for arg in "$@"; do
    if [[ "${arg}" == "--clean" ]]; then
        echo "=== --clean: removing build directory ==="
        rm -rf build build-arm
    fi
done

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