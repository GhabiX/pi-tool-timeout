import {
  createFindToolDefinition,
  createGrepToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_SECONDS,
  GUIDELINE,
  MAX_TIMER_SECONDS,
  applyTimeoutGuideline,
  executeWithDeadline,
  validateTimeout,
} from "./timeout-policy.ts";

function timeoutParameter() {
  return Type.Optional(
    Type.Number({
      description: `Wall-clock timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}; explicit values are honored)`,
      exclusiveMinimum: 0,
      maximum: MAX_TIMER_SECONDS,
    }),
  );
}

export default function toolTimeout(pi: ExtensionAPI) {
  // Bash already exposes timeout. Patch only the missing default so the active
  // bash implementation (including shell settings / other extensions) stays owner.
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && event.input.timeout === undefined) {
      event.input.timeout = DEFAULT_TIMEOUT_SECONDS;
    }
  });

  const baseCwd = process.cwd();
  const grep = createGrepToolDefinition(baseCwd);
  const find = createFindToolDefinition(baseCwd);
  const grepParameters = Type.Object({ ...grep.parameters.properties, timeout: timeoutParameter() });
  const findParameters = Type.Object({ ...find.parameters.properties, timeout: timeoutParameter() });

  // grep/find need overrides only because their native schemas expose no timeout.
  // Everything else, including rendering and search semantics, is delegated.
  pi.registerTool({
    ...grep,
    description: `${grep.description} Searches default to a ${DEFAULT_TIMEOUT_SECONDS}s timeout; set timeout explicitly for intentionally long scans.`,
    parameters: grepParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { timeout: requestedTimeout, ...grepParams } = params;
      const timeout = validateTimeout(requestedTimeout ?? DEFAULT_TIMEOUT_SECONDS);
      return executeWithDeadline("grep", timeout, signal, (deadlineSignal) =>
        createGrepToolDefinition(ctx.cwd).execute(toolCallId, grepParams, deadlineSignal, onUpdate, ctx),
      );
    },
  });

  pi.registerTool({
    ...find,
    description: `${find.description} Searches default to a ${DEFAULT_TIMEOUT_SECONDS}s timeout; set timeout explicitly for intentionally long scans.`,
    parameters: findParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { timeout: requestedTimeout, ...findParams } = params;
      const timeout = validateTimeout(requestedTimeout ?? DEFAULT_TIMEOUT_SECONDS);
      return executeWithDeadline("find", timeout, signal, (deadlineSignal) =>
        createFindToolDefinition(ctx.cwd).execute(toolCallId, findParams, deadlineSignal, onUpdate, ctx),
      );
    },
  });

  // Pi only applies before_agent_start results that return `systemPrompt`.
  // Mutating promptGuidelines alone does not rebuild the model-visible prompt.
  pi.on("before_agent_start", (event) => {
    const guidelines = (event.systemPromptOptions.promptGuidelines ??= []);
    if (!guidelines.includes(GUIDELINE)) guidelines.push(GUIDELINE);
    const systemPrompt = applyTimeoutGuideline(event.systemPrompt);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}

export {
  DEFAULT_TIMEOUT_SECONDS,
  GUIDELINE,
  applyTimeoutGuideline,
  executeWithDeadline,
  validateTimeout,
};
