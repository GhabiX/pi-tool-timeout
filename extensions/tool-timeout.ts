import {
  createFindToolDefinition,
  createGrepToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMER_SECONDS,
  TIMEOUT_PARAMETER_DESCRIPTION,
  WRAPPED_TIMEOUT_TOOLS,
  applyNativeTimeoutGuidelines,
  isNativeTimeoutTool,
  withTimeoutOverlay,
} from "./timeout-policy.ts";

const WRAP_FACTORIES = {
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
} as const;

function timeoutParameter() {
  return Type.Optional(
    Type.Number({
      description: TIMEOUT_PARAMETER_DESCRIPTION,
      exclusiveMinimum: 0,
      maximum: MAX_TIMER_SECONDS,
    }),
  );
}

function overlayBuiltIn<T extends { parameters: { properties?: Record<string, unknown> } }>(definition: T) {
  return withTimeoutOverlay(
    definition,
    Type.Object({
      ...(definition.parameters.properties ?? {}),
      timeout: timeoutParameter(),
    }),
  );
}

function installOverlays(pi: ExtensionAPI, cwd: string) {
  const known = new Set(pi.getAllTools().map((tool) => tool.name));
  const active = pi.getActiveTools();
  for (const name of WRAPPED_TIMEOUT_TOOLS) {
    if (!known.has(name)) continue;
    pi.registerTool(overlayBuiltIn(WRAP_FACTORIES[name](cwd)));
  }
  pi.setActiveTools(active);
}

export default function toolTimeout(pi: ExtensionAPI) {
  // Native-timeout tools already own execution (shell settings, spawn hooks,
  // other bash extensions). Only fill the omitted default.
  pi.on("tool_call", (event) => {
    if (isNativeTimeoutTool(event.toolName) && event.input.timeout === undefined) {
      event.input.timeout = DEFAULT_TIMEOUT_SECONDS;
    }
  });

  // Register same-name overlays after the default active set exists so this
  // package never enables grep/find. Overlay never changes enablement.
  pi.on("session_start", (_event, ctx) => {
    installOverlays(pi, ctx.cwd);
  });

  // bash/powershell keep their live schema, so the model-visible default has to
  // be returned as systemPrompt. grep/find guidelines live on the overlayed
  // tool definitions and are included by Pi only when those tools are active.
  pi.on("before_agent_start", (event) => {
    const selectedTools = event.systemPromptOptions.selectedTools ?? [];
    const systemPrompt = applyNativeTimeoutGuidelines(event.systemPrompt, selectedTools);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}

export {
  DEFAULT_TIMEOUT_SECONDS,
  applyNativeTimeoutGuidelines,
  isNativeTimeoutTool,
  withTimeoutOverlay,
};
