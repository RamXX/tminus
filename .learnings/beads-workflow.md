# Beads Git Workflow Learnings

## beads-sync Branch Is for Protected Branches Only
**Priority:** Important
**Source:** Beads documentation (~/workspace/beads/docs/PROTECTED_BRANCHES.md)

The `beads-sync` branch exists to solve a specific problem: repositories with
protected `main` branches that require PRs for all changes. Beads uses it as a
metadata-only branch where issue state is auto-committed without disrupting main.

**When NOT to use it:** If you have no branch protection (e.g., local-only repos,
personal repos without PR requirements), beads-sync adds unnecessary complexity.
Just commit beads state directly to main.

**Lesson learned:** T-Minus ran its entire Phase 1 with an unnecessary beads-sync
branch because agents defaulted to it. Both branches stayed identical throughout
since all code merges were fast-forward. The branch was deleted after Phase 1 with
zero merge conflicts.

## Beads Worktrees for Multi-Agent Parallelism
**Priority:** Reference
**Source:** Beads documentation (~/workspace/beads/docs/WORKTREES.md)

For parallel agent work on the same codebase, beads supports git worktrees with a
shared database architecture:

```bash
# Always use bd worktree, never raw git worktree
bd worktree create .worktrees/agent-1 --branch feature/agent-1
bd worktree create .worktrees/agent-2 --branch feature/agent-2
```

Key rules:
- Set `BEADS_NO_DAEMON=1` in worktrees (daemon conflicts with shared DB state)
- All worktrees share one `.beads/` database (single source of truth)
- Use `bd worktree` commands to get proper config (gitignore, DB redirect files)
- Never use raw `git worktree add` -- it skips beads setup

## Wrangler TOML: Durable Objects Use bindings, Not classes
**Priority:** Critical
**Source:** Failed deploy dry-run, Cloudflare docs

The correct wrangler.toml format for Durable Objects uses `[[durable_objects.bindings]]`
with `name` (not `binding`), not `[durable_objects]` with `classes`:

```toml
# WRONG (old/invalid format):
[durable_objects]
classes = [
  { binding = "USER_GRAPH", class_name = "UserGraphDO" },
]

# CORRECT:
[[durable_objects.bindings]]
name = "USER_GRAPH"
class_name = "UserGraphDO"
```

For DO references from other workers, add `script_name`:
```toml
[[durable_objects.bindings]]
name = "USER_GRAPH"
class_name = "UserGraphDO"
script_name = "tminus-api"
```

All 5 T-Minus wrangler.toml files had this wrong. Fixed in commit with the
Phase 1.5 story creation.

## Beads Sync Modes
**Priority:** Reference
**Source:** Beads documentation

- `bd sync --flush-only` -- Export issues to JSONL without git operations. Use at
  session end when you just need to persist state.
- `bd sync --from-main` -- Pull beads updates from main into an ephemeral branch.
  Use when working on feature branches that need the latest issue state.
- `bd sync --merge` -- Merge beads-sync back into main. Use when running the
  protected-branch workflow.

For T-Minus (no branch protection), `bd sync --flush-only` at session close is
sufficient. The JSONL gets committed with the next regular commit.
