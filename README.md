# opencode-context-guard

An [OpenCode](https://opencode.ai) plugin that guards sub-agent capacity, enforcing a lightweight, configurable, per-session capacity lifecycle. It tracks cumulative tool invocations and ingested context tokens per sub-agent session, surfaces live remaining-capacity feedback, and smoothly transitions exhausted sub-agents from an active `execution` stage to a controlled `finalization` stage where non-whitelisted tool usage is blocked so agents conclude their tasks cleanly.

## Features

- **Two-stage lifecycle**: sessions move one-way from `execution` to `finalization` when any limit is breached.
- **Dual-metric tracking**: cumulative tool invocations and estimated ingested context tokens, isolated per `sessionID`.
- **Primary-agent exemption**: `build`, `plan`, and `orchestrator` are unconstrained by default; per-agent overrides can assign custom budgets.
- **Finalization whitelist**: permit specific tools (and optionally specific file paths) once a budget is exhausted.
- **Transparent feedback**: interception errors explain which limit was hit, and live budget status is injected into the system prompt.
- **Hierarchical config**: global defaults → per-agent overrides → environment variables.
- **Zero runtime dependencies**: executes natively as TypeScript under OpenCode's Bun-based plugin runtime.

## Installation

### Local path (development)

Reference the package folder directly in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "file:/path/to/packages/opencode-context-guard"
  ]
}
```

### GitHub tag (recommended for distribution)

```jsonc
{
  "plugin": [
    "github:your-username/opencode-context-guard#v1.0.0"
  ]
}
```

### npm

```jsonc
{
  "plugin": [
    "opencode-context-guard"
  ]
}
```

## Configuration

The plugin accepts an optional options tuple in `opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["opencode-context-guard", {
      "enabled": true,
      "primaryAgents": ["build", "plan", "orchestrator"],
      "defaults": {
        "maxTools": 15,
        "maxTokens": 40000,
        "finalization": {
          "allowedTools": [],
          "allowedPaths": []
        }
      },
      "agents": {
        "code-reviewer": { "maxTools": 10, "maxTokens": 30000 },
        "writer": {
          "maxTools": 10,
          "maxTokens": 25000,
          "finalization": {
            "allowedTools": ["write", "edit"],
            "allowedPaths": ["./reports/**"]
          }
        }
      }
    }]
  ]
}
```

### Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Global toggle for capacity guarding. |
| `primaryAgents` | `string[]` | `["build", "plan", "orchestrator"]` | Agents exempt from capacity limits by default. |
| `defaults.maxTools` | `number` | `15` | Default maximum cumulative tool invocations. |
| `defaults.maxTokens` | `number` | `40000` | Default maximum ingested context tokens. |
| `defaults.finalization` | `object` | `{ "allowedTools": [], "allowedPaths": [] }` | Tools/paths permitted once in `finalization`. |
| `agents` | `object` | `{}` | Per-agent overrides: `enabled`, `maxTools`, `maxTokens`, `finalization`. |

### Environment variables

| Variable | Effect |
| :--- | :--- |
| `OPENCODE_CONTEXT_GUARD_ENABLED` | Overrides `enabled` (`true`/`false`). |
| `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS` | Overrides `defaults.maxTools` (accepts `Infinity` for unlimited). |
| `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS` | Overrides `defaults.maxTokens` (accepts `Infinity` for unlimited). |
| `OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS` | Comma-separated list overriding `primaryAgents`. |

### Precedence

1. `opencode.jsonc` options (highest)
2. Environment variables
3. Built-in defaults (lowest)

## How it works

- On `chat.params`, the plugin records the agent for the incoming session.
- On `tool.execute.before`, it records the attempt and — if the session has entered `finalization` — blocks any non-whitelisted tool call with a structured `CapacityLimitError`.
- On `tool.execute.after`, it accumulates the tool count and estimates ingested tokens (input args + output text, ~4 chars/token), transitioning the session to `finalization` when either limit is reached.
- Live budget status is injected into the system prompt via `experimental.chat.system.transform`.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
