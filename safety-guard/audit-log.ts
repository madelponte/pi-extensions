import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type AuditCaptureMode = "off" | "catches" | "all";

/** Increment when the JSONL record shape changes incompatibly. */
export const AUDIT_LOG_SCHEMA_VERSION = 1;
/** Increment when stable rule IDs or scanner decision semantics change. */
export const AUDIT_RULESET_VERSION = 1;
export const DEFAULT_MAX_AUDIT_BYTES = 25 * 1024 * 1024;

export interface AuditRecord {
	schemaVersion: number;
	rulesetVersion: number;
	timestamp: string;
	event: "evaluation" | "resolution" | "execution_end";
	captureMode: Exclude<AuditCaptureMode, "off">;
	sessionId: string;
	sessionFile?: string;
	run: number;
	toolCallId: string;
	parentToolCallId?: string;
	cwd: string;
	safetyMode: "interactive" | "unattended" | "approval-unavailable";
	extensionMode: "tui" | "rpc" | "json" | "print";
	commandHash: string;
	command?: string;
	decision?: "allow" | "review";
	ruleId?: string;
	reason?: string;
	outcome?: string;
	executed?: boolean;
	isError?: boolean;
	durationMs?: number;
}

export interface AuditAppendResult {
	ok: boolean;
	path: string;
	error?: string;
	limitReached?: boolean;
}

export interface AuditLogOptions {
	directory?: string;
	maxBytes?: number;
	now?: () => Date;
}

export function getSafetyGuardAuditDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const agentDir = configured ? resolve(configured) : join(homedir(), ".pi", "agent");
	return join(agentDir, "logs", "safety-guard");
}

export function commandFingerprint(command: string): string {
	return createHash("sha256").update(command).digest("hex");
}

export class SafetyGuardAuditLog {
	readonly directory: string;
	readonly maxBytes: number;
	private readonly now: () => Date;
	private queue: Promise<void> = Promise.resolve();
	private initialized = false;
	private totalBytes = 0;

	constructor(options: AuditLogOptions = {}) {
		this.directory = options.directory ?? getSafetyGuardAuditDirectory();
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIT_BYTES;
		this.now = options.now ?? (() => new Date());
	}

	get currentPath(): string {
		return join(this.directory, `${this.now().toISOString().slice(0, 10)}.jsonl`);
	}

	append(record: AuditRecord): Promise<AuditAppendResult> {
		const path = this.currentPath;
		const operation = this.queue.then(async () => {
			try {
				await this.initialize();
				const line = `${JSON.stringify(record)}\n`;
				const bytes = Buffer.byteLength(line);
				if (this.totalBytes + bytes > this.maxBytes) {
					return {
						ok: false,
						path,
						limitReached: true,
						error: `audit log limit reached (${this.maxBytes} bytes)`,
					};
				}
				await appendFile(path, line, { encoding: "utf8", flag: "a", mode: 0o600 });
				await chmod(path, 0o600);
				this.totalBytes += bytes;
				return { ok: true, path };
			} catch (error) {
				return {
					ok: false,
					path,
					error: error instanceof Error ? error.message : "unknown audit logging error",
				};
			}
		});
		this.queue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		const entries = await readdir(this.directory, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			try {
				total += (await stat(join(this.directory, entry.name))).size;
			} catch {
				// A concurrently removed file does not need to count toward the cap.
			}
		}
		this.totalBytes = total;
		this.initialized = true;
	}
}
