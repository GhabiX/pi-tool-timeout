# pi-tool-timeout

Pi coding-agent extension: one timeout overlay for foreground execution.

> **No explicit budget -> 300s. Explicit budget -> honor it.**

Compatible with `@earendil-works/pi-coding-agent` `0.85.x`.

## Design

This package does not own tools. It overlays a single timeout policy onto whoever already owns them.

Pi 0.85.x has no wrap-current-tool API, so the overlay uses two adapters:

- **Native timeout** (`bash`, `powershell`): Pi already exposes `timeout`. A `tool_call` hook fills `300` only when it is omitted. The live implementation stays owner, so shell settings, renderers, spawn hooks, and other bash extensions keep working. The native schema still says there is no default; the model-visible correction is a per-tool guideline returned as `systemPrompt` from `before_agent_start` when that tool is selected.
- **Signal wrap** (`grep`, `find`): native schemas have no timeout field. On `session_start`, the overlay adds `timeout?: number`, wraps `execute` with a wall-clock deadline, then delegates to Pi's public factories. Registration happens after the default active set exists, and the previous active set is restored, so installing this package does **not** enable grep/find.

Explicit positive timeouts are preserved. Parent cancellation is not turned into a timeout.

No retry policy, command classification, background execution, UI, or configuration system.

The only technical upper bound is Node's timer limit (~24.8 days), matching Pi's native bash timer constraint.

Same-name extension tools are first-wins in Pi. This overlay wraps builtins when no earlier extension registered the same name. It cannot compose on top of an earlier same-name override.

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
npm run test:e2e
```

Requires Node `>=22.19.0`. `npm test` covers the overlay helpers. `npm run test:e2e` loads the extension through a local Pi 0.85.x install and exercises bash/grep/find timeouts against the native tools.

## License

Apache-2.0. See [LICENSE](LICENSE).
