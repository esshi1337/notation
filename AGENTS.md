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
- `.codex/` and `orchestration/roles.json` — project-level native Codex
  configuration (Serena MCP, model roles, compaction).

## Project orchestration and file boundaries

Start this project's main session with `scripts/notation-advisor`. This selects
Astra High inside the mandatory Linux Bubblewrap sandbox. The global
`notation-advisor` alias and direct `codex` commands do not provide
these project boundaries. Never use them as a sandbox fallback. Use an
independent clone; the launcher deliberately rejects linked worktrees.

Astra is the sole advisor, orchestrator and integrator. Astra owns issue scope,
architecture, task selection, review, GitHub operations and the final answer.
Never start peer orchestrators, standing teams, or recursive workers. Workers
never spawn workers. Keep one implementer active unless disjoint write-sets
and a concrete benefit justify parallel work.

| Role | Model | Task profile |
| --- | --- | --- |
| Astra main | gpt-6-astra, High | Requirements, scoped issues, advice, integration, PRs and merges |
| `deepseek` | combo/deepseek-auto, High | Default general coding, bounded features, routine fixes, refactors and regression tests |
| `sol` | gpt-6.1-sol, High | Complex problems, ambiguous bugs, multiple systems/services and security-sensitive implementation |
| `challenger` / `security` | zai/glm-5.3-flash, High | Independent adversarial review and targeted checks: bugs, logic, errors, races, leaks and security |

DeepSeek's combo uses moving upstream aliases. The catalog's exact 1017 route
returned `provider.no-route` during setup; do not claim a revision pin.
Use a bounded `--read-only` worker for scouting; do not turn scouts into
standing teams. Every role uses the existing OpenCodex Responses gateway;
workers execute through native `codex exec`, with recursive agents disabled.

Implementers require explicit existing `--write` files/directories or
`--read-only`. Their source is otherwise read-only, Git metadata and harness
policy are protected, and they receive no GitHub or native Codex credentials.
Reviewers have read-only source, no Serena mutations or general shell, and
a small `notation_review` MCP surface for reads, diffs and fixed checks.
Tests execute in the same filesystem boundary with disposable scratch/cache output. Network
access remains available for model providers and tools; never describe this
as a network sandbox. See `orchestration/README.md` for exact boundaries.

Every packet includes the issue, objective, write-set, relevant facts,
non-goals, acceptance checks and required report. Prefer 2–6k focused input
tokens and reports under 1k tokens with changed paths and exact pass/fail/unrun
evidence. Example:

```sh
scripts/notation-worker deepseek --write src/store.ts '<bounded packet>'
scripts/notation-worker sol --write src '<bounded cross-system packet>'
scripts/notation-worker deepseek --read-only '<investigation packet>'
scripts/notation-worker challenger '<review packet>'
```

Serena MCP is pinned to `serena-agent==1.7.0`, registered as `Notation` under
`.serena/` with the Svelte language server, and enabled for Astra and write
implementers. Install `node_modules` first. It is disabled for read-only
workers because it also exposes mutation tools.

## Issue-first development and pull requests

Before changing code or configuration, define the problem, bound the scope,
state non-goals and measurable acceptance checks. Inspect existing issues;
reuse a matching scoped issue or create one on `esshi1337/notation` assigned
to `esshi1337`. Use exactly one category: `bug` (incorrect behavior),
`enhancement` (new behavior), `documentation` (docs only), or `maintenance`
(tooling, dependencies, refactoring and operations). Do not create status,
priority, agent, milestone or duplicate category labels by default.

Use `scripts/notation-task issue <category> '<title>' --body-file <file>`
with substantive `## Problem`, `## Scope`, `## Non-goals`, `## Acceptance`
sections. The four GitHub issue forms provide the same fields. Use
`scripts/notation-task start <number> <slug>` in a clean independent clone.
Work on `issue/<number>-<slug>`; never implement directly on `main`.
For a dirty checkout, create a separate clone rather than resetting it.

Install local hooks once with `scripts/notation-task install-hooks`; the
advisor launcher also sets their path for every session. The hooks verify the
live owner-assigned issue and block direct main pushes, unrelated refs,
branch deletion and non-fast-forward pushes. They require GitHub access and
fail closed offline. They are local guardrails, not server protection.

Review the actual diff independently of worker claims. Run meaningful local
checks, then GLM Flash challenger review and relevant security checks. GLM
must challenge error paths, logic and cleanup of timers, listeners, native
resources and memory growth where applicable. It runs relevant fixed test
suites; it returns concrete reproduction steps for missing cases to the
implementer. Fix confirmed findings, retest and review the changed result.
Do not claim leak freedom without runtime memory/lifecycle evidence.

Commit only scoped files, then create a PR using
`scripts/notation-task pr --title '<title>' --body-file <file>`. The body must
include `Closes #<issue>`, `## Validation` and `## Review` with exact results,
fixes and remaining gaps. Keep one coherent issue per PR. All checks and review
evidence are local. A macOS workflow exists (`.github/workflows/macos.yml`:
builds and launches the app on Apple Silicon and Intel, runs the Rust tests and
the Playwright suite on WebKit), but the owner has disabled it and it is
manual-only. Do not wait for it, enable it or dispatch it; write "macOS CI:
disabled by user" in the PR's Validation section and say what in the change
still needs a build or a person on a Mac.

After inspecting the reports and accepting the exact committed result,
Astra can use `scripts/notation-task record-review --checks-file <file>
--review-file <file>` to attest acceptance for HEAD. Only attest when the
checks passed and independent findings are resolved, or the user explicitly
accepted a documented gap. This records evidence, not a model verdict parser.
When merge is within the user's authorized task, use
`scripts/notation-task merge <pr>`: it checks the linked issue, branch and
accepted local HEAD against the live PR head, then squash-merges with
`--match-head-commit`. Any new commit invalidates the acceptance record.
Never force-push, bypass hooks/checks, weaken tests or merge unrelated work.
GitHub server branch protection is unavailable on this private repo's current
plan; local helpers can be bypassed by a human and must not be represented as
server-enforced protection.

## Build, Test, and Development Commands

Requires Node.js 22.13+ and Rust 1.89+. Desktop packaging needs the Tauri
prerequisites (`webkit2gtk-4.1`, `gtk3` on Arch).

```sh
npm ci                 # install pinned dependencies
npm run dev            # Vite dev server at http://127.0.0.1:1420
npm run check          # svelte-check (Svelte and TypeScript diagnostics)
npm run desktop        # Tauri dev with hot reload
npm run desktop:build  # release AppImage build
npm run test:e2e       # Playwright suite
```

Focused suites: `test:store`, `test:preferences`, `test:documents`,
`test:markdown`, `test:math`, `test:tables`, `test:export`, `test:canvas`,
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
provider credentials stay in the existing OpenCodex host stores outside
this repository; never print, copy, or commit them. No model role receives
native Codex authentication; the existing gateway authenticates upstream.
