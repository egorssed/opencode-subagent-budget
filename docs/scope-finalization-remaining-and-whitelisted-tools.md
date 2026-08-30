# Scope: `finalizationRemaining` + non-counting `whitelistedTools`

Port the two reference capabilities that the current plugin build lacks (see
`docs/reference/subagent-budget-core.ts` — `AgentRestriction` fields that were
not mimicked) into the as-built plugin.

## Current behavior (as-built baseline)

- Config per agent: `maxTools`, `maxTokens`, `finalization { allowedTools, allowedPaths }`.
- Hard transition `execution → finalization` when `toolCount >= maxTools` **or**
  `tokensIngested >= maxTokens` (tool limit takes precedence).
- In `finalization`, only `finalization.allowedTools` pass — **unlimited** number of calls.
- **Every** successful tool call increments `toolCount` (no exemptions).
- Baked table (`REFERENCE_AGENT_BUDGETS`) has no finalization-call caps or whitelists.

## Feature A — `whitelistedTools` (non-counting tools)

Config: `whitelistedTools?: string[]` on `AgentCapacityProfile` /
`ResolvedAgentCapacityProfile`; merged per-field (`explicit option ?? baked table`).

Semantics (mirror reference `matchesWhitelist`):

- A tool matching the whitelist **does not increment `toolCount`**. Token
  ingestion still counts (output text is still ingested context).
- Always whitelisted regardless of config: tools starting with `todo` and the
  tool `skill`.
- Pattern matching: exact name, or prefix match when pattern ends with `*`
  (e.g. `context7*` matches `context7-docs`).
- Exempt agents (`primaryAgents`, `enabled: false`) are unaffected either way.

## Feature B — `finalizationRemaining` (bounded finalization)

Config: `finalizationRemaining?: number` on the profile. Reuse the existing
`finalization.allowedTools` as the reference's `finalizationAllowedTools`
(identical semantics — the tools permitted during finalization).

State: add `finalizationToolsUsed: number` to `SessionGuardState`.

Rules:

1. **Earlier transition**: when `finalizationRemaining = R` is configured,
   transition to `finalization` when `toolCount >= maxTools - R` (or token
   exhaustion). Without `R`, transition stays at `maxTools` (unchanged).
2. **Enforcement** (`tool.execute.before`, finalization phase):
   - `finalizationToolsUsed >= R` → block all tools; error mirrors reference:
     "Finalization calls exhausted for this subagent. … Proceed to report."
   - else if tool ∈ `finalization.allowedTools` → allow; else block:
     "Finalization: N call(s) remaining. Only <allowed>, allowed."
3. **Counting** (`tool.execute.after`): when in finalization phase,
   `finalizationToolsUsed += 1` for each permitted call except the allowed
   handover write (see below).
4. **Status line**: extend the `[capacity-guard]` prompt injection with
   `finalization: x/R used` when configured and in finalization phase; include
   reference-style wrap-up notices ("FORCEFUL WRAP-UP" at phase entry, "LAST
   CALL" when one call remains) in the injected line.

## Feature C — handover escape hatch (part of B, makes the hard block safe)

Mirror the reference `isAllowedHandover` / `handoverAdvice`:

- A `write`-family call (`write`, `edit`, `apply_patch`) targeting
  `Handovers/SCRATCH_<agentType>_<sessionID>.md` (exact or suffix path match)
  is **always permitted**, even with all budgets/finalization calls exhausted —
  but only once: `isHandoverWritten` flips and further handover writes block.
- Block reasons and status lines gain the reference-style advice suffix:
  "If the task remains unfinished, you may preserve the critical context so
  another agent can complete it efficiently. For that write handover to
  Handovers/SCRATCH_<agent>_<sessionID>.md"

## Config table changes (baked budgets)

Extend `REFERENCE_AGENT_BUDGETS` to full reference parity:

| agent | change |
| :--- | :--- |
| planner | + `finalizationRemaining: 2`, `whitelistedTools: ["lsp"]` |
| doc-writer | + `finalizationRemaining: 2`, `whitelistedTools: ["lsp"]` |
| coder | + `finalizationRemaining: 3`, `whitelistedTools: ["context7*", "task", "lsp"]` |
| file-explorer | + `whitelistedTools: ["lsp"]` |
| code-reviewer | + `whitelistedTools: ["lsp"]` |
| security-reviewer | + `whitelistedTools: ["lsp"]` |

All other agents unchanged (no finalization, no whitelist).

## Files touched

- `src/types.ts` — profile fields `whitelistedTools`, `finalizationRemaining`;
  session state `finalizationToolsUsed`, `isHandoverWritten`.
- `src/config.ts` — table extension + per-field merge for the two new fields.
- `src/core/state.ts` — whitelist-aware counting, transition threshold
  `maxTools - R`, finalization enforcement with call cap, handover allowance.
- `src/index.ts` — pass `tool` + `args.filePath` into enforcement for handover
  detection (hook plumbing already exists).
- `test/guard.test.ts` — whitelist matching (exact / prefix / `todo*` / `skill`
  always free), non-counting behavior, transition at `maxTools - R`, finalization
  call cap + blocking, handover write allowed once then blocked, backward-compat
  for agents without the new fields.
- `README.md` — document the two new options and updated baked table.

## Acceptance criteria

1. Whitelisted tool calls (incl. always-free `todo*`/`skill`) never increment
   `toolCount`; token ingestion unchanged.
2. planner/doc-writer enter finalization with 2 calls remaining, coder with 3;
   only `finalization.allowedTools` pass during finalization; exceeding the cap
   blocks with the reference-style error.
3. Handover write to `Handovers/SCRATCH_<agent>_<sessionID>.md` is allowed
   exactly once after exhaustion; subsequent attempts block.
4. Agents without the new config fields behave byte-for-byte as today.
5. `npm run typecheck` and `npm test` pass; new tests cover all the above.

## Out of scope

- Persistent state across OpenCode restarts (in-memory per session, as today).
- Handover file templating / content generation.
- Rewriting existing status-line format beyond the additions above.
