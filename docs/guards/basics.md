# basics

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Three narrow rules for mistakes that cannot be undone, on by default.

## rm-root

Blocks `rm -rf`, `Remove-Item -Recurse -Force` and `rd /s` aimed at a filesystem or drive root, the home directory or a folder above it, or a folder above the current repository, including `*` at those.

```
rm -rf /                 rm -rf ~                 rm -rf ~/*
rm -rf ..                Remove-Item -Recurse -Force C:\
rd /s /q C:\
rm -Rf /                 rm -r -f /               rm --recursive --force /
rm -rf -- /              sudo rm -rf /            bash -c "rm -rf ~"
```

Wrappers (`bash -c`, `cmd /c`, `sudo`, `env` and the others listed in [kill-guard](kill-guard.md)) are opened for all three rules. Commands run on another machine with `ssh` pass.

Passes: `rm -rf node_modules`, `rm -rf ./dist`, and paths with variables it cannot expand.

## force-push-main

Blocks `git push --force`, `-f` or a `+` refspec to a protected branch: `main` and `master` unless `basics.protectedBranches` says otherwise.

```
git push --force origin main
git push -f origin master
git push origin +main
```

Passes: `--force-with-lease`, and force-pushes to other branches.

## discard-changes

Blocks `git reset --hard` when tracked files have uncommitted changes, and `git clean -fd` or `-fdx` when there are untracked files. Both pass on a clean tree. It runs `git status --porcelain` only for these two commands.

```
[bulkhead] basics: `git reset --hard origin/main` would throw away 2 uncommitted changes (src/app.js, src/db.js).
Commit them or run `git stash push -u` first, so they can be brought back.
```

## Turn off or tune

- `BULKHEAD_DISABLE=basics` turns all three off.
- `BULKHEAD_DISABLE=rm-root`, `force-push-main` or `discard-changes` turns off one rule.
- In a config file: `basics.enabled`, `basics.rmRoot`, `basics.forcePushMain`, `basics.discardChanges`, and `basics.protectedBranches`, for example `["main", "master", "release"]`. See [configuration](../configuration.md).

## Limits

That is all it covers. For broad coverage of destructive commands, see [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) or [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net). bulkhead is about machines shared by many sessions.
