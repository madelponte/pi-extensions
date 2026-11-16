import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	AUDIT_LOG_SCHEMA_VERSION,
	AUDIT_RULESET_VERSION,
	commandFingerprint,
	SafetyGuardAuditLog,
	type AuditRecord,
} from "./audit-log.ts";

function record(command: string, event: AuditRecord["event"] = "evaluation"): AuditRecord {
	return {
		schemaVersion: AUDIT_LOG_SCHEMA_VERSION,
		rulesetVersion: AUDIT_RULESET_VERSION,
		timestamp: "2026-01-02T03:04:05.000Z",
		event,
		captureMode: "all",
		sessionId: "session-1",
		run: 1,
		toolCallId: "call-1",
		cwd: "/work",
		safetyMode: "interactive",
		extensionMode: "tui",
		commandHash: commandFingerprint(command),
		command,
		decision: "allow",
		ruleId: "allow.no_match",
	};
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "safety-guard-audit-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("audit log appends JSONL with restrictive permissions", async (t) => {
	const directory = await temporaryDirectory(t);
	const log = new SafetyGuardAuditLog({ directory, now: () => new Date("2026-01-02T03:04:05Z") });
	const first = await log.append(record("printf 'one\\ntwo'"));
	const second = await log.append(record("git push", "resolution"));
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.path, join(directory, "2026-01-02.jsonl"));
	const lines = (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.equal(lines[0].command, "printf 'one\\ntwo'");
	assert.equal(lines[1].event, "resolution");
	if (process.platform !== "win32") {
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
		assert.equal((await stat(first.path)).mode & 0o777, 0o600);
	}
});

test("audit writes are serialized", async (t) => {
	const directory = await temporaryDirectory(t);
	const log = new SafetyGuardAuditLog({ directory });
	const results = await Promise.all(Array.from({ length: 50 }, (_, index) => log.append(record(`echo ${index}`))));
	assert.ok(results.every((result) => result.ok));
	await log.flush();
	const lines = (await readFile(results[0].path, "utf8")).trim().split("\n");
	assert.equal(lines.length, 50);
	assert.deepEqual(lines.map((line) => JSON.parse(line).command), Array.from({ length: 50 }, (_, index) => `echo ${index}`));
});

test("audit log refuses writes beyond its total size cap", async (t) => {
	const directory = await temporaryDirectory(t);
	const log = new SafetyGuardAuditLog({ directory, maxBytes: 1 });
	const result = await log.append(record("echo too-large"));
	assert.equal(result.ok, false);
	assert.equal(result.limitReached, true);
	assert.match(result.error!, /limit reached/);
});

test("command fingerprints are stable without storing command text", () => {
	assert.equal(commandFingerprint("git status"), commandFingerprint("git status"));
	assert.notEqual(commandFingerprint("git status"), commandFingerprint("git push"));
});
