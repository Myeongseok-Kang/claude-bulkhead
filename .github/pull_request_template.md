## What changes

<!-- One or two sentences: what behaves differently after this PR. -->

## Why

<!-- The command, report or issue that prompted it. Link the issue if there is one. -->

## Checks

- [ ] `node --test` passes (say on which OS)
- [ ] New or changed behavior has a test; a false positive or missed block has its exact command in the guard's case table
- [ ] For a PreToolUse guard: `node scripts/bench-hooks.js 15` before and after (paste the two lines)
- [ ] `claude plugin validate . --strict` passes, if `hooks/`, `.claude-plugin/`, `commands/` or `skills/` changed
- [ ] New settings are in `src/config.js`, `config.example.json` and `docs/configuration.md`
- [ ] `CHANGELOG.md` updated under Unreleased, for user-visible changes
- [ ] No personal paths, host names or project names in code, tests or docs
