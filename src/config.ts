import type { PluginOptions } from "@opencode-ai/plugin";
import type {
  AgentCapacityProfile,
  ContextGuardOptions,
  FinalizationPolicy,
  ResolvedAgentCapacityProfile,
  ResolvedContextGuardConfig,
  WhitelistedToolEntry,
} from "./types.js";

// Baked-in per-agent budgets mirroring the AGENT_RESTRICTION_TABLE in
// docs/reference/subagent-budget-core.ts. These are enforced even when no
// per-agent options are provided; explicit tuple options still win per-field.
export const REFERENCE_AGENT_BUDGETS: Record<string, AgentCapacityProfile> = {
  "web-researcher": { maxTools: 9, maxTokens: 24000 },
  "file-explorer": {
    maxTools: 15,
    maxTokens: 50000,
    whitelistedTools: [
      "lsp","todo*",
      { name: "read", allowedPaths: [".agent_file_explorer.md"] },
      { name: "write", allowedPaths: [".agent_file_explorer.md"] },
      { name: "edit", allowedPaths: [".agent_file_explorer.md"] },
    ],
    finalization: {
      allowedTools: ["read", "write", "edit"],
      allowedPaths: [".agent_file_explorer.md"],
    },
  },
  "code-reviewer": { maxTools: 12, maxTokens: 18000, whitelistedTools: ["lsp"] },
  "security-reviewer": { maxTools: 14, maxTokens: 24000, whitelistedTools: ["lsp"] },
  planner: {
    maxTools: 15,
    maxTokens: 18000,
    finalization: {
      allowedTools: ["read", "write", "edit"],
      allowedPaths: [".agent_file_explorer.md","docs/*.md"],
    },
    whitelistedTools: ["lsp", 'task',"todo*",
      { name: "read", allowedPaths: [".agent_planner.md","docs/*.md"] },
      { name: "write", allowedPaths: [".agent_planner.md","docs/*.md"] },
      { name: "edit", allowedPaths: [".agent_planner.md","docs/*.md"] },
      { name: "apply_patch", allowedPaths: [".agent_planner.md","docs/*.md"] }
  ],
  },
  "doc-writer": {
    maxTools: 10,
    maxTokens: 10000,
    finalizationRemaining: 5,
    finalization: { allowedTools: ["write", "edit", "apply_patch"] },
    whitelistedTools: ["lsp","todo*",],
  },
  coder: {
    maxTools: 24,
    maxTokens: 48000,
    finalizationRemaining: 10,
    finalization: { allowedTools: ["write", "edit", "apply_patch"] },
    whitelistedTools: ["context7*", "task", "lsp", "todo*",
      { name: "read", allowedPaths: [".agent_coder.md"] },
      { name: "write", allowedPaths: [".agent_coder.md"] },
      { name: "edit", allowedPaths: [".agent_coder.md"] },
      { name: "apply_patch", allowedPaths: [".agent_coder.md"] }],
  }
};

const DEFAULT_DEFAULTS: ResolvedContextGuardConfig["defaults"] = {
  maxTools: 15,
  maxTokens: 40000,
  finalization: {
    allowedTools: [],
    allowedPaths: [],
  },
};

export const DEFAULT_CONFIG: ResolvedContextGuardConfig = {
  enabled: true,
  primaryAgents: ["build", "plan", "orchestrator"],
  defaults: DEFAULT_DEFAULTS,
  agents: resolveBakedAgents(DEFAULT_DEFAULTS),
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

function resolveBakedAgents(
  defaults: ResolvedContextGuardConfig["defaults"],
): Record<string, ResolvedAgentCapacityProfile> {
  const agents: Record<string, ResolvedAgentCapacityProfile> = {};
  for (const [name, profile] of Object.entries(REFERENCE_AGENT_BUDGETS)) {
    agents[name] = resolveAgentProfile(profile, defaults);
  }
  return agents;
}

function resolveAgentProfile(
  profile: AgentCapacityProfile | undefined,
  defaults: ResolvedContextGuardConfig["defaults"],
): ResolvedAgentCapacityProfile {
  const maxTools = profile?.maxTools;
  const maxTokens = profile?.maxTokens;
  const whitelistedTools = profile?.whitelistedTools;
  const finalizationRemaining = profile?.finalizationRemaining;
  return {
    enabled: profile?.enabled ?? true,
    enabledExplicit: profile?.enabled === true,
    maxTools: isPositiveInt(maxTools) ? maxTools : defaults.maxTools,
    maxTokens: isPositiveInt(maxTokens) ? maxTokens : defaults.maxTokens,
    finalization: resolveFinalization(defaults.finalization, profile?.finalization),
    // Copy configured arrays so resolution never aliases or mutates the input.
    whitelistedTools: whitelistedTools
      ? whitelistedTools.map((entry) =>
          typeof entry === "string"
            ? entry
            : {
                name: entry.name,
                ...(entry.allowedPaths !== undefined
                  ? { allowedPaths: [...entry.allowedPaths] }
                  : {}),
              },
        )
      : undefined,
    // Positive-integer convention: 0 (or any non-positive value) means unset.
    finalizationRemaining: isPositiveInt(finalizationRemaining) ? finalizationRemaining : undefined,
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
  const names = new Set([...Object.keys(REFERENCE_AGENT_BUDGETS), ...Object.keys(raw.agents ?? {})]);
  for (const name of names) {
    const base = REFERENCE_AGENT_BUDGETS[name];
    const override = raw.agents?.[name];
    if (!base) {
      agents[name] = resolveAgentProfile(override, defaults);
    } else if (!override) {
      agents[name] = resolveAgentProfile(base, defaults);
    } else {
      // Per-field merge: explicit option fields win over the baked budget.
      agents[name] = resolveAgentProfile(
        {
          enabled: override.enabled ?? base.enabled,
          maxTools: override.maxTools ?? base.maxTools,
          maxTokens: override.maxTokens ?? base.maxTokens,
          finalization: {
            allowedTools: override.finalization?.allowedTools ?? base.finalization?.allowedTools,
            allowedPaths: override.finalization?.allowedPaths ?? base.finalization?.allowedPaths,
          },
          whitelistedTools: override.whitelistedTools ?? base.whitelistedTools,
          finalizationRemaining:
            override.finalizationRemaining ?? base.finalizationRemaining,
        },
        defaults,
      );
    }
  }

  return {
    enabled: raw.enabled ?? envEnabled() ?? DEFAULT_CONFIG.enabled,
    primaryAgents: raw.primaryAgents ?? envPrimaryAgents() ?? DEFAULT_CONFIG.primaryAgents,
    defaults,
    agents,
  };
}
