# Research Record: Replenish Prompt Budget

**Feature**: `002-replenish-prompt-budget`
**Date**: 2026-09-02
**Status**: Approved

## Required outcome

Add an opt-in boolean `replenishOnPrompt` to an explicit guarded-agent profile. When a new prompt is received in an opted-in guarded subagent's existing session, its configured tool and token allowance begins again. Profiles that omit the flag retain the current cumulative session budget.

## Evidence-backed findings

| Finding | Source and authority | Consequence |
|---|---|---|
| Guard state is created and retained by `sessionID`; it starts with zero tool and token use and an execution stage. Existing sessions are returned without reset. | Local implementation, `src/core/state.ts:230-268` — binding implementation evidence. | Replenishment requires an explicit state-manager reset operation; creating a new session is neither necessary nor desired. |
| Finalization is one-way in current state handling; it is entered on a budget threshold and not exited. | Local implementation, `src/core/state.ts:557-576` — binding implementation evidence. | Reset must explicitly restore execution-stage state and clear exhaustion/finalization bookkeeping. |
| The current plugin registers `chat.params`, tool hooks, event handling, and system transformation; it does not register `chat.message`. | Local implementation, `src/index.ts:55-167` — binding implementation evidence. | The feature adds one hook integration without replacing the existing accounting hooks. |
| Guard activation is controlled by an explicit enabled agent profile; absent or disabled profiles are exempt. | Local implementation, `src/core/state.ts:303-311` — binding behavior. | The reset path must use the same profile/exemption decision as existing budget accounting. |
| `chat.message` is an OpenCode plugin hook called when a new user message is received. | Upstream OpenCode plugin interface, `packages/plugin/src/index.ts` on `anomalyco/opencode` dev — descriptive external API evidence. | It is the intended lifecycle boundary for prompt replenishment. |
| OpenCode's prompt flow triggers `chat.message` from user-message creation before message persistence. | Upstream OpenCode, `packages/opencode/src/session/prompt.ts` — descriptive external implementation evidence. | The reset can occur before the new prompt is handled and therefore before new allowance consumption. |
| OpenCode's task tool accepts `task_id`, loads that existing subagent session, and dispatches the new prompt into the same session with a fresh message ID. | Upstream OpenCode, `packages/opencode/src/tool/task.ts` — descriptive external implementation evidence. | The hook receives the existing child `sessionID` for orchestrator follow-ups, which is exactly the local state key. |
| Continued work caused by tool-loop activity does not create a new user message; it is handled through tool activity and message updates. | Upstream OpenCode, `packages/opencode/src/session/prompt.ts` — descriptive external implementation evidence. | Ordinary tool execution does not cause a reset. |
| The peer dependency is `@opencode-ai/plugin >=1.0.0`. | Local `package.json` — binding dependency declaration. | Hook types must be validated against the installed plugin API; the upstream dev branch is not a version guarantee. |

## Relevant interfaces and conventions

- Config profiles are resolved in `src/config.ts`; explicit agent profiles override baked reference defaults per field.
- State and lifecycle behavior live in `src/core/state.ts`.
- Plugin hooks and session-to-agent bookkeeping live in `src/index.ts`.
- Guard behavior is covered in `test/guard.test.ts`.
- Existing project verification commands are `bun run typecheck` and `bun run test`.
- Tests must use explicit local profiles and must not hard-code mutable defaults or tool lists.

## Accepted decisions

- Use `chat.message` and its `sessionID` directly as the prompt boundary.
- Do not build origin attribution, deduplication, retry, or synthetic-message handling.
- Restore configured tool and token allowances and clear the exhausted/finalization condition.
- Make `replenishOnPrompt` opt-in and default it to `false`.
- Apply only to enabled, non-exempt guarded profiles.
- Confirm the local plugin type exposes `chat.message`; do not substitute another lifecycle event if it does not.

## Scope boundary

In scope: the profile boolean, `chat.message`-driven reset for opted-in guarded subagent sessions, and focused regression coverage.

Out of scope: proving prompt origin, changing OpenCode, reset quotas, prompt-content inspection, deduplication, and special handling for unusual prompt sources or retries.

## Evidence review record

Evidence and the minimal scope were accepted in the batched review and approved in plain text on 2026-09-02.