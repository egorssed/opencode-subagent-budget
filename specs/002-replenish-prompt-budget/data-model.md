# Minimal Change Design: Replenish Prompt Budget

**Feature**: `002-replenish-prompt-budget`
**Status**: Approved

## Preconditions

- Each guarded subagent has a `SessionGuardState` keyed by `sessionID` in `SessionStateManager`.
- The state includes execution/finalization stage, tool count, token usage and baselines, exhaustion reason, and finalization-tool usage.
- Existing `getOrCreateSession` preserves the session state for the session lifetime.
- An agent is guarded only when its resolved profile exists and is enabled; other profiles are exempt.
- The plugin has access to OpenCode's `chat.message` hook with the receiving `sessionID`.

## Postconditions

- A profile may declare `replenishOnPrompt: true`.
- When `chat.message` is received for an opted-in guarded subagent session, that session begins a new budget period before the prompt is handled.
- The new budget period has zero consumed tools and tokens, no exhaustion reason, no finalization-tool use, and execution stage.
- Profiles without `replenishOnPrompt: true` retain the existing cumulative per-session behavior.
- Existing enabled/exempt profile behavior is unchanged.

## Integration points

| Component | Existing contract | Minimal change |
|---|---|---|
| `src/types.ts` | Defines resolved agent-profile and guard-state shapes. | Add optional `replenishOnPrompt` to the agent-profile configuration type. Do not add persistent state beyond existing resettable fields. |
| `src/config.ts` | Resolves baked defaults and explicit agent overrides. | Preserve `replenishOnPrompt` when supplied by an explicit profile; absent means false. Reference defaults remain unchanged unless explicitly configured. |
| `src/core/state.ts` | Owns state initialization, accounting, exhaustion, and stage transition. | Add one reset operation accepting `sessionID`, which restores all budget-period fields to their initialized execution values while retaining session identity, agent identity, creation metadata, and the resolved profile relationship. |
| `src/index.ts` | Registers hooks and maps session IDs to agent names. | Register `chat.message`; resolve the received `sessionID` with the existing agent/session and exemption/profile logic; if and only if the resolved profile enables replenishment, invoke the reset operation. |
| `test/guard.test.ts` | Verifies explicit-profile budget behavior. | Add focused tests for enabled reset, disabled/omitted no-reset, tool/token counter reset, and recovery from exhausted/finalization state. |

## Smallest sufficient addition

1. Add `replenishOnPrompt?: boolean` to the per-agent profile schema/type and resolved configuration contract; treat any value other than explicit `true` as disabled.
2. Add `SessionStateManager.resetBudgetForPrompt(sessionID)` (final spelling is a local choice) that resets only per-period accounting/lifecycle values:
   - `toolCount`
   - all token counters and baselines used by accounting
   - `exhaustionReason`
   - `finalizationToolsUsed`
   - `stage` to `execution`
   - `lastActiveAt` to the reset time
3. Preserve immutable identity and registration values: `sessionID`, `agentName`, subagent classification, `createdAt`, and cached planning state unless existing accounting establishes that it is per-period.
4. In `chat.message`, do no prompt-content analysis. Locate the relevant guarded session/profile, then call the reset operation only for an opted-in profile.
5. Continue using existing tool hooks and assistant-message accounting unchanged after reset.

## Decision boundaries

| Local decision | Constraint and evidence | Boundary |
|---|---|---|
| Where the new profile field is declared | Configuration is already resolved through the package's type/config layer. | Follow the existing optional-profile-field pattern; no global switch or baked-default modification. |
| Exact reset field list | State fields are consumed by accounting and finalization. | Reset every field that measures current-period consumption or blocks execution; retain identity and configuration-derived fields. Validate this with a state-focused test. |
| Session-to-agent lookup in `chat.message` | Existing hooks already maintain session-agent mapping and perform subagent/exemption checks. | Reuse the existing helper/path rather than introducing a separate classification cache or new OpenCode API call unless the current helper is unavailable in this hook. |
| Hook typing | The installed plugin package governs supported hooks. | Typecheck against the local dependency. If `chat.message` is unavailable, stop the implementation rather than replace the requested hook. |
| No edge-case policy | User explicitly requested no brittle edge handling. | Do not inspect prompt text, origin, retry identity, or synthetic flags. Every received `chat.message` in an opted-in guarded session is a reset boundary. |

## Validation design

- Explicit opted-in profile: consume allowance, simulate `chat.message`, then verify configured tool and token allowance is available again.
- Explicit non-opted-in profile: simulate the same event and verify counters/exhaustion remain cumulative.
- Exhausted/finalization state: simulate the event and verify normal execution is restored.
- Exempt/unconfigured profile: simulate the event and verify no guard state is created or reset.
- Run `bun run typecheck` and `bun run test` after the focused tests pass.

## Design review record

The minimal design was accepted in the batched review and approved in plain text on 2026-09-02.