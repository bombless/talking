#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHISPER_DIR="${ROOT_DIR}/whisper.cpp"
BUILD_DIR="${WHISPER_DIR}/build"

cmake_args=(
  -S "${WHISPER_DIR}"
  -B "${BUILD_DIR}"
  -DGGML_CUDA=ON
  -DWHISPER_BUILD_TESTS=OFF
)

if [[ -n "${CUDA_ARCHITECTURES:-}" ]]; then
  cmake_args+=(-DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES}")
elif command -v nvidia-smi >/dev/null 2>&1; then
  cuda_arch="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d '.')"
  if [[ "${cuda_arch}" =~ ^[0-9]+$ ]]; then
    cmake_args+=(-DCMAKE_CUDA_ARCHITECTURES="${cuda_arch}")
  fi
fi

cmake "${cmake_args[@]}"
cmake --build "${BUILD_DIR}" -j --config Release --target whisper-cli
