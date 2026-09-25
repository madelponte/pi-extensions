export type DiscoveredTool = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

export type ModelImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

export function normalizeToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
}

export function reserveExposedName(serverName: string, prefix: string, reservedNames: Set<string>): string {
	const cleanServerName = normalizeToolName(serverName);
	const cleanPrefix = normalizeToolName(prefix).replace(/^_+|_+$/g, "");
	const baseName = cleanPrefix ? `${cleanPrefix}_${cleanServerName}` : cleanServerName;
	let publicName = baseName;
	let suffix = 2;
	while (reservedNames.has(publicName)) {
		publicName = `${baseName}_${suffix}`;
		suffix += 1;
	}
	reservedNames.add(publicName);
	return publicName;
}

export async function listAllMcpTools(client: {
	listTools(params?: { cursor?: string }): Promise<{ tools?: DiscoveredTool[]; nextCursor?: string }>;
}): Promise<DiscoveredTool[]> {
	const tools: DiscoveredTool[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	while (true) {
		const page = await client.listTools(cursor ? { cursor } : undefined);
		tools.push(...(page.tools ?? []));
		const nextCursor = page.nextCursor;
		if (!nextCursor) return tools;
		if (seenCursors.has(nextCursor)) {
			throw new Error(`MCP tools/list returned a repeated cursor: ${nextCursor}`);
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
}

export function modelContentForMcpResult(result: {
	content?: unknown;
	structuredContent?: unknown;
}): { text: string; images: ModelImageContent[] } {
	const textParts: string[] = [];
	const images: ModelImageContent[] = [];
	const content = result.content;

	if (Array.isArray(content)) {
		for (const part of content) {
			if (!part || typeof part !== "object") {
				textParts.push(String(part));
				continue;
			}
			const item = part as Record<string, unknown>;
			if (item.type === "text") {
				textParts.push(String(item.text ?? ""));
			} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
				images.push({ type: "image", data: item.data, mimeType: item.mimeType });
			} else {
				textParts.push(JSON.stringify(item, null, 2));
			}
		}
	} else if (content !== undefined) {
		textParts.push(JSON.stringify(content, null, 2) ?? String(content));
	}

	if (result.structuredContent !== undefined) {
		const structured = JSON.stringify(result.structuredContent, null, 2) ?? String(result.structuredContent);
		textParts.push(`Structured content:\n${structured}`);
	}

	return {
		text: textParts.filter(Boolean).join("\n\n"),
		images,
	};
}
