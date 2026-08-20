import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import fs from "node:fs/promises";
import { resolveConfig } from "./config.js";
import { estimatePatchSize } from "./core/estimator.js";

export const server: Plugin = async (
  _input: PluginInput,
  rawOptions?: PluginOptions,
): Promise<Hooks> => {
  const config = resolveConfig(rawOptions);
  if (!config.enabled) return {};

  const sessionAgent = new Map<string, string>();

  const budgetFor = (agent: string | undefined): number => {
    const budgetKB =
      agent === "orchestrator" ? config.orchestratorBudgetKB : config.defaultBudgetKB;
    return budgetKB * 1024;
  };

  const agentLabel = (agent: string | undefined): string =>
    agent === "orchestrator"
      ? "the orchestrator's"
      : agent === "planner"
        ? "the planner's"
        : "the";

  return {
    "chat.params": async (input, _output) => {
      sessionAgent.set(input.sessionID, input.agent);
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "read") return;

      const agent = sessionAgent.get(input.sessionID);
      if (!agent) return;

      try {
        const filePath = output.args?.filePath;
        if (!filePath || typeof filePath !== "string") return;

        const stat =
          typeof Bun !== "undefined" && Bun?.file
            ? await Bun.file(filePath).stat()
            : await fs.stat(filePath);
        const fileSize = stat.size;

        const budget = budgetFor(agent);

        const readLimit = output.args?.limit;
        if (typeof readLimit === "number" && readLimit > 0) {
          const estimatedPatchSize = await estimatePatchSize(filePath, fileSize, readLimit);

          if (estimatedPatchSize <= budget) return;

          throw new Error(
            `Partial read of "${filePath}" is estimated at ~${Math.round(estimatedPatchSize / 1024)} KB ` +
              `(${readLimit} lines). ` +
              `This exceeds ${agentLabel(agent)} read budget of ${Math.round(budget / 1024)} KB. ` +
              `Use a smaller limit value to read a smaller slice.`,
          );
        }

        if (fileSize <= budget) return;

        throw new Error(
          `File "${filePath}" is ~${Math.round(fileSize / 1024)} KB. ` +
            `This exceeds ${agentLabel(agent)} read budget of ${Math.round(budget / 1024)} KB. ` +
            `Use offset/limit to read slices, or delegate large file inspection to @file-explorer.`,
        );
      } catch (e) {
        if (e instanceof Error && e.message.includes("read budget")) throw e;
      }
    },
  };
};

export default server;
