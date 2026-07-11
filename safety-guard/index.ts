import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
	[/(^|[;&|]\s*|\bsudo\s+)(rm|rmdir)\b/i, "file deletion"],
	[/\b(shred|wipefs|mkfs(?:\.[\w-]+)?|fdisk|parted)\b/i, "destructive disk operation"],
	[/\b(dd)\b[^\n;&|]*\bof\s*=/i, "raw device/file overwrite"],
	[/\b(kill|killall|pkill)\b/i, "process termination"],
	[/\b(docker|podman)\s+(system\s+prune|volume\s+rm|image\s+rm|container\s+rm)\b/i, "container data deletion"],
	[/\b(kubectl)\s+delete\b/i, "Kubernetes resource deletion"],
	[/\b(dropdb|DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, "database deletion"],
];

const READ_ONLY_GIT_COMMANDS = new Set([
	"annotate", "blame", "count-objects", "describe", "diff", "diff-tree", "for-each-ref", "fsck",
	"grep", "help", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "reflog",
	"rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version", "whatchanged",
]);

function shellWords(value: string): string[] {
	return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function gitInvocationReason(command: string): string | undefined {
	const matches = command.matchAll(/(?:^|[;&|()]|\b(?:sudo|command|env)\s+)(?:\s*)git\b([^\n;&|)]*)/gi);
	for (const match of matches) {
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

function approvalReason(command: string): string | undefined {
	const gitReason = gitInvocationReason(command);
	if (gitReason) return gitReason;
	for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}

export default function safetyGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const reason = approvalReason(command);
		if (!reason) return;

		if (!ctx.hasUI) return { block: true, reason: `Safety guard blocked command because approval is unavailable: ${reason}` };
		const approved = await ctx.ui.confirm("Approve command?", `${reason}\n\n${command}`);
		if (!approved) return { block: true, reason: `User declined command: ${reason}` };
	});
}
