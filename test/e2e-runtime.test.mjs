import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const PLUGIN = join(import.meta.dirname, "..");

function resolvePiIndex() {
  const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  return join(dirname(realpathSync(piBin)), "..", "index.js");
}

const PI_INDEX = pathToFileURL(resolvePiIndex()).href;
const pi = await import(PI_INDEX);
const policy = await import(pathToFileURL(join(PLUGIN, "extensions/timeout-policy.ts")).href);

function schemaProperties(schema) {
  return schema?.properties ?? {};
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadPlugin() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-timeout-load-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  return pi.discoverAndLoadExtensions(
    [join(PLUGIN, "extensions/tool-timeout.ts")],
    cwd,
    agentDir,
  );
}

async function createIsolatedSession() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-timeout-e2e-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "needle.txt"), "alpha-timeout-token\n");

  const settingsManager = pi.SettingsManager.inMemory({ packages: [await realpath(PLUGIN)] });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(),
    modelRuntime: await pi.ModelRuntime.create(),
    tools: ["bash", "grep", "find"],
  });
  return { cwd, session, extensions: resourceLoader.getExtensions() };
}

test("Pi jiti loader registers grep/find timeout overrides without replacing bash", async () => {
  const loaded = await loadPlugin();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);

  const ext = loaded.extensions[0];
  assert.deepEqual([...ext.tools.keys()].sort(), ["find", "grep"]);
  assert.equal(ext.handlers.has("tool_call"), true);
  assert.equal(ext.handlers.has("before_agent_start"), true);

  const grep = ext.tools.get("grep").definition;
  const find = ext.tools.get("find").definition;
  assert.equal(schemaProperties(grep.parameters).timeout.type, "number");
  assert.equal(schemaProperties(find.parameters).timeout.type, "number");
  assert.match(grep.description, /300s timeout/);
  assert.match(find.description, /300s timeout/);
});

test("tool_call fills bash default 300 and preserves explicit values", async () => {
  const loaded = await loadPlugin();
  const handler = loaded.extensions[0].handlers.get("tool_call")[0];

  const omitted = { command: "true" };
  await handler({ toolName: "bash", input: omitted });
  assert.equal(omitted.timeout, 300);

  const explicit = { command: "true", timeout: 12 };
  await handler({ toolName: "bash", input: explicit });
  assert.equal(explicit.timeout, 12);

  const grepInput = { pattern: "x" };
  await handler({ toolName: "grep", input: grepInput });
  assert.equal(grepInput.timeout, undefined);
});

test("before_agent_start returns systemPrompt because Pi 0.85.x ignores promptGuidelines mutation", async () => {
  const loaded = await loadPlugin();
  const handler = loaded.extensions[0].handlers.get("before_agent_start")[0];
  const event = { systemPrompt: "base prompt", systemPromptOptions: {} };
  const result = await handler(event);

  assert.equal(result.systemPrompt, `base prompt\n\n${policy.GUIDELINE}`);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, [policy.GUIDELINE]);

  const second = await handler({
    systemPrompt: result.systemPrompt,
    systemPromptOptions: event.systemPromptOptions,
  });
  assert.equal(second, undefined);
});

test("isolated Pi session loads the package and executes bash/grep/find timeouts", async () => {
  const { cwd, session, extensions } = await createIsolatedSession();
  try {
    assert.deepEqual(extensions.errors, []);
    assert.equal(
      extensions.extensions.some((ext) => String(ext.path).includes("tool-timeout")),
      true,
    );

    const active = session.getActiveToolNames();
    for (const name of ["bash", "grep", "find"]) assert.equal(active.includes(name), true);

    const bashDef = session.getToolDefinition("bash");
    const grepDef = session.getToolDefinition("grep");
    const findDef = session.getToolDefinition("find");
    assert.match(JSON.stringify(schemaProperties(bashDef.parameters).timeout), /no default timeout/);
    assert.equal(schemaProperties(grepDef.parameters).timeout.type, "number");
    assert.equal(schemaProperties(findDef.parameters).timeout.type, "number");
    assert.match(grepDef.description, /300s timeout/);
    assert.match(findDef.description, /300s timeout/);
    assert.deepEqual(Object.keys(schemaProperties(grepDef.parameters)), [
      "pattern",
      "path",
      "glob",
      "ignoreCase",
      "literal",
      "context",
      "limit",
      "timeout",
    ]);

    const injected = await session._extensionRunner.emitBeforeAgentStart(
      "probe",
      undefined,
      session.systemPrompt ?? "base",
      { cwd, promptGuidelines: [] },
    );
    assert.equal(injected.systemPrompt.includes(policy.GUIDELINE), true);

    const bashTool = session._toolRegistry.get("bash");
    const grepTool = session._toolRegistry.get("grep");
    const findTool = session._toolRegistry.get("find");

    const omitted = { command: "echo ok-timeout" };
    const block = await session.agent.beforeToolCall({
      toolCall: { name: "bash", id: "bash-default" },
      args: omitted,
    });
    assert.equal(block, undefined);
    assert.equal(omitted.timeout, 300);

    const bashOk = await withTimeout(
      bashTool.execute("bash-ok", { command: "echo ok-timeout", timeout: 2 }),
      5000,
      "bash success",
    );
    assert.match(JSON.stringify(bashOk), /ok-timeout/);

    const bashTimeoutStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        bashTool.execute("bash-to", { command: "sleep 5", timeout: 0.4 }),
        5000,
        "bash timeout",
      ),
      /timed out after 0\.4 seconds/,
    );
    const bashTimeoutMs = Date.now() - bashTimeoutStart;
    assert.ok(bashTimeoutMs >= 300 && bashTimeoutMs < 2500, `bash timeout ms=${bashTimeoutMs}`);

    const grepOk = await withTimeout(
      grepTool.execute("grep-ok", { pattern: "alpha-timeout-token", path: cwd }),
      5000,
      "grep default timeout success",
    );
    assert.match(JSON.stringify(grepOk), /alpha-timeout-token/);

    const findOk = await withTimeout(
      findTool.execute("find-ok", { pattern: "needle.txt", path: cwd, timeout: 5 }),
      5000,
      "find success",
    );
    assert.match(JSON.stringify(findOk), /needle.txt/);

    const grepHangStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        grepTool.execute("grep-hang", { pattern: "nomatch", path: "/dev/zero", timeout: 0.4 }),
        5000,
        "grep hang",
      ),
      /grep timed out after 0\.4s/,
    );
    const grepHangMs = Date.now() - grepHangStart;
    assert.ok(grepHangMs < 2500, `grep hang ms=${grepHangMs}`);

    const parent = new AbortController();
    const pending = grepTool.execute(
      "grep-parent",
      { pattern: "nomatch", path: "/dev/zero", timeout: 5 },
      parent.signal,
    );
    setTimeout(() => parent.abort(new Error("parent cancelled")), 150);
    await assert.rejects(() => withTimeout(pending, 5000, "grep parent cancel"), (error) => {
      assert.equal(/timed out/i.test(error.message), false);
      assert.match(error.message, /aborted/i);
      return true;
    });

    const findHangStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        findTool.execute("find-hang", {
          pattern: "zzz-pi-tool-timeout-no-such-file",
          path: "/data",
          timeout: 0.1,
        }),
        5000,
        "find hang",
      ),
      /find timed out after 0\.1s/,
    );
    const findHangMs = Date.now() - findHangStart;
    assert.ok(findHangMs < 2500, `find hang ms=${findHangMs}`);

    await assert.rejects(
      () => grepTool.execute("grep-invalid", { pattern: "x", path: cwd, timeout: 0 }),
      /Invalid timeout/,
    );
  } finally {
    session.dispose?.();
  }
});
