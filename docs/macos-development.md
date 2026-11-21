# macOS development audit (issue #41)

The [README setup sequence](../README.md#macos-development) prepares a host
development checkout. The audit below was prepared from Linux. Since issue #54
a CI workflow builds, ad-hoc signs and launches the macOS app (see
[Continuous integration](#continuous-integration)); no Developer ID signed or
notarized DMG is produced.

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
either host output as universal.

## Continuous integration

`.github/workflows/macos.yml` is currently **disabled by the repository owner**.
It does not run on pull requests; it only runs if the owner re-enables or
dispatches it, and pull requests are gated on local checks. Code under
`cfg(target_os = "macos")` merged since it was disabled has not been compiled by
it. When enabled, it runs on pull requests that touch app, native, test or
tooling files, and on demand (`workflow_dispatch`):

- **Build + launch smoke** on Apple Silicon (`macos-15`) and Intel
  (`macos-15-intel`): `scripts/setup-macos.py`, `npm run check`, the Python
  native suites, `npm run desktop:build`, a bundle check (minimum system
  version, ad-hoc signature, architecture), then a launch of the built
  executable in an isolated `HOME` that must stay alive for 20 seconds and
  create `state.sqlite3`. The DMG, launch log and a screenshot are uploaded.
- **Rust tests** (`cargo test`, core features) on Apple Silicon.
- **Playwright WebKit e2e**: the browser-mode suite against Playwright's WebKit
  build, the closest automatable stand-in for WKWebView. The `webkit` project
  is opt-in through `NOTATION_E2E_WEBKIT=1` because that build does not start
  on every Linux host.

A green run proves the app compiles, bundles, launches and that the browser
suite passes in WebKit. It does not exercise trackpad scrolling, the native
menu, window dragging, Finder integration or native dialogs; those still need a
person on a Mac.

## Signing and Gatekeeper

The bundle is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), which Apple
Silicon requires to run at all, and declares macOS 13.0 as its minimum system
version. It is not signed with a Developer ID and not notarized, so a DMG
downloaded through a browser is quarantined and Gatekeeper refuses it or calls
it damaged. After copying the app to `/Applications`, clear the quarantine
flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Notation.app
```

Alternatively, Control-click the app, choose Open, and confirm (on macOS 15,
allow it under System Settings → Privacy & Security). Developer ID signing and
notarization remain future work.

## Keyboard focus in WebKit

Two WebKit defaults on macOS differ from Chromium and WebKitGTK, and the app
is written so that neither matters:

- **A click does not focus a button.** Controls keep their key handling on the
  clicked button (Escape and arrows on a dropdown, arrows on section tabs and
  segmented options). `src/click-focus.ts` moves focus to a button after a
  pointer click in every engine, except where a control cancels the press to
  keep focus elsewhere (sticky-note formatting buttons, list options) or where
  the click's own handlers already moved focus. Dropdowns also take focus when
  they open, and Settings closes an open dropdown before it closes itself on
  Escape.
- **Tab skips buttons** unless the user turns on "Keyboard navigation" in
  System Settings (or presses Option+Tab). Nothing depends on Tab reaching a
  button: every command is reachable from the command palette shortcut and
  the native menu, menus and lists move focus with arrow keys through explicit
  `focus()` calls, dialogs focus their first field or tab when they open, and
  modal dialogs confine focus natively. The dialog focus traps only wrap Tab
  between the first and last focusable control and are inert when Tab never
  reaches them. Tests that count Tab stops on buttons are excluded from the
  WebKit run for this reason (`tests/e2e/webkit-exclusions.ts`).

Focus rings: after pointer input, controls focused by script keep focus without
a ring (WebKit matches `:focus-visible` there); any key press brings rings back.

