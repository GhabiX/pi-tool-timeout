# pi-tool-timeout

Pi coding-agent extension: one policy for foreground execution.

> **No explicit budget -> 300s. Explicit budget -> honor it.**

Applied to Pi's built-in `bash`, `grep`, and `find` tools.

Compatible with `@earendil-works/pi-coding-agent` `0.85.x`.

## Design

- `bash`: **not overridden**. Pi already exposes `timeout`; a `tool_call` hook fills `300` only when it is omitted. This keeps the active bash implementation, shell settings, renderers, and other bash extensions in control.
- `grep` / `find`: thin same-name overrides only because Pi's native schemas have no timeout field. The overrides add `timeout?: number`, create a wall-clock deadline, then delegate execution and rendering to Pi's native implementations.
- Explicit positive timeouts are preserved unchanged.
- Parent cancellation propagates normally.
- No retry policy, command classification, background execution, UI, configuration system, or arbitrary policy max.

The only technical upper bound is Node's timer limit (~24.8 days), matching Pi's native bash timer constraint.

Native bash still documents `timeout` as optional with no default. This extension does not replace that schema. It injects a model-visible guideline by returning `systemPrompt` from `before_agent_start` (Pi 0.85.x only applies that return value; mutating `promptGuidelines` alone is not enough).

## Install

Local path:

```bash
pi install /absolute/path/to/pi-tool-timeout
```

Project-local:

```bash
pi install -l /absolute/path/to/pi-tool-timeout
```

Git:

```bash
pi install git:github.com/GhabiX/pi-tool-timeout
```

Then restart Pi or run `/reload`.

## Semantics

```text
bash(command="rg foo .")                     -> 300s
bash(command="cargo test", timeout=600)     -> 600s
grep(pattern="foo", path=".")               -> 300s
grep(pattern="foo", path=".", timeout=600) -> 600s
find(pattern="*.rs", path=".")              -> 300s
```

Use a separate background-terminal tool for servers, watchers, and genuinely long-lived work.

## Develop

```bash
npm test
```

Requires Node `>=22.19.0`. Tests cover the timeout policy helpers only; grep/find still delegate to Pi at runtime.

## License

Apache-2.0. See [LICENSE](LICENSE).
