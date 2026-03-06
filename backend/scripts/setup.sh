#!/bin/bash
set -e

echo "Setting up dependencies for ctrlpanel_backend..."

# Create third_party directory
mkdir -p third_party
cd third_party

# Download httplib (header-only HTTP library)
if [ ! -d "httplib" ]; then
    echo "Downloading httplib..."
    git clone https://github.com/yhirose/cpp-httplib.git
fi

cd ..

echo "Dependencies installed!"
echo ""
echo "To build:"
echo "  mkdir build && cd build"
echo "  cmake .."
echo "  make -j\$(nproc)"
echo ""
echo "To run:"
echo "  ./ctrlpanel_backend"
