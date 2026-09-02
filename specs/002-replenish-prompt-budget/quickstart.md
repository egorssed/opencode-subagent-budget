# Quickstart: Validate Prompt Budget Replenishment

## Prerequisites

- Work from the `002-replenish-prompt-budget` feature state.
- Install project dependencies.
- Use an explicit local guarded-agent profile; do not rely on mutable default budgets.

## Configuration scenario

Configure one enabled guarded subagent profile with:

```json
{
  "replenishOnPrompt": true
}
```

Configure a second enabled guarded profile without this setting, or with it set to `false`.

## Validation scenarios

### 1. Opted-in follow-up receives a new allowance

1. Start the opted-in guarded subagent session.
2. Consume all or part of its configured tool/token allowance.
3. Send a follow-up prompt to the same subagent session.
4. Confirm it can consume its full configured allowance again.

Expected: the session's counters begin at zero for the follow-up and a prior exhausted/finalization condition no longer blocks execution.

### 2. Default behavior remains cumulative

1. Start the non-opted-in guarded subagent session.
2. Consume all or part of its configured allowance.
3. Send a follow-up prompt to the same session.

Expected: remaining allowance and any exhaustion condition are unchanged from existing cumulative-session behavior.

### 3. Exempt profile is unaffected

1. Use an unconfigured or disabled agent profile.
2. Send a new prompt to its session.

Expected: no guarded budget is created or reset.

## Automated verification

Run:

```sh
bun run typecheck
bun run test
```

Expected: both commands succeed; focused tests cover enabled reset, disabled/omitted no-reset, exhausted-state recovery, and exemption behavior.

## Scope reminder

A received `chat.message` is the reset boundary. This feature intentionally does not distinguish prompt origin, retries, or synthetic prompts.

## Review Record

The user accepted this validation guide in the final review on 2026-09-02.