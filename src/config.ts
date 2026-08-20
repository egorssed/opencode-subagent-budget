import type { PluginOptions } from "@opencode-ai/plugin";
import type { ContextGuardOptions, ResolvedContextGuardConfig } from "./types.js";

export const DEFAULT_CONFIG: ResolvedContextGuardConfig = {
  enabled: true,
  orchestratorBudgetKB: 5,
  defaultBudgetKB: 100,
};

const ENV_ENABLED = "OPENCODE_ORCHESTRATOR_CONTEXT_GUARD";
const ENV_ORCHESTRATOR_BUDGET_KB = "OPENCODE_CONTEXT_GUARD_ORCHESTRATOR_BUDGET_KB";
const ENV_DEFAULT_BUDGET_KB = "OPENCODE_CONTEXT_GUARD_DEFAULT_BUDGET_KB";

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function envEnabled(): boolean | undefined {
  const val = process.env[ENV_ENABLED];
  if (val === undefined) return undefined;
  return val !== "0" && val !== "false";
}

function envOrchestratorBudgetKB(): number | undefined {
  return parsePositiveInt(process.env[ENV_ORCHESTRATOR_BUDGET_KB]);
}

function envDefaultBudgetKB(): number | undefined {
  return parsePositiveInt(process.env[ENV_DEFAULT_BUDGET_KB]);
}

export function resolveConfig(options?: PluginOptions): ResolvedContextGuardConfig {
  const raw = (options ?? {}) as Partial<ContextGuardOptions>;

  return {
    enabled: raw.enabled ?? envEnabled() ?? DEFAULT_CONFIG.enabled,
    orchestratorBudgetKB:
      raw.orchestratorBudgetKB ?? envOrchestratorBudgetKB() ?? DEFAULT_CONFIG.orchestratorBudgetKB,
    defaultBudgetKB:
      raw.defaultBudgetKB ?? envDefaultBudgetKB() ?? DEFAULT_CONFIG.defaultBudgetKB,
  };
}
