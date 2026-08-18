import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { approvalReason } from "./guard.ts";

export default function safetyGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		const reason = approvalReason(command);
		if (!reason) return;

		if (!ctx.hasUI) return { block: true, reason: `Safety guard blocked command because approval is unavailable: ${reason}` };
		const approved = await ctx.ui.confirm("Approve command?", `${reason}\n\n${command}`);
		if (!approved) return { block: true, reason: `User declined command: ${reason}` };
	});
}
