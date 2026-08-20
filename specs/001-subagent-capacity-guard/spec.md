# Feature Specification: Sub-Agent Capacity Guard

**Feature Name**: `subagent-capacity-guard`  
**Status**: Draft  
**Target Directory**: `specs/001-subagent-capacity-guard`

---

## 1. Overview & Purpose

Automated sub-agents executing complex workflows risk running unchecked, exhausting LLM context windows, and burning excessive tool execution cycles. The Sub-Agent Capacity Guard enforces a lightweight, configurable, per-session capacity lifecycle for sub-agents. 

It tracks cumulative tool executions and context token consumption across each sub-agent's session, exposes real-time remaining capacity feedback to the agent, and smoothly transitions exhausted sub-agents from an active `execution` stage to a controlled `finalization` stage where non-essential tool usage is restricted and agents conclude their tasks cleanly.

---

## 2. User Scenarios & Acceptance Flows

### Scenario 1: Sub-Agent Pacing and Successful Completion Within Budget
- **Given** a sub-agent session with a configured limit of 10 tool calls and 32,000 ingested context tokens,
- **When** the sub-agent executes tools (such as reading files or searching code),
- **Then** the sub-agent receives transparent visibility into remaining tool calls and token budget, and completes its task within limits without entering finalization.

### Scenario 2: Tool Count Exhaustion Triggers Finalization
- **Given** a sub-agent session with a limit of 5 tool calls,
- **When** the sub-agent attempts a 6th non-whitelisted tool execution,
- **Then** the tool execution is intercepted and blocked with a structured notification that capacity has been exhausted and the session has entered the `finalization` stage, prompting the agent to produce its concluding report or handover.

### Scenario 3: Context Token Exhaustion Triggers Finalization
- **Given** a sub-agent session with an ingested context token limit of 20,000 tokens,
- **When** tool responses accumulate context data exceeding the 20,000 token threshold,
- **Then** subsequent normal tool invocations are blocked, transitioning the session state to `finalization`.

### Scenario 4: Whitelisted Finalization Operations
- **Given** a sub-agent in `finalization` stage configured with a whitelist permitting specific file write/edit operations (e.g. at a designated report path),
- **When** the sub-agent invokes an allowed whitelisted tool targeting the permitted path,
- **Then** the operation succeeds, while any other unauthorized tool call remains strictly blocked.

### Scenario 5: Primary Agent Exemption and Agent Overrides
- **Given** a primary agent (e.g., orchestrator or interactive build agent) and specialized sub-agents with custom configured budgets,
- **When** the primary agent operates,
- **Then** it operates without capacity restrictions by default, while each sub-agent adheres strictly to its specific override or default capacity limits.

---

## 3. Functional Requirements

### Requirement 1: Two-Stage Session Lifecycle State Machine
- **1.1**: The system must maintain an explicit per-session state machine consisting of two distinct stages: `execution` and `finalization`.
- **1.2**: New sub-agent sessions must initialize in the `execution` stage.
- **1.3**: When any active budget metric (tool count or ingested context tokens) reaches or exceeds configured limits, the session must automatically transition to `finalization`.
- **1.4**: Once transitioned to `finalization`, a session cannot revert back to `execution`.

### Requirement 2: Dual-Metric Capacity Tracking
- **2.1**: The system must track the exact cumulative count of successful and attempted tool invocations per session.
- **2.2**: The system must track cumulative context volume (estimated context tokens) ingested from tool outputs and payload data within the session.
- **2.3**: Capacity metrics must be isolated per session ID to prevent cross-session contamination.

### Requirement 3: Agent Capacity Visibility & Feedback
- **3.1**: The system must provide current budget status (tools used/remaining, tokens consumed/remaining, and current stage) to the agent during execution.
- **3.2**: When budget capacity is exhausted, tool interception errors must provide actionable context: stating that the budget was exceeded, indicating which metric triggered the limit, and instructing the agent to conclude its response.

### Requirement 4: Finalization Stage Enforcement & Whitelisting
- **4.1**: In `finalization` stage, all standard tool invocations must be blocked by default.
- **4.2**: The system must support an optional whitelist configuration allowing specific tools (and optionally specific target file paths or arguments) during the `finalization` stage.
- **4.3**: Non-whitelisted operations attempted during `finalization` must be rejected with informative feedback.

### Requirement 5: Hierarchical & Minimalist Configuration
- **5.1**: The configuration schema must provide global default thresholds:
  - `defaultMaxTools` (integer, maximum allowed tool calls)
  - `defaultMaxTokens` (integer, maximum allowed ingested context tokens)
  - `defaultFinalization` (whitelisted tools and paths)
- **5.2**: The configuration must allow per-agent overrides specifying customized limits, custom finalization whitelists, or complete exclusion/inclusion flags.
- **5.3**: Primary agents must be unconstrained by default unless explicitly configured otherwise.
- **5.4**: Configuration values must accept environment variable fallbacks for seamless CI and deployment overrides.

---

## 4. Key Entities & Data Model

- **Session Guard State**:
  - `sessionID`: Unique identifier for the agent session.
  - `agentName`: Identifier/role of the executing agent.
  - `stage`: Current stage (`execution` | `finalization`).
  - `toolCount`: Number of tool calls executed in this session.
  - `tokensIngested`: Cumulative estimated tokens consumed by tool responses.
  - `exhaustionReason`: Reason for entering finalization (`tool_limit` | `token_limit` | `null`).

- **Capacity Guard Configuration**:
  - `enabled`: Global toggle for capacity guarding.
  - `defaults`: Default limits applied to guarded agents (`maxTools`, `maxTokens`, `finalizationWhitelist`).
  - `agents`: Map of agent names to specific overrides (`maxTools`, `maxTokens`, `enabled`, `finalizationWhitelist`).
  - `primaryAgents`: Set of agent names treated as unconstrained primary agents.

- **Finalization Whitelist Policy**:
  - `allowedTools`: List of tool names permitted during finalization (e.g. `["write", "edit"]`).
  - `allowedPaths`: Optional list of regexes or glob path prefixes where allowed file modifications may take place during finalization.

---

## 5. Success Criteria

- **SC-1 (Enforcement Precision)**: 100% of tool invocations exceeding configured tool limits or token thresholds are intercepted and prevented from executing unauthorized operations.
- **SC-2 (Transparent Transition)**: 100% of intercepted tool attempts during finalization provide clear feedback identifying the exhausted threshold and required finalization actions.
- **SC-3 (Config Flexibility)**: Capacity thresholds, per-agent overrides, and finalization whitelists can be configured without modifying core plugin code.
- **SC-4 (Zero Primary Disruption)**: Primary interactive agent workflows remain 100% unaffected unless explicit limits are assigned to them.
- **SC-5 (Performance & Overhead)**: Budget evaluation and state tracking add negligible latency (<1ms) to tool execution interceptors.

---

## 6. Assumptions & Non-Goals

### Assumptions
- Sub-agents operate in distinct session IDs mapped to specific agent definitions.
- Estimating token counts from tool output text length (e.g., standard ~4 characters per token ratio) provides sufficient precision for guarding runaway context ingestion.
- Sub-agents can conclude their tasks using text summarization once tools are blocked.

### Non-Goals
- Built-in multi-agent orchestration or task dispatching (handled by OpenCode or external orchestration plugins).
- Permanent file system sandboxing or OS-level security sandboxing (handled by permission configurations).
- Complex multi-stage workflow graphs (the guard strictly manages the 2-stage `execution` -> `finalization` capacity lifecycle).
