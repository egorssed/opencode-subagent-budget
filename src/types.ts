declare global {
  const Bun:
    | {
        file(path: string): {
          text(): Promise<string>;
          slice(start: number, end: number): {
            text(): Promise<string>;
          };
          stat(): Promise<{ size: number }>;
        };
      }
    | undefined;
}

export interface ContextGuardOptions {
  enabled?: boolean;
  primaryAgents?: string[];
  defaults?: Partial<{
    maxTools: number;
    maxTokens: number;
    finalization: Partial<FinalizationPolicy>;
  }>;
  agents?: Record<string, AgentCapacityProfile>;
}

export type WhitelistedToolEntry =
  | string
  | {
      name: string;
      allowedPaths?: string[];
    };

export interface ResolvedAgentCapacityProfile {
  enabled: boolean;
  enabledExplicit: boolean;
  maxTools: number;
  maxTokens: number;
  finalization: FinalizationPolicy;
  /** Tool names that do not count against the tool budget; undefined when unset. */
  whitelistedTools?: WhitelistedToolEntry[];
  /** Remaining finalization calls; 0/undefined means unset (positive-integer convention). */
  finalizationRemaining?: number;
}

export interface ResolvedContextGuardConfig {
  enabled: boolean;
  primaryAgents: string[];
  defaults: {
    maxTools: number;
    maxTokens: number;
    finalization: FinalizationPolicy;
  };
  agents: Record<string, ResolvedAgentCapacityProfile>;
}

export type SessionStage = "execution" | "finalization";

export type ExhaustionReason = "tool_limit" | "token_limit" | "manual";

export interface SessionGuardState {
  sessionID: string;
  agentName: string;
  /** True for child sessions, false for roots, undefined until resolved. */
  isSubagent?: boolean;
  /** Set after a child session successfully completes todowrite. */
  hasPlanned?: boolean;
  stage: SessionStage;
  toolCount: number;
  toolCallsAttempted: number;
  toolCallsSucceeded: number;
  tokensInput: number;
  tokensOutput: number;
  tokensIngested: number;
  /**
   * Provider ground truth for context size: the first observed assistant
   * token count (input + cache.read) for this session; null until an
   * assistant token event arrives.
   */
  baselineContextTokens: number | null;
  /** Most recent observed assistant token count; null until any arrives. */
  latestContextTokens: number | null;
  /** Message id of the most recent accepted assistant token observation. */
  lastTokenMessageId: string | null;
  finalizationToolsUsed: number;
  exhaustionReason: ExhaustionReason | null;
  createdAt: number;
  lastActiveAt: number;
}

export interface FinalizationPolicy {
  allowedTools: string[];
  allowedPaths?: string[];
}

export interface AgentCapacityProfile {
  enabled?: boolean;
  maxTools?: number;
  maxTokens?: number;
  finalization?: Partial<FinalizationPolicy>;
  whitelistedTools?: WhitelistedToolEntry[];
  finalizationRemaining?: number;
}

export interface ContextGuardConfig {
  enabled: boolean;
  primaryAgents: string[];
  defaults: {
    maxTools: number;
    maxTokens: number;
    finalization: FinalizationPolicy;
  };
  agents: Record<string, AgentCapacityProfile>;
}
