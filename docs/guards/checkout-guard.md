# checkout-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Two sessions in one checkout share one branch and one set of files. When one of them runs `git checkout other-branch` or `git stash`, the other one's edits vanish or land on the wrong branch, and it usually does not notice. checkout-guard blocks git commands that move the working tree when another live Claude session works in the same tree.

## Blocked

When another live session works in the same tree:

```
git checkout main
git switch -c feature
git stash            git stash pop        git stash apply
git reset --hard
git clean -f
git rebase main
git merge feature
git restore .
git checkout -- .
git pull             # only when there are uncommitted changes
```

## Allowed

```
git checkout -- src/app.js     # restoring single files
git restore --staged .
git rebase --abort             git merge --continue
```

Anything in a tree no other session uses passes. git runs only when a command matches and another session is alive.

## What Claude sees

```
[bulkhead] checkout-guard: `git checkout main` switches the branch in /home/me/src/acme-web, and another Claude session works in the same tree (pid 18672, started 2026-10-13 10:40).
Its files and branch would change under it. Work in your own worktree instead:
  git worktree add ../acme-web-<task> -b <branch>
```

## How it finds other sessions

Other sessions come from the session files Claude Code keeps in `~/.claude/sessions`, which record each session's PID, ID and project directory. A session counts when its PID is alive, its ID is not the current session's, and its project directory is inside the same `git rev-parse --show-toplevel` (compared without case on Windows). Subagents share their parent's session ID, so they never block each other.

## Turn off or tune

- `BULKHEAD_DISABLE=checkout-guard`, or `"checkoutGuard": { "enabled": false }` in a config file, turns it off. See [configuration](../configuration.md).

## Limits

- A session that started in another directory and later `cd`'d into this tree is not seen.
- Wrappers such as `bash -c "git checkout main"` and prefixes such as `GIT_TRACE=1` are opened. Git commands sent over `ssh` pass.
