#!/usr/bin/env bash
# Type-check the Rust crate and its tests for macOS from another platform.
#
# `cargo check` never links, so no Apple SDK or cross toolchain is needed:
# build scripts that compile C only need a "compiler" and "archiver" that
# create their output files. This catches type and borrow errors in
# `cfg(target_os = "macos")` code, which is otherwise never compiled on
# Linux. It does not link, run or test anything: behaviour still needs a Mac.
#
# Needs the Rust target once: rustup target add aarch64-apple-darwin
set -euo pipefail

target="${NOTATION_MACOS_TARGET:-aarch64-apple-darwin}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! rustup target list --installed 2>/dev/null | grep -qx "$target"; then
  echo "Rust target $target is not installed. Run: rustup target add $target" >&2
  exit 2
fi

tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT

cat > "$tools/cc" <<'TOOL'
#!/usr/bin/env bash
# Stand-in C compiler: create the requested output and succeed.
out=""; prev=""
for arg in "$@"; do
  [ "$arg" = "-E" ] && exit 0
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
done
[ -n "$out" ] && : > "$out"
exit 0
TOOL
cat > "$tools/ar" <<'TOOL'
#!/usr/bin/env bash
# Stand-in archiver: create the archive and succeed.
for arg in "$@"; do case "$arg" in *.a) : > "$arg" ;; esac; done
exit 0
TOOL
chmod +x "$tools/cc" "$tools/ar"

key="${target//-/_}"
export "CC_$key=$tools/cc" "CXX_$key=$tools/cc" "AR_$key=$tools/ar"
cargo check --manifest-path "$root/src-tauri/Cargo.toml" --features desktop --tests --target "$target" "$@"
