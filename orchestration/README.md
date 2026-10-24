# Notation orchestration

Local multi-model harness for this repository: one Astra advisor session in
Codex, bounded implementers, read-only challenger and security reviewers, and small-model scouts as
OpenCode agents routed through OpenCodex, with Serena MCP providing symbol-level navigation to both
runtimes. The working arrangement lives in AGENTS.md; this file is the quick
reference.

## Sessions

| Role | Launch | Model |
| --- | --- | --- |
| Advisor | `notation-advisor` (`codex -p notation-advisor`) | GPT-6 Astra, high reasoning |
| Scout (standalone) | `notation-scout` (`codex -p notation-scout`) | GPT-6 Luna |
| Workers / reviewers | `scripts/notation-worker <role> <prompt>` | see AGENTS.md table |

Launch from the repository root (or the assigned worktree) so the project
`.codex/config.toml` and `opencode.json` apply. Never run multiple advisor
sessions for one task.

## Files

- `AGENTS.md` — working arrangement and role table (ambient instructions).
- `.codex/config.toml` — project Codex config: Serena MCP server, multi-agent
  features disabled, compaction handoff prompt. No model keys on purpose:
  project model keys would override the selected Codex profile in 0.164.
- `opencode.json` — OpenCode agents, Serena MCP server, worker permission
  rules (`task` denied for implementers; `edit`/`bash`/`task` denied for
  reviewers and scouts), autocompaction settings.
- `orchestration/compact.md` — compaction handoff prompt referenced by the
  project Codex config using a path relative to `.codex/config.toml`, so the
  same configuration works in other checkouts without a machine-specific path.

## Serena

The project is registered in `.serena/project.yml` (`svelte` language server,
UTF-8). The MCP server runs pinned via uvx (`serena-agent==1.7.0`) with
`--context codex --project-from-cwd`; the svelte language server needs
`node_modules` present. The dashboard is disabled for the Codex server.

Reviewer launches disable Serena in the child runtime configuration, so its
mutation tools cannot bypass the built-in `edit`/`bash` permission denials.
Reviewers use built-in read, grep and glob tools. The launcher preserves other
inline configuration and leaves implementation sessions' Serena unchanged.
Scouts retain their existing instructions and permissions. These roles and
worker write-sets are not OS-level filesystem sandboxes; the advisor must
still scope packets and inspect changes independently.

## Model notes

- The DeepSeek worker uses `opencodex/combo/deepseek-auto`, the existing
  OpenCodex combo labeled DeepSeek (Go -> direct fallback). Its upstream
  aliases are not immutable 1017 revision pins. Combo membership and fallback
  policy stay managed in OpenCodex; do not silently bypass the combo.
- `opencodex/zai/glm-5.3` is the reviewer's second eye — a different model
  family from the OpenAI advisor, which is the point of a second opinion.
  `opencodex/zai/glm-5.3-flash` is the dedicated read-only security reviewer.
  GLM is no longer an implementation tier.
- `scout-flash` uses the free OpenCode Console tier: fine for text sweeps,
  not for judgment.
- Model and context budgets belong to the selected Codex profile, never to
  the project layer.

## Launching bounded tasks

```sh
scripts/notation-worker sol "<bounded implementation packet>"
scripts/notation-worker deepseek "<bounded implementation packet>"
scripts/notation-worker challenger "<read-only review packet>"
scripts/notation-worker security "<read-only security review packet>"
```

The launcher changes to this checkout, selects the configured agent, and runs
`opencodex opencode run --standalone`. OpenCodex injects its live provider
catalog and authentication through the child environment; no provider secrets
are written into this repository. The advisor remains the sole orchestrator.
Use Sol for complex debugging, ambiguous requirements and cross-file changes;
use DeepSeek for bounded implementation and targeted tests. Request GLM 5.3
as the independent challenger and GLM 5.3 Flash for security-relevant changes.
Do not automatically run a standing review team for every trivial edit.

Plain `opencode` or an ordinary OpenCode MCP server does not inject this
provider. To delegate through MCP, connect it to a server launched with
`opencodex opencode serve` using `OPENCODE_SERVER_URL`; reconnect the MCP after
changing that environment. Otherwise use the launcher above. Never silently
fall back to a different provider when the OpenCodex route is unavailable.
