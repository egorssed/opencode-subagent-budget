# AGENTS.md

## Purpose

`opencode-context-guard` limits configured subagents per session: tool calls and ingested context tokens are tracked, capacity status is shown to the agent, and exhausted sessions enter a restricted finalization stage.

## Current behavior

- Only agents with an explicit, enabled profile are guarded. Unconfigured, unnamed, and `enabled: false` agents are exempt.
- Status is injected into the system prompt and appended to successful tool results (except `todowrite`).
- `todo*` and `skill` never consume the tool-call budget; configured `whitelistedTools` also skip tool counting but still consume tokens.

## Code map

- `src/index.ts` — OpenCode hooks and capacity-status formatting.
- `src/config.ts` — defaults and config resolution.
- `src/core/state.ts` — session lifecycle, exemptions, finalization enforcement.
- `src/core/estimator.ts` — token, argument, patch-size, and output estimation.
- `test/guard.test.ts` — comprehensive test suite.

## Token counting

`estimateTokens` uses `gpt-tokenizer` BPE counts. Preserve its guards:

- Text above 128 KB is counted from a 128 KB prefix and extrapolated.
- A run over 2048 identical characters falls back to `ceil(length / 4)`; otherwise low-entropy input makes BPE counting pathologically slow and hangs the test suite.

## Verification

- `bun run typecheck`
- `bun run test` — preferred; runs Node's test runner in about 330 ms.
- `bun test` also passes, but is slower under Bun's JavaScriptCore.

## Editing constraints

- Test guard behavior with explicit local profiles; do not hard-code mutable default budgets or tool lists.
- Token fixtures use BPE counts (for example, `"a".repeat(400)` is 50 tokens).
- Do not edit `docs_opencode/`; it is synced upstream reference documentation.
