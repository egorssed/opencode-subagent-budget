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
        "code-reviewer": {
          "maxTools": 10,
          "maxTokens": 30000,
          "whitelistedTools": ["lsp"]
        },
        "writer": {
          "maxTools": 10,
          "maxTokens": 25000,
          "whitelistedTools": ["context7*"],
          "finalizationRemaining": 2,
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
| `agents` | `object` | `{}` | Per-agent overrides: `enabled`, `maxTools`, `maxTokens`, `finalization`, `whitelistedTools`, `finalizationRemaining`. |
| `agents.<name>.whitelistedTools` | `string[]` | unset | Tool-name patterns that do not count toward `maxTools`. Each entry matches a tool exactly, or as a prefix when it ends with `*` (e.g. `context7*`). Tool names starting with `todo` and the exact `skill` tool are always non-counting. |
| `agents.<name>.finalizationRemaining` | `number` | unset | Positive integer of paid finalization invocations. When unset (or zero), the legacy behavior applies: the transition is at `maxTools` and finalization calls are unlimited. |

### Baked-in agent budgets

When no options are provided, the plugin enforces the following per-agent budgets (mirroring the reference `AGENT_RESTRICTION_TABLE`):

| Agent | `maxTools` | `maxTokens` | `finalization.allowedTools` | `whitelistedTools` | `finalizationRemaining` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `web-researcher` | 9 | 24000 | — | — | — |
| `unbiased-collector` | 14 | 48000 | — | — | — |
| `file-explorer` | 15 | 50000 | — | `lsp` | — |
| `hoare-spec-formalizer` | 4 | 10000 | — | — | — |
| `hoare-checks` | 10 | 18000 | — | — | — |
| `hoare-planner` | 4 | 12000 | — | — | — |
| `hoare-plan-verifier` | 5 | 12000 | — | — | — |
| `hoare-impl-verifier` | 12 | 24000 | — | — | — |
| `code-reviewer` | 12 | 18000 | — | `lsp` | — |
| `security-reviewer` | 14 | 24000 | — | `lsp` | — |
| `planner` | 15 | 18000 | `write`, `edit`, `apply_patch` | `lsp` | 2 |
| `doc-writer` | 10 | 10000 | `write`, `edit`, `apply_patch` | `lsp` | 2 |
| `coder` | 24 | 48000 | `write`, `edit`, `apply_patch` | `context7*`, `task`, `lsp` | 3 |
| `test-builder` | 1 | 4000 | — | — | — |

Explicit tuple options override the baked budgets per field: e.g. `agents.coder { "maxTools": 5 }` lowers `maxTools` to 5 while `maxTokens` stays 48000. Agents not in the table keep using `defaults`.

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
- On `tool.execute.before`, it records the attempt and — if the session has entered `finalization` — blocks any tool not permitted by `finalization.allowedTools`/`allowedPaths` with a structured `CapacityLimitError`.
- On `tool.execute.after`, it accumulates the tool count and estimates ingested tokens (input args + output text, ~4 chars/token), transitioning the session to `finalization` when either limit is reached.
- Live budget status is injected into the system prompt via `experimental.chat.system.transform`.

### Counting whitelist (`whitelistedTools`)

- Tool names starting with `todo` and the exact `skill` tool never count toward the budget, regardless of configuration.
- Each configured entry matches a tool name exactly, or as a prefix when the entry ends with `*` (e.g. `context7*` matches `context7_resolve-library-id`).
- A successful whitelisted call still consumes tokens and is recorded as a success (advice, status, and token totals include it) — only its `toolCount` contribution is zero.
- The whitelist affects counting only; it does not grant any permission and is unrelated to `finalization.allowedTools`.

### Finalization budget (`finalizationRemaining`)

- Profiles without a positive `finalizationRemaining` retain the legacy behavior: the transition happens when cumulative `toolCount` reaches `maxTools` (or on token exhaustion), and finalization-stage calls permitted by `finalization.allowedTools`/`allowedPaths` are unlimited.
- With `finalizationRemaining` set to `R`, the transition happens once the non-finalization budget is exhausted: `toolCount >= maxTools - R` or token exhaustion, whichever comes first.
- After the transition, only `finalization.allowedTools`/`allowedPaths` calls pass; each successful finalization call consumes one unit of `R`, regardless of whether its tool is in the counting whitelist. When `R` is spent, the session is locked.
- One-time handover exception: during finalization, a single successful `write`/`edit`/`apply_patch` call targeting the session's own `Handovers/SCRATCH_<agent>_<sessionID>.md` file (exact path or any path ending in `/` + that filename) bypasses the finalization restrictions exactly once. Ordinary accounting still applies to it (tokens and success counting), it does not consume `finalizationToolsUsed`, and block messages and status advice advertise the remaining handover until it is consumed. Handovers are per-session state only — no templating, persistence across restarts, or generation of files.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
