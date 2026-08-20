# Quickstart & Validation Guide: Sub-Agent Capacity Guard

**Feature**: `subagent-capacity-guard`  
**Status**: Completed  
**Artifact**: `specs/001-subagent-capacity-guard/quickstart.md`

---

## 1. Installation & Setup

1. Reference in `opencode.json`:
   ```json
   {
     "plugin": [
       [
         "opencode-context-guard",
         {
           "defaults": {
             "maxTools": 5,
             "maxTokens": 10000
           }
         }
       ]
     ]
   }
   ```

---

## 2. Validation Scenarios

### Scenario A: Verify Normal Tool Ingestion Tracking
1. Invoke a sub-agent session `@explore search for error handler`.
2. Agent executes `grep` and `read` tools (2 tool calls, ~1,500 tokens).
3. **Expected Outcome**: Both tool calls succeed without disruption; session remains in `execution` stage.

### Scenario B: Verify Tool Limit Enforcement
1. Configure `maxTools: 3` for agent `@general`.
2. Trigger `@general` to run 4 successive commands or tool calls.
3. On the 4th tool call, `tool.execute.before` blocks execution.
4. **Expected Outcome**: Tool call is prevented; error notification instructs `@general` to finalize and output its text response.

### Scenario C: Verify Context Token Exhaustion
1. Configure `maxTokens: 2000` for agent `@explore`.
2. Agent reads a file whose output text is ~12,000 characters (~3,000 tokens).
3. Upon completion of that read, state advances to `finalization`.
4. Agent attempts next tool call (e.g. `glob`).
5. **Expected Outcome**: Next tool call is blocked with context token exhaustion notice.

### Scenario D: Verify Finalization Whitelisting
1. Configure agent `@writer` with `finalization: { allowedTools: ["write"], allowedPaths: ["./reports/**"] }`.
2. Agent exhausts budget (`toolCount >= maxTools`).
3. Agent attempts `read "package.json"` -> **Blocked** (not in allowed tools).
4. Agent attempts `write "./reports/summary.md"` -> **Allowed** (matches whitelist).

### Scenario E: Verify Primary Agent Exemption
1. Invoke primary interactive agent `@build`.
2. Execute 20+ tool calls.
3. **Expected Outcome**: Operations proceed without capacity restriction.
