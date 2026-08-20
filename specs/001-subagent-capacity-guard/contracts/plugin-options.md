# Contract Specification: Plugin Options & Interception Protocol

**Feature**: `subagent-capacity-guard`  
**Status**: Completed  
**Artifact**: `specs/001-subagent-capacity-guard/contracts/plugin-options.md`

---

## 1. Plugin Configuration Schema (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-context-guard",
      {
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
          "explore": {
            "maxTools": 20,
            "maxTokens": 50000
          },
          "code-reviewer": {
            "maxTools": 10,
            "maxTokens": 30000
          },
          "writer": {
            "maxTools": 10,
            "maxTokens": 25000,
            "finalization": {
              "allowedTools": ["write", "edit"],
              "allowedPaths": ["./docs/**", "./reports/**"]
            }
          }
        }
      }
    ]
  ]
}
```

---

## 2. Capacity Breach Error Contract

When a sub-agent exhausts its budget and attempts a non-whitelisted tool call in `finalization`, the plugin intercepts the call at `tool.execute.before` and throws an error with the following message format:

```text
[Capacity Guard] Session limit reached for agent "@<agentName>".
Current stage: FINALIZATION
Limit exceeded: <tool_limit | token_limit> (Used: <X>/<MaxTools> tools, <Y>/<MaxTokens> tokens).
Action required: Tool execution is restricted in finalization stage. Please summarize your findings, provide your final report, or complete task handover in your text response.
```

---

## 3. Environment Variable Fallbacks

| Environment Variable | Target Configuration Key | Default Value |
|---|---|---|
| `OPENCODE_CONTEXT_GUARD_ENABLED` | `enabled` | `true` |
| `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS` | `defaults.maxTools` | `15` |
| `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS` | `defaults.maxTokens` | `40000` |
| `OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS` | `primaryAgents` | `"build,plan,orchestrator"` |
