# Persistence allocation follow-up — 2026-10-24

This follows [the memory report](performance-report.md). The bounded change
removes redundant recovery comparison strings and avoids loading document bodies
when refreshing navigation metadata. Native serialization experiments did not
improve write-phase memory and were reverted. This does not replace whole-session
snapshots, swap out open buffers, or establish a total RAM budget.

## Changes and invariants

- Recovery comparison checks ordered tab IDs, names, paths, content and the
  normalized Hemingway flag directly. Selection, active tab and saved baselines
  retain their previous comparison semantics. An older successful retry cannot
  clear recovery for a newer content edit.
- `metadata_summary` reads only workspace selection, workspace catalog and
  recent files. Refreshing recents no longer loads/parses/returns the session,
  active draft, script draft, settings or script library. Startup still uses
  the full bootstrap command.
- SQLite schema, recovery representation, limits, revision behavior and
  transaction rollback are unchanged. No document buffers or undo are evicted.

## Frontend allocation probe

`tests/persistence-profile.mjs` loads the real store through Vite in Node
v22.23.3, with simulated native IPC and storage. Its fixture has eight tabs,
524,288 characters each, including quotes, backslashes, newlines and Unicode;
each tab has a saved baseline and the active tab also has a draft. Counters
measure JSON characters, not UTF-8 bytes, actual wire framing or native memory.
Three paired runs compared source at `98889f5` with the changed source.

| Phase | Before | After |
| --- | ---: | ---: |
| Matching startup: store stringify characters | 9,103,778 | 0 |
| Matching recovery retry: store stringify characters | 9,103,790 | 4 |
| Five navigation refreshes: response characters | 51,210,440 | 420 |
| Twenty selection-only updates: store stringify characters | 204,838,640 | 204,838,640 |

The four remaining retry characters encode `null` when clearing pending
recovery. Median times across the three runs were 44.49 → 36.87 ms for startup,
24.00 → 10.03 ms for retry and 111.08 → 1.25 ms for five summaries. These are
small local samples with a simulated boundary, not desktop latency promises.
Forced-GC retained heap stayed essentially unchanged (roughly 34.4 MiB after
retry and summary). The removed strings are temporary allocations.

Selection-only writes still serialize full text plus saved baselines into the
recovery cache and send full snapshots to native persistence. That unchanged
path remains the next major target. Although its timings varied between runs,
this change does not establish an improvement to that path.

## Native measurement method

`tests/native/persistence_stress.py` drives real release AppImages through
WebKitWebDriver, with isolated XDG data/config/cache. Inside WebKit it creates
eight 512-Ki-character tabs with saved baselines, sends twelve sequential
session-plus-active-draft updates, then performs twenty navigation refreshes.
It verifies rejected-write atomicity directly in SQLite, reloads eight tabs,
types an unsaved suffix through CodeMirror, checks SQLite content and saved
baseline, then reloads and checks the suffix in the UI.

The test requests process-tree PSS samples every 50 ms, plus before/after each
phase; `/proc` enumeration adds time, so shorter peaks can be missed. The
sum includes Notation and descendant WebKit processes, excluding WebDriver.
Each invocation has an aggregate two-core CPU quota on the same workstation
as the earlier report. Other tasks were running, with no memory quota or
forced native GC. Timings cover awaited native calls; response-size counting
occurs outside their timing but within the sampled phase.

Two native serialization experiments were rejected. The first retained one
encoded buffer from validation through SQL; the second counted size without
retaining JSON and serialized after previous-session processing. Both produced
higher write-phase PSS in three trials. The accepted change preserves the
original native persistence writer; it only adds the metadata read endpoint.

| Twelve-write phase | Baseline | Reused-buffer experiment | Counting experiment |
| --- | ---: | ---: | ---: |
| Sampled peak PSS range, three runs | 503.8–546.0 MiB | 564.7–643.9 MiB | 582.2–645.6 MiB |

These small, sequential samples do not establish which allocator caused the
increase. They do not support shipping either serialization change as a memory
improvement. Experimental evidence remains in `native-optimized*/` and
`native-final-*/`; despite the latter's name, neither is the accepted artifact.

The accepted AppImage passed a separate native run (`native-accepted-1/`).
Twenty metadata refreshes returned 1,680 JSON characters in total, compared
with 204,855,920 for the baseline full-bootstrap path. Median awaited summary
time was below the timer's 1 ms resolution. Its sampled summary-phase peak
was 369.3 MiB, but that short phase had only one periodic sample.
The twelve-write phase had a 70 ms median and a 630.8 MiB sampled peak despite
retaining the original writer. This also exceeds the earlier baseline range:
the trials do not isolate a native serialization regression or demonstrate an
overall memory reduction. The supported gains are reduced comparison
serialization and smaller metadata responses.

Accepted artifact: `Notation-persistence-accepted.AppImage`, SHA-256
`f8b4f776869bec1b9ce8816f1a0c409189d51ba5efd6775664a6c298ed2443dc`.
Validation used this local artifact before installation or publication.

## Validation scope

- Passed: release AppImage build and the accepted artifact's native
  eight-tab persistence, rejected-write atomicity, unsaved edit, preserved
  saved baseline and reload checks. The directly seeded large fixture shows
  a cached-recovery banner on both baseline and changed builds; this test
  verifies stored/restored text, not absence of that banner.
- Passed: Svelte/TypeScript check with zero errors/warnings; store recovery
  (13 scenario groups), document (8) and workspace (9) feature scenarios;
  all 13 selected Chromium persistence/tab/workspace tests.
- Passed: all 15 Rust SQLite tests,
  including exact 32 MiB acceptance, rejection at one extra byte, escaped
  oversized drafts/scripts, rollback of revisions/settings/session, explicit
  null clearing and metadata reads with unrelated malformed draft JSON.
- The broader existing native SQLite/workspace smoke failed at clicking
  `Open note: alpha.md` with WebDriver `element not interactable`. This also
  reproduced on the unchanged baseline with a 1280×900 window; no pass is
  claimed for that suite. Its existing assertions were not changed.
- The first baseline profiling attempt lost the WebDriver connection while
  selecting the entire large document. The final harness appends through
  ordinary keyboard input and verifies exact SQLite content plus reload.
- Sol implementation, GLM challenger and GLM security-review attempts were
  unavailable due to upstream insufficient account funds. No completed
  independent model review is claimed; implementation and checks were local.
- No full Rust/browser suite, overnight soak, memory quota, physical low-end
  hardware test or inactive-buffer hydration change was performed.

## Reproduce

```sh
node --expose-gc tests/persistence-profile.mjs
npm run test:store
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --test sqlite
npx playwright test tests/e2e/persistence.spec.ts tests/e2e/tabs.spec.ts tests/e2e/workspaces.spec.ts --workers=2
python3 tests/native/persistence_stress.py --app /path/to/new.AppImage --output /short/evidence/new
python3 tests/native/persistence_stress.py --app /path/to/old.AppImage --output /short/evidence/old --legacy-summary
```

For the frontend baseline, extract `src/store.ts` and `src/storage.ts` from
the baseline revision to an ignored directory under the repository, then pass
the store's Vite-root-relative path as the profiler's first argument. Avoid
`test-results/`, which Playwright cleans at startup. Native tests require the
configured Tauri/WebKit drivers, a graphical session and a short `TMPDIR`;
run them serially. They create and remove their own disposable XDG profiles.

Raw local evidence lives outside the repository in
`/home/esshi/Coding/notation-builds/2026-10-24-persistence/`.
