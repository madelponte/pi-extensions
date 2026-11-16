import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuditReport, formatAuditReport } from "./review-log.ts";
import type { AuditRecord } from "./audit-log.ts";

function evaluation(overrides: Partial<AuditRecord>): AuditRecord {
	return {
		schemaVersion: 1,
		rulesetVersion: 1,
		timestamp: "2026-01-01T00:00:00.000Z",
		event: "evaluation",
		captureMode: "all",
		sessionId: "session",
		run: 1,
		toolCallId: "call",
		cwd: "/work",
		safetyMode: "interactive",
		extensionMode: "tui",
		commandHash: "hash",
		command: "git status",
		decision: "allow",
		ruleId: "git.read_only",
		...overrides,
	};
}

test("review report identifies approved catches and allowed commands", () => {
	const records = [
		evaluation({ toolCallId: "review", commandHash: "one", command: "git push", decision: "review", ruleId: "git.state_change" }),
		evaluation({ event: "resolution", toolCallId: "review", commandHash: "one", command: undefined, decision: undefined, ruleId: undefined, outcome: "approved" }),
		evaluation({ toolCallId: "allow", commandHash: "two", command: "git status" }),
	];
	const report = buildAuditReport(["audit.jsonl"], records);
	assert.equal(report.evaluations, 2);
	assert.equal(report.reviewed, 1);
	assert.equal(report.allowed, 1);
	assert.equal(report.approvedReviews.length, 1);
	assert.equal(report.allowedCommands.length, 1);
	assert.equal(report.byRule.get("git.state_change"), 1);
	assert.equal(report.byOutcome.get("approved"), 1);
	assert.match(formatAuditReport(report), /Approved review candidates/);
	assert.match(formatAuditReport(report), /"git push"/);
});

test("review report compares recorded decisions with the current scanner", () => {
	const report = buildAuditReport([], [evaluation({ command: "git push", decision: "allow", ruleId: "allow.no_match" })]);
	assert.equal(report.changedDecisions.length, 1);
	assert.equal(report.changedDecisions[0].currentDecision, "review");
	assert.equal(report.changedDecisions[0].currentRuleId, "git.state_change");
});

test("review queues deduplicate exact command fingerprints", () => {
	const report = buildAuditReport([], [
		evaluation({ toolCallId: "one", commandHash: "same" }),
		evaluation({ toolCallId: "two", commandHash: "same" }),
	]);
	assert.equal(report.evaluations, 2);
	assert.equal(report.allowedCommands.length, 1);
});
