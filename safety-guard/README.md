# Safety Guard

Confirms before destructive Bash commands and before Git commands that may change repository state. Common read-only Git commands such as `status`, `diff`, `log`, and `show` run without confirmation. Unknown Git subcommands are treated as mutating. In non-UI modes, commands requiring approval are blocked. The guard intercepts Pi's built-in `bash` tool; it does not inspect PowerShell or commands executed by MCP/custom tools.

## What triggers a prompt

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

In the TUI, approval uses a height-bounded command preview so long commands do not force the terminal to redraw thousands of rows. Scroll by line with the configured selection up/down keys and by page with the configured selection page keys. Approve with `y` and deny with `n` or the configured selection-cancel key; Enter does nothing. Because the prompt takes keyboard focus as soon as it appears, `y` and `n` count only after a short pause in typing, so keys from a message being typed cannot approve or deny the command. The cancel key always denies immediately. RPC mode continues to use Pi's standard confirm dialog. Aborting the active turn closes either prompt and denies the command.

## Layout

- `index.ts` — the pi extension (wires the `tool_call` event to the guard).
- `guard.ts` — pure command analysis, dependency-free so it can be tested without pi.
- `test.ts` — test suite for the guard.

## Tests

Run with Node 22.18+ (or `node --experimental-strip-types` on older Node 20/22):

```bash
node ~/.pi/agent/extensions/safety-guard/test.ts
```
