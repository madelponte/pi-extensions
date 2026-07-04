import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type Phase = "planning" | "coding" | "reviewing";

type WorkflowState = {
	active: true;
	phase: Phase;
	task: string;
	planner: Model<Api>;
	coder: Model<Api>;
	reviewer: Model<Api>;
	originalModel: Model<Api> | undefined;
	plannerSummary?: string;
	coderSummary?: string;
	reviewTurnStarted: boolean;
	startedAt: number;
};

const CONTINUE_PARAMS = Type.Object({
	summary: Type.String({ description: "Concise summary of what this phase completed." }),
	next_instruction: Type.Optional(
		Type.String({ description: "Optional instruction or context to pass to the next workflow phase." }),
	),
});

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function modelLabel(model: Model<Api>): string {
	const key = modelKey(model);
	return model.name && model.name !== model.id ? `${key} — ${model.name}` : key;
}

function phaseLabel(phase: Phase): string {
	return phase[0].toUpperCase() + phase.slice(1);
}

async function chooseModel(ctx: ExtensionContext, title: string): Promise<Model<Api> | undefined> {
	const models = await ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No available models found.", "error");
		return undefined;
	}

	const labels = models.map(modelLabel);
	const choice = await ctx.ui.select(title, labels);
	if (!choice) return undefined;
	return models[labels.indexOf(choice)];
}

function planningPrompt(task: string): string {
	return `Start workflow-code planning phase for this task:\n\n${task}\n\nYou are the planner in a sequential code workflow. Create a concise implementation plan for the task. Do not edit files. When the plan is ready, call workflow_continue with the plan summary.`;
}

function codingPrompt(state: WorkflowState, handoff?: string): string {
	return `Continue workflow-code in the coding phase.\n\n## Original task\n${state.task}\n\n## Planner summary\n${state.plannerSummary ?? "(none)"}${handoff ? `\n\n## Additional handoff context\n${handoff}` : ""}\n\nYou are the coder in a sequential code workflow. Implement the planner's instructions. Make the necessary file changes. Do not redesign unless required. When finished, call workflow_continue with a summary of changes and checks performed.`;
}

function reviewPrompt(state: WorkflowState, handoff?: string): string {
	return `Continue workflow-code in the review phase.\n\n## Original task\n${state.task}\n\n## Planner summary\n${state.plannerSummary ?? "(none)"}\n\n## Coder summary\n${state.coderSummary ?? "(none)"}${handoff ? `\n\n## Additional handoff context\n${handoff}` : ""}\n\nYou are the reviewer in a sequential code workflow. Review the planner's plan and the coder's changes. If you find problems, fix them directly. When finished, provide a final summary of what was changed and any checks performed.`;
}

export default function workflowCodeExtension(pi: ExtensionAPI) {
	let state: WorkflowState | undefined;

	function updateStatus(ctx: ExtensionContext) {
		if (!state) {
			ctx.ui.setStatus("workflow-code", undefined);
			return;
		}
		ctx.ui.setStatus("workflow-code", `workflow:${state.phase}`);
	}

	async function switchTo(model: Model<Api>, ctx: ExtensionContext, role: string): Promise<boolean> {
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`Could not switch to ${role} model: ${modelKey(model)}`, "error");
			return false;
		}
		ctx.ui.notify(`workflow-code: switched to ${role} model ${modelKey(model)}`, "info");
		return true;
	}

	async function exitWorkflow(ctx: ExtensionContext, reason = "Workflow exited.") {
		const originalModel = state?.originalModel;
		state = undefined;
		if (originalModel) {
			await pi.setModel(originalModel);
		}
		updateStatus(ctx);
		ctx.ui.notify(originalModel ? `${reason} Restored ${modelKey(originalModel)}.` : reason, "info");
	}

	pi.registerCommand("workflow-code", {
		description: "Start a planner → coder → reviewer model workflow for a coding task",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/workflow-code requires UI mode.", "error");
				return;
			}

			if (state) {
				const replace = await ctx.ui.confirm(
					"Workflow already active",
					"Exit the current workflow and start a new one?",
				);
				if (!replace) return;
				await exitWorkflow(ctx, "Previous workflow exited.");
			}

			const planner = await chooseModel(ctx, "Select planner model");
			if (!planner) return;
			const coder = await chooseModel(ctx, "Select coder model");
			if (!coder) return;
			const reviewer = await chooseModel(ctx, "Select reviewer model");
			if (!reviewer) return;

			const task = args.trim() || (await ctx.ui.editor("Workflow coding task", ""));
			if (!task?.trim()) {
				ctx.ui.notify("Workflow cancelled: no task provided.", "info");
				return;
			}

			state = {
				active: true,
				phase: "planning",
				task: task.trim(),
				planner,
				coder,
				reviewer,
				originalModel: ctx.model,
				reviewTurnStarted: false,
				startedAt: Date.now(),
			};

			if (!(await switchTo(planner, ctx, "planner"))) {
				state = undefined;
				updateStatus(ctx);
				return;
			}

			updateStatus(ctx);
			pi.sendUserMessage(planningPrompt(state.task));
		},
	});

	pi.registerCommand("workflow-exit", {
		description: "Exit workflow-code mode and restore the model active before the workflow",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No workflow-code workflow is active.", "info");
				return;
			}
			await exitWorkflow(ctx);
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show current workflow-code phase and selected models",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No workflow-code workflow is active.", "info");
				return;
			}

			ctx.ui.notify(
				[
					`Workflow active: ${phaseLabel(state.phase)}`,
					`Planner: ${modelKey(state.planner)}`,
					`Coder: ${modelKey(state.coder)}`,
					`Reviewer: ${modelKey(state.reviewer)}`,
					`Original: ${state.originalModel ? modelKey(state.originalModel) : "(none)"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		name: "workflow_continue",
		label: "Workflow Continue",
		description:
			"Advance the active workflow-code sequence to the next phase. Use this only when the current workflow phase is complete.",
		promptSnippet: "Advance workflow-code to the next sequential model phase",
		parameters: CONTINUE_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				throw new Error("No workflow-code workflow is active.");
			}

			const handoff = params.next_instruction?.trim();
			if (state.phase === "planning") {
				state.plannerSummary = params.summary;
				state.phase = "coding";
				state.reviewTurnStarted = false;
				await switchTo(state.coder, ctx, "coder");
				updateStatus(ctx);
				pi.sendUserMessage(codingPrompt(state, handoff), { deliverAs: "followUp" });
				return {
					content: [{ type: "text", text: "Planning complete. Queued coding phase." }],
					details: { nextPhase: "coding", plannerSummary: state.plannerSummary },
					terminate: true,
				};
			}

			if (state.phase === "coding") {
				state.coderSummary = params.summary;
				state.phase = "reviewing";
				state.reviewTurnStarted = false;
				await switchTo(state.reviewer, ctx, "reviewer");
				updateStatus(ctx);
				pi.sendUserMessage(reviewPrompt(state, handoff), { deliverAs: "followUp" });
				return {
					content: [{ type: "text", text: "Coding complete. Queued review phase." }],
					details: { nextPhase: "reviewing", coderSummary: state.coderSummary },
					terminate: true,
				};
			}

			await exitWorkflow(ctx, "Review complete.");
			return {
				content: [{ type: "text", text: "Review complete. Workflow exited." }],
				details: { completed: true },
				terminate: true,
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!state) return;
		if (state.phase === "reviewing") state.reviewTurnStarted = true;

		const roleInstruction =
			state.phase === "planning"
				? "You are currently in workflow-code planning phase. Create the plan only; do not edit files. Call workflow_continue when the plan is ready."
				: state.phase === "coding"
					? "You are currently in workflow-code coding phase. Implement the plan, make focused changes, and call workflow_continue when coding is complete."
					: "You are currently in workflow-code review phase. Review the changes, fix problems directly, and finish with a concise final summary.";

		return {
			systemPrompt: `${event.systemPrompt}\n\n${roleInstruction}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state || state.phase !== "reviewing" || !state.reviewTurnStarted) return;
		await exitWorkflow(ctx, "Workflow complete.");
	});

	pi.on("session_start", async (_event, ctx) => {
		state = undefined;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		state = undefined;
	});
}
