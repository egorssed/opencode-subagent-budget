import type { Hooks, Plugin, PluginInput, PluginOptions, PluginModule } from "@opencode-ai/plugin";
import { resolveConfig } from "./config.ts";
import { estimateArgsTokens } from "./core/estimator.ts";
import { SessionStateManager } from "./core/state.ts";

export const server: Plugin = async (
  input: PluginInput,
  rawOptions?: PluginOptions,
): Promise<Hooks> => {
  const config = resolveConfig(rawOptions);
  if (!config.enabled) return {};

  const stateManager = new SessionStateManager(config, input.directory);
  const sessionAgent = new Map<string, string>();

  return {
    "chat.params": async (input) => {
      sessionAgent.set(input.sessionID, input.agent);
      stateManager.getOrCreateSession(input.sessionID, input.agent);
    },

    "tool.execute.before": async (input, output) => {
      const agent = sessionAgent.get(input.sessionID);
      if (!agent || stateManager.isAgentExempt(agent)) return;

      const session = stateManager.getOrCreateSession(input.sessionID, agent);
      stateManager.recordToolAttempt(input.sessionID, input.callID);
      if (session.stage !== "finalization") return;

      stateManager.assertOperationPermitted(
        input.sessionID,
        input.tool,
        (output.args ?? {}) as Record<string, unknown>,
      );
    },

    "tool.execute.after": async (input, output) => {
      const agent = sessionAgent.get(input.sessionID);
      if (!agent || stateManager.isAgentExempt(agent)) return;

      stateManager.getOrCreateSession(input.sessionID, agent);
      const hookOutput = output as { output?: string; args?: unknown };
      stateManager.recordToolSuccess(
        input.sessionID,
        estimateArgsTokens(input.args ?? hookOutput.args ?? {}),
        hookOutput.output ?? "",
        input.callID,
        input.tool,
        (input.args ?? hookOutput.args ?? {}) as Record<string, unknown>,
      );
    },

    event: async (input) => {
      const evt = (input as unknown as { event?: Record<string, unknown> }).event;
      if (!evt || evt.type !== "message.updated") return;
      const props = evt.properties as Record<string, unknown> | undefined;
      const info = props?.info as Record<string, unknown> | undefined;
      if (!info || info.role !== "assistant") return;
      const tokens = info.tokens as Record<string, unknown> | undefined;
      if (!tokens) return;
      const inputVal = Number(tokens.input);
      const cacheReadVal = Number(
        (tokens.cache as Record<string, unknown> | undefined)?.read ?? 0,
      );
      // Reject non-finite or negative provider values (e.g. "Infinity").
      if (!Number.isFinite(inputVal) || inputVal < 0) return;
      if (!Number.isFinite(cacheReadVal) || cacheReadVal < 0) return;
      const contextTokens = inputVal + cacheReadVal;
      if (!Number.isFinite(contextTokens) || contextTokens <= 0) return;
      const sid = (info.sessionID as string) || (props?.sessionID as string);
      if (typeof sid !== "string") return;
      const msgId = info.id;
      if (typeof msgId !== "string") return;
      const agent = sessionAgent.get(sid);
      if (!agent || stateManager.isAgentExempt(agent)) return;
      stateManager.recordProviderTokens(sid, msgId, contextTokens);
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const agent = sessionAgent.get(sessionID);
      if (!agent || stateManager.isAgentExempt(agent)) return;

      stateManager.getOrCreateSession(sessionID, agent);
      const budget = stateManager.getRemainingBudget(sessionID);
      if (!budget) return;

      let line = `[capacity-guard] tools: ${budget.toolCount}/${budget.maxTools} (${budget.remainingTools} remaining); tokens: ${budget.tokensIngested}/${budget.maxTokens} (~${budget.remainingTokens} remaining); stage: ${budget.stage}`;

      // Bounded finalization: extend the status line only while the cap is
      // configured and the session is in finalization, with reference-style
      // wrap-up notices at phase entry and when exactly one call remains.
      const cap = budget.finalizationRemaining;
      if (budget.stage === "finalization" && cap !== undefined) {
        const used = budget.finalizationToolsUsed;
        line += `; finalization: ${used}/${cap} used`;
        if (used === 0) {
          line += ` ⚠️ FORCEFUL WRAP-UP: You have exactly ${cap} finalization call(s) remaining. Stop exploring and start producing your deliverable immediately.`;
        } else if (used === cap - 1) {
          line += ` 🚨 LAST CALL: This is your FINAL tool call. You must produce your deliverable NOW.`;
        }
      }
      // Advertise the one-time scratch-handover escape hatch on every
      // finalization status line while it remains available, whether or not
      // the profile configures a finalization cap. Advice is gated on the
      // resolved profile being write-capable (see handoverAdviceFor).
      if (budget.stage === "finalization") {
        line += stateManager.handoverAdvice(sessionID);
      }

      output.system.push(line);
    },
  };
};

export default { id: "opencode-context-guard", server } satisfies PluginModule;
