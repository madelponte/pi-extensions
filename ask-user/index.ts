import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CUSTOM_OPTION = "None of these — write a custom response";

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
			description:
				"Multiple-choice options. Omit this field for an open-ended question. A custom-response choice is always added automatically.",
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

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a blocking clarification question during the current agent run, then continue with their answer. Omit options for an open-ended response, or provide two or more options for a single-choice question. Multiple-choice questions always include a custom-response alternative. The result returns the full selected option text, not only its number.",
		promptSnippet: "Ask a blocking open-ended or multiple-choice clarification question",
		promptGuidelines: [
			"Use ask_user when a material ambiguity or user decision blocks correct progress instead of guessing.",
			"Use ask_user without options for open-ended questions and with options when the user should choose among concrete alternatives.",
			"After ask_user returns, continue the original task using the user's response.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options ?? [];

			if (!ctx.hasUI) {
				return resultFor(params.question, options, "unavailable", null);
			}

			// RPC supports Pi's standard dialogs, but not custom TUI components.
			if (ctx.mode === "rpc") {
				if (options.length === 0) {
					const answer = await ctx.ui.input(params.question, "Type your response", { signal });
					if (answer === undefined) return resultFor(params.question, options, "cancelled", null);
					const trimmed = answer.trim();
					if (!trimmed) return resultFor(params.question, options, "cancelled", null);
					return resultFor(params.question, options, "custom", trimmed);
				}

				let customChoice = CUSTOM_OPTION;
				while (options.includes(customChoice)) customChoice += " (custom)";
				const choices = [...options, customChoice];
				const choice = await ctx.ui.select(params.question, choices, { signal });
				if (choice === undefined) return resultFor(params.question, options, "cancelled", null);
				if (choice === customChoice) {
					const answer = await ctx.ui.input("Your response", "Type your response", { signal });
					if (answer === undefined) return resultFor(params.question, options, "cancelled", null);
					const trimmed = answer.trim();
					if (!trimmed) return resultFor(params.question, options, "cancelled", null);
					return resultFor(params.question, options, "custom", trimmed);
				}

				const selectedIndex = choices.indexOf(choice);
				return resultFor(params.question, options, "selection", choice, selectedIndex);
			}

			if (ctx.mode !== "tui") {
				return resultFor(params.question, options, "unavailable", null);
			}

			const response = await ctx.ui.custom<UserResponse | null>((tui, theme, keybindings, done) => {
				const hasOptions = options.length > 0;
				let optionIndex = 0;
				let editing = !hasOptions;
				let validationError = false;
				let componentFocused = false;
				let finished = false;
				let cachedWidth: number | undefined;
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
					cachedLines = undefined;
				}

				function refresh() {
					clearCache();
					editor.focused = componentFocused && editing;
					tui.requestRender();
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
					if (editing) {
						if (keybindings.matches(data, "tui.select.cancel")) {
							if (hasOptions) {
								editing = false;
								validationError = false;
								editor.setText("");
								refresh();
							} else {
								finish(null);
							}
							return;
						}
						validationError = false;
						editor.handleInput(data);
						refresh();
						return;
					}

					if (keybindings.matches(data, "tui.select.up")) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						optionIndex = Math.min(options.length, optionIndex + 1);
						refresh();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						if (optionIndex === options.length) {
							editing = true;
							editor.setText("");
							refresh();
						} else {
							finish({
								kind: "selection",
								text: options[optionIndex],
								selectedIndex: optionIndex,
							});
						}
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) finish(null);
				}

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;

					const renderWidth = Math.max(1, width);
					const lines: string[] = [];

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let index = 0; index < wrapped.length; index++) {
							lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					addWrappedWithPrefix(renderWidth > 1 ? " " : "", theme.fg("text", theme.bold(params.question)));
					lines.push("");

					if (hasOptions) {
						for (let index = 0; index < options.length; index++) {
							const selected = !editing && optionIndex === index;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							addWrappedWithPrefix(
								prefix,
								theme.fg(selected ? "accent" : "text", `${index + 1}. ${options[index]}`),
							);
						}

						const customSelected = !editing && optionIndex === options.length;
						const customPrefix = customSelected ? theme.fg("accent", "> ") : "  ";
						addWrappedWithPrefix(
							customPrefix,
							theme.fg(customSelected || editing ? "accent" : "text", `${options.length + 1}. ${CUSTOM_OPTION}`),
						);
					}

					if (editing) {
						if (hasOptions) lines.push("");
						addWrappedWithPrefix(renderWidth > 1 ? " " : "", theme.fg("muted", "Your response:"));
						const margin = renderWidth >= 3 ? " " : "";
						const editorWidth = Math.max(1, renderWidth - visibleWidth(margin));
						for (const line of editor.render(editorWidth)) lines.push(`${margin}${line}`);
						if (validationError) {
							addWrappedWithPrefix(renderWidth > 1 ? " " : "", theme.fg("warning", "Please enter a response."));
						}
					}

					lines.push("");
					const help = editing
						? [
							keyHint("tui.input.submit", "submit"),
							keyHint("tui.input.newLine", "newline"),
							keyHint("tui.select.cancel", hasOptions ? "return to choices" : "cancel"),
						].join(" • ")
						: [
							keyHint("tui.select.up", "up"),
							keyHint("tui.select.down", "down"),
							keyHint("tui.select.confirm", "select"),
							keyHint("tui.select.cancel", "cancel"),
						].join(" • ");
					addWrappedWithPrefix(renderWidth > 1 ? " " : "", theme.fg("dim", help));
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedWidth = width;
					cachedLines = lines;
					return lines;
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
