# Implementation Tasks: Sub-Agent Capacity Guard

**Feature**: `subagent-capacity-guard`  
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)  
**Status**: Ready for Implementation

---

## Task Summary & Sizing Proxy

Each task is scoped as a substantial, self-contained development module designed for execution within 1–2 coder agent turns (budgeted at ~25 tool calls and ~40,000 context tokens each).

- **Total Tasks**: 6
- **MVP Scope**: Phase 1 through Phase 4 (T001–T005)

---

## Phase 1: Setup & Data Model Types

- [ ] T001 Implement Core Capacity Types and Data Model Interfaces in `src/types.ts`
  - Define `SessionStage` (`"execution"` | `"finalization"`), `ExhaustionReason`, and `SessionGuardState`.
  - Define `FinalizationPolicy`, `AgentCapacityProfile`, `ContextGuardOptions`, and `ResolvedContextGuardConfig`.
  - Export all shared contracts and Bun/Node environment declarations.

---

## Phase 2: Foundational Configuration & Estimation

- [ ] T002 [P] Implement Hierarchical Configuration Resolver and Environment Parsers in `src/config.ts`
  - Implement `DEFAULT_CONFIG` with default thresholds (`maxTools: 15`, `maxTokens: 40000`, primary agents `["build", "plan", "orchestrator"]`).
  - Implement environment variable readers (`OPENCODE_CONTEXT_GUARD_*`) for CI/deployment overrides.
  - Implement `resolveConfig(options?: PluginOptions): ResolvedContextGuardConfig` supporting global defaults, primary agent exemption list, and per-agent override mapping.

- [ ] T003 [P] Implement Context Token & Payload Estimator in `src/core/estimator.ts`
  - Implement fast character/byte-to-token converter (~4 chars per token) for tool output text.
  - Implement payload inspection helper extracting text content from string or structured tool outputs (`output.output`).
  - Provide fallback estimation for read tool file size checks if needed.

---

## Phase 3: User Story 1 & 3 — Session State Machine & Finalization Whitelist

- [ ] T004 [US1] Implement Session Capacity State Manager and Lifecycle Transitions in `src/core/state.ts`
  - Implement `SessionStateManager` class managing per-session guard states.
  - Implement session initialization (`getOrCreateSession(sessionID, agentName, config)`).
  - Implement metric accumulation (`recordToolExecution(sessionID, outputText)`).
  - Implement transition logic: check thresholds and advance stage to `"finalization"` when limits are reached.
  - Implement whitelist validator (`isOperationPermittedInFinalization(sessionID, toolName, args, config)`): check tool name whitelist and target file path restrictions.
  - Expose diagnostic getters for remaining tool and token budget.

---

## Phase 4: User Story 2 & 4 — Plugin Server Hooks & Interception Feedback

- [ ] T005 [US2] Integrate Plugin Server Hooks and Interception Protocol in `src/index.ts`
  - Export `server: Plugin` adhering to `@opencode-ai/plugin` interface.
  - Implement `chat.params` hook to register active agent name for incoming `sessionID`.
  - Implement `tool.execute.before` hook:
    - Check if executing agent is an exempt primary agent (bypass if unconstrained).
    - If session is in `finalization`, evaluate whitelist via state manager; throw formatted diagnostic `CapacityLimitError` if non-whitelisted.
  - Implement `tool.execute.after` hook:
    - Accumulate tool count and ingested output tokens in `SessionStateManager`.
    - Automatically advance stage to `finalization` upon threshold breach.

---

## Phase 5: Polish & Test Verification

- [ ] T006 Create Comprehensive Unit Tests and Type-Check Verification in `test/guard.test.ts`
  - Write test suite using Node/Bun test runner covering:
    - Configuration resolution with hierarchical defaults, per-agent overrides, and env variables.
    - Token estimation calculation accuracy.
    - State machine lifecycle transitions (`execution` -> `finalization`).
    - Tool count and token threshold boundary enforcement.
    - Finalization whitelist tool and path filtering.
    - Primary agent exemption bypassing.
  - Update `package.json` test scripts and verify clean TypeScript type-checking (`npm run typecheck`).

---

## Dependency & Execution Order

```text
       ┌──────────────┐
       │     T001     │ (src/types.ts)
       └──────┬───────┘
              │
       ┌──────┴───────┐
       │              │
       ▼              ▼
 ┌───────────┐  ┌───────────┐
 │   T002    │  │   T003    │ (src/config.ts & src/core/estimator.ts) [Parallel]
 └─────┬─────┘  └─────┬─────┘
       │              │
       └──────┬───────┘
              ▼
       ┌─────────────┐
       │    T004     │ (src/core/state.ts - State Machine & Whitelisting)
       └──────┬──────┘
              ▼
       ┌─────────────┐
       │    T005     │ (src/index.ts - Plugin Hooks & Interception)
       └──────┬──────┘
              ▼
       ┌─────────────┐
       │    T006     │ (test/guard.test.ts & Typecheck)
       └─────────────┘
```

---

## Parallel Execution Opportunities

- **T002** (`src/config.ts`) and **T003** (`src/core/estimator.ts`) can be executed completely in parallel once **T001** (`src/types.ts`) is completed.
