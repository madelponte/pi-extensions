import { createHash } from "node:crypto";

export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_REPEATED_DENIALS = 3;
export const DENIAL_GUIDANCE = "Do not retry a denied operation through another command, script, or tool, and do not change safety-guard configuration. Skip optional cleanup, continue independent permitted work, and report skipped operations and approval-dependent work in your final response. If no independent work remains, finish with a blocked-work summary rather than asking for approval or looping.";

/** One absolute deadline; typing and scrolling never extend it. No timers at import time. */
export class ApprovalDeadline {
	private readonly controller = new AbortController();
	readonly expiresAt: number;
	private timer: ReturnType<typeof setTimeout>;
	private parentSignal: AbortSignal | undefined;
	private expired = false;
	private disposed = false;

	constructor(parentSignal?: AbortSignal, timeoutMs = APPROVAL_TIMEOUT_MS) {
		this.parentSignal = parentSignal;
		this.expiresAt = Date.now() + timeoutMs;
		this.timer = setTimeout(() => this.expire(), timeoutMs);
		if (parentSignal?.aborted) this.cancel();
		else parentSignal?.addEventListener("abort", this.cancel, { once: true });
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get remainingSeconds(): number {
		return Math.max(0, Math.ceil((this.expiresAt - Date.now()) / 1000));
	}

	get timedOut(): boolean {
		// Reject late approval even if a busy event loop delayed the timer callback.
		if (!this.disposed && !this.signal.aborted && Date.now() >= this.expiresAt) this.expire();
		return this.expired;
	}

	private expire() {
		if (this.disposed || this.signal.aborted) return;
		this.expired = true;
		this.cancel();
	}

	cancel = () => {
		clearTimeout(this.timer);
		this.controller.abort();
	};

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.parentSignal?.removeEventListener("abort", this.cancel);
	}
}

/** Bounded, in-memory review data. Never duplicates raw commands into summaries. */
export class DenialTracker {
	total = 0;
	private reasons = new Map<string, number>();
	private attempts = new Map<string, number>();

	record(command: string, reason: string): number {
		this.total++;
		// Reasons can contain command-derived text; bound and sanitize them too.
		let category = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 160);
		if (!this.reasons.has(category) && this.reasons.size >= 8) category = "Other guarded operations";
		this.reasons.set(category, (this.reasons.get(category) ?? 0) + 1);
		const key = createHash("sha256").update(command).digest("hex");
		if (!this.attempts.has(key) && this.attempts.size >= 64) {
			this.attempts.delete(this.attempts.keys().next().value!);
		}
		const attempts = (this.attempts.get(key) ?? 0) + 1;
		this.attempts.set(key, attempts);
		return attempts;
	}

	summary(): string {
		return [
			`Safety guard blocked ${this.total} command attempt(s) in the current/most recent run.`,
			...Array.from(this.reasons, ([reason, count]) => `- ${count} × ${reason}`),
			"See the original tool calls for commands and details; blocked commands were not executed or queued for replay.",
		].join("\n");
	}
}
