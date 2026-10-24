# Memory and performance report — 2026-10-24

The changes reduce retained editor views and rendering work, fix a recovered
document retention bug, and add an optional Performance mode. They **do not
establish a hard RAM budget or make every workload use less memory**. Language
servers are the largest optional expense measured; without them, WebKit is the
largest process in the heavy editing workload.

## Test conditions

- Linux release AppImage, real WebKitGTK, disposable profiles. Measurements
  cover Notation and its descendant processes, excluding WebDriver.
- Ryzen 5 9600X, about 30.4 GiB physical RAM, Arch Linux kernel 7.2.11.
  Each native test had an aggregate two-core CPU quota. Other workstation
  tasks were running. This is not a simulation of an old laptop.
- PSS is proportional resident memory: shared pages are apportioned rather
  than counted fully in each process. RSS was also recorded. Values below
  use MiB (1,048,576 bytes). Samples were taken once per second and at named
  phases; shorter peaks can be missed.
- One trial per configuration, plus six heavy reopen/close rounds on each
  new configuration. Timing and allocator variability prevent statistical
  performance claims. No overnight soak, memory quota, or physical 2–4 GB
  laptop test was performed.
- Baseline source: `53e0eff6d61e6433dd4ca8732c14375014cfab92`.
  New AppImage SHA-256:
  `90bf3599898dadc34da519d5a12b2c534a001f3ae1788b074ebbca1ea0b09227`.

## Common workload

Open 64 mixed Markdown/TypeScript/Svelte/Rust/text tabs, including a 60,000-line
TypeScript file (1,957,780 bytes), type and save, check the tab limit, idle,
close 63 tabs, perform 12 open/close cycles, open a 1,200-section Markdown
document (148,907 bytes), open a near-limit text file (4,194,164 bytes), reject
an oversized file, then close the stress files and settle for ten seconds.
Language intelligence is disabled. Performance mode shows Markdown source
instead of rendering its preview, intentionally doing less work.

| Measurement | Previous build | New normal | Performance mode |
| --- | ---: | ---: | ---: |
| Sampled peak PSS over common workload | 1,023.8 MiB | 957.3 MiB | 902.9 MiB |
| PSS with 64 tabs after idle | 703.0 MiB | 619.7 MiB | 633.7 MiB |
| PSS at Markdown phase | 650.5 MiB | 677.3 MiB | 537.4 MiB |
| PSS at near-4-MiB text phase | 923.0 MiB | 957.3 MiB | 660.2 MiB |
| PSS after closing stress files and settling | 492.0 MiB | 537.2 MiB | 563.1 MiB |
| Open 63 files | 2.396 s | 2.055 s | 1.719 s |
| Typing to next frame, median / p95 | 65 / 114 ms | 53 / 68 ms | 51 / 58 ms |
| Idle CPU, percent of one core over five seconds | 0.20% | 1.59% | 0.80% |

The common-workload peak was about 6.5% lower in new normal and 11.8% lower in
Performance mode than the previous build. Typing was faster in these trials.
Normal mode's post-close footprint was higher than the previous build, and
Performance mode was not lower at every phase. A cold-start memory improvement
is not established: the Performance-mode test opens Settings to enable it before
its initial measurement, unlike the other runs.

## Repeated heavy workload

Each round reopens the large code file, Markdown document and near-limit text
file, closes all three, and settles for three seconds. The default configuration
keeps at most one editor view mounted. Both new configurations passed six
rounds; the previous build was not run through this extension.

| Measurement | New normal | Performance mode |
| --- | ---: | ---: |
| Peak PSS across entire test including repeated rounds | 1,105.1 MiB | 1,239.9 MiB |
| Peak summed RSS across entire test | 1,245.1 MiB | 1,379.3 MiB |
| PSS after first heavy round closes | 617.8 MiB | 619.9 MiB |
| PSS after sixth heavy round closes | 644.3 MiB | 591.8 MiB |

**Performance mode had the higher worst-case peak in this repeated workload.**
It reduces syntax/rendering/server work but retains document buffers, undo and
recovery persistence. Runtime allocation, collection and persistence still
produce substantial transient memory. The short measurements do not identify
the exact allocator responsible for the higher peak or establish a stable
long-session plateau.

## What consumes the RAM?

At new normal's near-limit phase, the 957.3 MiB total consisted of about
652.3 MiB WebKit content process, 267.2 MiB native Notation process, and
37.8 MiB WebKit network process. These are process totals, not allocation-level
attribution: the content process includes JavaScript, editor state, DOM,
rendering and runtime allocations; the native process includes GTK/Tauri,
storage/IPC and allocator overhead.

An additional packaged smoke test enabled real TypeScript, Svelte and Rust
intelligence and waited for diagnostics/formatting before sampling:

| Process group | PSS |
| --- | ---: |
| Rust analyzer | 552.1 MiB |
| TypeScript and Svelte Node processes combined | 525.0 MiB |
| WebKit content process | 231.5 MiB |
| Native Notation | 139.0 MiB |
| WebKit network process | 35.3 MiB |
| Total | 1,482.9 MiB |

Language-server processes alone held **1,077.1 MiB**, about 73% of this snapshot.
This is one small multi-language fixture, not a universal server memory limit;
larger projects can behave differently. These processes are absent by default.
The test verified that enabling Performance mode stops all three server
sessions and disabling it restores them while preserving unsaved cross-file
edits and the user's intelligence preference.

Application-owned live data includes open text and saved baselines, undo
history, editor state, the active preview/parser, notebook outputs and caches.
Visited inactive tabs release their view DOM/plugins but retain text and undo.
Explicit opt-in language intelligence retains connected views for cross-file
operations. Closed notebooks clear output records. See
[the memory inventory](memory-retention.md) for limits and lifetimes.

## Retention proof and disk cache

A forced-GC Chromium regression test repeated six rounds of opening and closing
four 8,000-line TypeScript files. Closed-round DOM/listener/view counts stayed
at 1,798 / 90 / 1. The heap grew about 0.78 MiB from the second closed round to
the sixth, with diminishing increments; it did not return fully to startup.
This measures reachable browser memory, separately from native WebKit PSS.

A restored-session fixture exposed a real retained startup snapshot. Removing
the full document array from startup props and the module's awaited result
allowed about **3.44 MiB** to be collected after closing its eight restored
documents. A heap snapshot traced the original reference path.

Advanced diagram SVGs now use a 2 MiB RAM budget and an optional 32 MiB logical
IndexedDB disk budget, each limited to 16 entries. Seven-day expiry is enforced
on use, not by a background timer. The cached SVG can contain document text;
the hashed key is not encryption. Storage failure falls back to regeneration.

Drafts, sessions and revision history already persist to disk. Open text and
undo are **not swapped out** in this release. That needs safe asynchronous
hydration across editing, search and agent operations; evicting them without
that infrastructure risks losing undo or edits.

## Remaining optimization targets

The subsequent [persistence allocation follow-up](persistence-performance.md)
measures the first target and removes redundant comparison/metadata work.
The measurements above describe the earlier build and are unchanged.

1. Profile session/draft serialization and native IPC allocation. Current
   recovery writes serialize document content into the webview recovery store
   and debounce SQLite persistence. Full snapshots create transient copies;
   measuring and then changing persistence granularity is the next useful
   investigation. These measurements do not prove how much of native PSS it
   accounts for.
2. Design safe inactive-buffer and undo hydration before moving editable data
   to disk. The existing 64-tab / 4-MiB-per-file caps remain; Performance mode
   does not impose stricter caps.
3. Consider disk-backed notebook outputs with consistent downstream-cell input
   hydration. Outputs remain intentionally available while notebooks are open.
4. Run an hours-long soak and repeated trials under a realistic memory budget,
   including real low-end hardware. Explicit graph/export/notebook work can
   still be expensive in Performance mode.

For a minimum-spec machine, Performance mode and disabled intelligence reduce
optional work. The tested heavy workload still reached roughly 1.2 GiB PSS;
this is not evidence that a 2-GB machine will handle it comfortably alongside
the OS and other applications.

## Validation and evidence

- Passed: Svelte/TypeScript check (zero errors/warnings), store, documents,
  preferences, workspace, code-editor unit suites and document-count regression.
- Browser run: 44 of 45 passed initially; the scroll restoration failure was
  fixed. The subsequent focused residency/tabs/retention run passed all nine
  tests, including that regression. Covered cache failure/eviction, inactive
  guarded edits, undo/selection/scroll, settings and mode behavior.
- Passed: release AppImage build, previous-build common stress workload, both
  new six-round packaged stress runs, and packaged TS/Svelte/Rust intelligence
  smoke including suspension/resume and guarded saves.
- Independent cache security review completed and its findings were addressed.
  The general GLM challenger was unavailable due to provider HTTP 402; no
  completed independent general review is claimed.
- Rust unit suite was not rerun (no Rust source changed). No CI was added.

Raw local evidence is outside the repository at
`/home/esshi/Coding/notation-builds/2026-10-24-memory/`:
`baseline-close-buttons/`, `optimized-normal/`, `optimized-performance/`,
`intelligence/`, and `logs/`. Native reports include per-phase process memory
and sampled resources; the regression sources live under `tests/e2e/` and
`tests/native/`. Reproduction commands are in
[memory-retention.md](memory-retention.md#reproduce).
