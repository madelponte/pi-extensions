#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getSafetyGuardAuditDirectory, type AuditRecord } from "./audit-log.ts";
import { analyzeCommand } from "./guard.ts";

export interface EvaluatedCall {
	evaluation: AuditRecord;
	resolution?: AuditRecord;
	execution?: AuditRecord;
}

export interface AuditReport {
	files: string[];
	invalidLines: number;
	evaluations: number;
	reviewed: number;
	allowed: number;
	byRule: Map<string, number>;
	byOutcome: Map<string, number>;
	approvedReviews: EvaluatedCall[];
	allowedCommands: EvaluatedCall[];
	changedDecisions: Array<{ call: EvaluatedCall; currentDecision: string; currentRuleId: string }>;
}

function callKey(record: AuditRecord): string {
	return `${record.sessionId}\u0000${record.toolCallId}`;
}

function increment(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) ?? 0) + 1);
}

export async function auditFiles(path: string): Promise<string[]> {
	const target = resolve(path);
	const info = await stat(target);
	if (info.isFile()) return [target];
	if (!info.isDirectory()) throw new Error(`Not a file or directory: ${target}`);
	return (await readdir(target, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => resolve(target, entry.name))
		.sort();
}

export async function loadAuditRecords(path: string): Promise<{ files: string[]; records: AuditRecord[]; invalidLines: number }> {
	const files = await auditFiles(path);
	const records: AuditRecord[] = [];
	let invalidLines = 0;
	for (const file of files) {
		const content = await readFile(file, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as AuditRecord;
				if (!record || typeof record !== "object" || typeof record.event !== "string") invalidLines++;
				else records.push(record);
			} catch {
				invalidLines++;
			}
		}
	}
	return { files, records, invalidLines };
}

export function buildAuditReport(files: string[], records: AuditRecord[], invalidLines = 0): AuditReport {
	const calls = new Map<string, EvaluatedCall>();
	for (const record of records) {
		const key = callKey(record);
		if (record.event === "evaluation") calls.set(key, { evaluation: record });
		else {
			const call = calls.get(key);
			if (!call) continue;
			if (record.event === "resolution") call.resolution = record;
			if (record.event === "execution_end") call.execution = record;
		}
	}

	const byRule = new Map<string, number>();
	const byOutcome = new Map<string, number>();
	const approvedReviews: EvaluatedCall[] = [];
	const allowedCommands: EvaluatedCall[] = [];
	const changedDecisions: AuditReport["changedDecisions"] = [];
	let reviewed = 0;
	let allowed = 0;

	for (const call of calls.values()) {
		const evaluation = call.evaluation;
		increment(byRule, evaluation.ruleId ?? "unknown");
		if (call.resolution?.outcome) increment(byOutcome, call.resolution.outcome);
		if (evaluation.decision === "review") {
			reviewed++;
			if (call.resolution?.outcome === "approved") approvedReviews.push(call);
		} else {
			allowed++;
			allowedCommands.push(call);
		}
		if (evaluation.command) {
			const current = analyzeCommand(evaluation.command);
			if (current.decision !== evaluation.decision || current.ruleId !== evaluation.ruleId) {
				changedDecisions.push({ call, currentDecision: current.decision, currentRuleId: current.ruleId });
			}
		}
	}

	return {
		files,
		invalidLines,
		evaluations: calls.size,
		reviewed,
		allowed,
		byRule,
		byOutcome,
		approvedReviews: uniqueCalls(approvedReviews),
		allowedCommands: uniqueCalls(allowedCommands),
		changedDecisions,
	};
}

function uniqueCalls(calls: EvaluatedCall[]): EvaluatedCall[] {
	const unique = new Map<string, EvaluatedCall>();
	for (const call of calls) unique.set(call.evaluation.commandHash, call);
	return Array.from(unique.values());
}

function sortedCounts(values: Map<string, number>): Array<[string, number]> {
	return Array.from(values).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function commandLine(call: EvaluatedCall): string {
	const record = call.evaluation;
	return `- \`${record.ruleId ?? "unknown"}\` ${JSON.stringify(record.command ?? `[hash ${record.commandHash}]`)}`;
}

export function formatAuditReport(report: AuditReport, limit = 50): string {
	const lines = [
		"# Safety guard audit report",
		"",
		`- Files: ${report.files.length}`,
		`- Evaluated Bash calls: ${report.evaluations}`,
		`- Sent for review: ${report.reviewed}`,
		`- Allowed: ${report.allowed}`,
		`- Invalid log lines skipped: ${report.invalidLines}`,
		"",
		"## Decisions by rule",
		"",
		...sortedCounts(report.byRule).map(([rule, count]) => `- ${count} × \`${rule}\``),
		"",
		"## Review outcomes",
		"",
		...(report.byOutcome.size ? sortedCounts(report.byOutcome).map(([outcome, count]) => `- ${count} × \`${outcome}\``) : ["- None recorded"]),
		"",
		"## Approved review candidates",
		"",
		"These are useful false-positive candidates, but approval alone does not prove the command was harmless.",
		"",
		...(report.approvedReviews.length ? report.approvedReviews.slice(0, limit).map(commandLine) : ["- None"]),
		"",
		"## Allowed-command review queue",
		"",
		"Review these commands for false negatives. Entries are deduplicated by exact command hash.",
		"",
		...(report.allowedCommands.length ? report.allowedCommands.slice(0, limit).map(commandLine) : ["- None"]),
		"",
		"## Decisions changed under the current ruleset",
		"",
		...(report.changedDecisions.length ? report.changedDecisions.slice(0, limit).map(({ call, currentDecision, currentRuleId }) =>
			`- \`${call.evaluation.decision}/${call.evaluation.ruleId}\` → \`${currentDecision}/${currentRuleId}\` ${JSON.stringify(call.evaluation.command ?? `[hash ${call.evaluation.commandHash}]`)}`) : ["- None"]),
	];
	if (report.approvedReviews.length > limit || report.allowedCommands.length > limit || report.changedDecisions.length > limit) {
		lines.push("", `Output limited to ${limit} entries per review section. Use --limit=N to change it.`);
	}
	return lines.join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const limitArg = args.find((arg) => arg.startsWith("--limit="));
	const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : 50;
	if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
	const path = args.find((arg) => !arg.startsWith("--")) ?? getSafetyGuardAuditDirectory();
	const loaded = await loadAuditRecords(path);
	const report = buildAuditReport(loaded.files, loaded.records, loaded.invalidLines);
	if (json) {
		console.log(JSON.stringify({
			...report,
			byRule: Object.fromEntries(report.byRule),
			byOutcome: Object.fromEntries(report.byOutcome),
		}, null, 2));
	} else {
		console.log(formatAuditReport(report, limit));
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`safety-guard review failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
