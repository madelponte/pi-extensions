# Repository Guide for Coding Agents

## Scope

This repository contains global extensions for the Pi coding agent. A single root guide is intentional: the repository is small, and extension-specific operational details already live in each extension's `README.md`. This file applies to every directory unless a future nested `AGENTS.md` overrides it.

## Read Pi documentation first

Before changing an extension, read Pi's extension documentation completely and follow the relevant cross-references and examples. In this environment, the primary references are:

- Extension API: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Additional docs: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
- Extension examples: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

For custom TUI work, also read `docs/tui.md` and any linked keybinding/theme documentation. Prefer current Pi APIs and examples over assumptions from older versions.

## Compatibility baseline

The extensions were last reviewed against Pi `0.85.0`. Before a future upgrade, read the installed package's `CHANGELOG.md` from this baseline forward, then re-run the extension load checks and targeted tests below. Pi `0.85.0` did not introduce an extension API breaking change; the relevant TUI guidance is that custom components should honor the injected `KeybindingsManager` rather than hard-coded keys.

## Repository layout

- `ask-user/index.ts` — registers the sequential, blocking `ask_user` tool. TUI mode uses a custom focus-aware component; RPC mode uses standard `select`/`editor` dialogs; non-UI modes return an unavailable result instead of hanging.
- `mcp-bridge/` — starts one MCP client during `session_start`, discovers the server's tools, and registers them dynamically. It closes the client during `session_shutdown`, truncates large model-facing output, and writes full truncated output to a private temporary file through Pi's file mutation queue. See its `README.md`, schema, and example config.
- `safety-guard/` — intercepts typed built-in Bash tool calls and asks for approval before risky commands. Command analysis is isolated in `guard.ts` and covered by `test.ts`.
- `tool-profiles/` — provides `/profile` and `/profile-status` commands for switching active tool sets. `main` intentionally means every registered tool, while `no-mcp` identifies MCP tools from their name or Pi `sourceInfo` metadata. Profile state is in memory for the current session runtime.
- `LICENSE` — MIT license.

Pi auto-discovers top-level `*.ts` extensions and extension directories containing `index.ts` from this location. After changing extension code, reload Pi with `/reload` before interactive verification.

## Working conventions

- Inspect `git status` before editing. Preserve unrelated user changes and never restore or rewrite files merely because they are already modified or deleted.
- Read the relevant extension's source and `README.md` before changing behavior.
- Keep extensions focused and dependency-light. Do not add a root build system unless the task requires one.
- TypeScript is loaded directly by Pi through jiti; extension code does not need a compile step.
- Follow the existing style: tabs for indentation, semicolons, double quotes, and type-only imports where appropriate.
- Use `isToolCallEventType` to narrow built-in tool events.
- Guard dialogs with `ctx.hasUI`; distinguish TUI-only custom components with `ctx.mode === "tui"`.
- Start long-lived resources during session lifecycle events, not extension factory initialization, and clean them up in `session_shutdown`.
- Use TypeBox schemas for custom tool parameters. Keep Google compatibility requirements from Pi's docs in mind when adding enums.
- Use Pi's output truncation helpers for tools that can return large results. File-mutating custom tools must participate in `withFileMutationQueue`.
- Update the extension's `README.md` whenever configuration, commands, safety policy, or setup behavior changes.
- Run `git diff --check` before finishing.

## Testing

There is no repository-wide test runner. Run checks relevant to the extension you changed.

### Safety guard

```bash
node safety-guard/test.ts
```

The safety guard is a conservative heuristic scanner, not a shell parser. Preserve these policy properties unless the user explicitly requests otherwise:

- Direct `rm`/`rmdir` with only static paths lexically beneath `/tmp` may run without approval.
- Dynamic paths, mixed targets, `/tmp` itself, and `rmdir -p` require approval.
- Privileged, wrapped, or path-qualified deletion forms remain guarded, even when their target is in `/tmp`.
- Unknown or mutating Git invocations require approval; known read-only Git operations do not.
- Alternate deletion, privilege escalation, recursive permission/ownership changes, and ACL changes require approval.
- Non-UI modes fail closed when approval would be required.

Add both positive and negative regression cases for scanner changes. Test harmless/nonexistent paths during interactive confirmation checks so accidental approval cannot damage data.

### MCP bridge

The MCP bridge has its own pinned dependencies:

```bash
cd mcp-bridge
npm ci
```

Use `npm ci` for normal setup. Use `npm install` only when intentionally updating dependencies, and commit `package.json` and `package-lock.json` together. Do not edit or commit `mcp-bridge/node_modules/`.

`mcp-bridge/config.json` and local backup variants may contain secrets. Never read them unless the user explicitly asks, and never print or commit their contents. Use `config.json.example` and `config.schema.json` for documented configuration changes. MCP calls may require a live configured server, so clearly report when validation is limited to static checks.

### Extension load checks

Validate that each factory still imports and registers against the installed Pi version without starting a session or making model/MCP calls:

```bash
pi --no-extensions --offline --list-models -e ./ask-user/index.ts
pi --no-extensions --offline --list-models -e ./mcp-bridge/index.ts
pi --no-extensions --offline --list-models -e ./safety-guard/index.ts
pi --no-extensions --offline --list-models -e ./tool-profiles/index.ts
```

`ask-user` and `tool-profiles` currently have no automated test suite. Validate their control flow statically, then use `/reload` and exercise the affected tool or slash command interactively when practical. For `ask-user`, cover open-ended and multiple-choice paths, cancellation, custom responses, narrow rendering, remapped selection keys, RPC dialogs, and non-UI fallback.

## Finishing work

Summarize changed files and validation performed. Mention unrelated pre-existing working-tree changes only when useful to prevent confusion, and do not include secrets or local MCP configuration in output.
