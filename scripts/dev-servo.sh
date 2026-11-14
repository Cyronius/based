#!/usr/bin/env bash
# Build and run the separate experimental Servo shell with the real based frontend/backend.
set -euo pipefail
based_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$based_root"

# Optional machine-local toolchain setup. This file is ignored by Git.
if [[ -f shell-servo/target/env.sh ]]; then
  source shell-servo/target/env.sh
fi

based_bun="$(command -v bun || true)"
if [[ -z "$based_bun" && -x shell-tauri/dist-core/bun/bun ]]; then
  based_bun="$based_root/shell-tauri/dist-core/bun/bun"
fi
if [[ -z "$based_bun" ]] || ! command -v cargo >/dev/null; then
  echo "The Servo experiment needs Bun and Cargo on PATH. See shell-servo/README.md." >&2
  exit 1
fi
export PATH="$(dirname "$based_bun"):$PATH"

build_prefix=()
if command -v dibs >/dev/null; then
  dibs status
  build_prefix=(dibs run build network --label "Build based Servo experiment" --eta 20m --)
fi
"${build_prefix[@]}" bash -c '"$1" run --cwd ui build --mode servo && cargo build --locked --manifest-path shell-servo/Cargo.toml' -- "$based_bun"

if [[ "${1:-}" == --build-only ]]; then
  exit 0
fi
exec shell-servo/target/debug/based-shell-servo "$@"

