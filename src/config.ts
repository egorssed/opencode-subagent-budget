import type { PluginOptions } from "@opencode-ai/plugin";
import type {
  AgentCapacityProfile,
  ContextGuardOptions,
  FinalizationPolicy,
  ResolvedAgentCapacityProfile,
  ResolvedContextGuardConfig,
} from "./types.js";

export const DEFAULT_CONFIG: ResolvedContextGuardConfig = {
  enabled: true,
  primaryAgents: ["build", "plan", "orchestrator"],
  defaults: {
    maxTools: 15,
    maxTokens: 40000,
    finalization: {
      allowedTools: [],
      allowedPaths: [],
    },
  },
  agents: {},
};

const ENV_ENABLED = "OPENCODE_CONTEXT_GUARD_ENABLED";
const ENV_DEFAULT_MAX_TOOLS = "OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS";
const ENV_DEFAULT_MAX_TOKENS = "OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS";
const ENV_PRIMARY_AGENTS = "OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS";

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function isPositiveInt(value: number | undefined): value is number {
  if (value === undefined) return false;
  if (value === Infinity) return true;
  return Number.isInteger(value) && value > 0;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === "Infinity") return Infinity;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function envEnabled(): boolean | undefined {
  return parseBool(process.env[ENV_ENABLED]);
}

function envDefaultMaxTools(): number | undefined {
  return parsePositiveInt(process.env[ENV_DEFAULT_MAX_TOOLS]);
}

function envDefaultMaxTokens(): number | undefined {
  return parsePositiveInt(process.env[ENV_DEFAULT_MAX_TOKENS]);
}

function envPrimaryAgents(): string[] | undefined {
  return parseList(process.env[ENV_PRIMARY_AGENTS]);
}

function resolveFinalization(
  policy: FinalizationPolicy,
  override?: Partial<FinalizationPolicy>,
): FinalizationPolicy {
  return {
    allowedTools: override?.allowedTools ?? policy.allowedTools,
    allowedPaths: override?.allowedPaths ?? policy.allowedPaths,
  };
}

function resolveAgentProfile(
  profile: AgentCapacityProfile | undefined,
  defaults: ResolvedContextGuardConfig["defaults"],
): ResolvedAgentCapacityProfile {
  const maxTools = profile?.maxTools;
  const maxTokens = profile?.maxTokens;
  return {
    enabled: profile?.enabled ?? true,
    enabledExplicit: profile?.enabled === true,
    maxTools: isPositiveInt(maxTools) ? maxTools : defaults.maxTools,
    maxTokens: isPositiveInt(maxTokens) ? maxTokens : defaults.maxTokens,
    finalization: resolveFinalization(defaults.finalization, profile?.finalization),
  };
}

export function resolveConfig(options?: PluginOptions): ResolvedContextGuardConfig {
  const raw = (options ?? {}) as Partial<ContextGuardOptions>;

  const explicitMaxTools = raw.defaults?.maxTools;
  const explicitMaxTokens = raw.defaults?.maxTokens;
  const defaults: ResolvedContextGuardConfig["defaults"] = {
    maxTools: isPositiveInt(explicitMaxTools)
      ? explicitMaxTools
      : envDefaultMaxTools() ?? DEFAULT_CONFIG.defaults.maxTools,
    maxTokens: isPositiveInt(explicitMaxTokens)
      ? explicitMaxTokens
      : envDefaultMaxTokens() ?? DEFAULT_CONFIG.defaults.maxTokens,
    finalization: resolveFinalization(DEFAULT_CONFIG.defaults.finalization, raw.defaults?.finalization),
  };

  const agents: Record<string, ResolvedAgentCapacityProfile> = {};
  for (const [name, profile] of Object.entries(raw.agents ?? {})) {
    agents[name] = resolveAgentProfile(profile, defaults);
  }

  return {
    enabled: raw.enabled ?? envEnabled() ?? DEFAULT_CONFIG.enabled,
    primaryAgents: raw.primaryAgents ?? envPrimaryAgents() ?? DEFAULT_CONFIG.primaryAgents,
    defaults,
    agents,
  };
}
