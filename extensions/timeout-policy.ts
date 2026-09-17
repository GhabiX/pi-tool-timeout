export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMER_SECONDS = 2_147_483_647 / 1000;

export const NATIVE_TIMEOUT_TOOLS = ["bash", "powershell"] as const;
export const WRAPPED_TIMEOUT_TOOLS = ["grep", "find"] as const;

export const TIMEOUT_PARAMETER_DESCRIPTION =
  `Wall-clock timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}; explicit values are honored)`;

export type NativeTimeoutTool = (typeof NATIVE_TIMEOUT_TOOLS)[number];
export type WrappedTimeoutTool = (typeof WRAPPED_TIMEOUT_TOOLS)[number];

export function toolTimeoutGuideline(toolName: string): string {
  return `${toolName} calls default to ${DEFAULT_TIMEOUT_SECONDS}s. Set timeout explicitly when a different execution budget is appropriate.`;
}

export function isNativeTimeoutTool(toolName: string): toolName is NativeTimeoutTool {
  return (NATIVE_TIMEOUT_TOOLS as readonly string[]).includes(toolName);
}

export function schemaHasTimeout(parameters: { properties?: Record<string, unknown> } | undefined): boolean {
  return parameters?.properties != null && Object.hasOwn(parameters.properties, "timeout");
}

export function withTimeoutDescription(description: string, defaultSeconds = DEFAULT_TIMEOUT_SECONDS): string {
  const marker = `${defaultSeconds}s timeout`;
  if (description.includes(marker)) return description;
  return `${description} Defaults to a ${defaultSeconds}s timeout; set timeout explicitly for intentionally long work.`;
}

export function withToolGuideline(guidelines: readonly string[] | undefined, guideline: string): string[] {
  const current = guidelines ?? [];
  return current.includes(guideline) ? [...current] : [...current, guideline];
}

export function withTimeoutSchema<T extends { properties?: Record<string, unknown>; required?: string[] }>(
  parameters: T | undefined,
) {
  const properties = { ...(parameters?.properties ?? {}), timeout: timeoutParameterSchema() };
  const required = Array.isArray(parameters?.required)
    ? parameters.required.filter((name) => name !== "timeout")
    : parameters?.required;
  return { ...parameters, type: "object" as const, properties, required };
}

export function timeoutParameterSchema() {
  return {
    type: "number" as const,
    description: TIMEOUT_PARAMETER_DESCRIPTION,
    exclusiveMinimum: 0,
    maximum: MAX_TIMER_SECONDS,
  };
}

export function applyTimeoutGuideline(systemPrompt: string, guideline: string): string {
  if (systemPrompt.includes(guideline)) return systemPrompt;
  return systemPrompt.length > 0 ? `${systemPrompt}\n\n${guideline}` : guideline;
}

export function applyNativeTimeoutGuidelines(systemPrompt: string, selectedTools: readonly string[] = []): string {
  let next = systemPrompt;
  for (const toolName of NATIVE_TIMEOUT_TOOLS) {
    if (selectedTools.includes(toolName)) {
      next = applyTimeoutGuideline(next, toolTimeoutGuideline(toolName));
    }
  }
  return next;
}

export function validateTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMER_SECONDS) {
    throw new Error(`Invalid timeout: expected 0 < seconds <= ${MAX_TIMER_SECONDS}`);
  }
  return timeout;
}

export async function executeWithDeadline<T>(
  toolName: string,
  timeout: number,
  parentSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${toolName} timed out after ${timeout}s`));
  }, timeout * 1000);

  try {
    return await execute(controller.signal);
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      throw new Error(`${toolName} timed out after ${timeout}s`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function wrapExecuteWithTimeout<TExecute extends (...args: any[]) => Promise<unknown>>(
  toolName: string,
  nativeTimeout: boolean,
  execute: TExecute,
): TExecute {
  const wrapped = async (
    toolCallId: unknown,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => {
    const timeout = validateTimeout((params?.timeout as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS);
    if (nativeTimeout) {
      return execute(toolCallId, { ...params, timeout }, signal, onUpdate, ctx);
    }
    const { timeout: _ignored, ...rest } = params ?? {};
    return executeWithDeadline(toolName, timeout, signal, (deadlineSignal) =>
      execute(toolCallId, rest, deadlineSignal, onUpdate, ctx),
    );
  };
  return wrapped as TExecute;
}

export function withTimeoutOverlay<T extends {
  name: string;
  description: string;
  parameters?: { properties?: Record<string, unknown> };
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<unknown>;
}>(definition: T, parameters?: T["parameters"]): T {
  const nativeTimeout = schemaHasTimeout(definition.parameters);
  const guideline = toolTimeoutGuideline(definition.name);
  return {
    ...definition,
    description: withTimeoutDescription(definition.description),
    parameters: parameters ?? withTimeoutSchema(definition.parameters),
    promptGuidelines: withToolGuideline(definition.promptGuidelines, guideline),
    execute: wrapExecuteWithTimeout(definition.name, nativeTimeout, definition.execute),
  };
}
