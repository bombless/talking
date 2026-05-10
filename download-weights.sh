#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$ROOT_DIR/qwen3-tts.cpp"

exec python3 "$PROJECT_DIR/scripts/setup_pipeline_models.py" \
  --coreml off \
  "$@"
