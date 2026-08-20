import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { resolveConfig } from "./config.ts";
import { estimateArgsTokens } from "./core/estimator.ts";
import { SessionStateManager } from "./core/state.ts";

export const server: Plugin = async (
  _input: PluginInput,
  rawOptions?: PluginOptions,
): Promise<Hooks> => {
  const config = resolveConfig(rawOptions);
  if (!config.enabled) return {};

  const stateManager = new SessionStateManager(config);
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
      );
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const agent = sessionAgent.get(sessionID);
      if (!agent || stateManager.isAgentExempt(agent)) return;

      stateManager.getOrCreateSession(sessionID, agent);
      const budget = stateManager.getRemainingBudget(sessionID);
      if (!budget) return;

      output.system.push(
        `[capacity-guard] tools: ${budget.toolCount}/${budget.maxTools} (${budget.remainingTools} remaining); tokens: ${budget.tokensIngested}/${budget.maxTokens} (~${budget.remainingTokens} remaining); stage: ${budget.stage}`,
      );
    },
  };
};

export default server;
