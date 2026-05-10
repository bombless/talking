#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$ROOT_DIR/qwen3-tts.cpp"
GGML_DIR="$PROJECT_DIR/ggml"
GGML_BUILD_DIR="$GGML_DIR/build"
BUILD_DIR="$PROJECT_DIR/build"

JOBS="${JOBS:-$(command -v nproc >/dev/null 2>&1 && nproc || sysctl -n hw.ncpu)}"

git -C "$PROJECT_DIR" submodule update --init --recursive

ggml_cmake_args=("-DCMAKE_BUILD_TYPE=Release")
if [[ "$(uname -s)" == "Darwin" ]]; then
  ggml_cmake_args+=("-DGGML_METAL=ON")
fi

cmake -S "$GGML_DIR" -B "$GGML_BUILD_DIR" "${ggml_cmake_args[@]}"
cmake --build "$GGML_BUILD_DIR" -j"$JOBS"

cmake -S "$PROJECT_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" -j"$JOBS"
