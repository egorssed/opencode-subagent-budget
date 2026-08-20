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

export interface ResolvedAgentCapacityProfile {
  enabled: boolean;
  enabledExplicit: boolean;
  maxTools: number;
  maxTokens: number;
  finalization: FinalizationPolicy;
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
  stage: SessionStage;
  toolCount: number;
  toolCallsAttempted: number;
  toolCallsSucceeded: number;
  tokensInput: number;
  tokensOutput: number;
  tokensIngested: number;
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
