# Notation usability audit — 2026-10-25

Issue: [#7](https://github.com/esshi1337/notation/issues/7). Independent reviewer: GLM Flash (`opencodex/zai/glm-5.3-flash`), read-only source with fixed local check commands. The advisor inspected the implementation and checked the review evidence. No CI was used.

## Exact scope

- Merged main: [`62f2e2e`](https://github.com/esshi1337/notation/commit/62f2e2ec7ab0f6b98749fd3f1b909732af5f9240), including built-in themes, user CSS/themes, Canvas interactions and note linking ([PRs #10](https://github.com/esshi1337/notation/pull/10), [#11](https://github.com/esshi1337/notation/pull/11), [#12](https://github.com/esshi1337/notation/pull/12), [#13](https://github.com/esshi1337/notation/pull/13)).
- Audited tree: [`57ed070`](https://github.com/esshi1337/notation/commit/57ed07092e8f69c3ed80335a9f350394ab811d4e), adding the unmerged sticky implementation in [draft PR #14](https://github.com/esshi1337/notation/pull/14).

Review covered CSS validation/import/recovery, Canvas gesture cancellation and stale edits, note-search/navigation errors, sticky SQLite migration and bounds, caller authorization, window admission/close races, autosave ordering, and listener/timer cleanup.

## Findings and disposition

GLM found no confirmed blocker in the theme, note-navigation, or sticky-core changes. The audit identified one file-drop handling gap and two nonblocking observations:

1. **File drops outside the Canvas viewport:** toolbar, inspector and surrounding app surfaces did not cancel the event default. The advisor reproduced `defaultPrevented: false`; a CDP file drag did **not** reproduce navigation in headless Chromium. The impact is therefore recorded as uncancelled unsupported drops, not proven navigation or data loss. [Issue #15](https://github.com/esshi1337/notation/issues/15) adds a capture guard, actionable Open/Add card guidance, and regression coverage. The fix is in [PR #16](https://github.com/esshi1337/notation/pull/16), reviewed at source commit `07d92c5` (final screenshot-only commit `3526c94`). Its 26 Canvas browser tests and Svelte check pass. GLM accepted the guard and cleanup, independently passing Canvas7 and check0. Real OS drag delivery/guidance remains unverified; capture also intentionally cancels file drops onto file-picker inputs, while choosing files through the picker remains available.
2. **Settings merge bound:** the native store bounds the incoming settings object but not the combined old/new object. GLM verified that the shipped frontend re-sends the complete merged settings, so it did not establish a reachable frontend defect. No speculative hardening change was made.
3. **Delete immediately after sticky close:** deletion can briefly be refused until the native Destroyed event releases the reservation. Retrying succeeds; the refusal protects an open note. No change was required.

Before the final audit, the advisor reproduced a sticky load-retry race: two pending reads could let a late response overwrite newly entered text. The final implementation permits one load at a time and disables Retry during loading. A browser regression queues two Retry clicks with delayed reads and verifies that fresh input remains saved. The separate reproduction now retains fresh input. This was fixed within issue #6 before the audited commit.

## Exact validation

| Check | Result | Executor |
| --- | --- | --- |
| `scripts/notation-review-check check` | 0 errors, 0 warnings | GLM |
| `scripts/notation-review-check canvas` | 7 passed | GLM |
| `scripts/notation-review-check preferences` | 30 passed | GLM |
| `scripts/notation-review-check workspace` | 9 passed | GLM |
| `scripts/notation-review-check native` | 23 passed, 5 failed; stopped at engine tests | GLM |
| Focused Playwright: Canvas, wiki links, sticky notes | 37 passed (25 + 4 + 8) | Advisor |
| Core Rust: `--no-default-features --test sticky --test sqlite --test launch` | 36 passed (8 + 18 + 10) | Advisor and implementer |
| Desktop `cargo check --features desktop --locked` | Passed in disposable source copy using an official WebKitGTK 4.1 package extracted for pkg-config | Implementer |
| Production frontend build | Passed; existing chunk-size warning | Implementer |

The five native failures all stop at the missing pinned engine-fixture assertion in `src-tauri/tests/engines.rs:16`. They concern offline diagrams, conversion, citations, confinement, and export-error handling. Fixtures were not provisioned for this run; these checks are **not passing**. The suite stopped before later integration binaries, so their results cannot be inferred from this run. The focused sticky/SQLite/launch run above was executed separately against the final source.

## Remaining verification

Sticky notes remain **draft and unmerged** under the user's instruction to leave uncertain work in draft. Actual Linux native window creation, always-on-top/focus, independence when minimizing the main window, close events, and AppImage packaging were not verified. Browser native-command tests use mocks; Rust type checking does not establish native runtime behavior. The system itself lacks WebKitGTK 4.1; temporary dependency extraction did not install system packages.

Tauri native drag interception may affect HTML5 text drops; real packaged-app drag/drop behavior remains unverified. The file-drop guard does not establish native drag behavior.

The full browser suite was not repeated for this final audit. There was no runtime heap profile or general proof of leak freedom. Static cleanup review and focused state/lifecycle tests support only the cases they exercise.
