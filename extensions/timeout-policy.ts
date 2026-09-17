export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMER_SECONDS = 2_147_483_647 / 1000;
export const GUIDELINE = `Foreground bash, grep, and find calls default to ${DEFAULT_TIMEOUT_SECONDS}s. Set timeout explicitly when a different execution budget is appropriate.`;

export function applyTimeoutGuideline(systemPrompt: string, guideline = GUIDELINE): string {
  if (systemPrompt.includes(guideline)) return systemPrompt;
  return systemPrompt.length > 0 ? `${systemPrompt}\n\n${guideline}` : guideline;
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
