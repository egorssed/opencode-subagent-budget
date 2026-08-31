import type { PluginInput, Hooks } from "@opencode-ai/plugin";

// Subagent sessions (sessions with a parentID) must call todowrite before
// invoking any other tool. Root sessions (no parentID) are never tracked or
// blocked. State is per-sessionID, mirroring subagent-budget-core.ts.
const hasPlanned = new Map<string, boolean>();
const parentIDCache = new Map<string, string | null>();

async function isSubagent(
  client: PluginInput["client"],
  sessionID: string,
): Promise<boolean> {
  const cached = parentIDCache.get(sessionID);
  if (cached !== undefined) return cached !== null;
  let parentID: string | null = null;
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    parentID =
      typeof result.data?.parentID === "string" && result.data.parentID !== ""
        ? result.data.parentID
        : null;
    parentIDCache.set(sessionID, parentID);
  } catch {
    // Fail-open: never crash or block on session lookup errors. Only cache
    // successful lookups so a transient error cannot disable enforcement.
    return false;
  }
  return parentID !== null;
}

export const server = async ({ client }: PluginInput): Promise<Hooks> => {
  return {
    "tool.execute.before": async (input) => {
      if (typeof input.sessionID !== "string") return;
      if (hasPlanned.get(input.sessionID)) return;
      if (String(input.tool ?? "").startsWith("todo")) return;
      if (String(input.tool ?? "") === "skill") return;
      if (!(await isSubagent(client, input.sessionID))) return;

      throw new Error(
        "Direct execution is blocked. You MUST consider the task and plan your actions ahead. Only when you issue a viable todo list with 'todowrite' tool you will be allowed to call tools.",
      );
    },

    "tool.execute.after": async (input) => {
      if (typeof input.sessionID !== "string") return;
      if (String(input.tool ?? "") !== "todowrite") return;
      if (!(await isSubagent(client, input.sessionID))) return;

      hasPlanned.set(input.sessionID, true);
    },
  };
};
