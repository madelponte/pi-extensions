import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "config.json");

type ServerConfig =
	| { type: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
	| { type: "sse" | "http"; url: string; headers?: Record<string, string> };

type Config = {
	enabled?: boolean;
	prefix?: string;
	disabledTools?: string[];
	allowedTools?: string[];
	server: ServerConfig;
};

type DiscoveredTool = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

type ToolRecord = {
	serverName: string;
	exposedName: string;
	description: string;
	disabledReason?: string;
};

function readConfig(): Config | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
}

function expandEnv(value: string): string {
	return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_match, name) => process.env[name] ?? "");
}

function expandEnvMap(values?: Record<string, string>): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandEnv(value)]));
}

function describeError(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	let depth = 0;
	while (current instanceof Error && depth < 5) {
		const code = (current as { code?: unknown }).code;
		parts.push(typeof code === "string" && code ? `${current.message} (${code})` : current.message);
		current = (current as { cause?: unknown }).cause;
		depth += 1;
	}
	if (current !== undefined && current !== null) parts.push(String(current));
	return parts.join(": ") || String(error);
}

function cleanProcessEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

function normalizeToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
}

function exposedName(serverName: string, prefix: string): string {
	const cleanServerName = normalizeToolName(serverName);
	const cleanPrefix = normalizeToolName(prefix).replace(/^_+|_+$/g, "");
	return cleanPrefix ? `${cleanPrefix}_${cleanServerName}` : cleanServerName;
}

function matchesName(value: string, serverName: string, publicName: string): boolean {
	return value === serverName || value === publicName;
}

function shouldExpose(tool: DiscoveredTool, publicName: string, config: Config): string | undefined {
	const disabled = config.disabledTools ?? [];
	if (disabled.some((name) => matchesName(name, tool.name, publicName))) {
		return "disabled by config.disabledTools";
	}

	const allowed = config.allowedTools ?? [];
	if (allowed.length > 0 && !allowed.some((name) => matchesName(name, tool.name, publicName))) {
		return "not listed in config.allowedTools";
	}

	return undefined;
}

function inputSchemaToTypeBox(schema: Record<string, unknown> | undefined) {
	if (!schema || Object.keys(schema).length === 0) return Type.Object({});
	return Type.Unsafe(schema as any);
}

function summarizeMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return JSON.stringify(content, null, 2) ?? String(content ?? "");
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return String(part);
			const item = part as Record<string, unknown>;
			if (item.type === "text") return String(item.text ?? "");
			return JSON.stringify(item, null, 2);
		})
		.filter(Boolean)
		.join("\n\n");
}

async function truncateForModel(text: string, toolName: string) {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content, truncation, fullOutputPath: undefined };
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	const fullOutputPath = join(tempDir, `${normalizeToolName(toolName)}.txt`);
	await withFileMutationQueue(fullOutputPath, () =>
		writeFile(fullOutputPath, text, { encoding: "utf8", mode: 0o600 }),
	);

	let output = truncation.content;
	output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	output += ` Full output saved to: ${fullOutputPath}]`;
	return { text: output, truncation, fullOutputPath };
}

async function makeTransport(config: ServerConfig): Promise<any> {
	if (config.type === "stdio") {
		return new StdioClientTransport({
			command: expandEnv(config.command),
			args: (config.args ?? []).map(expandEnv),
			cwd: config.cwd ? expandEnv(config.cwd) : undefined,
			env: { ...cleanProcessEnv(), ...expandEnvMap(config.env) },
		});
	}

	const headers = expandEnvMap(config.headers);
	if (config.type === "sse") {
		return new SSEClientTransport(new URL(expandEnv(config.url)), {
			eventSourceInit: { headers },
			requestInit: { headers },
		} as any);
	}

	return new StreamableHTTPClientTransport(new URL(expandEnv(config.url)), { requestInit: { headers } } as any);
}

export default function mcpBridgeExtension(pi: ExtensionAPI) {
	let client: Client | undefined;
	let records: ToolRecord[] = [];
	const registeredToolNames = new Set<string>();

	async function closeClient() {
		const oldClient = client;
		client = undefined;
		if (oldClient) await oldClient.close().catch(() => undefined);
	}

	async function connectAndRegister(ctx: { ui?: { notify?: (message: string, level?: any) => void } }) {
		const config = readConfig();
		records = [];

		if (!config) {
			ctx.ui?.notify?.(`MCP bridge: create ${CONFIG_PATH} from config.json.example to enable.`, "warning");
			return;
		}
		if (config.enabled === false) return;

		await closeClient();

		const nextClient = new Client({ name: "pi-mcp-bridge", version: "1.1.0" });
		try {
			const transport = await makeTransport(config.server);
			await nextClient.connect(transport);
			client = nextClient;
		} catch (error) {
			await nextClient.close().catch(() => undefined);
			throw error;
		}

		const prefix = config.prefix ?? "mcp";
		const list = await nextClient.listTools();
		const tools = (list.tools ?? []) as DiscoveredTool[];
		const seenPublicNames = new Set<string>();

		for (const tool of tools) {
			let publicName = exposedName(tool.name, prefix);
			if (seenPublicNames.has(publicName)) publicName = `${publicName}_${seenPublicNames.size + 1}`;
			seenPublicNames.add(publicName);

			const description = tool.description || `Call MCP server tool ${tool.name}.`;
			const disabledReason = shouldExpose(tool, publicName, config);
			records.push({ serverName: tool.name, exposedName: publicName, description, disabledReason });
			if (disabledReason || registeredToolNames.has(publicName)) continue;

			registeredToolNames.add(publicName);
			pi.registerTool({
				name: publicName,
				label: publicName,
				description: `${description}\n\nOutput is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; truncated output is saved to a temporary file.`,
				promptSnippet: description.split("\n")[0],
				parameters: inputSchemaToTypeBox(tool.inputSchema),
				async execute(_toolCallId, params, signal) {
					if (!client) throw new Error("MCP server is not connected.");
					const result = await client.callTool(
						{ name: tool.name, arguments: params as Record<string, unknown> },
						undefined,
						{ signal },
					);

					const summary = await truncateForModel(summarizeMcpContent((result as any).content), tool.name);
					if ((result as any).isError) {
						throw new Error(`MCP tool ${tool.name} failed: ${summary.text}`);
					}
					return {
						content: [{ type: "text", text: summary.text }],
						details: {
							serverTool: tool.name,
							exposedTool: publicName,
							truncation: summary.truncation.truncated ? summary.truncation : undefined,
							fullOutputPath: summary.fullOutputPath,
						},
					};
				},
			});
		}

		const enabledCount = records.filter((record) => !record.disabledReason).length;
		ctx.ui?.notify?.(`MCP bridge: registered ${enabledCount}/${records.length} tools.`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await connectAndRegister(ctx);
		} catch (error) {
			ctx.ui.notify(`MCP bridge failed: ${describeError(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await closeClient();
	});

	pi.registerCommand("mcp-tools", {
		description: "List MCP tools exposed by the MCP bridge extension",
		handler: async (_args, ctx) => {
			if (records.length === 0) {
				ctx.ui.notify("MCP bridge: no tools discovered yet.", "warning");
				return;
			}

			const lines = records.map((record) => {
				const status = record.disabledReason ? `disabled (${record.disabledReason})` : "enabled";
				return `${record.exposedName} -> ${record.serverName}: ${status}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "Reload extensions after editing mcp-bridge/config.json",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
