# Repository Guide for Coding Agents

## Scope

This repository contains global extensions for the Pi coding agent. A single root guide is intentional: the repository is small, and extension-specific operational details already live in each extension's `README.md`. This file applies to every directory unless a future nested `AGENTS.md` overrides it.

## Read Pi documentation first

Before changing an extension, read Pi's extension documentation completely and follow the relevant cross-references and examples. In this environment, the primary references are:

- Extension API: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Additional docs: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
- Extension examples: `/home/mdelponte/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

For custom TUI work, also read `docs/tui.md` and any linked keybinding/theme documentation. Prefer current Pi APIs and examples over assumptions from older versions.

## Repository layout

- `ask-user/index.ts` — registers the blocking `ask_user` tool, including custom TUI and RPC interaction paths.
- `mcp-bridge/` — discovers one MCP server's tools and exposes them as Pi tools. See its `README.md`, schema, and example config.
- `safety-guard/` — intercepts Bash tool calls and asks for approval before risky commands. Command analysis is isolated in `guard.ts` and covered by `test.ts`.
- `tool-profiles/` — provides `/profile` and `/profile-status` commands for switching active tool sets.
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

`mcp-bridge/config.json` is local, ignored, and may contain secrets. Never print or commit its contents. Use `config.json.example` and `config.schema.json` for documented configuration changes. MCP calls may require a live configured server, so clearly report when validation is limited to static checks.

### Other extensions

`ask-user` and `tool-profiles` currently have no automated test suite. Validate their control flow statically, then use `/reload` and exercise the affected tool or slash command interactively when practical.

## Finishing work

Summarize changed files and validation performed. Mention unrelated pre-existing working-tree changes only when useful to prevent confusion, and do not include secrets or local MCP configuration in output.
