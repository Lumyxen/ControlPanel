#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "=== Building all targets ==="

# Clean and configure
rm -rf build
cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_LLAMACPP=ON \
    -DENABLE_LLAMACPP_VISION=ON

# Build x86 Linux + Windows targets
cmake --build build --target ctrlpanel -j$(nproc)
cmake --build build --target ctrlpanel_exe -j$(nproc)

# ARM — needs separate build dir with toolchain, then copy result into build/
rm -rf build-arm
cmake -B build-arm \
    -DCMAKE_TOOLCHAIN_FILE=cmake/aarch64-toolchain.cmake \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_LLAMACPP=ON \
    -DENABLE_LLAMACPP_VISION=ON
cmake --build build-arm --target ctrlpanel_arm -j$(nproc)

# Copy ARM binary into the main build dir
cp build-arm/ctrlpanel_arm build/ctrlpanel_arm

# Clean up ARM build dir
rm -rf build-arm

echo ""
echo "=== Done ==="
echo "  build/ctrlpanel        (x86 Linux)"
echo "  build/ctrlpanel.exe    (Windows)"
echo "  build/ctrlpanel_arm    (ARM64)"