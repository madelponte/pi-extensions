/**
 * Pure command analysis for the safety guard extension.
 *
 * Kept dependency-free (no pi imports) so it can be unit-tested with plain
 * Node: `node safety-guard/test.ts`.
 *
 * Design note: this is a heuristic scanner over the command string, not a
 * shell parser. It deliberately errs toward flagging (a confirm prompt)
 * rather than missing destructive commands. Inherent limits: it cannot see
 * inside interpreted payloads (`node -e "..."`, `curl ... | sh`) or
 * indirection such as `xargs`, `at`, or cron entries.
 */

const READ_ONLY_GIT_COMMANDS = new Set([
	"annotate", "blame", "count-objects", "describe", "diff", "diff-tree", "for-each-ref", "fsck",
	"grep", "help", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "reflog",
	"rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version", "whatchanged",
]);

/**
 * A "command boundary": the start of the command string, a shell separator
 * (`;`, `&`, `|`), a subshell or command-substitution opener (`(`, `$(`,
 * backtick), a quote (covers `sh -c 'rm ...'`), or a newline (multi-line
 * commands).
 */
const COMMAND_BOUNDARY = String.raw`(?:^|[;&|(\n\`'"]|\$\()\s*`;

/** A `VAR=value` environment assignment token. */
const ENV_ASSIGN = String.raw`\b[A-Za-z_][A-Za-z0-9_]*=\S*`;
/** A shell flag token, optionally taking a value (e.g. `-u deploy`). */
const FLAG_PAIR = String.raw`-\S+(?:\s+\S+)?`;

/**
 * Wrappers that may directly precede a git invocation:
 * - `sudo` / `command` with flag tokens (e.g. `sudo -u deploy git ...`)
 * - `env` with flags/assignments (e.g. `env -i git ...`, `env FOO=1 git ...`)
 * - leading `VAR=value` assignments (e.g. `GIT_DIR=/x git ...`)
 */
const GIT_WRAPPER =
	`(?:` +
	`(?:\\b(?:sudo|command)\\b(?:\\s+${FLAG_PAIR})*\\s+)|` +
	`(?:\\benv\\b|${ENV_ASSIGN})(?:\\s+${FLAG_PAIR})*(?:\\s+${ENV_ASSIGN})*\\s+)`;

/**
 * Matches a git invocation:
 * - `git` at a command boundary (start, `;`/`&`/`|`, newline, `$( )`,
 *   backticks, subshells, or a closing quote as in `bash -c "git push"`), or
 * - `git` after a wrapper (see GIT_WRAPPER).
 *
 * A `git` embedded in a longer identifier (`git-lfs`, `.git`, `git@host`,
 * `grep git`) is not treated as an invocation.
 *
 * Group 1 is always the argument text following `git`.
 */
const GIT_INVOCATION = new RegExp(
	`(?:${COMMAND_BOUNDARY}|${GIT_WRAPPER})git\\b(?![-.@])([^\\n;&|]*)`,
	"gi",
);

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
	// rm/rmdir at a command boundary, or after sudo (with flag tokens, e.g.
	// `sudo -u deploy rm -rf /`).
	[new RegExp(`(?:${COMMAND_BOUNDARY}|\\bsudo\\b(?:\\s+${FLAG_PAIR})*\\s+)(rm|rmdir)\\b`, "i"), "file deletion"],
	[/\b(shred|wipefs|mkfs(?:\.[\w-]+)?|fdisk|parted)\b/i, "destructive disk operation"],
	[/\b(dd)\b[^\n;&|]*\bof\s*=/i, "raw device/file overwrite"],
	[/\b(kill|killall|pkill)\b/i, "process termination"],
	[/\b(docker|podman)\s+(system\s+prune|volume\s+rm|image\s+rm|container\s+rm)\b/i, "container data deletion"],
	[/\b(kubectl)\s+delete\b/i, "Kubernetes resource deletion"],
	[/\b(dropdb|DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "database deletion"],
	// `find ... -delete` and `find ... -exec rm ...`.
	[/\bfind\b[^\n;&|]*(?:\s-delete\b|\s-exec\b[^\n;&|]*\brm\b)/i, "find file deletion"],
];

function shellWords(value: string): string[] {
	return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

/** Returns a reason when the command contains a git invocation that may change repository state. */
export function gitInvocationReason(command: string): string | undefined {
	for (const match of command.matchAll(GIT_INVOCATION)) {
		const words = shellWords(match[1] ?? "");
		let index = 0;
		while (index < words.length) {
			const word = words[index];
			if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") {
				index += 2;
				continue;
			}
			if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=") || word.startsWith("--namespace=")) {
				index++;
				continue;
			}
			if (word.startsWith("-")) {
				index++;
				continue;
			}
			break;
		}

		const subcommand = words[index]?.toLowerCase();
		const args = words.slice(index + 1);
		if (!subcommand) return "Git invocation with no identifiable read-only subcommand";
		if (READ_ONLY_GIT_COMMANDS.has(subcommand)) continue;
		if (subcommand === "branch" && (args.length === 0 || args.every((arg) => /^(--list|-l|--all|-a|--remotes|-r|--show-current|--contains|--no-contains|--merged|--no-merged|--sort=|--format=|--column|--no-column)/.test(arg)))) continue;
		if (subcommand === "tag" && (args.length === 0 || args.some((arg) => arg === "--list" || arg === "-l"))) continue;
		if (subcommand === "remote" && (args.length === 0 || ["-v", "show", "get-url"].includes(args[0]))) continue;
		if (subcommand === "stash" && ["list", "show"].includes(args[0])) continue;
		if (subcommand === "worktree" && args[0] === "list") continue;
		if (subcommand === "config" && args.some((arg) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)$/.test(arg))) continue;
		return `Git command may change repository state: git ${subcommand}`;
	}
	return undefined;
}

/** Returns a reason when the command looks destructive, or undefined if it looks safe. */
export function approvalReason(command: string): string | undefined {
	const gitReason = gitInvocationReason(command);
	if (gitReason) return gitReason;
	for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}
