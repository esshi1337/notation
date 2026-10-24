# Memory retention and disk caching

Notation's document recovery store is persistent; that does not mean its open
buffers are disk-backed. Editing, undo, workspace search, agent edits and
language-server requests still use live document state.

## What stays in memory

| Data | Lifetime and cost | Disk treatment |
| --- | --- | --- |
| Open document text and saved baseline | Up to 64 tabs, each file limited to 4 MiB of UTF-8. Strings may share storage until edited; JavaScript representation and parsing add overhead. | Draft/session recovery already persists to SQLite on desktop, with a webview recovery copy. These copies do not replace the live buffers. |
| Editor state and undo | Per visited tab until closed. History can retain deleted text and source-format effects. | Kept in RAM. Safe eviction requires explicit undo serialization and asynchronous hydration across editing/search/agent APIs. |
| Editor view DOM and plugins | One active view by default; inactive visited tabs keep state but release DOM/plugins. Never-visited tabs remain lazy. Opt-in intelligence keeps views connected for unsaved cross-file operations. | Release/recreate the view rather than write DOM to disk. |
| Advanced diagram SVGs | Previously 16 entries with a per-result limit of 4 million characters and no aggregate byte budget. | Now a 2 MiB in-memory SVG budget plus a 32 MiB logical IndexedDB payload budget, both capped at 16 entries. |
| Markdown analysis | One cached source/result, plus the active rendered DOM and parser state. | Recomputable; currently kept in RAM. |
| Notebook cell results | Results remain available for display and subsequent cells while their document is open. Each result is limited to 1,048,576 JSON characters, with at most 128 runnable cells; string representation, logs and parsed objects add overhead. | Candidate for later disk-backed storage, but downstream cell inputs must hydrate consistently. Not silently evicted in this change. |
| Language intelligence | Optional, disabled by default. Enabled servers have separate processes and project indexes. Reference lookups can temporarily cache up to 32 files / 16 MiB of UTF-8 source per session, with 30-second expiry. | Server-dependent caches; editor residency changes must preserve cross-file edits. |
| Renderer/runtime code | Loaded JavaScript modules, WebKit/JIT heaps, media and graphics resources. | Browser-managed. Dropping application references does not guarantee immediate reduction in process RSS. |
| Revision history | SQLite records fetched on demand, with bounded per-document history. | Already on disk. |

## Changes

The initial recovery snapshot is consumed without retaining its full document
array in application props or the top-level await continuation. A Chromium heap
snapshot traced the latter retention through the module generator; discarding
the bootstrap return value released about 3.4 MiB in the restored-session test. Closed-tab editor,
conflict and intelligence bookkeeping is removed. Line and word counts use a
single scan instead of allocating arrays for every line and word on edits.
Closed notebooks clear completed output records. Ordinary Markdown without cell
markers skips executable-cell parsing.

Advanced diagram cache keys hash the engine, theme, source and cache version.
The cache stores **derived SVG, which can contain document text**; hashing keys
is not encryption. It stays in the current webview profile. Values still pass
through the existing SVG sanitizer before DOM insertion or export. The cache
is optional: storage denial, quota failures and timeouts fall back to rendering.
Drafts and undo never depend on it.

Disk eviction reads only small metadata records, not all cached SVGs. Entries
older than seven days are rejected on access and removed during subsequent
writes. This is expiry on use, not a background deletion timer. Logical byte
budgets conservatively count UTF-16 strings; IndexedDB metadata/filesystem
space and browser buffers are additional. Bump the cache namespace when
renderer versions or options change.

## Performance mode

**Settings → Editor → Performance mode** is optional and off by default.
It uses the source editor for Markdown, code and canvas files, suspends syntax
parsing and language intelligence, and disables smooth scrolling. It preserves
normal layout/intelligence/scroll preferences and undo history, restoring the
usual behavior when switched off. Language tools remain opt-in and require a
separately acquired package. There are no automatic downloads.

The mode does not impose a smaller tab limit, discard buffers or undo, or stop
explicitly requested tools such as graph, export or notebook execution. Those
operations can still be expensive. It is not an operating-system memory limit.
Already-loaded JavaScript modules cannot be unloaded; starting with the saved
mode enabled avoids loading code grammars in the first place.

Moving open text or undo to disk is deferred: synchronous editing, workspace
search and agent changes need a shared asynchronous buffer-hydration design.
Silently dropping undo or allowing disk I/O to lose edits is not an acceptable
memory optimization. Derived diagram SVG is safe to regenerate and is the disk
cache introduced here.

## Reproduce

```sh
node --experimental-strip-types tests/document-counts.mjs
npm run test:store
npm run test:documents
npx playwright test tests/e2e/diagram-cache.spec.ts tests/e2e/memory-retention.spec.ts --workers=1
python3 tests/native/lightweight_stress.py --app /path/to/Notation.AppImage --output /short/evidence/path --retention-rounds 6
```

Use disposable native profiles and a short `TMPDIR` (for example `/tmp`), because
Unix sockets have path-length limits. Serialize native WebDriver runs. Measure
the entire app process tree using PSS as well as RSS. The browser retention test
forces garbage collection to measure reachable JavaScript memory independently
of WebKit's allocator. It is a bounded repeated workload, not an overnight soak
or proof that every workload is leak-free.
