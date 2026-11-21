# Notation user guide

Notation is a local-first Markdown, Mermaid, and Canvas editor. Notes and canvases
stay ordinary files; Notation adds live preview, linked notes, workspaces,
diagrams, and a desktop writing environment around them. See the
[README](../README.md) for setup and [examples](examples.md) for workflows.

## Get started

Notation is distributed as a Linux x86-64 AppImage. From a source checkout with
Node.js 22.13+, Rust 1.89+, and the [desktop prerequisites](../README.md#desktop-application):

```sh
npm ci
npm run desktop:engines
npm run desktop:build
npm run desktop:install
notation
```

The per-user installer needs no sudo, places the AppImage under
`~/.local/opt/notation/`, adds a `notation` launcher to `~/.local/bin/`, and adds
Notation to your application launcher. The built AppImage is also in
`src-tauri/target/release/bundle/appimage/`. Documents and recovery data live
outside the installation directory.

Browser development uses `npm ci` then `npm run dev`; open
`http://127.0.0.1:1420`. **Open** imports a file and **Save** downloads the edited
copy, never silently writing back. Browser drafts use local storage; desktop
drafts and preferences use SQLite with a webview recovery cache. Desktop adds
native dialogs and writes, workspace indexing, wiki lookup and missing-note
creation, note graph, Git, local media and the PDF viewer, native script APIs,
PDF/DOCX/PPTX conversion, and MCP. Browser mode follows wiki links between open
tabs, edits Canvas boards, exports HTML or a self-contained page, and runs script
document transforms and logs. Browser Canvas note cards resolve open tabs only.

## Write and preview

Choose **New** for a Markdown note, or run **New canvas** from Commands
(`Ctrl/Cmd+K`). The **+** beside the tabs creates a Markdown document. Opening a
file that is already open selects its tab.

The layout menu has four views; these defaults can be remapped:

- **Source** shows Markdown with line numbers (`Ctrl/Cmd+Alt+1`).
- **Split** shows source and rendered Preview (`Ctrl/Cmd+Alt+2`).
- **Preview** shows the rendered note (`Ctrl/Cmd+Alt+3`).
- **Live Preview** formats headings, emphasis, code, links, lists, tasks, math,
  and Mermaid in one pane (`Ctrl/Cmd+Alt+4`). Syntax reappears on the edited line.
  Click a diagram or equation to edit it, then move away to render again.

Saved files remain ordinary Markdown or Mermaid source. Use `.md` for notes and
`.mmd` for a standalone diagram. Fenced `mermaid`, `dot`/`graphviz`, `d2`, and
`plantuml`/`puml` blocks render diagrams, with errors shown in place. Mermaid works
in both modes; the other engines require the desktop renderer. Inline math
uses `$...$`; display math uses `$$...$$`. Math is read as Typst by default and
rendered by a bundled Typst compiler; equations written in LaTeX (backslash
commands, `^{…}`) are detected and rendered by bundled KaTeX. Neither makes a
network request. A `math: typst`, `math: latex` or `math: auto` property
overrides this for one note, and **Settings → Editor → Math syntax** sets the
default.

To follow file edits made by an external editor or agent, enable
**Settings → Editor → Automatically reload external changes**. It starts off.
In the desktop app, the displayed file and preview update automatically when
there are no unsaved edits. Unsaved changes and Hemingway mode are protected;
use **Compare / reload** to inspect a conflict. Inactive tabs are checked when
selected. Workspace indexes still need **Refresh index** after external edits.

**Hemingway mode** from Commands makes the current tab literal text. Typing at an
empty caret works, while deletion, selection replacement, cut, drag/drop, undo,
and redo are blocked. Copy, navigation, Find, and Save remain available. Turn it
off through the same command; the setting is per tab.

In normal editing, type `/` on a blank line for insertion commands, and use **Block actions** to move, duplicate, delete, or
change the block at the cursor.

## Saving, drafts, and recovery

**Save** writes the document file. `Ctrl/Cmd+S` writes the current file on desktop
or downloads it in a browser; `Ctrl/Cmd+Shift+S` is Save As on desktop. Notation
also autosaves recovery state, but that draft is not the exported file: it does
not update the `.md`, `.mmd`, or `.canvas` file until you save. When recovery is
offered, the banner lists only the work it can restore: **Restore tabs**
replaces the current open tabs (unsaved tabs are confirmed first), **Restore
document** opens the offered draft, or **Restore script edits** replaces the code
in Scripts without running it. Document files stay unchanged, and **Keep current
work** dismisses the offer. If scripts are disabled, the banner asks you to
enable scripts in **Settings → Editor** before the script restore button appears.

Closing a tab with unsaved edits asks first. If the window closes while app state
cannot be saved, **Changes not saved** appears: **Keep open** lets you retry
saving or save document files, while **Close anyway** may lose recent document
edits, script edits, or settings. Tabs, selection, cursor positions,
and layouts restore after restart; undo history does not. Desktop **History** keeps up to
50 revisions and can compare or restore one as an undoable change, but it is not
a backup.

## Workspaces, links, and properties

A workspace is a collection of file references, not a folder that owns files.
Open **Workspace**, name it, and choose **Create workspace**. Use **Add files** or
**Add current file**; files stay in place and can belong to several workspaces.
**Referenced files** shows full paths and can remove a reference without deleting
the file. **Refresh index** after external edits. Search, Tasks, Tags, Backlinks,
and the note graph use the selected workspace.

Wiki links use `[[Note]]`, `[[Note#Heading]]`, `[[Note#Heading|Label]]`, and
`[[Note#^block-id]]`. Type `[[` for completion. Click a rendered link, or use
Ctrl/Cmd+click or Ctrl/Cmd+Enter in source. Desktop lookup checks the current
folder, then unique workspace filenames or YAML aliases; ambiguity opens a
chooser. **Note not found** offers an explicit **Create note** action in the
current folder, never overwriting existing files. Browser mode follows links
between open tabs only.

**Properties** edits YAML frontmatter: text, numbers, booleans, dates, lists, and
custom YAML. Frontmatter starts with `---` on the first line and ends with `---`
or `...`. **Apply** changes the editor; save the file to write it. Comments,
unknown fields, and the body are preserved.

**Note graph** shows resolved links and unresolved targets for the selected
desktop workspace. Filter by title/path or tag, or switch to **Current note
neighborhood** and choose depth. Drag to pan, use the wheel or −/+ to zoom,
**1:1** for readable labels, or **Fit** for an overview. **Notes** and
**Unresolved links** list every visible target.

## Tables, citations, templates, queries, and cells

Place the cursor in a Markdown table and run **Table editor**. Tab and Shift+Tab
move between cells. Add or delete rows and columns, set alignment, sort, or import
CSV. **Apply table** makes one undoable source edit; **Export CSV** leaves the
note unchanged. Tables nested in lists or quotes remain source-editable.

Citations use Pandoc-style groups such as `[@doe2024]` and `[-@doe2024]`.
Frontmatter can name `bibliography` files, an optional `csl` style, or inline CSL
`references`; bibliography and style files must be workspace references. Desktop
formatting produces inline citations and a Bibliography section. Browser preview
keeps the keys visible and explains that formatting needs the desktop app.

Variable text such as `{{status}}` or `{{project.name}}` reads frontmatter values.
**Templates** previews reusable Markdown with those substitutions and inserts it
as one undoable edit. Use **Save template**, **Import template**, and **Export
template**; `{{document.name}}` is available during insertion. The library is
bounded to 32 KiB, so larger templates belong in separate Markdown files.

A `query` fence renders a read-only view of saved workspace metadata. It accepts
`view` (`table` or `list`), `columns`, `tags` and `where` filters, `sort`, and a
`limit` up to 200. Filters support `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
`contains`, and `exists`. Queries require desktop and never execute SQL or
JavaScript; **Refresh** updates the view. The
[README](../README.md#references-queries-and-graph) has a complete query sample.

JavaScript cells run only when explicitly asked. Give each fence a unique name:

````markdown
```javascript cell:prices
return { subtotal: 40 };
```

```javascript cell:total
return inputs.prices.subtotal * 1.16;
```
````

**Run cell** uses fresh earlier outputs; **Run through here** runs preceding cells
in order. **Stop** cancels. Outputs are session-only and become stale after edits.
Opening or rendering a note never executes a cell. Cells use the Scripts API, so
desktop runs can read and write files and run commands with your permissions;
browser mode rejects those native APIs. Ordinary JavaScript fences and cells in
embeds do not execute.

## Canvas

**New canvas** creates a separate `.canvas` document in JSON Canvas 1.0 format.
**Add card** creates **Add text card**, **Add note card**, **Add media card**,
**Add diagram card**, or **Add group**. Cards can also be JSON Canvas `link`
nodes; the menu has no link entry, but imported link cards work and their URL is
editable in Source. Link cards open only `http`, `https`, and `mailto` targets.

Drag a card title to move it and the bottom-right corner to resize. With the board
focused and a card selected, Arrow moves by 1 pixel, Shift+Arrow by 10, Alt+Arrow
resizes by 1 (Alt+Shift+Arrow by 10). Hold Space and drag, middle-drag, or drag
empty space to pan. The wheel pans; Ctrl/Cmd+wheel zooms. **Fit canvas** frames
the board; **−** and **+** change zoom.

Connect with the arrow button (`⇢`) on one card and then another, or use **Connect
cards**, choose **From card**, **To card**, a **Connection label**, and **Add
connection**. New connections point at the target; delete existing ones under
**Connections**.

A blank note card shows **Choose note**. In **Edit card**, **Card file** takes a
workspace-relative path such as `notes/example.md` (not an absolute home path).
Use **Find note**, **Search notes**, and a **Use note: …** result, then **Apply
card**. **Open original** opens the note at its saved heading. On desktop, a
missing target offers the explicit **Create note** prompt; files are never
overwritten. Browser note cards resolve open tabs only.

Media cards use workspace-relative images, audio, video, or PDFs. Local media and
the PDF viewer require desktop; remote resources show **Load external media**.
Groups are visual containers. Canvas changes share tab recovery, undo, and Save
with notes; Save writes the `.canvas` file. Source exposes the JSON and preserves
unknown fields. Invalid Canvas JSON stays unchanged and disables editing until
repaired in Source.

## Themes

Open **Settings → Appearance** (`Ctrl/Cmd+,`). **Theme** chooses **Dark** or
**Light**. Dark presets are **Midnight**, **Charcoal**, **AMOLED**, **Forest**,
and **Dusk**; light presets are **Default** and **Paper**.

Local user themes use the same section:

1. Choose **Create theme**, enter a name, pick a **Built-in base**, and write CSS.
2. **Preview theme** for a temporary preview, then **Save and apply theme**.
   Cancel or close Settings to restore the saved theme.
3. Select it from **User theme**, or choose **Off — built-in theme** to go back.
   **Edit theme**, **Duplicate theme**, **Delete theme**, **Import theme**, and
   **Export theme** manage the library. Deleting the selected theme restores the
   built-in theme; saved themes are kept when custom styling is disabled.

Themes are local: up to 8 themes, 4096 UTF-8 bytes of CSS each, and 24 KiB for the
library. CSS is deliberately limited to flat ASCII `selector { property: value; }`
rules, with no comments, escapes, `@` rules, nesting, quoted values, URLs, or external font/image resources. Colors, numbers, keywords, and
`rgb`/`rgba`/`hsl`/`hsla`/`calc`/`min`/`max`/`clamp`/`var` are supported. `var()`
may reference built-in color and layout tokens such as `--bg`, `--bar`, `--panel`,
`--text`, `--accent`, `--border`, and `--reading-width`, but not icon or resource
tokens. Put overrides in a standalone `:root` rule. See
[examples](examples.md#a-small-local-theme) for working CSS and JSON.

Import expects a version 1 JSON file with `version`, `id`, `name`, `base`, and
`css`; imports get a fresh local ID. Exports use the same format and suggest
`notation-theme.json`. If custom CSS ever hides the interface, press
**Ctrl/Cmd+Shift+F12**. This reserved shortcut always disables custom styling and
keeps saved themes; it cannot be remapped in **Settings → Shortcuts**.

## Export and shortcuts

Open **Export** from the Notation menu. **HTML with linked images** and
**Self-contained webpage** work in both modes; PDF, DOCX, and PPTX use bundled
converters and require desktop. Choose a format and **Export document**. An export
is a snapshot: later edits do not change it, code cells do not run, and the source
is unchanged. HTML includes styles and fonts; self-contained export also bundles
supported local resources and reports anything it cannot include.

Useful defaults, all remappable in **Settings → Shortcuts**: `Ctrl/Cmd+K`
Commands; `Ctrl/Cmd+,` Settings; `Ctrl/Cmd+N`/`O`/`S` New/Open/Save; `F2` Rename
document; `Ctrl/Cmd+W` Close tab; `Ctrl/Cmd+Alt+1`–`4` Source/Split/Preview/Live
Preview; `Ctrl/Cmd+Shift+E` Explorer; `Ctrl/Cmd+Shift+F` Focus mode. Shortcut
settings can search, record, disable, or reset bindings. Conflicts are rejected,
editing shortcuts stay reserved, and window-manager shortcuts take precedence.

## Sticky notes (Linux desktop)

Open **Sticky notes** in the sidebar, then **New sticky note**, or run **New
sticky note** from Commands. Each note opens in its own resizable native window
that requests always-on-top. Write directly on the paper, with no title form or
normal save-status footer. Select text and use **Bold**, **Italic**, or **Bullets**;
`Ctrl/Cmd+B` and `Ctrl/Cmd+I` also work, with native undo. Choose one of six paper
colors: yellow (default), green, blue, pink, purple, or gray. Text, formatting,
and color autosave together, independently of regular documents. Paste and drop
insert plain text only, not links, images, or arbitrary HTML/styles.
**Close sticky** flushes pending edits and keeps the note in the saved list.
A failed save leaves the window open with **Retry**.

Use **Refresh notes** to update the list and click a saved title to reopen it.
Opening an already open note focuses its window. Close a note's window before
using **Delete**, then confirm deletion. Close all sticky windows before exiting
Notation, or minimize the main window to keep them visible. The library supports
64 notes, with a first-nonempty-line title of up to 256 UTF-8 bytes, 64 KiB of text,
and 128 KiB of formatting per note. Older notes show a distinct old title as a
literal first line, including title-only notes; “Untitled sticky” is not added.
Opening a note does not rewrite it. If combining an old title/body exceeds a
limit, nothing is truncated: shorten the text to save, and the original stored
note remains intact until a successful save. Browser mode cannot create these
native windows. Native window decorations still provide dragging and resizing.

[PR #14](https://github.com/esshi1337/notation/pull/14) is merged into `main`.
Storage tests, mocked-window browser checks, and Rust type checking passed;
real compositor/GTK/WebKit behavior and packaged AppImage verification remain
outstanding. See the [audit notes](audits/2026-10-25-usability.md#remaining-verification).

## Git for the active file

In the desktop app, the Git sidebar icon appears only for an existing saved file
inside a Git worktree, with Git installed. It follows the actual file path, not
the selected workspace; linked worktrees are supported. The panel identifies the
repository and reads its branches, changes, history, and diffs without staging,
committing, fetching, or pushing. Unsaved editor changes are not in disk diffs.
Switching to an untitled, missing, or non-repository file hides Git and closes the
panel. Git is unavailable in browser mode, including its shortcut and command.

For technical notes, see [memory retention](memory-retention.md) and
[performance](performance-report.md).
