# Implementation Plan: Sub-Agent Capacity Guard

**Feature**: `subagent-capacity-guard`  
**Spec**: [spec.md](./spec.md)  
**Status**: In Progress (Phase 1: Design Complete)

---

## Technical Context

- **Platform & Host**: OpenCode Plugin Runtime (`@opencode-ai/plugin` >= 1.0.0, Bun/Node runtime).
- **Core Interceptors**:
  - `chat.params`: Capture session-to-agent mapping (`sessionID` -> `agent`).
  - `tool.execute.before`: State check before tool execution (enforce budget caps and finalization whitelists).
  - `tool.execute.after`: Accumulate ingested context volume and tool count after successful tool run.
  - `experimental.chat.system.transform`: (Optional/dynamic) inject capacity feedback or status headers into system prompt context if needed.
- **Language & Tooling**: TypeScript (ESM), strict type-checking (`tsc --noEmit`).
- **Dependencies**: `@opencode-ai/plugin` as peer dependency, zero runtime dependencies.

---

## Constitution Compliance Check

| Principle | Compliance Assessment | Status |
|---|---|---|
| **P1: Sub-Agent Capacity Discipline** | Sub-agents are guarded by default with tool call & token limits; primary agents (`build`, `orchestrator`) are unconstrained by default. | **PASS** |
| **P2: Deterministic Two-Stage Lifecycle** | State machine models one-way transition: `execution` -> `finalization`. Once in finalization, normal tools remain blocked. | **PASS** |
| **P3: Extensible, Decoupled Whitelisting** | Finalization allows configurable tool/path whitelists without embedding hardcoded handover protocols in core plugin logic. | **PASS** |
| **P4: Transparent Capacity Visibility** | Interception feedback surfaces clear breach details (metric exceeded, current stats, required actions). | **PASS** |
| **P5: Minimalist Hierarchical Configuration** | Configuration layers defaults -> per-agent overrides -> environment variable fallbacks without external runtime dependencies. | **PASS** |

---

## Gates & Unknowns Evaluation

- **Gate 1: State Machine Determinism**: Does the two-stage model cleanly separate execution and finalization without race conditions in parallel tool calls? -> *Yes, state is kept in-memory per `sessionID` with atomic step increments.*
- **Gate 2: Token Estimation Accuracy**: Is text character conversion (~4 chars/token) sufficient for guarding runaway context? -> *Yes, lightweight estimation avoids heavy tokenizer dependencies while providing robust safety margins.*
- **Gate 3: Whitelist Matching**: Does whitelist path matching avoid edge cases? -> *Yes, normalized path matching and string tool name matching.*

---

## Phases & Deliverables

- [x] **Phase 0: Research & Architecture Decisions** ([research.md](./research.md))
  - State machine design and hook integration.
  - Token estimation formula and payload extraction.
  - Hierarchical configuration resolution.
- [x] **Phase 1: Design & Interface Contracts**
  - Data Model ([data-model.md](./data-model.md))
  - Configuration & Hook Contract ([contracts/plugin-options.md](./contracts/plugin-options.md))
  - Validation & Quickstart Guide ([quickstart.md](./quickstart.md))
- [ ] **Phase 2: Implementation** (Core state machine, estimator, config resolver, plugin server hooks, test suite)
