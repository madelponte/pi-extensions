import { keyHint, rawKeyHint, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type KeyId,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_OPTION = "None of these — write a custom response";
/** Keeps every choice, including the custom response, on a number key (1-9). */
const MAX_OPTIONS = 8;
/** Fraction of the terminal height the TUI dialog may use. */
const MAX_HEIGHT_RATIO = 0.75;
/** Key hints wrap onto at most this many lines; narrow terminals drop the rest. */
const MAX_HELP_LINES = 2;

type ResponseKind = "selection" | "custom" | "cancelled" | "unavailable";

interface AskUserDetails {
	question: string;
	options: string[];
	response: string | null;
	responseKind: ResponseKind;
	selectedIndex?: number;
}

interface UserResponse {
	kind: "selection" | "custom";
	text: string;
	selectedIndex?: number;
}

const AskUserParams = Type.Object({
	question: Type.String({
		minLength: 1,
		description: "The clear, self-contained question to show the user",
	}),
	options: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			minItems: 2,
			maxItems: MAX_OPTIONS,
			description:
				`Multiple-choice options (at most ${MAX_OPTIONS}). Omit this field for an open-ended question. A custom-response choice is always added automatically.`,
		}),
	),
});

function resultFor(
	question: string,
	options: string[],
	responseKind: ResponseKind,
	response: string | null,
	selectedIndex?: number,
) {
	const details: AskUserDetails = {
		question,
		options,
		response,
		responseKind,
		...(selectedIndex === undefined ? {} : { selectedIndex }),
	};

	let text: string;
	switch (responseKind) {
		case "selection":
			// Return the complete option text, rather than only its ordinal.
			text = `User selected the following option:\n${response}`;
			break;
		case "custom":
			text = `User provided the following response:\n${response}`;
			break;
		case "cancelled":
			text = "User cancelled the question without providing an answer.";
			break;
		case "unavailable":
			text = "Cannot ask the user because an interactive UI is unavailable.";
			break;
	}

	return { content: [{ type: "text" as const, text }], details };
}

/**
 * Asks with Pi's standard dialogs (RPC mode), mirroring the TUI flow:
 * cancelling the custom response returns to the choices, and an empty
 * response asks again instead of cancelling the question.
 */
async function askWithDialogs(
	ui: ExtensionUIContext,
	question: string,
	options: string[],
	signal: AbortSignal | undefined,
): Promise<UserResponse | null> {
	const hasOptions = options.length > 0;
	let customChoice = CUSTOM_OPTION;
	while (options.includes(customChoice)) customChoice += " (custom)";
	const choices = [...options, customChoice];
	const inputTitle = hasOptions ? "Your response" : question;

	while (!signal?.aborted) {
		if (hasOptions) {
			const choice = await ui.select(question, choices, { signal });
			if (choice === undefined || signal?.aborted) return null;
			if (choice !== customChoice) {
				return { kind: "selection", text: choice, selectedIndex: choices.indexOf(choice) };
			}
		}

		let title = inputTitle;
		for (;;) {
			const answer = await ui.input(title, "Type your response", { signal });
			if (signal?.aborted) return null;
			if (answer === undefined) break;
			const text = answer.trim();
			if (text) return { kind: "custom", text };
			title = `${inputTitle} (a response is required)`;
		}
		// Cancelling an open-ended question cancels it; otherwise return to the choices.
		if (!hasOptions) return null;
	}
	return null;
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			`Ask the user a blocking clarification question during the current agent run, then continue with their answer. Omit options for an open-ended response, or provide two to ${MAX_OPTIONS} options for a single-choice question. Multiple-choice questions always include a custom-response alternative. The result returns the full selected option text, not only its number.`,
		promptSnippet: "Ask a blocking open-ended or multiple-choice clarification question",
		promptGuidelines: [
			"Use ask_user when a material ambiguity or user decision blocks correct progress instead of guessing.",
			"Use ask_user without options for open-ended questions and with options when the user should choose among concrete alternatives.",
			"After ask_user returns, continue the original task using the user's response.",
		],
		parameters: AskUserParams,
		// User-interaction tools must be called by the model directly; nested
		// tool/codemode calls cannot safely own a blocking UI interaction.
		exposure: "model-only",
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options ?? [];

			if (!ctx.hasUI) {
				return resultFor(params.question, options, "unavailable", null);
			}

			// RPC supports Pi's standard dialogs, but not custom TUI components.
			if (ctx.mode === "rpc") {
				const response = await askWithDialogs(ctx.ui, params.question, options, signal);
				if (!response) return resultFor(params.question, options, "cancelled", null);
				return resultFor(params.question, options, response.kind, response.text, response.selectedIndex);
			}

			if (ctx.mode !== "tui") {
				return resultFor(params.question, options, "unavailable", null);
			}

			const response = await ctx.ui.custom<UserResponse | null>((tui, theme, keybindings, done) => {
				const hasOptions = options.length > 0;
				const customIndex = options.length;
				let optionIndex = 0;
				let editing = !hasOptions;
				let validationError = false;
				let componentFocused = false;
				let finished = false;
				// Body scrolling, for questions and choices taller than the dialog.
				// While `followSelection` is set, rendering scrolls the selected
				// choice into view; scrolling away from it clears the flag.
				let scrollOffset = 0;
				let followSelection = false;
				let layout: { windowHeight: number; maxOffset: number; ranges: Array<{ start: number; end: number }> } | undefined;
				let cachedWidth: number | undefined;
				let cachedRows: number | undefined;
				let cachedLines: string[] | undefined;

				// Guard against duplicate done() calls (e.g. a stray key that
				// arrives after the answer is submitted but before unmount).
				function finish(result: UserResponse | null) {
					if (finished) return;
					finished = true;
					signal?.removeEventListener("abort", onAbort);
					done(result);
				}

				function onAbort() {
					finish(null);
				}

				if (signal?.aborted) finish(null);
				else signal?.addEventListener("abort", onAbort, { once: true });

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function clearCache() {
					cachedWidth = undefined;
					cachedRows = undefined;
					cachedLines = undefined;
				}

				function refresh() {
					clearCache();
					editor.focused = componentFocused && editing;
					tui.requestRender();
				}

				function overflows(): boolean {
					return layout !== undefined && layout.maxOffset > 0;
				}

				/** Whether any line of the selected choice is inside the scroll window. */
				function selectionVisible(): boolean {
					const range = layout?.ranges[optionIndex];
					if (!layout || !range || layout.maxOffset === 0) return true;
					return range.start < scrollOffset + layout.windowHeight && range.end > scrollOffset;
				}

				function scrollBy(lines: number) {
					if (!layout) return;
					scrollOffset = Math.max(0, Math.min(layout.maxOffset, scrollOffset + lines));
					followSelection = false;
					refresh();
				}

				function canScrollWithArrows(): boolean {
					return !hasOptions && overflows() && editor.getText().length === 0;
				}

				function pageSize(): number {
					return Math.max(1, (layout?.windowHeight ?? 1) - 1);
				}

				function startEditing() {
					optionIndex = customIndex;
					editing = true;
					followSelection = true;
					refresh();
				}

				function select(index: number) {
					if (index === customIndex) startEditing();
					else finish({ kind: "selection", text: options[index], selectedIndex: index });
				}

				/**
				 * Up/down move the selection while it is in view. While it is out of
				 * view they scroll one line at a time, so a long question can be read
				 * before choosing; up on the first choice scrolls back toward the start
				 * of the question.
				 */
				function moveSelection(delta: -1 | 1) {
					if (!selectionVisible() || (delta < 0 && optionIndex === 0 && scrollOffset > 0)) {
						scrollBy(delta);
						return;
					}
					const next = Math.max(0, Math.min(customIndex, optionIndex + delta));
					if (next === optionIndex) return;
					optionIndex = next;
					followSelection = true;
					refresh();
				}

				editor.onSubmit = (value) => {
					const text = value.trim();
					if (!text) {
						validationError = true;
						refresh();
						return;
					}
					finish({ kind: "custom", text });
				};

				function handleInput(data: string) {
					if (finished) return;
					if (overflows()) {
						if (keybindings.matches(data, "tui.select.pageUp")) {
							scrollBy(-pageSize());
							return;
						}
						if (keybindings.matches(data, "tui.select.pageDown")) {
							scrollBy(pageSize());
							return;
						}
					}

					if (editing) {
						if (keybindings.matches(data, "tui.select.cancel")) {
							if (hasOptions) {
								// Keep the draft so returning to the choices is not destructive.
								editing = false;
								validationError = false;
								followSelection = true;
								refresh();
							} else {
								finish(null);
							}
							return;
						}
						// Arrow keys belong to the editor once it has text. Before that, they
						// scroll an open-ended question that does not fit; page keys may be
						// taken by fullscreen transcript scrolling.
						if (canScrollWithArrows()) {
							if (keybindings.matches(data, "tui.select.up")) {
								scrollBy(-1);
								return;
							}
							if (keybindings.matches(data, "tui.select.down")) {
								scrollBy(1);
								return;
							}
						}
						validationError = false;
						editor.handleInput(data);
						refresh();
						return;
					}

					if (keybindings.matches(data, "tui.select.up")) {
						moveSelection(-1);
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						moveSelection(1);
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						// Never confirm a choice the user cannot see; bring it into view first.
						if (!selectionVisible()) {
							followSelection = true;
							refresh();
						} else {
							select(optionIndex);
						}
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) {
						finish(null);
						return;
					}
					for (let index = 0; index <= customIndex && index < 9; index++) {
						if (matchesKey(data, String(index + 1) as KeyId)) {
							select(index);
							return;
						}
					}
				}

				function render(width: number): string[] {
					const terminalRows = tui.terminal.rows;
					if (cachedLines && cachedWidth === width && cachedRows === terminalRows) return cachedLines;

					const renderWidth = Math.max(1, width);
					const indent = renderWidth > 1 ? " " : "";

					/** A single line, truncated to the width. */
					function fit(text: string): string {
						return truncateToWidth(indent + text, renderWidth, "");
					}

					function wrapWithPrefix(prefix: string, text: string): string[] {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) return wrapTextWithAnsi(prefix + text, renderWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						return wrapTextWithAnsi(text, renderWidth - prefixWidth).map(
							(line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`,
						);
					}

					// Scrollable body: the question and the choices.
					const body = wrapWithPrefix(indent, theme.fg("text", theme.bold(params.question)));
					const ranges: Array<{ start: number; end: number }> = [];
					if (hasOptions) {
						body.push("");
						const hasDraft = !editing && editor.getText().trim().length > 0;
						for (let index = 0; index <= customIndex; index++) {
							const isCustom = index === customIndex;
							const selected = !editing && optionIndex === index;
							const highlighted = selected || (isCustom && editing);
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							let label = theme.fg(highlighted ? "accent" : "text", `${index + 1}. ${isCustom ? CUSTOM_OPTION : options[index]}`);
							if (isCustom && hasDraft) label += theme.fg("dim", " (draft saved)");
							const start = body.length;
							body.push(...wrapWithPrefix(prefix, label));
							ranges.push({ start, end: body.length });
						}
					}

					// Fixed footer: the response editor and key hints.
					const footer: string[] = [];
					if (editing) {
						footer.push("");
						footer.push(fit(theme.fg("muted", "Your response:")));
						const margin = renderWidth >= 3 ? " " : "";
						const editorWidth = Math.max(1, renderWidth - visibleWidth(margin));
						for (const line of editor.render(editorWidth)) footer.push(`${margin}${line}`);
						if (validationError) {
							footer.push(fit(theme.fg("warning", "Please enter a response.")));
						}
					}

					// Leave room for the top border and, when scrolling, a position line.
					// Never exceed the advertised fraction of the terminal. Very short
					// terminals may not have enough room for every decoration, so a final
					// cursor/selection-aware crop below keeps the interaction usable.
					const maxHeight = Math.max(1, Math.min(terminalRows, Math.floor(terminalRows * MAX_HEIGHT_RATIO)));
					const helpLines = (scrolling: boolean) =>
						wrapWithPrefix(indent, theme.fg("dim", helpText(scrolling))).slice(0, MAX_HELP_LINES);
					const fixedHeight = 1 + footer.length + 1 + helpLines(false).length + 1;
					const scrolling = body.length > maxHeight - fixedHeight;
					const help = helpLines(scrolling);
					const windowHeight = scrolling
						? Math.max(1, maxHeight - (1 + footer.length + 1 + help.length + 1) - 1)
						: body.length;
					const maxOffset = Math.max(0, body.length - windowHeight);

					const followed = ranges[optionIndex];
					if (followSelection && followed) {
						if (followed.end > scrollOffset + windowHeight) scrollOffset = followed.end - windowHeight;
						if (followed.start < scrollOffset) scrollOffset = followed.start;
					}
					scrollOffset = Math.max(0, Math.min(maxOffset, scrollOffset));
					layout = { windowHeight, maxOffset, ranges };

					let lines = [theme.fg("accent", "─".repeat(renderWidth))];
					lines.push(...body.slice(scrollOffset, scrollOffset + windowHeight));
					if (scrolling) {
						const end = Math.min(body.length, scrollOffset + windowHeight);
						lines.push(fit(theme.fg("dim", `[lines ${scrollOffset + 1}-${end} of ${body.length}]`)));
					}
					lines.push(...footer, "", ...help, theme.fg("accent", "─".repeat(renderWidth)));

					// The Editor has its own minimum viewport, which can make the fixed
					// footer taller than the dialog budget in a short terminal. Crop the
					// complete dialog around the hardware cursor (or selected choice) as a
					// final safety net rather than returning more rows than are available.
					if (lines.length > maxHeight) {
						let preferredLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
						if (preferredLine < 0 && followed) {
							const visibleSelectionLine = Math.max(0, Math.min(windowHeight - 1, followed.start - scrollOffset));
							preferredLine = 1 + visibleSelectionLine;
						}
						if (preferredLine < 0) preferredLine = 0;
						const contextAbove = Math.floor((maxHeight - 1) / 2);
						const cropStart = Math.max(0, Math.min(lines.length - maxHeight, preferredLine - contextAbove));
						lines = lines.slice(cropStart, cropStart + maxHeight);
					}

					cachedWidth = width;
					cachedRows = terminalRows;
					cachedLines = lines;
					return lines;
				}

				function helpText(scrolling: boolean): string {
					const hints = editing
						? [
							keyHint("tui.input.submit", "submit"),
							keyHint("tui.input.newLine", "newline"),
							keyHint("tui.select.cancel", hasOptions ? "return to choices" : "cancel"),
						]
						: [
							keyHint("tui.select.up", "up"),
							keyHint("tui.select.down", "down"),
							rawKeyHint(`1-${Math.min(customIndex + 1, 9)}`, "choose"),
							keyHint("tui.select.confirm", "select"),
							keyHint("tui.select.cancel", "cancel"),
						];
					if (scrolling) {
						if (!hasOptions && editor.getText().length === 0) {
							hints.push(keyHint("tui.select.up", "scroll up"), keyHint("tui.select.down", "scroll down"));
						}
						hints.push(keyHint("tui.select.pageUp", "page up"), keyHint("tui.select.pageDown", "page down"));
					}
					return hints.join(" • ");
				}

				return {
					get focused() {
						return componentFocused;
					},
					set focused(value: boolean) {
						componentFocused = value;
						editor.focused = value && editing;
						clearCache();
						tui.requestRender();
					},
					render,
					handleInput,
					invalidate() {
						clearCache();
						editor.invalidate();
					},
					dispose() {
						finished = true;
						signal?.removeEventListener("abort", onAbort);
						clearCache();
					},
				};
			});

			if (!response) return resultFor(params.question, options, "cancelled", null);
			return resultFor(
				params.question,
				options,
				response.kind,
				response.text,
				response.selectedIndex,
			);
		},

		renderCall(args, theme, _context) {
			const question = typeof args?.question === "string" ? args.question : "";
			const rawOptions = args?.options;
			const options = Array.isArray(rawOptions)
				? rawOptions.filter((option): option is string => typeof option === "string")
				: [];
			let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", question);
			if (options.length > 0) {
				text += `\n${theme.fg("dim", options.map((option, index) => `${index + 1}. ${option}`).join(" • "))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			const content = result.content?.[0];
			// Every path must return a Component: pi adds the returned
			// component to the row's Box unchecked, so returning undefined
			// crashes the TUI. Validation failures and aborted calls arrive
			// with no usable details (e.g. `details: {}`), so fall back to
			// the raw result text, matching pi's built-in fallback.
			const fallback = new Text(content?.type === "text" ? content.text : "", 0, 0);
			if (!details) {
				return fallback;
			}

			switch (details.responseKind) {
				case "selection":
					return new Text(
						theme.fg("success", "✓ Selected: ") + theme.fg("accent", details.response ?? ""),
						0,
						0,
					);
				case "custom":
					return new Text(
						theme.fg("success", "✓ Response: ") + theme.fg("accent", details.response ?? ""),
						0,
						0,
					);
				case "cancelled":
					return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
				case "unavailable":
					return new Text(theme.fg("error", "Interactive UI unavailable"), 0, 0);
				default:
					// Unknown or stale details shape (e.g. an old session replay).
					return fallback;
			}
		},
	});
}
