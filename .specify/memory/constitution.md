<!--
Sync Impact Report:
- Version change: initial -> v1.0.0
- Ratification: 2026-08-20
- Added Principles:
  1. Sub-Agent Capacity Discipline
  2. Deterministic Two-Stage Lifecycle
  3. Extensible, Decoupled Whitelisting
  4. Transparent Capacity Visibility
  5. Minimalist Hierarchical Configuration
- Added Sections:
  - Core Principles
  - Architecture & Behavioral Boundaries
  - Governance & Evolution
- Deferred Items: None
-->

# Project Constitution: opencode-context-guard

## Metadata
- **Constitution Version**: `1.0.0`
- **Ratification Date**: `2026-08-20`
- **Last Amended Date**: `2026-08-20`
- **Status**: Ratified

---

## Core Principles

### Principle 1: Sub-Agent Capacity Discipline
Sub-agents MUST operate within bounded capacity constraints to prevent runaway execution and token exhaustion.
- Sub-agents MUST have explicit, configurable caps on cumulative tool invocations and ingested context tokens.
- Sub-agents MUST be guarded by default.
- Primary interactive agents (e.g. `build`, `orchestrator`) MUST remain unconstrained by default unless explicitly configured otherwise.
- *Rationale*: Unsupervised sub-agents can enter loops or ingest excessive file context, exhausting token budgets and polluting LLM context.

### Principle 2: Deterministic Two-Stage Lifecycle
Session capacity MUST be governed by a deterministic, one-way state machine transitioning from `execution` to `finalization`.
- Sessions MUST initialize in the `execution` stage where normal tool operations proceed within budget.
- When any configured limit (tool count or token volume) is breached, the session MUST transition to `finalization`.
- A session in `finalization` MUST NOT revert back to `execution`.
- *Rationale*: A simple two-stage state machine provides unambiguous boundaries and guarantees execution halts or narrows predictably.

### Principle 3: Extensible, Decoupled Whitelisting
The core guard MUST remain domain-agnostic and minimalistic, delegating specific handover workflows to extensible configuration profiles.
- In `finalization` stage, the guard MUST block all standard tools by default while respecting an optional whitelist of permitted tools and file paths.
- Complex handover protocols MUST NOT be hardcoded into the core plugin engine; they MUST be configured via finalization whitelists and prompt extensions.
- *Rationale*: Hardcoding agent-specific handover logic creates brittle, overfitted plugins. Decoupling whitelists allows the guard to scale cleanly across diverse agent setups.

### Principle 4: Transparent Capacity Visibility
Capacity status and transition events MUST be transparently communicated to the executing agent.
- The system MUST track cumulative tool count and ingested context tokens accurately per session.
- Tool interception errors upon exhaustion MUST provide clear diagnostic feedback identifying the breached limit and instructing the agent to conclude its task.
- *Rationale*: Agents need clear feedback when limits are reached so they can produce clean final summaries rather than repeatedly retrying blocked tools.

### Principle 5: Minimalist Hierarchical Configuration
Configuration MUST be hierarchical, predictable, and free of unnecessary bloat.
- The configuration schema MUST follow a clean hierarchy: global defaults -> per-agent overrides -> environment variable fallbacks.
- The plugin MUST rely only on standard platform hooks without introducing heavy external dependencies.
- *Rationale*: Lightweight, zero-overhead plugins maximize reliability and maintainability.

---

## Architecture & Behavioral Boundaries

- **Session Isolation**: All counters, stage states, and session metadata MUST be strictly isolated by `sessionID`.
- **Interception Mechanism**: Enforcement MUST occur deterministically at the plugin hook boundary (`tool.execute.before` / `tool.execute.after`).
- **Failure Safety**: If capacity estimation encounters an internal error, it MUST fail safely without silently bypassing configured hard caps.

---

## Governance & Evolution

- **Amendments**: Any change to Core Principles or Architecture Boundaries requires formal documentation and incrementation of the constitution version.
- **Versioning Policy**:
  - `MAJOR`: Redefinitions or removals of core principles, or backward-incompatible state-machine changes.
  - `MINOR`: New principles, expanded lifecycle stages, or significant new configuration capabilities.
  - `PATCH`: Clarifications, wording refinements, and formatting fixes.
- **Compliance**: All specifications (`specs/`), plans, and pull requests MUST comply with the principles established in this Constitution.
