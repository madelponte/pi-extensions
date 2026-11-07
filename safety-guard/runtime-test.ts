import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { APPROVAL_TIMEOUT_MS, ApprovalDeadline, DenialTracker } from "./runtime.ts";

test("approval deadline expires at exactly 30 minutes and aborts once", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const deadline = new ApprovalDeadline();
	let aborts = 0;
	deadline.signal.addEventListener("abort", () => aborts++);
	assert.equal(APPROVAL_TIMEOUT_MS, 30 * 60 * 1000);
	assert.equal(deadline.remainingSeconds, 1800);
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS - 1);
	assert.equal(deadline.timedOut, false);
	assert.equal(deadline.signal.aborted, false);
	t.mock.timers.tick(1);
	assert.equal(deadline.timedOut, true);
	assert.equal(deadline.signal.aborted, true);
	assert.equal(deadline.remainingSeconds, 0);
	deadline.cancel();
	deadline.dispose();
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS);
	assert.equal(aborts, 1);
});

test("late decisions expire even when the timer callback was delayed", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const deadline = new ApprovalDeadline();
	t.mock.timers.setTime(1000 + APPROVAL_TIMEOUT_MS);
	assert.equal(deadline.signal.aborted, false);
	assert.equal(deadline.timedOut, true);
	assert.equal(deadline.signal.aborted, true);
	deadline.dispose();
});

test("abort, explicit cancellation, and pre-abort are not timeouts", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	for (const action of ["abort", "cancel", "pre-abort"]) {
		const parent = new AbortController();
		if (action === "pre-abort") parent.abort();
		const deadline = new ApprovalDeadline(parent.signal);
		if (action === "abort") parent.abort();
		if (action === "cancel") deadline.cancel();
		t.mock.timers.tick(APPROVAL_TIMEOUT_MS * 2);
		assert.equal(deadline.signal.aborted, true);
		assert.equal(deadline.timedOut, false);
		deadline.dispose();
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	}
});

test("completed prompts leave no timer or parent abort listener", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const parent = new AbortController();
	const deadline = new ApprovalDeadline(parent.signal);
	assert.equal(getEventListeners(parent.signal, "abort").length, 1);
	deadline.dispose();
	deadline.dispose();
	assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	parent.abort();
	t.mock.timers.tick(APPROVAL_TIMEOUT_MS * 2);
	assert.equal(deadline.signal.aborted, false);
	assert.equal(deadline.timedOut, false);
});

test("denial summaries count attempts without duplicating raw commands", () => {
	const tracker = new DenialTracker();
	assert.equal(tracker.record("rm sensitive-name", "file deletion"), 1);
	assert.equal(tracker.record("rm sensitive-name", "file deletion"), 2);
	assert.equal(tracker.record("rm sensitive-name", "file deletion"), 3);
	assert.equal(tracker.record("git push", "Git state change"), 1);
	assert.equal(tracker.total, 4);
	assert.match(tracker.summary(), /3 × file deletion/);
	assert.match(tracker.summary(), /1 × Git state change/);
	assert.doesNotMatch(tracker.summary(), /sensitive-name/);
	assert.equal(new DenialTracker().record("rm sensitive-name", "file deletion"), 1);
});

test("review data and retry tracking are bounded", () => {
	const tracker = new DenialTracker();
	for (let i = 0; i < 1000; i++) tracker.record(`rm path-${i}`, `${i}\u001b\n${"x".repeat(1000)}`);
	assert.equal(tracker.total, 1000);
	assert.ok(tracker.summary().length < 2000);
	assert.match(tracker.summary(), /Other guarded operations/);
	assert.doesNotMatch(tracker.summary(), /\u001b/);
	assert.equal(tracker.record("rm path-0", "file deletion"), 1, "old fingerprints are evicted");
	assert.equal(tracker.record("rm path-999", "file deletion"), 2, "recent fingerprints remain");
});
