# Tasks: Replenish Prompt Budget

**Feature**: `002-replenish-prompt-budget`
**Input**: `spec`, `research`, `data_model`, `plan`, and `quickstart`

## Phase 1: Setup

**Purpose**: Confirm the local hook contract before changing guard behavior.

- [ ] T001 Verify the locally installed `Plugin` type exposes `chat.message` and record its callable signature while preparing the hook edit in `src/index.ts`

---

## Phase 2: Foundational

**Purpose**: Add the opt-in configuration and reusable state transition required by every story.

- [ ] T002 Add optional per-agent `replenishOnPrompt` configuration and preserve explicit-profile override/default-false resolution in `src/types.ts` and `src/config.ts`
- [ ] T003 Add a session budget-period reset operation that restores execution state and clears all current tool/token, exhaustion, finalization, and token-baseline accounting in `src/core/state.ts`

**Checkpoint**: An opted-in profile can be resolved and its existing session state can be restored to a fresh budget period.

---

## Phase 3: User Story 1 - Refresh a continuing subagent's allowance (Priority: P1) 🎯 MVP

**Goal**: An opted-in guarded subagent receives a fresh configured allowance when its existing session receives a follow-up prompt.

**Independent Test**: With an explicit opted-in local profile, consume allowance or enter finalization, simulate a new prompt event for the same session, and verify execution resumes with fresh configured tool and token allowance.

- [ ] T004 [US1] Register `chat.message`, reuse existing session/agent exemption resolution, and reset only opted-in guarded sessions in `src/index.ts`
- [ ] T005 [US1] Add explicit-profile regression coverage for prompt-triggered tool/token reset and exhausted/finalization recovery in `test/guard.test.ts`

**Checkpoint**: User Story 1 is independently functional and testable.

---

## Phase 4: User Story 2 - Configure replenishment per guarded agent (Priority: P2)

**Goal**: Administrators can enable replenishment for one guarded agent without changing another agent's cumulative-session behavior.

**Independent Test**: Configure one explicitly opted-in agent and one omitted/false agent, deliver a prompt event to each existing session, and verify only the opted-in state is reset.

- [ ] T006 [US2] Add explicit multi-profile coverage proving omitted/false `replenishOnPrompt` remains cumulative while enabled profiles reset in `test/guard.test.ts`

**Checkpoint**: Both profile modes work independently with backward-compatible defaults.

---

## Phase 5: Polish & Cross-Cutting Validation

**Purpose**: Validate the local OpenCode contract and all feature behavior without modifying upstream reference documentation.

- [ ] T007 Run `bun run typecheck` and resolve feature-caused type failures in `src/index.ts`, `src/types.ts`, `src/config.ts`, and `src/core/state.ts`
- [ ] T008 Run `bun run test` and resolve feature-caused failures in `test/guard.test.ts`

---

## Dependencies & Execution Order

```text
T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008
```

- T001 is a hard gate: do not replace the requested hook if the local plugin type lacks `chat.message`.
- T002 and T003 are foundational; T004 requires both.
- User Story 1 (T004–T005) is the MVP.
- User Story 2 (T006) depends on the profile field from T002 and can be delivered after User Story 1.
- Validation tasks follow all implementation and test tasks.

## Parallel Opportunities

No safe parallel tasks are identified: the change is deliberately small, later tasks depend on the preceding contract/config/state changes, and both story test tasks modify `test/guard.test.ts`.

## Implementation Strategy

1. Complete T001–T003 to establish the supported hook, opt-in configuration, and reset primitive.
2. Complete T004–T005 and validate User Story 1 as the MVP.
3. Complete T006 to prove per-profile enablement and backward compatibility.
4. Complete T007–T008 as final verification.

## Format Validation

All 8 tasks use the required checklist format with a checkbox, sequential task ID, applicable story label, actionable description, and exact repository-relative file path(s).