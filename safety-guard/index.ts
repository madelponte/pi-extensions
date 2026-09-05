import { isToolCallEventType, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { approvalReason } from "./guard.ts";

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
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		const reason = approvalReason(command);
		if (!reason) return;

		if (!ctx.hasUI) return { block: true, reason: `Safety guard blocked command because approval is unavailable: ${reason}` };

		let approved: boolean;
		if (ctx.mode === "tui") {
			approved = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
				const displayCommand = commandForDisplay(command);
				let scrollOffset = 0;
				let maxScrollOffset = 0;
				let pageSize = 1;
				let finished = false;
				let cachedWidth: number | undefined;
				let cachedHeight: number | undefined;
				let cachedLines: string[] | undefined;
				let cachedCommandWidth: number | undefined;
				let cachedCommandLines: string[] | undefined;

				function finish(value: boolean) {
					if (finished) return;
					finished = true;
					done(value);
				}

				function clearCache() {
					cachedWidth = undefined;
					cachedHeight = undefined;
					cachedLines = undefined;
				}

				function refresh() {
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
						pageSize = Math.max(1, Math.min(10, Math.floor(terminalHeight / 2) - 4));
						maxScrollOffset = Math.max(0, commandLines.length - pageSize);
						scrollOffset = Math.min(scrollOffset, maxScrollOffset);
						const endOffset = Math.min(commandLines.length, scrollOffset + pageSize);
						const fit = (text: string) => truncateToWidth(text, renderWidth, "");
						const scrollHelp = [
							keyHint("tui.select.up", "scroll up"),
							keyHint("tui.select.down", "scroll down"),
							keyHint("tui.editor.pageUp", "page up"),
							keyHint("tui.editor.pageDown", "page down"),
						].join(" • ");
						const decisionHelp = [
							keyHint("tui.select.confirm", "approve"),
							keyHint("tui.select.cancel", "deny"),
						].join(" • ");
						const lines = [
							theme.fg("warning", "─".repeat(renderWidth)),
							fit(theme.fg("warning", theme.bold("Approve command?"))),
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
						if (keybindings.matches(data, "tui.select.confirm")) {
							finish(true);
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							finish(false);
						} else if (keybindings.matches(data, "tui.select.up")) {
							scrollBy(-1);
						} else if (keybindings.matches(data, "tui.select.down")) {
							scrollBy(1);
						} else if (keybindings.matches(data, "tui.editor.pageUp")) {
							scrollBy(-pageSize);
						} else if (keybindings.matches(data, "tui.editor.pageDown")) {
							scrollBy(pageSize);
						}
					},
					invalidate() {
						clearCache();
					},
					dispose() {
						finished = true;
						cachedLines = undefined;
					},
				};
			});
		} else {
			// RPC mode supports Pi's standard dialogs, but not custom TUI components.
			approved = await ctx.ui.confirm("Approve command?", `${reason}\n\n${command}`);
		}

		if (!approved) return { block: true, reason: `User declined command: ${reason}` };
	});
}
