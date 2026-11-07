import { isToolCallEventType, rawKeyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { approvalReason } from "./guard.ts";
import { ApprovalDeadline, DENIAL_GUIDANCE, DenialTracker, MAX_REPEATED_DENIALS } from "./runtime.ts";

/**
 * Minimum pause before a `y`/`n` keypress counts as a decision. Keys typed
 * without a pause, such as a message being typed when the prompt appeared,
 * are ignored.
 */
const DELIBERATE_KEY_PAUSE_MS = 400;

function commandForDisplay(command: string): string {
	return command
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "   ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
		});
}

export default function safetyGuard(pi: ExtensionAPI) {
	let mode: "interactive" | "unattended" = "interactive";
	let denials = new DenialTracker();
	let reportedCount = 0;
	let stopped = false;
	const pending = new Set<ApprovalDeadline>();

	function updateStatus(ctx: ExtensionContext) {
		if (ctx.hasUI && !stopped) ctx.ui.setStatus("safety-guard", `Safety: ${mode}${denials.total ? ` • ${denials.total} blocked` : ""}`);
	}

	function setMode(next: typeof mode, ctx: ExtensionContext) {
		mode = next;
		if (mode === "unattended") for (const deadline of pending) deadline.cancel();
		updateStatus(ctx);
	}

	function block(command: string, reason: string, explanation: string, ctx: ExtensionContext) {
		const attempts = denials.record(command, reason);
		updateStatus(ctx);
		const stop = (mode === "unattended" || !ctx.hasUI) && attempts >= MAX_REPEATED_DENIALS;
		if (stop && !stopped) {
			// Abort is deliberate here: terminate alone is only a hint when sibling tools exist.
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify("Safety guard stopped the run after repeated attempts at the same denied command.", "warning");
		}
		return {
			block: true,
			reason: `${explanation}: ${reason}. ${DENIAL_GUIDANCE}${stop ? " Run stopped after repeated denied attempts." : ""}`,
		};
	}

	pi.registerCommand("safety", {
		description: "Safety guard: interactive, unattended (deny-and-continue), or status",
		getArgumentCompletions: (prefix) => ["interactive", "unattended", "status"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "interactive" || action === "unattended") {
				setMode(action, ctx);
				if (ctx.hasUI) ctx.ui.notify(action === "unattended"
					? "Safety guard: deny-and-continue. Guarded commands will be denied without prompting. Reload/restart resets to interactive."
					: "Safety guard: interactive approval, with a 30-minute timeout to deny-and-continue. No blocked commands will be replayed.", "info");
			} else if (action === "status") {
				if (ctx.hasUI) ctx.ui.notify(`Safety mode: ${mode}. Approval timeout: 30 minutes. Without UI, guarded commands are always denied.\n${denials.summary()}`, "info");
			} else if (ctx.hasUI) ctx.ui.notify("Usage: /safety [interactive|unattended|status]", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		stopped = true;
		for (const deadline of pending) {
			deadline.cancel();
			deadline.dispose();
		}
		if (ctx.hasUI) ctx.ui.setStatus("safety-guard", undefined);
	});
	pi.on("before_agent_start", (event, ctx) => {
		denials = new DenialTracker();
		reportedCount = 0;
		updateStatus(ctx);
		// Applies to user- and custom-message runs without reading user-only fields.
		event.systemPromptOptions.sections.safety_guard = [
			`Safety guard mode: ${ctx.hasUI ? mode : "unattended (approval unavailable)"}.`,
			"In interactive mode, approval expires after 30 minutes: the command is denied and the guard switches to unattended deny-and-continue until the user changes mode or the extension reloads/restarts.",
			"In unattended mode, guarded Bash commands fail immediately; permitted commands can still run. A denial is not permission to bypass the guard. Only the user may change its mode.",
			DENIAL_GUIDANCE,
			`Repeating the same denied command ${MAX_REPEATED_DENIALS} times in one run while unattended stops the run.`,
		].join("\n");
	});
	pi.on("agent_settled", () => {
		if (stopped || denials.total === reportedCount) return;
		reportedCount = denials.total;
		pi.sendMessage({
			customType: "safety-guard-summary",
			content: denials.summary(),
			display: true,
		}, { triggerTurn: false });
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		const reason = approvalReason(command);
		if (!reason) return;

		if (!ctx.hasUI || mode === "unattended") {
			return block(command, reason, ctx.hasUI
				? "Safety guard denied command in unattended (deny-and-continue) mode"
				: "Safety guard denied command because approval is unavailable", ctx);
		}

		const deadline = new ApprovalDeadline(ctx.signal);
		pending.add(deadline);
		try {
			const approved = await confirmCommand(command, reason, ctx, deadline);
			if (stopped) return { block: true, reason: "Safety guard is shutting down; command denied." };
			if (deadline.timedOut) {
				setMode("unattended", ctx);
				ctx.ui.notify("Safety approval timed out after 30 minutes. Command denied; switched to unattended deny-and-continue. Use /safety interactive to restore prompting, or reload/restart.", "warning");
				return block(command, reason, "Approval timed out after 30 minutes; safety guard switched to unattended (deny-and-continue) mode", ctx);
			}
			if (!approved || deadline.signal.aborted) {
				return block(command, reason, deadline.signal.aborted
					? "Safety approval cancelled; command denied"
					: "User declined command", ctx);
			}
		} finally {
			deadline.dispose();
			pending.delete(deadline);
		}
	});

	async function confirmCommand(command: string, reason: string, ctx: ExtensionContext, deadline: ApprovalDeadline): Promise<boolean> {
		let approved: boolean;
		if (ctx.mode === "tui") {
			approved = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
				const displayCommand = commandForDisplay(command);
				const keybindingText = (keybinding: Parameters<typeof keybindings.getKeys>[0]) =>
					keybindings.getKeys(keybinding).join("/");
				const keybindingHint = (
					keybinding: Parameters<typeof keybindings.getKeys>[0],
					description: string,
				) => {
					const keys = keybindingText(keybinding);
					return keys ? rawKeyHint(keys, description) : theme.fg("muted", description);
				};
				let scrollOffset = 0;
				let maxScrollOffset = 0;
				let pageSize = 1;
				let finished = false;
				let countdownTimer: ReturnType<typeof setInterval> | undefined;
				let lastInputAt = Date.now();
				let cachedWidth: number | undefined;
				let cachedHeight: number | undefined;
				let cachedLines: string[] | undefined;
				let cachedCommandWidth: number | undefined;
				let cachedCommandLines: string[] | undefined;

				function finish(value: boolean) {
					if (finished) return;
					finished = true;
					clearInterval(countdownTimer);
					deadline.signal.removeEventListener("abort", onAbort);
					done(value);
				}

				function onAbort() {
					finish(false);
				}

				if (deadline.signal.aborted) finish(false);
				else {
					deadline.signal.addEventListener("abort", onAbort, { once: true });
					countdownTimer = setInterval(refresh, 1000);
				}

				function clearCache() {
					cachedWidth = undefined;
					cachedHeight = undefined;
					cachedLines = undefined;
				}

				function refresh() {
					if (finished || deadline.timedOut) return;
					clearCache();
					tui.requestRender();
				}

				function scrollBy(lines: number) {
					const nextOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset + lines));
					if (nextOffset === scrollOffset) return;
					scrollOffset = nextOffset;
					refresh();
				}

				return {
					capturesViewportInput: true,
					render(width: number): string[] {
						const terminalHeight = tui.terminal.rows;
						if (cachedLines && cachedWidth === width && cachedHeight === terminalHeight) return cachedLines;

						const renderWidth = Math.max(1, width);
						const commandPrefix = renderWidth >= 3 ? "  " : "";
						const commandWidth = Math.max(1, renderWidth - visibleWidth(commandPrefix));
						if (!cachedCommandLines || cachedCommandWidth !== commandWidth) {
							cachedCommandLines = wrapTextWithAnsi(displayCommand, commandWidth);
							if (cachedCommandLines.length === 0) cachedCommandLines.push("");
							cachedCommandWidth = commandWidth;
						}
						const commandLines = cachedCommandLines;

						// Keep the replacement editor shorter than the terminal. The stock
						// confirm dialog puts its whole title (including the command) on
						// screen, which makes animated redraws unstable for long commands.
						pageSize = Math.max(1, Math.min(10, Math.floor(terminalHeight / 2) - 5));
						maxScrollOffset = Math.max(0, commandLines.length - pageSize);
						scrollOffset = Math.min(scrollOffset, maxScrollOffset);
						const endOffset = Math.min(commandLines.length, scrollOffset + pageSize);
						const fit = (text: string) => truncateToWidth(text, renderWidth, "");
						const scrollHelp = [
							keybindingHint("tui.select.up", "scroll up"),
							keybindingHint("tui.select.down", "scroll down"),
							keybindingHint("tui.select.pageUp", "page up"),
							keybindingHint("tui.select.pageDown", "page down"),
						].join(" • ");
						const cancelKeys = keybindingText("tui.select.cancel");
						const decisionHelp = [
							rawKeyHint("y", "approve"),
							rawKeyHint(cancelKeys ? `n/${cancelKeys}` : "n", "deny"),
						].join(" • ");
						const seconds = deadline.remainingSeconds;
						const lines = [
							theme.fg("warning", "─".repeat(renderWidth)),
							fit(theme.fg("warning", theme.bold("Approve command?"))),
							fit(theme.fg("warning", `Timeout in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} → deny + unattended mode`)),
							fit(theme.fg("muted", `Reason: ${reason}`)),
							fit(theme.fg("muted", `Command (visual lines ${scrollOffset + 1}-${endOffset} of ${commandLines.length}):`)),
							...commandLines.slice(scrollOffset, endOffset).map((line) => fit(commandPrefix + theme.fg("text", line))),
							fit(scrollHelp),
							fit(decisionHelp),
							theme.fg("warning", "─".repeat(renderWidth)),
						];

						cachedWidth = width;
						cachedHeight = terminalHeight;
						cachedLines = lines;
						return lines;
					},
					handleInput(data: string) {
						if (finished) return;
						if (deadline.timedOut || deadline.signal.aborted) {
							finish(false);
							return;
						}
						// The prompt takes focus as soon as it appears, so keys meant for a
						// message being typed arrive here. Approval therefore needs a
						// deliberate `y` after a pause rather than Enter or a typed-ahead key.
						const now = Date.now();
						const deliberate = now - lastInputAt >= DELIBERATE_KEY_PAUSE_MS;
						lastInputAt = now;
						if (keybindings.matches(data, "tui.select.cancel")) {
							finish(false);
						} else if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
							if (deliberate) finish(true);
						} else if (matchesKey(data, "n") || matchesKey(data, "shift+n")) {
							if (deliberate) finish(false);
						} else if (keybindings.matches(data, "tui.select.up")) {
							scrollBy(-1);
						} else if (keybindings.matches(data, "tui.select.down")) {
							scrollBy(1);
						} else if (keybindings.matches(data, "tui.select.pageUp")) {
							scrollBy(-pageSize);
						} else if (keybindings.matches(data, "tui.select.pageDown")) {
							scrollBy(pageSize);
						}
					},
					invalidate() {
						clearCache();
					},
					dispose() {
						finished = true;
						clearInterval(countdownTimer);
						deadline.signal.removeEventListener("abort", onAbort);
						cachedLines = undefined;
					},
				};
			}, {
				blocked: { kind: "permission", message: reason },
			});
		} else {
			// RPC mode supports Pi's standard dialogs, but not custom TUI components.
			approved = await ctx.ui.confirm("Approve command? (30-minute limit)",
				`${reason}\n\nAfter 30 minutes: deny this command and switch to unattended deny-and-continue.\n\n${command}`,
				{ signal: deadline.signal });
		}

		return approved;
	}
}
