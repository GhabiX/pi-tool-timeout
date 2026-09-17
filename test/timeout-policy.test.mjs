import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMER_SECONDS,
  applyNativeTimeoutGuidelines,
  applyTimeoutGuideline,
  executeWithDeadline,
  schemaHasTimeout,
  toolTimeoutGuideline,
  validateTimeout,
  withTimeoutDescription,
  withTimeoutOverlay,
  withToolGuideline,
  wrapExecuteWithTimeout,
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

test("guidelines are per-tool and append once", () => {
  const bash = toolTimeoutGuideline("bash");
  assert.match(bash, /bash calls default to 300s/);
  assert.equal(applyTimeoutGuideline("", bash), bash);
  assert.equal(applyTimeoutGuideline("base prompt", bash), `base prompt\n\n${bash}`);
  assert.equal(applyTimeoutGuideline(`base prompt\n\n${bash}`, bash), `base prompt\n\n${bash}`);
});

test("native guidelines only attach for selected shell tools", () => {
  const bash = toolTimeoutGuideline("bash");
  const powershell = toolTimeoutGuideline("powershell");
  assert.equal(applyNativeTimeoutGuidelines("base", ["grep", "find"]), "base");
  assert.equal(applyNativeTimeoutGuidelines("base", ["bash"]), `base\n\n${bash}`);
  assert.equal(
    applyNativeTimeoutGuidelines("base", ["bash", "powershell"]),
    `base\n\n${bash}\n\n${powershell}`,
  );
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

test("wrapExecuteWithTimeout fills omitted timeout for native tools", async () => {
  const seen = [];
  const execute = async (_id, params, signal) => {
    seen.push({ params, signal });
    return "ok";
  };
  const wrapped = wrapExecuteWithTimeout("bash", true, execute);
  assert.equal(await wrapped("id", { command: "true" }, undefined, undefined, {}), "ok");
  assert.equal(seen[0].params.timeout, 300);
  assert.equal(await wrapped("id", { command: "true", timeout: 12 }, "sig", undefined, {}), "ok");
  assert.equal(seen[1].params.timeout, 12);
  assert.equal(seen[1].signal, "sig");
});

test("wrapExecuteWithTimeout strips timeout and enforces a deadline for signal tools", async () => {
  const seen = [];
  const wrapped = wrapExecuteWithTimeout("grep", false, async (_id, params, signal) => {
    seen.push(params);
    return waitForAbort(signal);
  });
  await assert.rejects(
    () => wrapped("id", { pattern: "x", timeout: 0.05 }, undefined, undefined, {}),
    /grep timed out after 0\.05s/,
  );
  assert.deepEqual(seen[0], { pattern: "x" });
});

test("withTimeoutOverlay adds timeout without becoming a new tool", async () => {
  const overlayed = withTimeoutOverlay({
    name: "grep",
    description: "Search files",
    parameters: { properties: { pattern: { type: "string" } }, required: ["pattern"] },
    promptGuidelines: ["Use grep for content search."],
    async execute(_id, params) {
      return params;
    },
  });

  assert.equal(schemaHasTimeout(overlayed.parameters), true);
  assert.match(overlayed.description, /300s timeout/);
  assert.deepEqual(overlayed.promptGuidelines, [
    "Use grep for content search.",
    toolTimeoutGuideline("grep"),
  ]);
  assert.deepEqual(await overlayed.execute("id", { pattern: "x" }), { pattern: "x" });
  assert.equal(withTimeoutDescription(overlayed.description), overlayed.description);
  assert.deepEqual(
    withToolGuideline(overlayed.promptGuidelines, toolTimeoutGuideline("grep")),
    overlayed.promptGuidelines,
  );
});
