# Notation

A small Markdown and Mermaid editor built with Svelte, CodeMirror 6, and a Rust/Tauri backend. Markdown and diagrams are the focus of this first implementation.

## Desktop application

Notation builds into a standalone Linux AppImage with the interface embedded in the executable. It does not need Node.js, Vite, or a browser window at runtime.

After installing the build prerequisites below:

```sh
npm ci
npm run desktop:engines
npm run desktop:build
npm run desktop:install
notation
```

The installer copies the AppImage to `~/.local/opt/notation/Notation.AppImage`, creates `~/.local/bin/notation`, and adds **Notation** to your application launcher. It installs for the current user and needs no sudo. The distributable is in `src-tauri/target/release/bundle/appimage/`.

Rebuild and rerun `npm run desktop:install` to update the installed application. Close the app first. Documents and recovery data are kept outside the installation directory.

On Linux with the NVIDIA kernel module loaded, Notation defaults to WebKit's compatible renderer (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) to avoid the DMA-BUF startup failure observed on this workstation. An explicit environment value is respected. The application still runs as a native Wayland window.

## Development

Use Node.js 22.13+ and a current stable Rust toolchain (Rust 1.89 or newer).

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:1420`. Browser mode supports importing files and downloading edited documents. It does not silently write back to imported files.

For desktop development or packaging, install the [Tauri system prerequisites](https://tauri.app/start/prerequisites/). Development with hot reload uses:

```sh
npm run desktop
```

On Arch Linux, building Tauri requires `webkit2gtk-4.1` and `gtk3`; `webkitgtk-6.0` is a different API and does not replace that dependency. The AppImage bundles WebKitGTK for runtime use. Desktop mode uses native open/save dialogs and Rust file operations. The desktop Cargo feature is explicit so core file-operation tests can run without GTK/WebKit.

## First milestone

- Edit Markdown and standalone `.mmd` diagrams.
- Preview Markdown with Mermaid fences, including localized diagram errors.
- Switch between source, preview, split, and inline Live Preview layouts.
- Choose a theme, font size, and word wrapping.
- Restore the current draft and preferences from local application storage.
- Use CodeMirror editing commands, including undo/redo and find.

Press **F2**, double-click a tab, or run **Rename document** to change its name. Use `.mmd` for a standalone diagram, or `.md` for Markdown with fenced `mermaid` blocks. `Ctrl/Cmd+S` saves; `Ctrl/Cmd+Shift+S` opens Save As in desktop mode.

Desktop drafts and preferences use SQLite, with a webview recovery cache. Browser development mode uses local storage. Astro execution, IDE features, plugins, and a general custom-theme system are outside this milestone.

## Hemingway mode

Choose **Hemingway mode** through Commands (`Ctrl/Cmd+K`) to write literal, unformatted text in the current tab. Markdown, LaTeX, embeds, and canvas JSON remain ordinary source text. The mode preserves the file extension, selection, and previous layout, and recovers separately for each tab.

Typing at an empty caret works. Deletion, selection replacement, cut, drag/drop, undo, and redo are blocked. Copy, navigation, Find, and Save remain available. Script results, revision restoration, formatting commands, and agent edits cannot replace a protected tab. Undo history is retained for after you turn the mode off through the same command.

An IME may revise only its newly inserted, uncommitted composition text; start composition with an empty selection. Once committed, that text is protected too. Composition cannot replace an existing selection. Platform IME behavior has not been verified on every input method.

## Live Preview

Choose **Live Preview** from the compact layout menu, or press `Ctrl/Cmd+Alt+4`, to write and preview in one pane. `#` headings, bold/italic text, inline code, links, list markers, and quotes display their formatting. Markdown syntax reappears on the lines you are editing or selecting.

Mermaid fences become inline diagrams. Click a diagram, or focus it and press Enter, to edit its source; move outside the block or leave the editor to render it again. Invalid diagrams show an editable error in place. For a standalone `.mmd` document, the source is visible while editing and the diagram appears when the editor loses focus.

Switching modes preserves the document, selection, and undo history. Saved files remain ordinary Markdown or Mermaid source. Live Preview omits source line numbers; **Source** and **Split** retain them. The selected mode persists between sessions; **Source**, **Split**, and **Preview** remain available.

## Checkboxes and math

Tasks are clickable in Live Preview and in the rendered preview. A click changes the Markdown marker and can be undone in the editor. Standard task lists, nested tasks, and a bare checkbox at the start of a line are supported:

```md
- [ ] Finish these notes
- [x] Completed task
[] Quick task
```

Typing `[]` followed by a space and a label shows a checkbox in Live Preview. Use Source mode to see all markers. Brackets in code, links, or escaped text remain literal.

LaTeX math uses bundled KaTeX and fonts, with no network requirement. Write `$x^2 + \alpha$` for inline math, or put a display equation between `$$` delimiters:

```tex
$$
\frac{1}{2} + \sum_{i=1}^{n} i
$$
```

Click an equation in Live Preview to edit its LaTeX, then leave its line/block to render it again. Invalid or unsupported commands show a local math error. This supports KaTeX mathematical notation; it is not a full LaTeX document compiler. Dollars inside code, escaped dollar signs, and ordinary currency such as `$5 and $10` stay literal.

## Block editing and callouts

Type `/` on a blank line to insert a heading, task, diagram, equation, table, callout, toggle, code fence, or divider. Type to filter; use arrow keys and Enter, or Escape to dismiss. Commands insert ordinary Markdown and can be undone.

**Block actions** operates on the block containing the cursor. Move, duplicate, or delete a whole paragraph, list, fenced block, equation, or callout. Compatible text blocks can become headings, paragraphs, or tasks. These edits preserve source and undo history.

Callouts use Obsidian-compatible blockquote syntax:

```md
> [!NOTE]- Details
> This starts collapsed. Use + to start expanded.
> - [ ] A task inside the callout
```

The disclosure button changes only the view. **Edit callout** exposes its source. Callouts can be nested and contain tasks, math, Mermaid, and wikilinks. Warning, tip, danger, question, and information types use distinct monochrome icons and labels. Unknown types keep their label with the information icon.

## Local scripting

Open **Scripts** to run a JavaScript function body. Execution is explicit: opening a note or restoring a saved script never runs code automatically. The native app embeds QuickJS, so a separate Node.js installation is unnecessary.

```js
console.log(api.context.document.name);
return { text: api.context.document.text.toUpperCase() };
```

A returned string or `{ text }` can be applied with **Apply to document** as one undoable edit. Applying is refused if the document changed since the run began.

Native scripts can use `api.readText(path)`, `api.writeText(path, text)`, `api.listDir(path)`, and `api.run(program, args, { cwd, timeoutMs })`. Relative paths use the chosen working directory, otherwise the document's directory or home. `api.context.document` includes `name`, `path`, `text`, `selection`, `from`, and `to`. Commands receive literal arguments; use `sh` with `-c` explicitly when shell syntax is needed.

```js
api.writeText('summary.md', '# Summary\n\n' + api.context.document.text);
const result = api.run('wc', ['-w', 'summary.md']);
console.log(result.stdout);
```

Scripts run with your filesystem and command permissions. File/system effects happen immediately; editor undo only reverses edits applied inside Notation. Each run has a separate worker process, a 15-second total limit, bounded memory/output, and a **Stop script** control. Browser development mode supports document transforms and logs, and explicitly rejects filesystem/command APIs.

**Save script** adds a named entry to your library. The current script buffer is recovered separately, so unfinished edits do not replace its saved version. Native run history retains the latest 200 runs, including output and errors.

## Workspace and local data

Open **Workspace**, enter a folder, and choose **Open workspace** to index its Markdown and Mermaid files. Search searches file contents; the panel also lists tags, tasks, and backlinks. Choose **Refresh index** after external edits. Indexing skips symlinks, hidden/build directories, oversized files, and stops at 10,000 files or 64 MiB of source.

Your `.md` and `.mmd` files remain authoritative. SQLite holds preferences, recovery drafts, recent files, named scripts, run history, and document revisions. Search and link tables are a separate, rebuildable cache; refreshing them preserves your saved app data.

**History** previews previous versions and shows a unified diff against the current draft or another revision. Choose the comparison and context size; additions and removals are marked with `+` and `-`. Restoring applies an undoable editor change; save explicitly to update the file. History retains up to 50 revisions per document, including saved versions and periodic draft snapshots. It is not a substitute for backups.

The database is `state.sqlite3` in Tauri's application-data directory (`$XDG_DATA_HOME/local.notation.app/`, or `~/.local/share/local.notation.app/` on Linux). Existing webview preferences, drafts, and scripts migrate on first startup; the old recovery cache remains available. Failed database writes show an error, and a pending cached draft can be recovered explicitly. Back up the application-data directory with Notation closed, alongside your note folders.

## Linked notes and properties

Use `[[Note]]`, `[[Note#Heading]]`, or `[[Note#Heading|Label]]`. Type `[[` for note completion and `#` for headings. Click a rendered link, or use Ctrl/Cmd+click or Ctrl/Cmd+Enter in source. Heading navigation uses the opened document, including unsaved headings.

Native resolution checks the current folder first, then unique workspace filenames or YAML aliases. Ambiguous links offer a chooser. Missing notes offer an explicit **Create note** action in the current folder; existing files are never overwritten. Save or create refreshes the index and backlinks. Browser previews can navigate open tabs; workspace lookup and note creation require the desktop app.

Open **Properties** from the command palette to add, change, or delete YAML fields. Text, numbers, booleans, dates, lists, and custom YAML values are supported. Frontmatter begins with `---` on the first line and ends with `---` or `...`. The form preserves comments, unknown fields, and the Markdown body; edits are undoable and require Save to update disk. Dates never change automatically. Invalid YAML remains editable in source. CRLF documents retain their line-ending style; mixed line endings are normalized to one style by the editor.

## Tables and folding

Place the cursor in a Markdown table and run **Table editor** from Ctrl/Cmd+K. Tab and Shift+Tab move between cells. Add/delete rows or columns, set alignment, sort a column, or import CSV, then **Apply table** for one undoable source edit. Export CSV leaves the note unchanged. Quoted CSV fields, commas, quotes, and multiline values are supported; multiline Markdown cells use `<br>`. The grid edits top-level tables; tables inside lists or quotes remain editable in Source. Extra ragged columns produce an error instead of being discarded.

**Fold block**, **Unfold block**, **Fold all**, and **Unfold all** work on headings, code, quotes, and nested lists. Fold state survives Source/Live Preview switches without changing Markdown. Source also has a fold gutter. The command palette includes insertion commands, undo/redo, find/replace, and go to line; the slash menu uses the same insertion templates.

## References, queries, and graph

Add `^block-id` to the end of a paragraph, or on a separate line after a block. Link with `[[Note#^block-id]]`. Embed a note, heading, or block using `![[Note]]`, `![[Note#Heading]]`, or `![[Note#^block-id]]`. Embeds use open drafts when available and otherwise read the source file. Their tasks are read-only; open the source to edit it. **Refresh** reloads an embed. Duplicate block IDs, ambiguous paths, missing targets, cycles, and excessive nesting are reported inline.

Workspace **Search filters** combines content, folder, tags, and typed property conditions. Values can be plain text, JSON strings, numbers, booleans, or arrays. Metadata equality is type-sensitive. Use a property name in **Sort** to order by that field.

A `query` fence renders a read-only database view from saved workspace metadata:

````markdown
```query
view: table
columns: [title, status, priority]
tags: [work]
where:
  - key: status
    op: eq
    value: active
sort:
  by: priority
  direction: desc
limit: 50
```
````

Use `view: list` for a list. Filters support `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, and `exists`; filters combine with AND. `tagMode: any` changes tag matching from all to any. Click a result to edit its source note; **Refresh** updates the view. The visible result limit is 200. Queries never execute SQL or JavaScript.

**Note graph** shows resolved connections and lists unresolved links. Filter the visible graph by title/path or tag, zoom, or switch to the current note's neighborhood. Graph limits and omitted results are shown explicitly. Clicking a node opens its note.

## Executable cells, variables, and templates

JavaScript cells opt in with a unique name in the fence:

````markdown
```javascript cell:prices
return { subtotal: 40 };
```

```javascript cell:total
return inputs.prices.subtotal * 1.16;
```
````

**Run cell** uses fresh earlier outputs; **Run through here** explicitly runs preceding cells in order. `inputs` contains named JSON results and `variables` contains frontmatter properties. Cells use the existing synchronous scripting API and desktop file/command access. Opening or rendering a document does not execute code. Stop cancels a run, and edits mark outputs stale. Outputs are session-only; ordinary JavaScript fences and cells in embeds do not execute.

Write `{{status}}` or `{{project.name}}` in Markdown to display a frontmatter value as text. Missing variables remain visible. **Templates** previews and inserts reusable Markdown with these substitutions as one undoable edit. Save templates to the local library, or import/export `.md` templates. `{{document.name}}` is also available during template insertion. The library is bounded to 32 KiB; larger templates can be kept as separate files. Expressions belong in explicit executable cells.

## Media, diagrams, and citations

Use Markdown image syntax or `![[media/file.ext]]` for workspace-local images, audio, video, and PDFs. Local assets are limited to 20 MiB, resolved relative to the note, and confined to the workspace. PDFs use the bundled PDF viewer with page controls. Remote images and resources show **Load external media** before making a request. Remote sites can refuse iframe embedding; use their external link to open them separately.

Alongside `mermaid`, fenced `dot`/`graphviz`, `d2`, and `plantuml`/`puml` blocks render diagrams. Graphviz runs through bundled WebAssembly. The desktop package includes D2 and PlantUML with its own Java runtime. Renderers have source/output limits and timeouts; diagrams cannot import arbitrary host files or access the network.

Footnotes use `[^note]` and `[^note]: Definition`, with indented continuation paragraphs. Citations use Pandoc-style `[@key]` groups and frontmatter `bibliography`, optional `csl`, or inline CSL `references`. Bibliography/style files must be local workspace files. The bundled citation processor formats references in the desktop app; source keys remain in Markdown.

## Canvas and export

**New canvas** creates a separate `.canvas` document using [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). Add and move text, note, media, diagram, and group cards, connect them, and zoom or pan. File cards use workspace-relative paths. Canvas changes use the same tab recovery, Save, and undo mechanisms as notes. Source mode exposes the JSON, including preserved unknown fields. Save exports the `.canvas` file; rendered canvas conversion is not included.

**Export** captures a note snapshot as HTML, a self-contained webpage, PDF, DOCX, or PowerPoint slides. Rendered diagrams, math, note embeds, and query results are included. HTML includes its stylesheet and fonts; self-contained export also embeds supported local resources and reports any it cannot include. Remote resources are not fetched for export. Exports do not run code cells or change source files. Layout fidelity varies by format; Office/PDF conversions use a light theme.

The Linux x86-64 package bundles Pandoc and Typst, so conversion does not depend on system installations. For a fresh desktop build, run `npm run desktop:engines` first. It downloads pinned, checksum-verified artifacts described in `scripts/engines.lock.json`; generated binaries and licenses live under `src-tauri/resources/engines/`. Engine and font notices ship in the package. Runtime engine resolution does not fall back to PATH.

## Tabs, explorer, and settings

The interface uses one compact tab row. Press **Ctrl/Cmd+K** to search commands, or open the **N** menu for mouse access. Commands display their current shortcuts; the layout menu stays available at the right edge.

| Default shortcut | Action |
| --- | --- |
| Ctrl/Cmd+K | Commands |
| Ctrl/Cmd+, | Settings |
| Ctrl/Cmd+N / O / S | New / Open / Save |
| F2 | Rename document |
| Ctrl/Cmd+W | Close current tab |
| Ctrl/Cmd+PageUp / PageDown | Previous / next tab |
| Ctrl/Cmd+Shift+E | Explorer |
| Ctrl/Cmd+Shift+G | Git |
| Ctrl/Cmd+Alt+1 / 2 / 3 / 4 | Source / Split / Preview / Live Preview |
| Ctrl/Cmd+Shift+F | Focus mode |

**New** creates a document tab. Opening an already open file selects its tab. Each tab keeps its own draft, cursor, and undo history during the session; closing a tab with unsaved edits asks before discarding it. Open tabs and the selected tab are recovered after restarting. Undo history itself is not restored across restarts.

Choose a workspace folder and open **Explorer** to browse directories and open Markdown, Mermaid, and text files. Directories load as you expand them. Hidden files, build directories, and symlinks are omitted.

**Settings → Appearance** controls dark presets, accent color, interface density, sidebar width, status bar, and focus mode. **Editor** controls font family/size (bundled Geist and Geist Mono), line height, reading width, wrapping, layout, and line numbers. Each section has its own reset; these resets preserve documents, scripts, and recovery data.

**Settings → Shortcuts** lets you search by command or group, record or type bindings, disable a command's shortcut, and restore defaults. Conflicting bindings are rejected, and clipboard/undo shortcuts stay available to the editor. The command menu remains accessible even if its shortcut is disabled. Your window manager's global shortcuts take precedence over application bindings.

Open **Git** for the selected workspace's branch, changed files, commit graph, and diffs. Git must be installed. These views read local repository state; they do not stage, commit, fetch, or push. Save editor changes to include them in Git's working-tree diff.

## Agent MCP connection

Keep the desktop app open and configure an MCP client to launch `notation --mcp`. For clients using an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "notation": {
      "command": "notation",
      "args": ["--mcp"]
    }
  }
}
```

If `notation` is not on that client's PATH, use the absolute path to `~/.local/bin/notation`. The adapter communicates over [MCP stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and connects to the desktop app through a private local socket. It does not start a second editor window.

**Settings → Agents → MCP for agents** shows a copyable command with the socket path for the running instance. Use that path with `--socket` when the client uses a different data-directory environment. Both the `2025-11-25` initialization handshake and the `2026-07-28` per-request protocol are supported.

Agents can browse/search the selected workspace, inspect Git, list tabs, read current unsaved text, open documents, and apply guarded edits. Edits require the exact content the agent previously read; stale edits fail. Successful edits become one undoable editor change and do not automatically save the file. Disable agent editing in **Settings** to retain read access. No shell-execution tool is exposed through MCP; the separate Scripts panel remains available for explicit local automation.

Available tools: `workspace_info`, `list_directory`, `search_documents`, `read_file`, `list_tabs`, `read_tab`, `open_document`, `edit_document`, `git_status`, `git_history`, and `git_diff`. Read/edit text is limited to 4 MiB per document. `read_file` reads disk; `read_tab` reads the live editor buffer. Opening a document preserves other dirty tabs, and editing an inactive tab does not change the selected tab.

## Validation

```sh
npm run check
npm run test:store
npm run test:preferences
npm run test:documents
npm run test:markdown
npm run test:tables
npm run test:canvas
npm run test:workspace
npm run test:export
npm run test:citations
npm run test:hemingway
npm run build
npx playwright install chromium
npm run test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --no-default-features --all-targets -- -D warnings
```

Playwright starts an isolated Vite server on port 1420, so stop any existing development server before running tests. Tests exercise real CodeMirror input, rendering, malformed diagrams, browser import/export, draft recovery, preferences, layouts, and HTML sanitization. Live Preview tests also cover source preservation, undo across modes, inline diagram editing, keyboard access, standalone Mermaid, task toggles, and math rendering with local fonts. Failed tests retain screenshots and traces; use `npx playwright show-report` to inspect results.

Rust tests exercise real temporary files. Browser tests do not exercise native operating-system dialogs or prove desktop-webview compatibility. GitHub Actions runs frontend validation, Chromium tests, and Rust core checks.

The installed Linux package has an additional native smoke test using `tauri-driver` and `WebKitWebDriver`, with temporary user-data directories:

```sh
cargo install tauri-driver --locked
python3 tests/native/smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/sqlite_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/knowledge_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/advanced_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/tooling_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/close_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/checkbox_smoke.py --app "$HOME/.local/bin/notation"
python3 tests/native/hemingway_smoke.py --app "$HOME/.local/bin/notation"
```

These checks cover the embedded application, rendering, block editing, scripting, real file operations, SQLite persistence, and workspace indexing in isolated temporary profiles. The knowledge smoke adds note resolution and explicit creation, backlinks, CRLF properties, and revision comparison/restoration. `TAURI_DRIVER` and `WEBKIT_WEBDRIVER` can override driver locations. A graphical desktop session is required; no Vite server is started.

The advanced export smoke uses Python PyGObject and the AT-SPI typelib to operate the real GTK save dialog. It matches the app's isolated data directory before sending input and does not replace the Tauri bridge or clipboard.

The close smoke additionally requires Hyprland's Lua dispatcher. It sends the same close request as Super+Q to a verified test-owned window and checks that the window actually disappears before cleanup.

## Layout

- `src/`: Svelte workspace, editor integration, and preview rendering.
- `src-tauri/`: Rust file operations, Tauri commands, desktop configuration, and Rust tests.
- `tests/e2e/`: Playwright user-workflow tests.
- `playwright.config.ts`: browser and development-server configuration.

Build frontend assets with `npm run build`; build the desktop application with `npm run desktop:build` once native prerequisites are installed.
