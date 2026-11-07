# Safety Guard

> Compatibility: reviewed against Pi 1.5.0.

Confirms before destructive Bash commands and before Git commands that may change repository state. Common read-only Git commands such as `status`, `diff`, `log`, and `show` run without confirmation. Unknown Git subcommands are treated as mutating. Approval prompts expire after **30 minutes**, denying the command and switching to **unattended deny-and-continue** mode. In non-UI modes, commands requiring approval are always blocked. The guard intercepts Pi's built-in `bash` tool; it does not inspect PowerShell or commands executed by MCP/custom tools.

## Modes and unattended sessions

After updating the extension, run `/reload` to activate it.

| Command | Behavior |
| --- | --- |
| `/safety unattended` | Immediately deny guarded commands without prompting; leave permitted commands unchanged. Also cancels any pending safety approval. |
| `/safety interactive` | Restore approval prompts with a 30-minute deadline. Never replays previously blocked commands. |
| `/safety status` or `/safety` | Show the current mode, timeout, and a bounded denial summary for the current/most recent run. |

There is no disable/auto-approve mode, and no agent-callable tool for changing permissions. The footer reports the current mode and blocked-attempt count.

**Default: interactive.** Each approval request has a fixed 30-minute deadline, not a session-wide inactivity timer. Typing, scrolling, or sending other messages does not extend the deadline. When it expires:

1. The pending command is denied, never approved or queued for replay.
2. The guard switches to unattended mode and cancels any other pending approvals.
3. The agent receives a tool error explaining the transition and how to continue safely.
4. Subsequent guarded Bash calls are denied immediately; permitted work can continue.

The TUI shows a countdown and preserves the deliberate `y` approval requirement. RPC uses a standard confirmation with an agent-side deadline, so an unresponsive client cannot leave the guard waiting indefinitely. Manual denial, cancellation, or aborting the turn does **not** switch modes. Timers and abort listeners are cleaned up on completion and shutdown.

Mode is **in memory only**: it lasts across turns, compaction, and subsequent prompts in the same extension runtime, until changed explicitly. `/reload`, restart, or session replacement (`/new`, `/resume`, `/fork`, `/clone`) creates a fresh runtime with interactive mode. Mode and retry counters are not restored from session history. Non-UI modes still fail closed regardless of the selected mode. The timeout is currently fixed by `APPROVAL_TIMEOUT_MS` in `runtime.ts` (30 minutes), with no configuration file or CLI flag.

### Agent guidance, retry limits, and review

The guard injects policy guidance at the start of each run and includes guidance with every denial:

- Do not retry a denied operation through another command, script, or tool, or change the guard's configuration.
- Skip optional cleanup and continue independent permitted work.
- Report skipped operations and approval-dependent work in the final response.
- If nothing independent remains, finish with a blocked-work summary rather than asking for approval or looping.

As a retry-loop backstop, **three denials of the identical command in one run** stop the active run when unattended or without UI. This abort can also cancel sibling tools still running. Different denied commands do not trigger that limit; this is not a semantic detector for rewritten commands. Retry tracking stores at most 64 recent command fingerprints, not raw command strings, and resets at the next run.

After a run settles, a non-triggering transcript message summarizes blocked attempts by reason. `/safety status` shows the same current/most-recent-run counts. Review data is bounded (eight reason categories plus an overflow category, each limited to 160 characters); it does not duplicate full commands. Consult the original tool calls for exact commands. These summary messages remain in session history, but do not persist the selected mode.

Deny-and-continue does not promise task completion: a necessary blocked operation may leave work incomplete. It also does not change other interaction tools, which may still ask questions or pause a run. Detection rules, including the existing lexical `/tmp` exception, are unchanged. This remains a heuristic guard, not a sandbox or protection against arbitrary scripts and overwrites; use isolation and protected backups for stronger data protection.

## What requires approval (or is denied unattended)

Commands are recognized in command position: at the start of the command, after `;`/`&`/`|` or a newline, at the start of a `case` arm, after the shell control words `if`/`elif`/`then`/`else`/`while`/`until`/`do` or `!`, inside `$( )`, backticks, subshells, or `sh -c '...'` quotes. The scanner also looks through wrappers and launchers that run another command: `command`, `env` (with flags and assignments, path-qualified or not), leading `VAR=value` assignments, `time`, `nohup`, `nice`, `ionice`, `setsid`, `stdbuf`, `exec`, `xargs`, `timeout`, `chrt`, and `taskset`. A backslash-escaped name such as `\rm` is treated like the plain command. Words in other positions, such as `grep kill src/` or `npm run kill-port`, do not trigger a prompt.

- **File deletion**: `rm`/`rmdir`, including after `sudo` (with flag forms like `sudo -u deploy rm -rf /`). A direct invocation whose targets are all static paths lexically below `/tmp` runs without confirmation; mixed or dynamic targets, `/tmp` itself, `rmdir -p`, wrapper/launcher-prefixed commands (`nohup rm`, `FOO=1 rm`, ...), privileged/path-qualified invocations, and `unlink` still require approval.
- **Alternate deletion forms**: `unlink`, `xargs rm`, `rsync --delete*`/`--remove-source-files`, plus `find … -delete` and `find … -exec`/`-execdir`/`-ok`/`-okdir` with `rm`, `rmdir`, `unlink`, or `shred`.
- **Privilege escalation**: `sudo`, `sudoedit`, `doas`, `pkexec`, `run0`, and `su -c`/`su --command` (including combined flags such as `su -lc`).
- **Permissions and ownership**: recursive `chmod`/`chown`/`chgrp` (`-R`, combined short flags containing `R`, or `--recursive`) and `setfacl`.
- **Disk operations**: `shred`, `wipefs`, `mkfs*`, `fdisk`, `sfdisk`, `parted`, `blkdiscard`.
- **Raw overwrite**: `dd … of=`.
- **Process termination**: `kill`, `killall`, `pkill`.
- **Container data deletion**: `docker`/`podman` `rm`, `rmi`, `system|volume|image|container prune`/`rm`, `system reset`, and `compose down -v`/`--volumes` (including `docker-compose`/`podman-compose`), with or without global flags.
- **Kubernetes**: `kubectl delete`, including after global flags such as `-n prod` or `--context prod`.
- **Database deletion**: `dropdb`, and `DROP DATABASE/TABLE/SCHEMA` or `TRUNCATE TABLE` at the start of a statement.
- **Git state changes**: any `git` subcommand other than a read-only allowlist (`status`, `log`, `diff`, `show`, `cat-file`, `show-branch`, `check-ignore`, display-only `reflog`, list-only `branch` such as `branch -v` or `branch --contains`, `tag --list`, `remote -v/show/get-url`, `stash list/show`, `worktree list`, `config` getters such as `--get`, `--list`, `config get`, or a single key, …). `config` with `--unset*`, `--remove-section`, `--rename-section`, `--add`, `--replace-all`, `--edit`, or the `set`/`unset`/`edit` subcommands requires approval.
- **Git options that run programs or write files**: `-c` overrides other than display-only keys (`color.*`, `column.*`, `advice.*`, `core.quotepath`, and `core.pager=cat`), `--config-env`, `--exec-path=`, `--output`, `--ext-diff`, `--textconv`, `git grep -O`/`--open-files-in-pager`, and `git fsck --lost-found`.

Git invocations are detected in command position and after `sudo`/`command`/`env`/`VAR=value` wrappers anywhere in the command, including path-qualified forms (`/usr/bin/git`) and inside `bash -c "git push"` / `sh -c 'git push'` / `$(git push)` / multi-line commands.

Detection is a heuristic scanner over the command string, not a shell parser or security sandbox. It errs toward asking (a confirm prompt) rather than missing a destructive command, so occasional false positives are possible. It cannot see inside interpreted payloads such as `node -e "..."` or `curl … | sh`.

In the TUI, approval uses a height-bounded command preview so long commands do not force the terminal to redraw thousands of rows. While the prompt is visible, Pi reports that it is blocked on a permission decision. Scroll by line with the configured selection up/down keys and by page with the configured selection page keys. Approve with `y` and deny with `n` or the configured selection-cancel key; Enter does nothing. Because the prompt takes keyboard focus as soon as it appears, `y` and `n` count only after a short pause in typing, so keys from a message being typed cannot approve or deny the command. The cancel key always denies immediately. RPC mode continues to use Pi's standard confirm dialog. Aborting the active turn closes either prompt and denies the command.

## Layout

- `index.ts` — the Pi extension: mode commands, policy guidance, approval UI, and tool-call interception.
- `guard.ts` — pure command analysis, dependency-free so it can be tested without Pi.
- `runtime.ts` — approval deadline and bounded denial/retry tracking, using only Node built-ins.
- `test.ts` — command-scanner regression tests.
- `runtime-test.ts` — fake-clock tests for deadlines, cancellation, cleanup, and review-data limits.
- `extension-test.ts` — offline integration tests using the installed Pi loader and mocked TUI/RPC contexts.

## Tests

Run with Node 22.18+ (or `node --experimental-strip-types` on older Node 20/22):

```bash
node ~/.pi/agent/extensions/safety-guard/test.ts
node ~/.pi/agent/extensions/safety-guard/runtime-test.ts
```

Run the offline integration tests from this repository, passing the installed Pi package directory (adjust the version/path for your installation):

```bash
node safety-guard/extension-test.ts \
  ~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent
pi --no-extensions --offline --list-models -e ./safety-guard/index.ts
```

The integration suite uses Pi's loader, real key parsing/width utilities, mocked UI/context, and Node's fake timers; no model, MCP, shell command, or real 30-minute wait is involved. It covers timeout transitions in TUI/RPC, late approvals, explicit mode changes, no-UI denial, retry-loop stopping, run summaries, shutdown/reload behavior, deliberate keys, remapped navigation/cancellation, and narrow rendering. Node may print an experimental warning for its MockTimers API.

For a live smoke test after `/reload`, use harmless/nonexistent targets: verify an interactive guarded command can be denied, `/safety unattended` denies immediately while read-only commands still work, and `/safety interactive` restores prompting. Check both fullscreen and regular TUI layouts. The automated fake-clock tests exercise the full 30-minute expiry without lowering the production timeout.
