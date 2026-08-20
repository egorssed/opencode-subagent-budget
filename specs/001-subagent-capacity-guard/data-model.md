# Data Model & State Transitions: Sub-Agent Capacity Guard

**Feature**: `subagent-capacity-guard`  
**Status**: Completed  
**Artifact**: `specs/001-subagent-capacity-guard/data-model.md`

---

## 1. Entities & Types

### 1.1 `SessionStage`
```typescript
export type SessionStage = "execution" | "finalization";
```

### 1.2 `ExhaustionReason`
```typescript
export type ExhaustionReason = "tool_limit" | "token_limit" | "manual";
```

### 1.3 `SessionGuardState`
Tracks real-time capacity and lifecycle for a single agent session.
```typescript
export interface SessionGuardState {
  sessionID: string;
  agentName: string;
  stage: SessionStage;
  toolCount: number;
  tokensIngested: number;
  exhaustionReason: ExhaustionReason | null;
  createdAt: number;
  lastActiveAt: number;
}
```

### 1.4 `FinalizationPolicy`
Rules governing permitted actions once in finalization.
```typescript
export interface FinalizationPolicy {
  allowedTools: string[];          // e.g. ["write", "edit"]
  allowedPaths?: string[];         // e.g. ["./reports/*", ".opencode/handover.md"]
}
```

### 1.5 `AgentCapacityProfile`
Configuration limits applied to a specific agent role.
```typescript
export interface AgentCapacityProfile {
  enabled?: boolean;
  maxTools?: number;               // Maximum cumulative tool executions
  maxTokens?: number;              // Maximum cumulative context tokens from tool outputs
  finalization?: Partial<FinalizationPolicy>;
}
```

### 1.6 `ContextGuardConfig`
Full resolved plugin configuration.
```typescript
export interface ContextGuardConfig {
  enabled: boolean;
  primaryAgents: string[];         // Agents exempt from capacity limits
  defaults: {
    maxTools: number;
    maxTokens: number;
    finalization: FinalizationPolicy;
  };
  agents: Record<string, AgentCapacityProfile>;
}
```

---

## 2. State Transition Diagram

```text
       ┌────────────────────────┐
       │ Session Initialized    │
       │ stage: "execution"     │
       │ toolCount: 0           │
       │ tokensIngested: 0      │
       └───────────┬────────────┘
                   │
                   │ tool.execute.before / tool.execute.after
                   ▼
       ┌────────────────────────┐
       │ In Execution Loop      │◄────────────────┐
       │ toolCount < maxTools   │                 │
       │ tokens < maxTokens     │ (tool execution │
       └───────────┬────────────┘  within budget) │
                   │                              │
                   │                              └─ Normal tool execution
                   │ (toolCount >= maxTools OR
                   │  tokens >= maxTokens)
                   ▼
       ┌────────────────────────┐
       │ Entered Finalization   │
       │ stage: "finalization"  │
       └───────────┬────────────┘
                   │
                   ├────────────────────────────────┐
                   │                                │
                   ▼                                ▼
       ┌────────────────────────┐       ┌────────────────────────┐
       │ Allowed Whitelisted    │       │ Non-Whitelisted Tool   │
       │ Tool / Path            │       │ Call Attempt           │
       │ (Proceeds)             │       │ (Throws Capacity Error)│
       └────────────────────────┘       └────────────────────────┘
```

---

## 3. Validation Rules

1. `maxTools`: Must be a positive integer > 0 (or `Infinity` if unconstrained).
2. `maxTokens`: Must be a positive integer > 0 (or `Infinity` if unconstrained).
3. Transitions: A session in `finalization` CANNOT transition back to `execution`.
4. Whitelist matching:
   - Tool check: `policy.allowedTools.includes(toolName)`
   - Path check: If `policy.allowedPaths` is specified and the tool has a `filePath` or `path` argument, the path must match at least one allowed path pattern.
