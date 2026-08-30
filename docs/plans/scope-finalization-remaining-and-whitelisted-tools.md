# Plan: finalization remaining and non-counting whitelisted tools

## Problem summary

Port the authoritative scope's per-agent non-counting tool whitelist, bounded finalization calls, and one-time handover escape hatch while preserving all existing behavior for profiles that do not opt in.

## Grounded baseline and decisions

- The current state manager increments `toolCount` unconditionally in `recordToolSuccess` and transitions at `toolCount >= maxTools` or token exhaustion (`src/core/state.ts:258-284,381-394`); the new accounting path must therefore receive the executed tool name and distinguish normal execution from finalization.
- Current finalization only checks `finalization.allowedTools` (and optional `allowedPaths`) and has no per-finalization call counter (`src/core/state.ts:311-355`). Preserve this existing path policy in addition to the new call cap; the scope explicitly says `allowedTools` supplies the finalization allow-list.
- Existing session/config resolution already centralizes profile policy (`resolveProfile`, `resolveAgentProfile`, `resolveConfig`), so add both options as independently merged fields rather than altering global defaults or exemption semantics.
- Existing deduplication precedes successful-call accounting. Maintain that ordering so duplicate `tool.execute.after` delivery cannot increment either `toolCount` or `finalizationToolsUsed` twice.
- The reference's `matchesWhitelist` defines exact matching, a trailing-`*` prefix match, and unconditional `todo*`/`skill` matches (`docs/reference/subagent-budget-core.ts:91-100`); use those exact semantics.
- The scope is authoritative where it differs from the reference: its escape hatch explicitly permits the `write`, `edit`, and `apply_patch` families to the scratch-handover path. The reference instead ties its allowance to `finalizationAllowedTools` (`docs/reference/subagent-budget-core.ts:354-374`), so do **not** inherit that narrower condition.
- Exempt profiles (`enabled: false` and primary-agent exemptions) must remain wholly unaffected, as current `isAgentExempt` establishes (`src/core/state.ts:230-244`).

## Files to read for context

| File | Lines | Why |
| --- | --- | --- |
| `docs/scope-finalization-remaining-and-whitelisted-tools.md` | 1-116 | Authoritative requirements, compatibility rule, baked-budget deltas, and acceptance criteria. |
| `docs/reference/subagent-budget-core.ts` | 59-100, 123-192, 247-490 | Reference initialization, whitelist accounting, notices, handover helpers, transition, and restrictions. |
| `src/types.ts` | 15-85 | Current resolved/unresolved profile and session-state contracts to extend compatibly. |
| `src/config.ts` | 110-192 plus the budget-table declaration | Existing finalization resolution and baked/explicit/default merge order. |
| `src/core/state.ts` | 146-395 | Current session initialization, idempotent accounting, finalization enforcement, status, and transition implementation. |
| `src/index.ts` | whole file | Hook ordering and the data currently forwarded to before/after state-manager calls. |
| `test/guard.test.ts` | 60-245, 337-627, 677-781, 952-1480 | Existing baked configuration, resolution, lifecycle/finalization, hook, idempotency, token, and status test conventions. |
| `README.md` | configuration and baked-budget sections | Public option naming, examples, and table format to extend. |
| `package.json` and `tsconfig.json` | whole files | Exact typecheck/test scripts and compiler constraints for final validation. |

## Files to create or modify

| File | Expected change |
| --- | --- |
| `src/types.ts` | Add optional/resolved whitelist and finalization-count fields, plus the two session flags/counters. |
| `src/config.ts` | Extend baked profiles and resolve the new profile fields independently. |
| `src/core/state.ts` | Implement whitelist matching, bounded-finalization state/transition/enforcement/accounting/status and one-time handover handling. |
| `src/index.ts` | Forward tool identity and file-path arguments into success/before accounting/enforcement as required by state contracts. |
| `test/guard.test.ts` | Add focused regression tests for each new behavior and compatibility boundary. |
| `README.md` | Document both options, their semantics, and revised baked profiles. |

## Ordered development tasks

### 1. Extend public/internal policy types and configuration resolution

**Dependencies:** none.

**Requirements:**

1. Add `whitelistedTools?: string[]` and `finalizationRemaining?: number` to the unresolved agent profile, and their resolved counterparts using the repository's existing optionality convention.
2. Add `finalizationToolsUsed: number` and `isHandoverWritten: boolean` to `SessionGuardState`; initialize them for every newly created session.
3. Extend `REFERENCE_AGENT_BUDGETS` exactly as scoped: planner/doc-writer get `2` and `["lsp"]`; coder gets `3` and `["context7*", "task", "lsp"]`; file-explorer/code-reviewer/security-reviewer get `["lsp"]`; all other rows stay unchanged.
4. In profile resolution, merge each new field independently using explicit option first and baked value second (`explicit ?? baked`), with no accidental inheritance through a shared finalization object. Preserve existing default, environment, primary-agent, and enabled behavior.
5. Reject/normalize invalid `finalizationRemaining` consistently with existing positive-integer parsing (the executor must confirm whether zero is intentionally representable; see ambiguity below) and avoid mutating configured string arrays.

**Likely files:** `src/types.ts`, `src/config.ts`, `test/guard.test.ts`.

**Focused verification / acceptance:** Add resolution tests covering every changed baked profile, explicit replacement of each new field without replacing the other, and an agent with neither field retaining the prior resolved shape/behavior. Run the relevant test selection and `npm run typecheck`.

### 2. Make successful-call accounting whitelist-aware without changing token accounting

**Dependencies:** Task 1.

**Requirements:**

1. Implement a small private/helper predicate with reference semantics: `todo` prefix and exact `skill` are always free; configured exact patterns match exactly; a configured trailing `*` matches the name prefix; absent/empty lists do not match.
2. Change the success-accounting interface so the actual tool name is available at the point `toolCount` is incremented. Apply the predicate only to `toolCount`; always increment success diagnostics and always calculate/injest argument/output tokens for successful calls, including free tools.
3. Retain deduplication before all counters/tokens and preserve legacy wrapper behavior (`recordToolExecution`) with a clear compatible default or an updated explicit call contract.
4. Do not apply this behavior to exempt agents in a way that changes their observable unlimited status.

**Likely files:** `src/core/state.ts`, `src/index.ts`, `test/guard.test.ts`.

**Focused verification / acceptance:** Test configured exact and prefix matches, default `todo*` and `skill`, a non-match incrementing normally, free calls still adding input/output ingestion, and duplicate after-hook delivery remaining idempotent. Confirm an agent without a whitelist remains byte-for-byte equivalent in tool-count behavior.

### 3. Implement bounded finalization transition, enforcement, and accounting

**Dependencies:** Tasks 1-2.

**Requirements:**

1. Preserve current token-triggered transition and tool-limit precedence, but when a profile configures `finalizationRemaining: R`, begin finalization at `toolCount >= maxTools - R`; profiles without `R` keep the exact old threshold of `maxTools`.
2. In finalization, retain existing allowed-tool and allowed-path checking, then enforce the call cap: at `finalizationToolsUsed >= R`, deny every ordinary tool with reference-style “Finalization calls exhausted … Proceed to report.” messaging; before cap exhaustion deny non-allowed tools with remaining-count/allowed-list messaging.
3. Increment `finalizationToolsUsed` exactly once after each successfully permitted normal finalization call. Do not increment it for a permitted handover write (Task 4) or duplicate hooks. Decide and test whether an allowed-but-whitelisted finalization tool consumes a finalization slot: it should, because the scope says *each permitted [finalization] call* increments it; whitelist only exempts `toolCount`.
4. Surface finalization values in `getRemainingBudget` (or the established equivalent) if required to render diagnostics without breaking its current fields; do not change non-finalization status values.
5. Update the prompt/status injection to include `finalization: x/R used` only while configured and in finalization, with FORCEFUL WRAP-UP on entry and LAST CALL when one slot remains. Preserve the established status-line format except these additions.

**Likely files:** `src/core/state.ts`, `src/index.ts`, `test/guard.test.ts`.

**Focused verification / acceptance:** Test planner/doc-writer at two slots and coder at three: early transition, allowed call progression, last-call/entry notices, cap denial, non-allowed denial before cap, and token-exhaustion transition. Regression-test an agent with no `finalizationRemaining` at its existing max-tool transition and unlimited allowed finalization calls.

### 4. Add the one-time scratch-handover escape hatch and advice

**Dependencies:** Tasks 1-3.

**Requirements:**

1. Implement a narrowly scoped predicate that recognizes only `write`, `edit`, or `apply_patch` and only a `filePath` exactly equal to, or ending in `/${`Handovers/SCRATCH_<agentName>_<sessionID>.md`}`. Require a session agent name and a string file path; do not match arbitrary suffixes or non-write tools.
2. Let that target through once in all otherwise exhausted conditions (token/tool exhaustion and finalization-call exhaustion), set `isHandoverWritten` at permission time to prevent concurrent/repeated attempts, and block every subsequent scratch-handover attempt under normal exhausted-policy errors.
3. Do not let the escape hatch bypass enforcement before exhaustion in a way that changes ordinary execution behavior, and do not count the permitted handover as a finalization call; continue normal token/success accounting only if its after hook arrives.
4. Append the reference-style unfinished-task advice with the exact agent/session-specific path to applicable block reasons and terminal status lines; after successful use, report that the handover has been written where the reference-style UX calls for it.

**Likely files:** `src/core/state.ts`, `src/index.ts`, `test/guard.test.ts`.

**Focused verification / acceptance:** Test exact and absolute/suffix paths; each of the three permitted write-family tools; rejected wrong tool/path; one allowed post-exhaustion write followed by denial; and advice text on applicable token/tool/finalization blocks. Verify an exempt agent is still unrestricted.

### 5. Document the finalized configuration contract and complete integration validation

**Dependencies:** Tasks 1-4.

**Requirements:**

1. Update README configuration/API documentation for `whitelistedTools` and `finalizationRemaining`, including wildcard and built-in-free semantics, unchanged token ingestion, finalization-call behavior, and one-time handover path/rules.
2. Update the baked agent table exactly to match Task 1. State that absent fields preserve the old behavior.
3. Keep documentation limited to the scope; do not claim persistence, templating, or unrelated status rewrites.
4. Run `npm run typecheck` and `npm test` after all test changes. Resolve only scope-related type/test failures and re-run both commands.

**Likely files:** `README.md`, `test/guard.test.ts` (only if integration assertions need grouping/repair).

**Focused verification / acceptance:** README examples agree with resolved configuration and tests; full typecheck and suite pass; inspect the diff to confirm no production files outside the scoped five source files and no out-of-scope behavior changes.

## Risks and edge cases

- `maxTools - finalizationRemaining` can be zero or negative. The implementation must either validate R relative to `maxTools` or deliberately allow immediate finalization; the scope does not specify this boundary.
- The authoritative scope calls the permitted handover a “write-family” call, whereas the reference only permits an allowed finalization tool. Scope wording should control, but tests must lock that broader behavior to prevent a future refactor from silently re-narrowing it.
- Current finalization also supports `allowedPaths`; the scope only discusses allowed tools. Preserve path restrictions for ordinary finalization operations and specify whether the scratch handover intentionally overrides them (the scope says always permitted).
- Marking handover-written during `before` prevents a second call but consumes the one-time escape hatch if the host fails before `after`; this is consistent with the reference and is safer against duplicate/concurrent dispatch, but should be documented/tested.
- Whitelisted calls must not advance the tool-triggered transition, but their token ingestion can cause a token-triggered transition; tests must cover that distinction.
- Status text needs exact enough assertions to detect missing required notices without making tests brittle against harmless existing formatting.

## Discrepancies and ambiguities to resolve during implementation

1. **Reference vs scope handover allow-list:** reference `isAllowedHandover` requires the tool be in `finalizationAllowedTools`, while scope requires `write`/`edit`/`apply_patch` be always permitted. Grounded decision: follow scope.
2. **Reference uses `null`; current implementation uses optional profile fields:** use current TypeScript conventions rather than porting the reference data model mechanically.
3. **`finalizationRemaining = 0` and R greater than `maxTools`:** no explicit requested behavior. Prefer existing positive-integer validation for zero; for oversize R, either reject at config resolution or document immediate finalization only after maintainer direction.
4. **Path policy interaction:** scoped “always permitted” handover must bypass `finalization.allowedPaths`, but ordinary allowed finalization tools should retain it; add an explicit regression test.
