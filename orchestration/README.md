# Project orchestration

Notation uses one Astra main session, one bounded implementer at a time, and
an independent GLM Flash review before a PR is accepted. This setup changes
no global provider, model, credential or client configuration. No CI is added.

## Start

On Linux, install Bubblewrap, Codex, OpenCode, OpenCodex, GitHub CLI, Node and
uv. Use an **independent clone** (linked worktree metadata lies outside this
boundary and is rejected). Install pinned dependencies with `npm ci` and
retain your existing Codex/OpenCodex/GitHub logins on the host. Then:

```sh
scripts/notation-task install-hooks
scripts/notation-advisor
```

Use the repository script, not the older global `notation-advisor` alias.
Direct `codex`, `opencode`, or global aliases do not apply this sandbox.
A missing sandbox, login or provider is an error; there is no fallback to an
unprotected process. Only one main session owns a task.

The launcher explicitly selects Astra with high reasoning. DeepSeek is the
default general implementer; Sol 6.1 High handles complex/cross-system bugs.
Both `challenger` and `security` select GLM 5.3 Flash High. The CLI also pins
the worker model explicitly: this installed OpenCode version otherwise
selected its free default despite the agent's model field.

The DeepSeek combo is the existing Go-first/direct-fallback route. Its models
are moving aliases. A live attempt to use the catalog's exact
`ELabs/deepseek-v4.1-flash-1017` returned `provider.no-route`; the setup does
not pretend that the working combo is an immutable 1017 pin.

## Issue to PR

Inspect existing issues before creating one. Define a single problem, scope,
non-goals and acceptance checks, then create an owner-assigned issue. Four
categories cover the initial repository without workflow-label noise:

| Label | Meaning |
| --- | --- |
| bug | Existing behavior is incorrect |
| enhancement | New or extended product behavior |
| documentation | Documentation-only changes |
| maintenance | Tooling, dependencies, refactoring, repository operations |

Use one category, not several. No status, priority or agent labels. Issue
forms assign `esshi1337`; the CLI validates the same sections. Example:

```sh
scripts/notation-task issue bug 'Preserve a draft after a failed save' --body-file /tmp/issue.md
scripts/notation-task start 12 preserve-draft
scripts/notation-worker deepseek --write src/store.ts '<issue, objective, scope, non-goals, checks, report>'
scripts/notation-worker sol --write src --write src-tauri/src '<bounded complex packet>'
scripts/notation-worker deepseek --read-only '<bounded investigation>'
scripts/notation-worker challenger '<diff, acceptance criteria, checks, review questions>'
```

The issue body needs nonempty `## Problem`, `## Scope`, `## Non-goals`,
`## Acceptance` sections (GitHub form `###` headings are accepted too).
Issue branches use `issue/<number>-<slug>`. A write worker first checks that
its issue is open, assigned to the owner, scoped, and has exactly one category.
New files need an explicitly writable existing parent directory; use the
narrowest parent and inspect the final write-set. Harness-policy changes are
made by Astra, not delegated to a worker that could weaken its own boundary.

Review the diff, run relevant local checks, get GLM Flash to challenge the
actual code and run tests, fix findings, and retest. Reports must distinguish
passed, failed, and unrun checks. A model self-report is not independent
runtime proof. Test lifecycle and memory behavior when a change can leak;
a static review alone cannot establish leak freedom.

```sh
git add <scoped-files>
git commit -m 'Preserve a draft after a failed save'
scripts/notation-task pr --title 'Preserve a draft after a failed save' --body-file /tmp/pr.md
# For unresolved validation or design questions, add --draft and do not merge.
# After Astra inspects successful checks and resolved independent findings:
scripts/notation-task record-review --checks-file /tmp/checks.txt --review-file /tmp/review.txt
# When merging is part of the authorized task:
scripts/notation-task merge 12
```

The PR body needs `Closes #<issue>` and substantive `## Validation` and
`## Review` sections. Acceptance evidence is stored in local Git metadata,
linked to the committed HEAD; it is an advisor attestation, not automatic
verification that a report is truthful. A new commit invalidates it. Merge
compares local HEAD, accepted HEAD and live PR HEAD, verifies the linked
issue/branch, then uses squash and `--match-head-commit`.

Hooks reject commits without a scoped assigned issue and pushes to main,
other refs, deletions and non-fast-forward updates. They require live GitHub
access and fail closed offline. These are local guardrails: a human with
repository access can bypass local hooks. GitHub server branch protection
was unavailable for this private repository on its current plan. No server
protection, remote review requirement or CI enforcement is claimed.

## Filesystem and credential boundary

All model processes and their subprocesses run in a fresh Bubblewrap mount,
PID, IPC, UTS and user namespace, with capabilities dropped and a clean
environment. The host home, other projects, host `/tmp`, session buses and
SSH-agent sockets are absent. `/usr` and an allowlist of public system inputs
(DNS, CA certificates, account names and runtime loader data) are read-only;
`/proc` belongs to the new PID namespace and `/dev` is a minimal device tree.

| Surface | Astra | Implementer | GLM review |
| --- | --- | --- | --- |
| This checkout | Writable | Only declared files/directories writable | Read-only |
| Git metadata | Writable | Read-only | Read-only |
| Harness policy | Writable | Protected | Protected |
| Dependencies / optional Python and Rust installations | Read-only | Read-only | Read-only |
| Home / temporary files / test caches | Private scratch | Private scratch | Private scratch |
| GitHub authentication | Existing token, memory only | Absent | Absent |
| Native Codex authentication | Existing auth file, read-only bind | Absent | Absent |
| OpenCodex proxy configuration | Memory only | Memory only | Memory only |

Astra can fetch/pull, push issue branches, create PRs and merge accepted PRs
using the existing GitHub account. It does not get the rest of your home,
SSH keys or keyring sockets. Its history is project-local under ignored
`.agent-state/`; preserve it privately. Expired native authentication must be
refreshed on the host. Provider credentials remain in their existing stores.

Only provider maps from OpenCodex's injected configuration enter the sandbox;
host plugins, agents, MCP servers and permission overrides are discarded.
Workers cannot modify `.git`, `.codex`, `.github`, `.githooks`, `.serena`,
AGENTS, orchestration docs, model config, dependencies or launcher scripts.
Repository `.env*` regular files at every source-directory depth except `.env.example` are masked; secret
symlinks and directories are rejected. Bubblewrap receives its arguments via
an anonymous memory descriptor, keeping injected credentials out of argv. Never put
credentials in tracked source, Git URLs or prompts. A symlinked node_modules
is shared only as a read-only dependency tree, without exposing its parent
checkout; use a normal npm install for a portable independent clone.

Vite caches, reports, Serena cache/memories and Cargo target output are temporary.
Playwright writes below the disposable report mount points, generates PDF assets
in a disposable `public/pdfjs` mount, and uses two workers. If installed, the
fixed runner selects `/usr/bin/chromium`; otherwise Playwright needs its browser.
Launch preparation may create empty, gitignored mount-point directories in the
checkout and empty cache mount-point directories in the selected dependency
tree (including a shared symlink target); test and worker output goes into
disposable mounts. Secret discovery
does not traverse dependency trees, Git internals or masked agent history.
Report results before exit: scratch artifacts vanish. A suite that needs
additional writes fails rather than silently widening the sandbox. Every approved test runs in a nested sandbox with source read-only and no
model or GitHub credentials, including tests requested by Astra. Local
trusted tests can execute arbitrary code but remain within this mount policy.
GLM's OpenCode policy denies edits, delegation, general shell and web tools;
only exact `scripts/notation-review-check <suite>` commands are allowed.

Network access is shared for provider APIs, GitHub and dependency tools.
This is a filesystem sandbox, not an egress firewall; it does not prevent
exfiltration of data that was deliberately made available to the model.
Astra is the trusted project integrator and can alter this checkout, including
its guardrails. The boundary protects your other files, not code from its
owner. Concurrent hostile processes under your own host user are outside
this boundary; keep a single writer for this checkout. Git credentials are
intentionally available only in that trusted role.

## Serena and checks

`.codex/config.toml` and `opencode.json` pin `serena-agent==1.7.0` via Python
3.13, dashboard disabled. `.serena/project.yml` selects the Svelte language
server (also supports this project's TypeScript). Start by reading Serena's
`initial_instructions`, activate `/work` if it reports no active project,
then use symbol tools such as `get_symbols_overview` and `find_symbol`.
Serena is disabled in GLM and `--read-only` workers to avoid mutation tools.

```sh
python3 tests/orchestration_test.py
scripts/notation-review-check check
scripts/notation-review-check store
```

Other fixed suites: preferences, documents, markdown, tables, export, canvas,
workspace, citations, hemingway, code, e2e, native and orchestration. The native
suite needs Rust and platform libraries; e2e needs Playwright browsers. Test
only relevant areas, report unavailable prerequisites, and never update
snapshots or weaken tests through the reviewer command.
