# Feature Specification: Replenish Prompt Budget

**Feature Branch**: `002-replenish-prompt-budget`

**Created**: 2026-09-02

**Status**: Draft

**Input**: User description: "Add an optional per-agent `replenishOnPrompt` flag so configured guarded subagents receive a fresh budget when a new prompt is received in their existing session."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refresh a continuing subagent's allowance (Priority: P1)

A plugin administrator enables prompt replenishment for a guarded subagent. When the orchestrator sends a follow-up prompt to that same subagent session, the subagent receives its configured budget again and can continue working.

**Why this priority**: This provides the requested continuation behavior while preserving the existing per-session guard for agents that do not opt in.

**Independent Test**: Configure one guarded agent with prompt replenishment, exhaust its allowance, send a follow-up prompt to its existing session, and verify that it may use its configured allowance again.

**Acceptance Scenarios**:

1. **Given** a guarded subagent with prompt replenishment enabled has exhausted its allowance, **When** it receives a new follow-up prompt in its existing session, **Then** its allowance is restored to its configured initial amount before it handles the prompt.
2. **Given** a guarded subagent with prompt replenishment enabled has used part of its allowance, **When** it receives a new follow-up prompt in its existing session, **Then** its new allowance starts at the configured initial amount rather than the remaining amount from the earlier prompt.
3. **Given** a guarded subagent without prompt replenishment enabled, **When** it receives a follow-up prompt in its existing session, **Then** its allowance remains governed by the existing cumulative session behavior.

---

### User Story 2 - Configure replenishment per guarded agent (Priority: P2)

A plugin administrator can choose prompt replenishment independently for each configured guarded agent.

**Why this priority**: Administrators need to retain restrictive cumulative budgets for some agents while allowing iterative work for others.

**Independent Test**: Configure two guarded agents with different replenishment settings and verify that only the opted-in agent receives a fresh allowance after a follow-up prompt.

**Acceptance Scenarios**:

1. **Given** two guarded agents have different prompt-replenishment settings, **When** each receives a follow-up prompt, **Then** only the agent with the setting enabled receives a fresh allowance.
2. **Given** an existing configuration does not specify prompt replenishment, **When** it is loaded, **Then** its observed budget behavior remains unchanged.

### Edge Cases

- A new prompt received by an opted-in guarded subagent restores its allowance even if the prior allowance was already exhausted.
- Prompt replenishment is not applied to agents that are unconfigured, disabled, or otherwise exempt from guarding.
- This feature deliberately does not attempt to infer, deduplicate, or reject unusual prompt origins beyond the receipt of a new prompt in the guarded subagent session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support an optional boolean prompt-replenishment setting on each configured agent profile.
- **FR-002**: The setting MUST default to disabled when it is absent, preserving existing cumulative session budget behavior.
- **FR-003**: When the setting is enabled for a guarded subagent, the system MUST restore that subagent's configured tool and token allowances when it receives a new prompt in its existing session.
- **FR-004**: Restoring an allowance MUST clear the budget-exhausted condition for that subagent so it can begin handling the new prompt under the configured allowance.
- **FR-005**: The restored allowance MUST be independent of all budget usage associated with earlier prompts in that session.
- **FR-006**: The system MUST apply prompt replenishment only to guarded, enabled agent profiles that explicitly enable the setting.
- **FR-007**: The system MUST leave all existing guard behavior unchanged for profiles without the setting enabled.

### Key Entities *(include if feature involves data)*

- **Agent budget profile**: The administrator-configured allowance and prompt-replenishment preference for one agent.
- **Guarded subagent session**: A continuing subagent work context whose budget usage is tracked.
- **Prompt allowance period**: The budget usage interval beginning when a new prompt is received and ending immediately before the next received prompt in the same session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated checks, 100% of follow-up prompts delivered to an opted-in guarded subagent restore both its tool and token allowance before the subagent handles the prompt.
- **SC-002**: In automated checks, 100% of configured agents without prompt replenishment retain their prior cumulative-session behavior after a follow-up prompt.
- **SC-003**: An administrator can enable or omit the setting for an individual guarded agent with no changes required to any other agent profile.
- **SC-004**: Existing configuration fixtures that omit the setting continue to load and pass their existing budget-behavior checks.

## Assumptions

- A newly received prompt in an existing guarded subagent session is the intended boundary for a fresh allowance.
- The feature is opt-in on a per-agent basis and is disabled by default.
- The feature intentionally uses no special handling for retries, synthetic prompts, or prompt-origin attribution beyond the stated prompt boundary.
- The existing configured tool and token limits define the amount restored for each new prompt allowance period.
