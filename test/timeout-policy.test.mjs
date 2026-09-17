import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIMEOUT_SECONDS,
  GUIDELINE,
  MAX_TIMER_SECONDS,
  applyTimeoutGuideline,
  executeWithDeadline,
  validateTimeout,
} from "../extensions/timeout-policy.ts";

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

test("default budget is 300s", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 300);
});

test("validateTimeout accepts a finite positive budget", () => {
  assert.equal(validateTimeout(300), 300);
  assert.equal(validateTimeout(0.05), 0.05);
});

test("validateTimeout rejects non-positive or oversized values", () => {
  assert.throws(() => validateTimeout(0), /Invalid timeout/);
  assert.throws(() => validateTimeout(-1), /Invalid timeout/);
  assert.throws(() => validateTimeout(Number.NaN), /Invalid timeout/);
  assert.throws(() => validateTimeout(MAX_TIMER_SECONDS + 1), /Invalid timeout/);
});

test("applyTimeoutGuideline appends once", () => {
  assert.equal(applyTimeoutGuideline(""), GUIDELINE);
  assert.equal(applyTimeoutGuideline("base prompt"), `base prompt\n\n${GUIDELINE}`);
  assert.equal(applyTimeoutGuideline(`base prompt\n\n${GUIDELINE}`), `base prompt\n\n${GUIDELINE}`);
});

test("executeWithDeadline returns when work finishes in budget", async () => {
  const result = await executeWithDeadline("grep", 1, undefined, async () => "ok");
  assert.equal(result, "ok");
});

test("executeWithDeadline times out when the child honors abort", async () => {
  await assert.rejects(
    () => executeWithDeadline("grep", 0.05, undefined, waitForAbort),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match(error.message, /grep timed out after 0\.05s/);
      return true;
    },
  );
});

test("executeWithDeadline preserves parent cancellation", async () => {
  const parent = new AbortController();
  const pending = executeWithDeadline("find", 1, parent.signal, waitForAbort);
  parent.abort(new Error("parent cancelled"));
  await assert.rejects(pending, /parent cancelled/);
});
