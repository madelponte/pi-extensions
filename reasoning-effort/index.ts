import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Maximum",
};

export default function reasoningEffort(pi: ExtensionAPI) {
	function availableLevels(ctx: ExtensionCommandContext): ModelThinkingLevel[] {
		return ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
	}

	async function selectEffort(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.model) {
			ctx.ui.notify("No model is currently selected", "error");
			return;
		}

		const levels = availableLevels(ctx);
		const requested = args.trim().toLowerCase() as ModelThinkingLevel | "";
		let selected: ModelThinkingLevel | undefined;

		if (requested) {
			if (!levels.includes(requested)) {
				ctx.ui.notify(
					`Reasoning effort "${requested}" is not available for ${ctx.model.provider}/${ctx.model.id}. Available: ${levels.join(", ")}`,
					"error",
				);
				return;
			}
			selected = requested;
		} else {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Available reasoning efforts: ${levels.join(", ")}`, "info");
				return;
			}

			const current = pi.getThinkingLevel();
			const choices = levels.map((level) =>
				`${level === current ? "● " : "  "}${LEVEL_LABELS[level]} (${level})`,
			);
			const choice = await ctx.ui.select(
				`Reasoning effort for ${ctx.model.provider}/${ctx.model.id}`,
				choices,
			);
			if (!choice) return;
			selected = levels[choices.indexOf(choice)];
		}

		if (!selected) return;
		pi.setThinkingLevel(selected);
		ctx.ui.notify(`Reasoning effort: ${pi.getThinkingLevel()}`, "info");
	}

	const command = {
		description: "Select the reasoning effort for the current model",
		getArgumentCompletions: (prefix: string) => {
			// Completion has no command context, so expose all valid level names.
			const levels = Object.keys(LEVEL_LABELS) as ModelThinkingLevel[];
			return levels
				.filter((level) => level.startsWith(prefix.toLowerCase()))
				.map((level) => ({ value: level, label: level, description: LEVEL_LABELS[level] }));
		},
		handler: selectEffort,
	};

	pi.registerCommand("effort", command);
	pi.registerCommand("reasoning", command);
}
