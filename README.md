# opencode-context-guard

An [OpenCode](https://opencode.ai) plugin that guards agent `read` operations, enforcing per-agent file read budgets to prevent context overflow. The plugin tracks which agent owns each session and blocks `read` calls whose estimated payload — a full file or a `limit`-sliced partial read — would exceed the agent's budget.

## Features

- Tracks the active agent per session via the `chat.params` hook.
- Enforces a small orchestrator read budget (5 KB by default) and a larger default budget for other agents (100 KB by default).
- Estimates partial-read payloads with an exact line count for small files and an O(1) 8 KB sample estimate for large files.
- Configurable via `opencode.jsonc` options, environment variables, and built-in defaults (in that precedence order).
- Zero runtime dependencies; executes natively as TypeScript under OpenCode's Bun-based plugin runtime.

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
      "orchestratorBudgetKB": 5,
      "defaultBudgetKB": 100
    }]
  ]
}
```

### Options

| Option                 | Type     | Default | Description                                                          |
| :--------------------- | :------- | :------ | :------------------------------------------------------------------- |
| `enabled`              | `boolean` | `true`  | Toggle guard enforcement.                                            |
| `orchestratorBudgetKB` | `number` | `5`     | Read budget (KB) for the `orchestrator` agent.                       |
| `defaultBudgetKB`      | `number` | `100`   | Read budget (KB) for all other agents.                               |

### Environment variables

| Variable                                          | Effect                                                          |
| :------------------------------------------------ | :-------------------------------------------------------------- |
| `OPENCODE_ORCHESTRATOR_CONTEXT_GUARD`             | Legacy enable flag: any value other than `0` or `false` enables the guard (kept for compatibility). |
| `OPENCODE_CONTEXT_GUARD_ORCHESTRATOR_BUDGET_KB`   | Positive integer KB — overrides `orchestratorBudgetKB`.         |
| `OPENCODE_CONTEXT_GUARD_DEFAULT_BUDGET_KB`        | Positive integer KB — overrides `defaultBudgetKB`.              |

### Precedence

1. `opencode.jsonc` options (highest)
2. Environment variables
3. Built-in defaults (lowest)

## How it works

On every `chat.params` event, the plugin records the agent for the session. On every `tool.execute.before` event for the `read` tool, the plugin:

1. Looks up the session's agent; unknown sessions pass through untouched.
2. Stats the target file with `Bun.file(filePath).stat()`.
3. For partial reads (`limit` set), estimates the payload size — exact line count for files under 1 MB, an 8 KB sample extrapolation for larger files (worst case: the whole file when the sample has no newlines).
4. Throws an `Error` when the estimated payload (or the whole file for full reads) exceeds the agent's budget, aborting the read.

## Development

```bash
bun install
bunx tsc --noEmit
```

## License

MIT
