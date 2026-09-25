import assert from "node:assert/strict";
import {
	listAllMcpTools,
	modelContentForMcpResult,
	reserveExposedName,
} from "./helpers.ts";

let passed = 0;

const pages = new Map<string | undefined, { tools: Array<{ name: string }>; nextCursor?: string }>([
	[undefined, { tools: [{ name: "first" }], nextCursor: "page-2" }],
	["page-2", { tools: [{ name: "second" }] }],
]);
const cursors: Array<string | undefined> = [];
const tools = await listAllMcpTools({
	async listTools(params) {
		const cursor = params?.cursor;
		cursors.push(cursor);
		return pages.get(cursor) ?? { tools: [] };
	},
});
assert.deepEqual(tools.map((tool) => tool.name), ["first", "second"]);
assert.deepEqual(cursors, [undefined, "page-2"]);
passed += 2;

await assert.rejects(
	listAllMcpTools({ async listTools() { return { tools: [], nextCursor: "same" }; } }),
	/repeated cursor/,
);
passed++;

const reserved = new Set<string>();
assert.equal(reserveExposedName("a-b", "mcp", reserved), "mcp_a_b");
assert.equal(reserveExposedName("a_b_3", "mcp", reserved), "mcp_a_b_3");
assert.equal(reserveExposedName("a_b", "mcp", reserved), "mcp_a_b_2");
assert.equal(reserveExposedName("read", "", new Set(["read"])), "read_2");
passed += 4;

const modelContent = modelContentForMcpResult({
	content: [
		{ type: "text", text: "hello" },
		{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
	],
	structuredContent: { answer: 42 },
});
assert.match(modelContent.text, /hello/);
assert.match(modelContent.text, /"answer": 42/);
assert.deepEqual(modelContent.images, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
assert.doesNotMatch(modelContent.text, /aGVsbG8=/);
passed += 4;

console.log(`mcp-bridge: ${passed} cases passed`);
