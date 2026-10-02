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
 * indirection such as `at` or cron entries.
 */

const READ_ONLY_GIT_COMMANDS = new Set([
	"annotate", "blame", "cat-file", "check-attr", "check-ignore", "cherry", "count-objects", "describe", "diff",
	"diff-files", "diff-index", "diff-tree", "for-each-ref", "fsck", "grep", "help", "log", "ls-files", "ls-remote",
	"ls-tree", "merge-base", "name-rev", "range-diff", "rev-list", "rev-parse", "shortlog", "show", "show-branch",
	"show-ref", "status", "var", "version", "whatchanged",
]);

/**
 * A "command boundary": the start of the command string, a shell separator
 * (`;`, `&`, `|`), a subshell or command-substitution opener (`(`, `$(`,
 * backtick), a quote (covers `sh -c 'rm ...'`), a newline (multi-line
 * commands), a shell control word (`if`, `then`, `while`, ...), or `!`.
 */
const BASE_COMMAND_BOUNDARY = String.raw`(?:^|[;&|(\n\`'"{}]|\$\(|\b(?:if|elif|then|else|while|until|do)\b|!(?=\s))\s*`;
/**
 * The start of a case-arm body. The first arm follows `case ... in`; later
 * arms follow one of the case terminators (`;;`, `;&`, or `;;&`). Escaped
 * characters are skipped while looking for the pattern-closing `)`.
 */
const CASE_ARM_BOUNDARY = `(?:${BASE_COMMAND_BOUNDARY}case\\b[^\\n]*?\\bin\\b|;;&|;&|;;)\\s*(?:\\\\.|[^)\\n])*\\)\\s*`;
const COMMAND_BOUNDARY = `(?:${BASE_COMMAND_BOUNDARY}|${CASE_ARM_BOUNDARY})`;

/** A `VAR=value` environment assignment token. */
const ENV_ASSIGN = String.raw`\b[A-Za-z_][A-Za-z0-9_]*=\S*`;
/**
 * A shell flag token, optionally taking a value (e.g. `-u deploy`). The value
 * cannot look like a flag or a `VAR=value` assignment, which keeps flag and
 * assignment sequences unambiguous so the regex engine cannot backtrack
 * exponentially.
 */
const FLAG_PAIR = String.raw`-[^\s;&|()]+(?:\s+[^\s;&|()=-][^\s;&|()=]*)?`;
/** Optional directory components before an executable (`/usr/bin/`). */
const EXECUTABLE_PATH = String.raw`(?:[^\s;&|()/]*/)*`;
/** A leading backslash (`\rm`) bypasses aliases but runs the same command. */
const ESCAPE = String.raw`\\?`;
/** The end of a command name: `rm` but not `rm-thing` or `rm.txt`. */
const WORD_END = String.raw`\b(?![-.])`;
/** The rest of a simple command, up to the next separator. */
const ARGS = String.raw`[^\n;&|]*`;

const COMMAND_WRAPPER = String.raw`command(?:\s+-[^\s;&|()]+)*\s+`;
/** `env` and its options. Its `VAR=value` operands are matched as separate launchers. */
const ENV_COMMAND_WRAPPER = `env(?:\\s+${FLAG_PAIR})*\\s+`;
/**
 * Commands that run their arguments as another command, such as
 * `nohup git push` or `timeout 60 rm -rf dir`. `timeout`, `chrt`, and
 * `taskset` take one positional argument before the command.
 */
const PREFIX_COMMAND =
	`(?:(?:time|nohup|nice|ionice|setsid|stdbuf|exec|xargs)\\b(?:\\s+${FLAG_PAIR})*|` +
	`(?:timeout|chrt|taskset)\\b(?:\\s+${FLAG_PAIR})*\\s+[^\\s;&|()]+)\\s+`;
/** One wrapper, prefix command, or `VAR=value` assignment before a command. */
const LAUNCHER = `(?:${EXECUTABLE_PATH}(?:${COMMAND_WRAPPER}|${ENV_COMMAND_WRAPPER}|${PREFIX_COMMAND})|${ENV_ASSIGN}\\s+)`;
/** The start of a command name, after any launchers. Append the command name. */
const COMMAND_START = `${COMMAND_BOUNDARY}(?:${LAUNCHER})*${ESCAPE}${EXECUTABLE_PATH}`;

/**
 * Wrappers that may directly precede a git invocation anywhere in the command,
 * not only at a command boundary (e.g. `ssh host sudo -u deploy git ...`):
 * `sudo`, `command`, or `env` with flag tokens, or a `VAR=value` assignment.
 * Further assignments and launchers are matched by LAUNCHER.
 */
const GIT_WRAPPER = `(?:\\b(?:sudo|command|env)\\b(?:\\s+${FLAG_PAIR})*\\s+|${ENV_ASSIGN}\\s+)`;

/**
 * Matches a git invocation:
 * - `git` at a command boundary (start, `;`/`&`/`|`, newline, `$( )`,
 *   backticks, subshells, control words, or a closing quote as in
 *   `bash -c "git push"`), after any launchers (`nohup`, `timeout 60`, ...), or
 * - `git` after a wrapper (see GIT_WRAPPER).
 *
 * A `git` embedded in a longer identifier (`git-lfs`, `.git`, `git@host`,
 * `grep git`) is not treated as an invocation.
 *
 * Group 1 is always the argument text following `git`.
 */
const GIT_INVOCATION = new RegExp(
	`(?:${COMMAND_BOUNDARY}|${GIT_WRAPPER})(?:${LAUNCHER})*${ESCAPE}${EXECUTABLE_PATH}git\\b(?![-.@])([^\\n;&|]*)`,
	"gi",
);

/**
 * Direct rm/rmdir invocations, whose targets may qualify for the /tmp
 * exemption. Group 1 is the executable and group 2 its argument text.
 */
const RM_INVOCATION = new RegExp(
	`(?:${COMMAND_BOUNDARY}|\\bsudo\\b(?:\\s+${FLAG_PAIR})*\\s+)${ESCAPE}(rm|rmdir)${WORD_END}([^\\n;&|]*)`,
	"gi",
);

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
	// Alternate deletion forms that do not go through the rm parser above.
	[new RegExp(`${COMMAND_START}unlink${WORD_END}`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_START}xargs\\b${ARGS}\\b(?:rm|rmdir|unlink|shred)${WORD_END}`, "i"), "xargs file deletion"],
	// Wrapped (`command`, `env`, `nohup`, `VAR=1`, ...) or path-qualified rm stays guarded even for /tmp targets.
	[new RegExp(`${COMMAND_BOUNDARY}(?:${LAUNCHER})+${ESCAPE}${EXECUTABLE_PATH}(?:rm|rmdir)${WORD_END}`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_BOUNDARY}(?:${LAUNCHER})*${ESCAPE}(?:[^\\s;&|()/]*/)+(?:rm|rmdir)${WORD_END}`, "i"), "file deletion"],
	[new RegExp(`${COMMAND_START}rsync\\b${ARGS}\\s--(?:delete|remove-source-files)(?:-\\S+)?\\b`, "i"), "rsync deletion"],
	// `find ... -delete`, or `-exec`/`-execdir`/`-ok`/`-okdir` with a deleting command.
	[new RegExp(`${COMMAND_START}find${WORD_END}${ARGS}(?:\\s-delete\\b|\\s-(?:exec|execdir|ok|okdir)\\b${ARGS}\\b(?:rm|rmdir|unlink|shred)\\b)`, "i"), "find file deletion"],
	// Privilege escalation should always be explicit, even for an otherwise safe command.
	[new RegExp(`${COMMAND_START}(?:sudo|sudoedit|doas|pkexec|run0)${WORD_END}`, "i"), "privilege escalation"],
	[new RegExp(`${COMMAND_START}su${WORD_END}${ARGS}(?:\\s-[A-Za-z]*c[A-Za-z]*\\b|\\s--(?:session-)?command(?:=|\\s))`, "i"), "privilege escalation"],
	// Recursive permission changes and ACL mutation can disable access without deleting files.
	// Case-sensitive: `chmod -r` removes read permission rather than recursing.
	[new RegExp(`${COMMAND_START}(?:chmod|chown|chgrp)${WORD_END}${ARGS}(?:\\s--recursive\\b|\\s-[A-Za-z]*R[A-Za-z]*\\b)`), "recursive permission/ownership change"],
	[new RegExp(`${COMMAND_START}setfacl${WORD_END}`, "i"), "ACL change"],
	[new RegExp(`${COMMAND_START}(?:shred|wipefs|mkfs(?:\\.[\\w-]+)?|fdisk|sfdisk|parted|blkdiscard)${WORD_END}`, "i"), "destructive disk operation"],
	[new RegExp(`${COMMAND_START}dd${WORD_END}${ARGS}\\bof\\s*=`, "i"), "raw device/file overwrite"],
	[new RegExp(`${COMMAND_START}(?:kill|killall|pkill)${WORD_END}`, "i"), "process termination"],
	[new RegExp(`${COMMAND_START}(?:docker|podman)(?:\\s+${FLAG_PAIR})*\\s+(?:rm|rmi|(?:system|volume|image|container)\\s+(?:rm|prune)|system\\s+reset)\\b`, "i"), "container data deletion"],
	[new RegExp(`${COMMAND_START}(?:(?:docker|podman)(?:\\s+${FLAG_PAIR})*\\s+compose|docker-compose|podman-compose)\\b${ARGS}\\sdown\\b${ARGS}\\s(?:-v|--volumes)\\b`, "i"), "container data deletion"],
	[new RegExp(`${COMMAND_START}kubectl(?:\\s+${FLAG_PAIR})*\\s+delete\\b`, "i"), "Kubernetes resource deletion"],
	[new RegExp(`${COMMAND_START}dropdb${WORD_END}`, "i"), "database deletion"],
	// SQL statements start at a boundary too: `psql -c "DROP TABLE x"`, `...; DROP TABLE x`.
	[new RegExp(`${COMMAND_BOUNDARY}(?:DROP\\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE\\s+TABLE)\\b`, "i"), "database deletion"],
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

/** Global git options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"]);

/**
 * `-c` overrides that only affect output. Other keys can run programs
 * (`core.pager`, `core.fsmonitor`, `core.sshCommand`, `alias.*`, ...).
 */
const SAFE_GIT_CONFIG_OVERRIDE = /^(?:(?:color|column|advice)\.[^=]+|core\.quotepath)(?:=.*)?$|^core\.pager=cat$/i;

const GIT_BRANCH_LIST_OPTION =
	/^(?:-a|--all|-r|--remotes|-v+|--verbose|-i|--ignore-case|--show-current|--omit-empty|--no-abbrev|--no-color|--no-column|--(?:abbrev|color|column|sort|format)(?:=.*)?)$/;
/** Filters that take an optional commit and imply `--list`. */
const GIT_BRANCH_FILTER_OPTION = /^--(?:no-)?(?:contains|merged)$|^--points-at$/;

/** True when `git branch` only lists branches. */
function isReadOnlyGitBranch(args: string[]): boolean {
	let listMode = false;
	let hasPositional = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--list" || arg === "-l") {
			listMode = true;
		} else if (GIT_BRANCH_FILTER_OPTION.test(arg)) {
			listMode = true;
			if (args[index + 1] && !args[index + 1].startsWith("-")) index++;
		} else if (/^--(?:no-)?(?:contains|merged|points-at)=/.test(arg)) {
			listMode = true;
		} else if (arg.startsWith("-")) {
			// Unknown or mutating option (`-d`, `-m`, `--set-upstream-to`, `-vd`, ...).
			if (!GIT_BRANCH_LIST_OPTION.test(arg)) return false;
		} else {
			hasPositional = true;
		}
	}
	// Outside list mode, a positional argument names a branch to create.
	return listMode || !hasPositional;
}

const GIT_CONFIG_GETTER = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/;
const GIT_CONFIG_MUTATOR = /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|-e|--edit)$/;
const GIT_CONFIG_OPTIONS_WITH_VALUE = new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment"]);

/** True when `git config` only reads configuration. */
function isReadOnlyGitConfig(args: string[]): boolean {
	const positional: string[] = [];
	let hasGetter = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (GIT_CONFIG_MUTATOR.test(arg)) return false;
		if (GIT_CONFIG_GETTER.test(arg)) hasGetter = true;
		else if (GIT_CONFIG_OPTIONS_WITH_VALUE.has(arg)) index++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	// Subcommand syntax (Git 2.46+). Configuration keys always contain a dot, so
	// these words cannot be keys in the legacy syntax.
	if (positional[0] === "list" || positional[0] === "get") return true;
	if (["set", "unset", "rename-section", "remove-section", "edit"].includes(positional[0])) return false;
	// Legacy syntax: getters, or a single key (`git config user.name`).
	return hasGetter || positional.length <= 1;
}

/** Returns an option that makes an otherwise read-only git command write files or run a program. */
function gitWritingOption(subcommand: string, args: string[]): string | undefined {
	for (const arg of args) {
		if (/^--output(?:=|$)/.test(arg)) return "--output";
		if (arg === "--ext-diff") return "--ext-diff";
		if (arg === "--textconv") return "--textconv";
		if (subcommand === "grep" && /^(?:-[A-Za-z]*O|--open-files-in-pager(?:=|$))/.test(arg)) return "--open-files-in-pager";
		if (subcommand === "fsck" && arg === "--lost-found") return "--lost-found";
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
			if (word === "-c") {
				const override = words[index + 1] ?? "";
				if (!SAFE_GIT_CONFIG_OVERRIDE.test(override)) {
					return `Git configuration override may run commands: git -c ${override.split("=")[0]}`;
				}
				index += 2;
				continue;
			}
			if (word === "--config-env" || word.startsWith("--config-env=") || word.startsWith("--exec-path=")) {
				return `Git configuration override may run commands: git ${word.split("=")[0]}`;
			}
			if (GIT_OPTIONS_WITH_VALUE.has(word)) {
				index += 2;
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
		if (READ_ONLY_GIT_COMMANDS.has(subcommand)) {
			const option = gitWritingOption(subcommand, args);
			if (option) return `Git command may write files or run commands: git ${subcommand} ${option}`;
			continue;
		}
		if (subcommand === "branch" && isReadOnlyGitBranch(args)) continue;
		if (subcommand === "tag" && (args.length === 0 || args.some((arg) => arg === "--list" || arg === "-l"))) continue;
		if (subcommand === "reflog" && (args.length === 0 || args[0] === "show")) continue;
		if (subcommand === "remote") {
			const operationArgs = args.filter((arg) => arg !== "-v" && arg !== "--verbose");
			if (operationArgs.length === 0 || ["show", "get-url"].includes(operationArgs[0])) continue;
		}
		if (subcommand === "stash" && ["list", "show"].includes(args[0])) continue;
		if (subcommand === "worktree" && args[0] === "list") continue;
		if (subcommand === "config" && isReadOnlyGitConfig(args)) continue;
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
