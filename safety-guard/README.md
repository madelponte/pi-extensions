# Safety Guard

Confirms before destructive shell commands and before Git commands that may change repository state. Common read-only Git commands such as `status`, `diff`, `log`, and `show` run without confirmation. Unknown Git subcommands are treated as mutating. In non-UI modes, commands requiring approval are blocked.

## What triggers a prompt

- **File deletion**: `rm`/`rmdir` at a command boundary — start of command, after `;`/`&`/`|` or a newline, inside `$( )`, backticks, subshells, or `sh -c '...'` quotes — and after `sudo` (including flag forms like `sudo -u deploy rm -rf /`).
- **`find`-based deletion**: `find … -delete` and `find … -exec rm …`.
- **Disk operations**: `shred`, `wipefs`, `mkfs*`, `fdisk`, `parted`.
- **Raw overwrite**: `dd … of=`.
- **Process termination**: `kill`, `killall`, `pkill`.
- **Container data deletion**: `docker`/`podman` `system prune`, `volume rm`, `image rm`, `container rm`.
- **Kubernetes**: `kubectl delete`.
- **Database deletion**: `dropdb`, `DROP DATABASE/TABLE/SCHEMA`, `TRUNCATE TABLE`.
- **Git state changes**: any `git` subcommand other than a read-only allowlist (`status`, `log`, `diff`, `show`, `branch --list`-style, `tag --list`, `remote -v/show/get-url`, `stash list/show`, `worktree list`, `config` getters, …). Git invocations are detected after wrappers too: `sudo`/`command` with flags, `env` (with flags/assignments), leading `VAR=value` assignments (`GIT_DIR=/x git push`), and inside `bash -c "git push"` / `sh -c 'git push'` / `$(git push)` / multi-line commands.

Detection is a heuristic scanner over the command string, not a shell parser. It errs toward asking (a confirm prompt) rather than missing a destructive command, so occasional false positives are possible. It cannot see inside interpreted payloads such as `node -e "..."` or `curl … | sh`.

## Layout

- `index.ts` — the pi extension (wires the `tool_call` event to the guard).
- `guard.ts` — pure command analysis, dependency-free so it can be tested without pi.
- `test.ts` — test suite for the guard.

## Tests

Run with Node 22.18+ (or `node --experimental-strip-types` on older Node 20/22):

```bash
node ~/.pi/agent/extensions/safety-guard/test.ts
```
