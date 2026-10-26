# macOS development audit (issue #41)

The [README setup sequence](../README.md#macos-development) prepares a host
development checkout. This is preparation from Linux, not evidence of a working
macOS build. No macOS executable, signed app or notarized DMG was produced.

## Platform boundaries

| Area | Audit/result |
| --- | --- |
| Cargo | `landlock` is a Linux-target dependency; it must not compile on Darwin. The lockfile pins the same dependency versions. |
| Engine sandbox | `engine_process::restrict`, seccomp BPF, `prctl`, Linux syscall constants and Landlock are Linux-gated. Other platforms return an error before engine execution. No PATH fallback or alternate unsandboxed engine route was added. |
| Engine memory | `/proc/<pid>/status` is Linux-specific. The engine supervisor cannot successfully execute an engine on macOS because the worker rejects the missing sandbox. No macOS memory-limit equivalence is claimed. |
| Unix APIs | Unix file modes, `openat`, nonblocking regular-file reads, process groups, Unix sockets and `poll` also exist on macOS. They should not be changed to Linux-only indiscriminately. |
| Profile ownership | `instance.rs` uses `/proc/self/fd`, `ucred`, `SO_PEERCRED` and Linux socket flags, but the entire module and its desktop call sites are already Linux-gated. No macOS ownership substitute is implemented. |
| Automation | `/proc/.../children` descendant traversal is already Linux-gated. Scripts are explicitly trusted, opt-in and unsandboxed on every platform; no sandbox bypass was added. macOS command-descendant cleanup and lifecycle remain unverified. Keep scripts off for initial development. |
| Language servers | The optional installer pins a Linux x86-64 Node archive and uses `/proc/self/fd` for safe publication. Both install and publication reject unsupported hosts rather than weakening publication safety. macOS runtime rejects copied TypeScript/Svelte packs. Rust uses the host `rust-analyzer` and does not use this pack. |
| Language resource path | macOS's prospective pack location follows Tauri's `~/Library/Application Support/local.notation.app/language-servers`; Linux retains its XDG path. No macOS pack is installed. |
| Tauri resources | Existing resource mapping puts the disabled manifest in `engines/` inside the app resource directory. Runtime discovery already tries that location, then the source resource directory in debug builds. No Linux `APPDIR` is needed on macOS. |
| Packaging | Tauri automatically merges `tauri.macos.conf.json` to select `app` and `dmg`. The native CLI returns through the Darwin route before `patchelf`, `pkg-config`, GStreamer, JRE library paths, AppImage discovery or linuxdeploy. |

The setup stub is architecture-specific and contains no executables, scripts,
fonts, licenses or remote assets. Preflight requires exactly that manifest and
no additional files. It rejects unknown manifests, Linux packs, other host
architectures and symlinks without deleting or overwriting them. Move an old
resource directory aside explicitly before repeating setup. Setup does not
download any engine resources or introduce new checksum assertions.

## Local validation and remaining work

`tests/native/macos_platform_test.py` mocks Darwin on Linux to test Intel/Apple
Silicon detection, prerequisite checks, setup ordering, resource preservation,
platform config, native CLI routing and unsupported installer failures. Existing
packaging tests cover the Linux helper behavior and language-pack publication.
To run the Python suites in a suitably bounded external test harness:

```sh
python3 tests/native/macos_platform_test.py
python3 tests/native/packaging_test.py
python3 tests/native/language_packaging_test.py
```

The fixed external `notation-review-check native` runs Rust core tests;
`notation-review-check check` runs Svelte/TypeScript diagnostics. Neither runs
these Python tests or proves macOS compilation. Do not modify harness policy to
route the Python commands.

On a Mac, first follow README setup, then verify editing, save/reopen, recovery,
native dialogs, app-data placement, and errors for unavailable features. Close
the one profile instance before relaunching. Test native scripts and language
server termination separately before relying on them. Later validate
`npm run desktop:build` on each desired host architecture. Signing/notarization
and any distributable validation are separate future work; do not represent
either host output as universal. No CI is configured or requested.
