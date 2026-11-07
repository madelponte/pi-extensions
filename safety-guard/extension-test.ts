/**
 * Offline integration tests using the installed Pi loader and mocked UI/context.
 * Run: node safety-guard/extension-test.ts /path/to/@earendil-works/pi-coding-agent
 * No sessions, models, shell commands, or MCP servers are started.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { APPROVAL_TIMEOUT_MS } from "./runtime.ts";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Pass the installed @earendil-works/pi-coding-agent package directory as the first argument.");
const { loadExtensions } = await import(pathToFileURL(resolve(packageRoot, "dist/core/extensions/loader.js")).href);
const { initTheme } = await import(pathToFileURL(resolve(packageRoot, "dist/modes/interactive/theme/theme.js")).href);
initTheme("dark", false);
const require = createRequire(resolve(packageRoot, "package.json"));
const { visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);

type Component = {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
	capturesViewportInput: boolean;
};

async function harness(mode: "tui" | "rpc" | "print" = "tui") {
	const loaded = await loadExtensions([join(import.meta.dirname, "index.ts")], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const messages: { content: string; options: unknown }[] = [];
	loaded.runtime.sendMessage = (message: { content: string }, options: unknown) => messages.push({ content: message.content, options });
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	let component: Component | undefined;
	let rpcResponse: ((approved: boolean) => void) | undefined;
	let prompts = 0;
	let renders = 0;
	let aborts = 0;
	const controller = new AbortController();
	const keyMap: Record<string, string> = {
		"tui.select.up": "k", "tui.select.down": "j",
		"tui.select.pageUp": "[", "tui.select.pageDown": "]", "tui.select.cancel": "x",
	};
	const tui = { terminal: { rows: 24 }, requestRender: () => renders++ };
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const keys = {
		getKeys: (action: string) => keyMap[action] ? [keyMap[action]] : [],
		matches: (data: string, action: string) => data === keyMap[action],
	};
	const ctx = {
		mode, hasUI: mode !== "print", signal: controller.signal,
		abort: () => { aborts++; controller.abort(); },
		ui: {
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (value: string) => notifications.push(value),
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (approved: boolean) => void) => Component, options: { blocked: { kind: string } }) => {
				assert.equal(mode, "tui");
				assert.equal(options.blocked.kind, "permission");
				prompts++;
				return new Promise<boolean>((resolve) => {
					let finished = false;
					let current: Component | undefined;
					const done = (approved: boolean) => {
						if (finished) return;
						finished = true;
						current?.dispose();
						resolve(approved);
					};
					current = factory(tui, theme, keys, done);
					component = current;
					if (finished) current.dispose();
				});
			},
			confirm: async (_title: string, message: string, options: { signal: AbortSignal }) => {
				assert.equal(mode, "rpc");
				assert.match(message, /30 minutes/);
				prompts++;
				return new Promise<boolean>((resolve) => {
					const onAbort = () => finish(false);
					const finish = (approved: boolean) => {
						options.signal.removeEventListener("abort", onAbort);
						resolve(approved);
					};
					rpcResponse = finish;
					if (options.signal.aborted) onAbort();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				});
			},
		},
	};
	async function emit(name: string, event: Record<string, unknown> = {}) {
		let result;
		for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	}
	const startEvent = { messageType: "custom", systemPromptOptions: { sections: {} as Record<string, string> } };
	await emit("session_start");
	await emit("before_agent_start", startEvent);
	return {
		ctx, emit, startEvent, messages, notifications, statuses, tui, controller,
		get component() { assert.ok(component); return component; },
		get prompts() { return prompts; },
		get renders() { return renders; },
		get aborts() { return aborts; },
		rpcRespond: (approved: boolean) => { assert.ok(rpcResponse); rpcResponse(approved); },
		command: (args: string) => extension.commands.get("safety").handler(args, ctx),
		tool: (command = "rm /nonexistent-safety-guard-test", toolName = "bash") => emit("tool_call", {
			type: "tool_call", toolName, toolCallId: "test-call", input: { command },
		}),
	};
}

test("unattended denies guarded commands, preserves allowed commands, and supplies guidance", async () => {
	const h = await harness();
	await h.command("unattended");
	await h.emit("before_agent_start", h.startEvent);
	assert.match(h.startEvent.systemPromptOptions.sections.safety_guard, /mode: unattended/);
	const result = await h.tool();
	assert.equal(result.block, true);
	assert.match(result.reason, /Do not retry.*another command, script, or tool/);
	assert.match(result.reason, /continue independent permitted work/);
	assert.equal(await h.tool("git status"), undefined);
	assert.equal(await h.tool("rm /tmp/nonexistent-safety-guard-test"), undefined);
	assert.equal(await h.tool("rm /nonexistent-safety-guard-test", "other_tool"), undefined);
	assert.equal(h.prompts, 0);
	await h.command("status");
	assert.match(h.notifications.at(-1)!, /blocked 1 command/);
	await h.emit("agent_settled");
	await h.emit("agent_settled");
	assert.equal(h.messages.length, 1);
	assert.deepEqual(h.messages[0].options, { triggerTurn: false });
	assert.doesNotMatch(h.messages[0].content, /nonexistent-safety-guard-test/);
});

test("TUI timeout denies, changes mode, and subsequent prompts are skipped", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	const result = h.tool();
	assert.match(h.component.render(100).join("\n"), /30:00.*unattended/);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS - 1);
	assert.equal(h.notifications.length, 0);
	t.mock.timers.tick(1);
	assert.match((await result).reason, /timed out.*switched to unattended/);
	assert.match(h.statuses.at(-1)!, /unattended/);
	assert.equal((await h.tool("git push")).block, true);
	assert.equal(h.prompts, 1);
	assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
	const renders = h.renders;
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.equal(h.renders, renders, "countdown interval was disposed");
});

test("TUI preserves deliberate-key approval, Enter rejection, and timer cleanup", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	let finished = false;
	const result = h.tool().then((value) => { finished = true; return value; });
	h.component.handleInput("y"); // typed ahead
	t.mock.timers.tick(500);
	h.component.handleInput("\r"); // Enter never approves
	await Promise.resolve();
	assert.equal(finished, false);
	t.mock.timers.tick(400);
	h.component.handleInput("y");
	assert.equal(await result, undefined);
	const renders = h.renders;
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.equal(h.renders, renders);
	assert.equal(h.notifications.length, 0);
	assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
});

test("TUI remains width-bounded and honors remapped scrolling/cancellation", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	const result = h.tool(`rm /nonexistent-${"wide界".repeat(200)}`);
	assert.equal(h.component.capturesViewportInput, true);
	for (const width of [1, 2, 10, 40, 80]) {
		const lines = h.component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.length < h.tui.terminal.rows);
	}
	h.component.render(100);
	h.component.handleInput("j");
	assert.match(h.component.render(100).join("\n"), /visual lines 2-/);
	h.component.handleInput("]");
	assert.match(h.component.render(100).join("\n"), /visual lines 7-13 of 13/); // clamped at the last page
	h.component.handleInput("[");
	assert.match(h.component.render(100).join("\n"), /visual lines 1-/);
	h.component.handleInput("x");
	assert.match((await result).reason, /User declined/);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.doesNotMatch(h.statuses.at(-1)!, /unattended/);
});

test("TUI rejects late y even if timer callbacks have not run", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	const result = h.tool();
	t.mock.timers.setTime(1000 + APPROVAL_TIMEOUT_MS);
	h.component.handleInput("y");
	assert.match((await result).reason, /timed out/);
});

test("RPC timeout also switches mode, and manual interactive restores prompting", async (t) => {
	const h = await harness("rpc");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const first = h.tool();
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.match((await first).reason, /timed out/);
	assert.equal((await h.tool("git push")).block, true);
	assert.equal(h.prompts, 1);
	await h.command("interactive");
	const next = h.tool();
	h.rpcRespond(true);
	assert.equal(await next, undefined);
	assert.equal(h.prompts, 2);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.match(h.statuses.at(-1)!, /interactive/);
});

test("RPC manual denial is not a timeout, and late approval cannot win", async (t) => {
	const h = await harness("rpc");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const first = h.tool();
	h.rpcRespond(false);
	assert.match((await first).reason, /User declined/);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.match(h.statuses.at(-1)!, /interactive/);
	const second = h.tool("git push");
	t.mock.timers.setTime(Date.now() + APPROVAL_TIMEOUT_MS);
	h.rpcRespond(true);
	assert.match((await second).reason, /timed out/);
});

test("abort cancels TUI and RPC prompts without changing mode", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	for (const mode of ["tui", "rpc"] as const) {
		const h = await harness(mode);
		const result = h.tool();
		h.controller.abort();
		assert.match((await result).reason, /cancelled/);
		t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
		assert.match(h.statuses.at(-1)!, /interactive/);
		assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
	}
});

test("explicit unattended mode cancels pending approval; shutdown cleans up; fresh factory resets", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	const pending = h.tool();
	await h.command("unattended");
	assert.equal((await pending).block, true);
	await h.command("interactive");
	const pendingShutdown = h.tool("git push");
	await h.emit("session_shutdown");
	assert.equal((await pendingShutdown).block, true);
	assert.equal(h.statuses.at(-1), undefined);
	const renders = h.renders;
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.equal(h.renders, renders);
	assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
	const fresh = await harness();
	assert.match(fresh.statuses.at(-1)!, /interactive/);
});

test("already-aborted prompts deny immediately without switching mode", async (t) => {
	const h = await harness();
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	h.controller.abort();
	assert.match((await h.tool()).reason, /cancelled/);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.match(h.statuses.at(-1)!, /interactive/);
	assert.equal(h.renders, 0);
});

test("UI errors propagate fail-closed and clean up the deadline", async (t) => {
	const h = await harness("rpc");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	h.ctx.ui.confirm = async () => { throw new Error("UI failed"); };
	await assert.rejects(h.tool(), /UI failed/); // Pi blocks tool_call handler errors.
	assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.match(h.statuses.at(-1)!, /interactive/);
});

test("no-UI mode fails closed without any prompt, even with interactive selected", async () => {
	const h = await harness("print");
	await h.command("interactive");
	assert.match((await h.tool()).reason, /approval is unavailable/);
	assert.equal(h.prompts, 0);
	assert.equal(await h.tool("git status"), undefined);
	assert.match(h.startEvent.systemPromptOptions.sections.safety_guard, /approval unavailable/);
});

test("three identical unattended denials stop a retry loop; separate runs reset tracking", async () => {
	const h = await harness();
	await h.command("unattended");
	await h.tool();
	await h.tool();
	assert.equal(h.aborts, 0);
	assert.match((await h.tool()).reason, /Run stopped/);
	assert.equal(h.aborts, 1);
	await h.emit("agent_settled");
	assert.match(h.messages[0].content, /blocked 3 command/);
	await h.emit("before_agent_start", h.startEvent);
	await h.tool();
	assert.equal(h.aborts, 1);
	assert.match(h.statuses.at(-1)!, /1 blocked/);
});
