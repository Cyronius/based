#!/usr/bin/env bash
# Run based in the current official Servo demo shell, independently of the older Tauri adapter.
set -euo pipefail
based_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$based_root"

based_bun="$(command -v bun || true)"
if [[ -z "$based_bun" && -x shell-tauri/dist-core/bun/bun ]]; then
  based_bun="$based_root/shell-tauri/dist-core/bun/bun"
fi
if [[ -z "$based_bun" ]]; then
  echo "The latest Servo preview needs Bun on PATH." >&2
  exit 1
fi
export PATH="$(dirname "$based_bun"):$PATH"

build_prefix=()
run_prefix=()
if command -v dibs >/dev/null; then
  dibs status
  build_prefix=(dibs run build network --label "Prepare based with current Servo" --eta 10m --)
  run_prefix=(dibs run gpu --label "Preview based in current Servo" --eta 2h --)
fi
"${build_prefix[@]}" bash -c '"$1" run --cwd ui build --mode servo-latest && "$1" scripts/servo-latest.ts --prepare' -- "$based_bun"
if [[ "${1:-}" == --build-only ]]; then
  exit 0
fi
exec "${run_prefix[@]}" "$based_bun" scripts/servo-latest.ts "$@"
