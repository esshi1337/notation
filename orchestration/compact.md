# Notation compaction handoff

Summarize the session so a fresh context can continue without rereading
history. Keep it under 2,000 tokens; prefer paths and exact commands over
prose. Never carry credentials, full file contents, or large logs.

## Required content

1. **Intent** — the user's goal and the current task in one or two sentences.
2. **Authorization** — what the user has explicitly approved or declined
   (push, merge, deploy, destructive steps). Preserve exact scope.
3. **State** — branch or worktree, active task or packet ID, worker sessions
   and their status, applied migrations, long-running processes.
4. **Decisions** — accepted approaches and rejected alternatives with reasons.
5. **Evidence** — exact check commands and results (pass/fail/unrun), artifact
   paths, key file paths with one-line relevance notes.
6. **Next action** — the single next step, plus known risks or blockers.

## Rules

- Drop resolved back-and-forth; keep only decisions and evidence that bind
  future work.
- If a worker session was active, record the agent name, task, and whether its
  result was fetched and verified.
- Compaction must preserve intent, authorization, and live state; anything
  ambiguous goes under Next action as an open question.
