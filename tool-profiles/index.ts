import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Profile = "readonly" | "main" | "no-mcp";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function isMcpTool(tool: ReturnType<ExtensionAPI["getAllTools"]>[number]): boolean {
	return tool.name.startsWith("mcp_") || tool.sourceInfo.path.includes("mcp-bridge");
}

export default function toolProfiles(pi: ExtensionAPI) {
	let profile: Profile = "main";

	function applyProfile(ctx: ExtensionContext, notify = true) {
		const all = pi.getAllTools();
		const names = profile === "readonly"
			? all.filter((tool) => READ_ONLY_TOOLS.has(tool.name)).map((tool) => tool.name)
			: profile === "no-mcp"
				? all.filter((tool) => !isMcpTool(tool)).map((tool) => tool.name)
				: all.map((tool) => tool.name);
		pi.setActiveTools(names);
		ctx.ui.setStatus("tool-profile", `tools:${profile}`);
		if (notify) ctx.ui.notify(`Tool profile: ${profile} (${names.length}/${all.length} tools active)`, "info");
	}

	pi.registerCommand("profile", {
		description: "Select tool profile: readonly, main, or no-mcp",
		getArgumentCompletions: (prefix) => ["readonly", "main", "no-mcp"]
			.filter((name) => name.startsWith(prefix))
			.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			let selected = args.trim() as Profile | "";
			if (!selected && ctx.hasUI) selected = (await ctx.ui.select("Tool profile", ["readonly", "main", "no-mcp"])) as Profile | undefined ?? "";
			if (!(["readonly", "main", "no-mcp"] as string[]).includes(selected)) {
				ctx.ui.notify("Usage: /profile readonly|main|no-mcp", "error");
				return;
			}
			profile = selected as Profile;
			applyProfile(ctx);
		},
	});

	pi.registerCommand("profile-status", {
		description: "Show the active tool profile and enabled tools",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Profile: ${profile}\nActive: ${pi.getActiveTools().join(", ")}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => applyProfile(ctx, false));
}
