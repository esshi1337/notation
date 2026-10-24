# Repository Guidelines

## Project Overview

Notation is a Markdown and Mermaid editor: Svelte 5 and CodeMirror 6 in the
frontend, a Rust/Tauri 2 backend for desktop file operations, SQLite drafts and
preferences, and a standalone Linux AppImage as the distribution target.
README.md is the product and setup reference; this file governs how agents
work in this repository.

## Project Structure & Module Organization

- `src/` — flat layout of Svelte 5 components (`*.svelte`) and TypeScript
  modules (document features, rendering, storage, wiki links, citations,
  tables, canvas, export).
- `src-tauri/` — Rust backend: `src/` commands and state, `tests/`,
  `tauri.conf.json`, capabilities, icons, bundled resources.
- `tests/` — Node feature scripts plus `tests/e2e` (Playwright) and
  `tests/native`; `playwright.config.ts` configures the e2e suite.
- `scripts/` — build, bundling, and installer tooling (Python and Node).
- `orchestration/` — local multi-model orchestration docs.
- `.codex/` and `opencode.json` — project-level Codex and OpenCode
  configuration (Serena MCP, agent definitions, compaction).

## Orchestration

One advisor session owns each piece of work: Codex profile
`notation-advisor` (model `gpt-6-astra`, launcher `notation-advisor`). The
advisor owns requirements, architecture, task selection, review, integration,
and the final answer. Do not start peer orchestrators, standing recon or
verifier teams, or recursive worker trees. Workers never spawn workers.

Delegation runs through OpenCodex using the OpenCode agents in `opencode.json`.
Launch a bounded task with `scripts/notation-worker <role> <prompt>`; this uses
`opencodex opencode run --standalone` so the proxy routing is present in the
worker process without changing global client settings.

| Agent | Model | Use for |
| --- | --- | --- |
| `sol-implementer` | opencodex/gpt-6.1-sol | Complex or cross-file implementation, difficult debugging, security-sensitive work |
| `deepseek-implementer` | opencodex/combo/deepseek-auto | Well-specified smaller changes, mechanical work, targeted tests |
| `glm-reviewer` | opencodex/zai/glm-5.3 | Read-only challenger and second eye |
| `glm-security-reviewer` | opencodex/zai/glm-5.3-flash | Read-only security review of relevant trust boundaries and attack paths |
| `scout-luna` | openai/gpt-6-luna | Read-only code search: symbols, references, call sites |
| `scout-flash` | opencode/glm-5.3-flash-free | Cheap read-only text sweeps: files, patterns, docs |

Choose Sol 6.1 for complex or ambiguous work and DeepSeek for well-specified
bounded work. GLM 5.3 challenges the result; GLM 5.3 Flash reviews security
when the change touches a trust boundary. Both review roles remain read-only.
The DeepSeek worker uses the existing OpenCodex `combo/deepseek-auto` route
(Go first, direct DeepSeek fallback). Its upstream models are moving aliases,
not immutable 1017 revision pins; verify the version when exact 1017 matters. Scouts retain their existing search-only roles.

Working rules: delegate one bounded packet at a time containing objective,
write-set, relevant facts, non-goals, acceptance checks, and required report.
Prefer 2–6k tokens of focused input; reports fit in about 1k tokens with exact
pass/fail/unrun evidence and changed paths. Keep at most one implementer
active by default; parallel work needs disjoint write-sets and a concrete
benefit. Reviewers and scouts are read-only. A model's self-report is not
runtime evidence: the advisor reviews the diff and runs or inspects
independent checks. Standalone read-only sessions can use
`codex -p notation-scout` (launcher `notation-scout`).

Serena MCP provides symbol-level navigation in both Codex and OpenCode. The
project is registered as `Notation` under `.serena/` with the svelte language
server; it needs `node_modules` installed to activate.

## Build, Test, and Development Commands

Requires Node.js 22.13+ and Rust 1.89+. Desktop packaging needs the Tauri
prerequisites (`webkit2gtk-4.1`, `gtk3` on Arch).

```sh
npm ci                 # install pinned dependencies
npm run dev            # Vite dev server at http://127.0.0.1:1420
npm run check          # svelte-check + tsc over src/
npm run desktop        # Tauri dev with hot reload
npm run desktop:build  # release AppImage build
npm run test:e2e       # Playwright suite
```

Focused suites: `test:store`, `test:preferences`, `test:documents`,
`test:markdown`, `test:tables`, `test:export`, `test:canvas`,
`test:workspace`, `test:citations`, `test:hemingway`. Run the suite that
covers the touched area and report any checks that were not run.

## Coding Style & Naming Conventions

`.editorconfig` and `tsconfig.json` are authoritative: two-space indent, LF
endings, UTF-8, TypeScript strict mode, Svelte 5 runes syntax. Rust uses
four-space indent (`rustfmt` defaults). Use descriptive camelCase
identifiers, PascalCase component names, and keep formatting-only changes
separate from behavior changes.

## Testing Guidelines

Introduce tests alongside executable behavior and name them by behavior. Add
regression tests for bug fixes. Store and recovery tests use disposable local
state; Playwright is the acceptance layer for visible UI work. Do not weaken,
skip, or delete existing tests. Native-side changes belong in
`src-tauri/tests/` or `tests/native`.

## Commit & Pull Request Guidelines

Use concise, imperative subjects such as `Add document parser` and keep
commits focused. Pull requests explain the problem, resulting behavior, and
validation performed, with screenshots for visible interface changes.

## Security & Configuration

Keep credentials and local configuration out of version control; use example
files with placeholder values. Generated artifacts (`node_modules/`,
`dist/`, `src-tauri/target/`, `playwright-report/`, `test-results/`,
`public/pdfjs/`, `src-tauri/resources/engines/`) are gitignored. Model
provider credentials live in the OpenAI/DeepSeek/OpenCode auth stores outside
this repository; never print, copy, or commit them.
