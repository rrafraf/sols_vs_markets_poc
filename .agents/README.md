# Agent Board

This folder is a pointer for Codex agents working in this repo.

On this host, `.agents/` may be read-only to shell commands. The live writable board is:

```txt
docs/agent-board.json
```

Keep it boring:

1. Read `docs/current-state.md`.
2. Read `docs/agent-board.json`.
3. Claim one task before editing.
4. Write only inside the task's stated file scope.
5. Leave a short update when done, blocked, or handing off.

The board is not project management theater. It exists so parallel agents do not collide, forget the north star, or silently duplicate work.

## Commands

```powershell
node scripts\agent-board.js list
node scripts\agent-board.js claim hell-bench-001 --agent "codex-main"
node scripts\agent-board.js update hell-bench-001 --status review --note "Added first scoreboard draft."
node scripts\agent-board.js add "Add deterministic replay test" --scope "training_ground/hell-bench.js"
node scripts\agent-board.js note --agent "codex-main" --text "Paused to re-check current-state."
```

## Status Values

- `todo` - unclaimed work.
- `claimed` - agent intends to work this soon.
- `in_progress` - active editing.
- `review` - ready for main integration/review.
- `blocked` - cannot proceed without input or another task.
- `done` - complete and verified.
- `dropped` - intentionally abandoned.

## Collision Rule

If another active task owns the same file, do not edit that file. Add a note or split the task first.
