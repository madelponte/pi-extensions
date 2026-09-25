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
	"grep", "help", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev",
	"rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version", "whatchanged",
]);

/**
 * A "command boundary": the start of the command string, a shell separator
 * (`;`, `&`, `|`), a subshell or command-substitution opener (`(`, `$(`,
 * backtick), a quote (covers `sh -c 'rm ...'`), or a newline (multi-line
 * commands).
 */
const COMMAND_BOUNDARY = String.raw`(?:^|[;&|(\n\`'"{}]|\$\(|\b(?:then|do|else)\b)\s*`;

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
const EXECUTABLE_PATH = String.raw`(?:[^\s;&|()]+/)*`;

const GIT_INVOCATION = new RegExp(
	`(?:${COMMAND_BOUNDARY}|${GIT_WRAPPER})${EXECUTABLE_PATH}git\\b(?![-.@])([^\\n;&|]*)`,
	"gi",
);

const RM_INVOCATION = new RegExp(
	`(?:${COMMAND_BOUNDARY}|\\bsudo\\b(?:\\s+${FLAG_PAIR})*\\s+)(rm|rmdir)\\b([^\\n;&|]*)`,
	"gi",
);

const COMMAND_WRAPPER = String.raw`command(?:\s+-\S+)*\s+`;
const ENV_COMMAND_WRAPPER = String.raw`env(?:\s+(?:${ENV_ASSIGN}|-\S+(?:\s+\S+)?))*\s+`;
const OPTIONAL_COMMAND_WRAPPER = `(?:(?:${COMMAND_WRAPPER})|(?:${ENV_COMMAND_WRAPPER}))?`;

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
	// Alternate deletion forms that do not go through the rm parser above.
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}unlink\\b`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}(?:${COMMAND_WRAPPER}|${ENV_COMMAND_WRAPPER})${EXECUTABLE_PATH}(?:rm|rmdir)\\b`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}(?:${ENV_ASSIGN}\\s+)+${EXECUTABLE_PATH}(?:rm|rmdir)\\b`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}(?:[^\\s;&|()]+/)+(?:rm|rmdir)\\b`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}xargs\\b[^\\n;&|]*\\b(?:rm|rmdir)\\b`, "i"), "xargs file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}rsync\\b[^\\n;&|]*\\s--delete(?:-\\S+)?\\b`, "i"), "rsync deletion"],
	// Privilege escalation should always be explicit, even for an otherwise safe command.
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}(?:sudo|sudoedit|doas)\\b`, "i"), "privilege escalation"],
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}su\\b[^\\n;&|]*(?:\\s-c\\b|\\s--command(?:=|\\s))`, "i"), "privilege escalation"],
	// Recursive permission changes and ACL mutation can disable access without deleting files.
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}(?:chmod|chown)\\b[^\\n;&|]*(?:\\s--recursive\\b|\\s-[A-Za-z]*R[A-Za-z]*\\b)`, "i"), "recursive permission/ownership change"],
	[new RegExp(`${COMMAND_BOUNDARY}${OPTIONAL_COMMAND_WRAPPER}${EXECUTABLE_PATH}setfacl\\b`, "i"), "ACL change"],
	[/\b(shred|wipefs|mkfs(?:\.[\w-]+)?|fdisk|parted)\b/i, "destructive disk operation"],
	[/\b(dd)\b[^\n;&|]*\bof\s*=/i, "raw device/file overwrite"],
	[/\b(kill|killall|pkill)\b/i, "process termination"],
	[/\b(docker|podman)\s+(system\s+prune|volume\s+rm|image\s+rm|container\s+rm)\b/i, "container data deletion"],
	[/\b(kubectl)\s+delete\b/i, "Kubernetes resource deletion"],
	[/\b(dropdb|DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "database deletion"],
	// `find ... -delete`, `-exec rm ...`, and `-execdir rm ...`.
	[/\bfind\b[^\n;&|]*(?:\s-delete\b|\s-exec(?:dir)?\b[^\n;&|]*\brm\b)/i, "find file deletion"],
];

function shellWords(value: string): string[] {
	return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function isRedirection(word: string): boolean {
	return /^\d*(?:<>|>>?|<<?|>&|<&)/.test(word);
}

/**
 * Returns a reason for rm/rmdir unless every target is lexically below /tmp.
 * This remains deliberately conservative: dynamic paths and `rmdir -p` need
 * approval because they may resolve outside /tmp or remove /tmp itself.
 */
function rmInvocationReason(command: string): string | undefined {
	for (const match of command.matchAll(RM_INVOCATION)) {
		const executable = match[1]?.toLowerCase();
		const words = shellWords(match[2] ?? "");
		const targets: string[] = [];
		let options = true;
		let skipRedirectionTarget = false;

		for (const word of words) {
			if (skipRedirectionTarget) {
				skipRedirectionTarget = false;
				continue;
			}
			if (isRedirection(word)) {
				skipRedirectionTarget = /^(?:\d*)(?:<>|>>?|<<?)$/.test(word);
				continue;
			}
			if (options && word === "--") {
				options = false;
				continue;
			}
			if (options && word.startsWith("-")) {
				if (executable === "rmdir" && (word === "--parents" || /^-[^-]*p/.test(word))) return "file deletion";
				continue;
			}
			options = false;
			targets.push(word);
		}

		if (targets.length === 0) return "file deletion";
		for (const target of targets) {
			// Ignore syntax that closes a command substitution/backtick invocation.
			const staticTarget = target.replace(/[)`]+$/, "");
			// Expansions can inject `..` or extra path components, so only static
			// paths (shell globs included) qualify for the /tmp exemption.
			if (/[`$(){}]/.test(staticTarget)) return "file deletion";
			const normalized = staticTarget.replace(/\/{2,}/g, "/").split("/").reduce<string[]>((parts, part) => {
				if (!part || part === ".") return parts;
				if (part === "..") parts.pop();
				else parts.push(part);
				return parts;
			}, []).join("/");
			if (!staticTarget.startsWith("/") || !normalized.startsWith("tmp/")) return "file deletion";
		}
	}
	return undefined;
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
		if (subcommand === "reflog" && (args.length === 0 || args[0] === "show")) continue;
		if (subcommand === "remote") {
			const operationArgs = args.filter((arg) => arg !== "-v" && arg !== "--verbose");
			if (operationArgs.length === 0 || ["show", "get-url"].includes(operationArgs[0])) continue;
		}
		if (subcommand === "stash" && ["list", "show"].includes(args[0])) continue;
		if (subcommand === "worktree" && args[0] === "list") continue;
		if (subcommand === "config") {
			const hasGetter = args.some((arg) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/.test(arg));
			const positional = args.filter((arg) => !arg.startsWith("-"));
			if (hasGetter || positional.length <= 1) continue;
		}
		return `Git command may change repository state: git ${subcommand}`;
	}
	return undefined;
}

/** Returns a reason when the command looks destructive, or undefined if it looks safe. */
export function approvalReason(command: string): string | undefined {
	const gitReason = gitInvocationReason(command);
	if (gitReason) return gitReason;
	const rmReason = rmInvocationReason(command);
	if (rmReason) return rmReason;
	for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}
