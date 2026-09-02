# Implementation Plan: Replenish Prompt Budget

**Feature**: `002-replenish-prompt-budget`
**Specification**: `spec.md`
**Research**: `research.md`
**Design**: `data-model.md`

## Summary

Add an opt-in per-agent `replenishOnPrompt` setting. For an opted-in guarded subagent, every `chat.message` event for its existing session starts a fresh tool/token budget period. Profiles that omit the flag remain cumulative for the full session.

## Technical Context

- Package: `opencode-context-guard`
- Runtime/language: TypeScript plugin for OpenCode
- State key: OpenCode `sessionID`
- Required lifecycle integration: `chat.message`
- Existing accounting integrations: `chat.params`, tool hooks, and assistant message events
- Validation commands: `bun run typecheck`; `bun run test`
- Dependency constraint: implementation must typecheck against the locally installed `@opencode-ai/plugin` hook contract.

## Constitution Check

The current constitution artifact is a placeholder template and provides no enforceable project-specific principles. Repository guidance remains binding: use explicit local profiles in tests, do not hard-code mutable defaults/tool lists, and do not edit `docs_opencode/`.

## Project Structure

```text
src/
├── config.ts          # profile resolution
├── index.ts           # OpenCode hook integration
├── types.ts           # configuration and state contracts
└── core/state.ts      # session accounting and lifecycle

test/
└── guard.test.ts      # explicit-profile guard behavior
```

## Implementation Steps

1. Inspect the local `Plugin` hook type and current profile/state type declarations to confirm the exact `chat.message` signature and all state fields that represent a budget period.
2. Extend the per-agent configuration contract with optional `replenishOnPrompt`; ensure missing values resolve to disabled and preserve baked defaults/explicit override behavior.
3. Add one state-manager reset operation for a session's budget period. Reset current tool/token accounting, token baselines, exhaustion reason, finalization-tool usage, and lifecycle stage to execution. Retain session identity, agent identity, creation metadata, subagent classification, and configuration/cached planning metadata.
4. Register `chat.message` in `src/index.ts`. Resolve the event session using existing session-agent and exemption/profile behavior. If the profile is guarded, enabled, and has `replenishOnPrompt === true`, invoke the reset operation. Do not inspect message content or add origin/retry/synthetic filtering.
5. Add focused tests using explicit local profiles:
   - opted-in profile receives a fresh allowance after a new prompt event;
   - omitted/false setting retains cumulative state;
   - a reset exits exhausted/finalization state;
   - exempt or unconfigured profiles are unaffected.
6. Run typecheck and the package test suite. Fix only regressions directly caused by this feature.

## Design Decisions

- **Opt-in only**: backward compatibility requires absent `replenishOnPrompt` to be false.
- **Event boundary**: every `chat.message` received for an opted-in guarded session is a new allowance boundary.
- **No heuristic handling**: no prompt-source proof, content comparison, retry deduplication, or synthetic-message policy will be introduced.
- **State reset, not recreation**: follow-up task prompts retain session identity; only period accounting and blocking lifecycle state are reset.
- **No OpenCode changes**: use the supported plugin hook surface and halt if local types do not expose the required hook.

## Validation Plan

| Scenario | Expected result |
|---|---|
| Opted-in guarded session has consumed tools/tokens | A new `chat.message` resets consumption before subsequent guard checks. |
| Opted-in session is finalized/exhausted | A new `chat.message` restores execution-stage access with its configured allowance. |
| Profile omits or disables the flag | A new `chat.message` does not alter cumulative counters or lifecycle. |
| Profile is disabled/unconfigured | The event does not create or alter guarded budget state. |
| Existing suite | All existing guard tests remain green with no mutable-default assumptions added. |

## Complexity Tracking

No complexity exception: this is a contained config field, state transition, hook registration, and focused test change. No new dependency, storage model, or cross-service integration is required.

## Plan Review Record

The user accepted this plan and quickstart in the final review on 2026-09-02.