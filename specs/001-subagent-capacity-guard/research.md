# Research & Architectural Decisions: Sub-Agent Capacity Guard

**Feature**: `subagent-capacity-guard`  
**Status**: Completed  
**Artifact**: `specs/001-subagent-capacity-guard/research.md`

---

## 1. State Machine & Hook Lifecycle Architecture

### Decision
Implement an in-memory session state manager storing `SessionState` indexed by `sessionID`:
- Stages: `execution` | `finalization`.
- Counters: `toolCount: number`, `tokensIngested: number`.
- Transition triggers:
  - When `toolCount >= maxTools` OR `tokensIngested >= maxTokens`, transition to `finalization`.
  - In `tool.execute.before`:
    - If stage is `execution`: check if about to exceed tool limit (if hard cap on calls) or already breached; allow execution.
    - If stage is `finalization`: check if requested tool and target path match the configured `finalization.allowedTools` and `finalization.allowedPaths`. If not matched, throw a descriptive `CapacityLimitError`.
  - In `tool.execute.after`:
    - Increment `toolCount`.
    - Estimate token count from `output.output` and add to `tokensIngested`.
    - If `tokensIngested >= maxTokens` or `toolCount >= maxTools`, set stage to `finalization`.

### Rationale
- Decoupling pre-execution authorization from post-execution metric accumulation ensures tools that fail before executing don't unfairly consume tool budget, while successful tool outputs are immediately counted against context limits.
- Throwing a structured error in `tool.execute.before` prevents execution while communicating clearly to the LLM agent that its capacity is spent.

### Alternatives Considered
- *Single-stage immediate abort*: Terminating the process or session on threshold breach. Rejected because it prevents the agent from providing a final summary or delivering handover notes.
- *LLM system prompt mutation only without tool blocking*: Advisory warnings without hard interception. Rejected because sub-agents frequently ignore advisory warnings and continue looping.

---

## 2. Ingested Context & Token Estimation

### Decision
Use lightweight character/byte estimation (~4 characters per token for string outputs, or byte length / 4) to estimate tokens added by tool outputs (`output.output` from `tool.execute.after`).

### Rationale
- Eliminates heavy tokenizer WASM / C-bindings (e.g. `tiktoken`), preserving instant startup and zero external dependencies.
- A 4:1 character-to-token ratio provides consistent protection against runaway tool responses (e.g., dumping large log files or hundreds of lines of code).

### Alternatives Considered
- *Full Tiktoken BPE tokenizer*: Exact token counting. Rejected due to bundle size, native binary compilation issues across platforms, and unnecessary CPU overhead for simple bounding.
- *Byte size counting only (KB)*: Rejected because token count is the standard mental model for LLM context limits across OpenCode configurations.

---

## 3. Configuration Hierarchy & Primary Agent Exemptions

### Decision
Support a 3-tier configuration hierarchy:
1. **Global Defaults**: `defaults: { maxTools: 15, maxTokens: 40000, finalization: { allowedTools: [] } }`
2. **Per-Agent Overrides**: `agents: { [agentName]: { maxTools?: number, maxTokens?: number, enabled?: boolean, finalization?: { allowedTools?: string[], allowedPaths?: string[] } } }`
3. **Primary Agent Exemption List**: `primaryAgents: ["build", "plan", "orchestrator"]` (defaulting to unconstrained mode).
4. **Environment Variables**:
   - `OPENCODE_CONTEXT_GUARD_ENABLED`
   - `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS`
   - `OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS`

### Rationale
- Allows subagents (like `@explore`, `@general`, `@code-reviewer`, `@scout`) to be protected by default while ensuring the user's interactive primary chat sessions (`build`, `plan`, `orchestrator`) are not abruptly blocked.
- Individual subagents with heavy needs (e.g., deep refactoring agents) can easily be assigned higher limits.
