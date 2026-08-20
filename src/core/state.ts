import path from "node:path";

import { DEFAULT_CONFIG } from "../config.ts";
import type {
  ExhaustionReason,
  ResolvedAgentCapacityProfile,
  ResolvedContextGuardConfig,
  SessionGuardState,
  SessionStage,
} from "../types.ts";
import { estimateTokens, extractOutputText } from "./estimator.ts";

export interface CapacityLimitErrorInfo {
  agentName: string;
  reason: ExhaustionReason;
  toolCount: number;
  maxTools: number;
  tokensIngested: number;
  maxTokens: number;
}

export interface SessionBudgetStatus {
  sessionID: string;
  agentName: string;
  stage: SessionStage;
  toolCount: number;
  maxTools: number;
  remainingTools: number;
  tokensIngested: number;
  maxTokens: number;
  remainingTokens: number;
  exhaustionReason: ExhaustionReason | null;
  exempt: boolean;
}

export function formatCapacityBreachMessage(info: CapacityLimitErrorInfo): string {
  return [
    `[Capacity Guard] Session limit reached for agent "@${info.agentName}".`,
    "Current stage: FINALIZATION",
    `Limit exceeded: ${info.reason} (Used: ${info.toolCount}/${info.maxTools} tools, ${info.tokensIngested}/${info.maxTokens} tokens).`,
    "Action required: Tool execution is restricted in finalization stage. Please summarize your findings, provide your final report, or complete task handover in your text response.",
  ].join("\n");
}

export class CapacityLimitError extends Error {
  readonly agentName: string;
  readonly reason: ExhaustionReason;
  readonly toolCount: number;
  readonly maxTools: number;
  readonly tokensIngested: number;
  readonly maxTokens: number;

  constructor(info: CapacityLimitErrorInfo) {
    super(formatCapacityBreachMessage(info));
    this.name = "CapacityLimitError";
    this.agentName = info.agentName;
    this.reason = info.reason;
    this.toolCount = info.toolCount;
    this.maxTools = info.maxTools;
    this.tokensIngested = info.tokensIngested;
    this.maxTokens = info.maxTokens;
  }
}

function normalizePath(input: string): string {
  let normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  if (normalized === ".") return "";
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

export function pathMatchesPattern(candidate: string, pattern: string): boolean {
  const path = normalizePath(candidate);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.length === 0) return false;

  if (globPatternToRegExp(normalizedPattern).test(path)) return true;

  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3);
    return path === base || path.startsWith(base + "/");
  }

  if (!/[?*]/.test(normalizedPattern)) {
    return path === normalizedPattern || path.startsWith(normalizedPattern + "/");
  }

  return false;
}

export const CALLID_DEDUP_CAPACITY = 1024;

/**
 * Bounded, insertion-ordered deduplication window for callIDs.
 * Retains at most CALLID_DEDUP_CAPACITY IDs; the oldest ID is evicted when
 * the window overflows. Re-adding an existing ID refreshes its recency so
 * redelivered hook calls stay deduplicated while they remain in the window.
 * Backed by a single built-in Map, so retained state is bounded.
 */
class BoundedCallIDCache {
  private ids = new Map<string, true>();

  add(callID: string): boolean {
    if (this.ids.has(callID)) {
      this.ids.delete(callID);
      this.ids.set(callID, true);
      return false;
    }
    this.ids.set(callID, true);
    if (this.ids.size > CALLID_DEDUP_CAPACITY) {
      const oldest = this.ids.keys().next().value as string | undefined;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.ids.size;
  }
}

function extractTargetPath(args: Record<string, unknown>): string | undefined {
  const filePath = args["filePath"];
  if (typeof filePath === "string" && filePath.length > 0) return filePath;
  const path = args["path"];
  if (typeof path === "string" && path.length > 0) return path;
  return undefined;
}

export class SessionStateManager {
  private sessions = new Map<string, SessionGuardState>();
  private sessionConfigs = new Map<string, ResolvedContextGuardConfig>();
  private attemptedCallIDs = new Map<string, BoundedCallIDCache>();
  private succeededCallIDs = new Map<string, BoundedCallIDCache>();
  private config: ResolvedContextGuardConfig;

  constructor(config: ResolvedContextGuardConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  private configForSession(sessionID: string): ResolvedContextGuardConfig {
    return this.sessionConfigs.get(sessionID) ?? this.config;
  }

  getOrCreateSession(
    sessionID: string,
    agentName: string,
    config?: ResolvedContextGuardConfig,
  ): SessionGuardState {
    if (config) this.sessionConfigs.set(sessionID, config);
    const existing = this.sessions.get(sessionID);
    if (existing) return existing;

    const now = Date.now();
    const session: SessionGuardState = {
      sessionID,
      agentName,
      stage: "execution",
      toolCount: 0,
      toolCallsAttempted: 0,
      toolCallsSucceeded: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensIngested: 0,
      exhaustionReason: null,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(sessionID, session);
    return session;
  }

  getSession(sessionID: string): SessionGuardState | undefined {
    return this.sessions.get(sessionID);
  }

  /** Diagnostic only: current retained callID dedup window sizes per session. */
  getDiagnosticCallIDCacheSizes(): {
    attemptedBySession: Record<string, number>;
    succeededBySession: Record<string, number>;
  } {
    const attemptedBySession: Record<string, number> = {};
    const succeededBySession: Record<string, number> = {};
    for (const [sessionID, cache] of this.attemptedCallIDs) {
      attemptedBySession[sessionID] = cache.size;
    }
    for (const [sessionID, cache] of this.succeededCallIDs) {
      succeededBySession[sessionID] = cache.size;
    }
    return { attemptedBySession, succeededBySession };
  }

  resolveProfile(
    agentName: string,
    config: ResolvedContextGuardConfig = this.config,
  ): ResolvedAgentCapacityProfile {
    return config.agents[agentName] ?? {
      enabled: true,
      enabledExplicit: false,
      maxTools: config.defaults.maxTools,
      maxTokens: config.defaults.maxTokens,
      finalization: config.defaults.finalization,
    };
  }

  isAgentExempt(
    agentName: string,
    config: ResolvedContextGuardConfig = this.config,
  ): boolean {
    // Any profile with explicit enabled: false keeps its agent exempt,
    // primary or not; normal non-primary agents remain guarded.
    const profile = config.agents[agentName];
    if (profile !== undefined && profile.enabled === false) return true;
    // Primary agents are exempt unless an explicit enabled: true profile
    // overrides the exemption.
    return (
      config.primaryAgents.includes(agentName) &&
      profile?.enabledExplicit !== true
    );
  }

  recordToolAttempt(sessionID: string, callID?: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    if (callID !== undefined) {
      const seen = this.attemptedCallIDs.get(sessionID) ?? new BoundedCallIDCache();
      if (!seen.add(callID)) return;
      this.attemptedCallIDs.set(sessionID, seen);
    }
    session.toolCallsAttempted += 1;
    session.lastActiveAt = Date.now();
  }

  recordToolSuccess(
    sessionID: string,
    argsTokens: number,
    outputText: string,
    callID?: string,
  ): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    if (callID !== undefined) {
      const seen = this.succeededCallIDs.get(sessionID) ?? new BoundedCallIDCache();
      if (!seen.add(callID)) return;
      this.succeededCallIDs.set(sessionID, seen);
    }
    session.toolCallsSucceeded += 1;
    session.toolCount += 1;
    session.tokensInput += Math.max(0, argsTokens);
    let outputTokens = 0;
    try {
      outputTokens = estimateTokens(extractOutputText(outputText));
    } catch {
      outputTokens = Number.POSITIVE_INFINITY;
    }
    session.tokensOutput += Math.max(0, outputTokens);
    session.tokensIngested = session.tokensInput + session.tokensOutput;
    session.lastActiveAt = Date.now();
    this.advanceStage(session);
  }

  recordToolExecution(sessionID: string, outputText = ""): void {
    this.recordToolSuccess(sessionID, 0, outputText);
  }

  recordTokens(sessionID: string, tokenCount: number): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    session.tokensOutput += Math.max(0, tokenCount);
    session.tokensIngested = session.tokensInput + session.tokensOutput;
    session.lastActiveAt = Date.now();
    this.advanceStage(session);
  }

  transitionToFinalization(
    sessionID: string,
    reason: ExhaustionReason,
  ): SessionGuardState | undefined {
    const session = this.sessions.get(sessionID);
    if (!session || session.stage === "finalization") return session;
    session.stage = "finalization";
    session.exhaustionReason = reason;
    session.lastActiveAt = Date.now();
    return session;
  }

  isOperationPermittedInFinalization(
    sessionID: string,
    toolName: string,
    args: Record<string, unknown> = {},
    config?: ResolvedContextGuardConfig,
  ): boolean {
    const session = this.sessions.get(sessionID);
    if (!session || session.stage !== "finalization") return true;

    const effectiveConfig = config ?? this.configForSession(sessionID);
    if (this.isAgentExempt(session.agentName, effectiveConfig)) return true;

    const profile = effectiveConfig.agents[session.agentName];

    const policy = (profile ?? effectiveConfig.defaults).finalization;
    if (!policy.allowedTools.includes(toolName)) return false;

    const targetPath = extractTargetPath(args);
    const allowedPaths = policy.allowedPaths;
    if (targetPath === undefined || !allowedPaths || allowedPaths.length === 0) return true;

    return allowedPaths.some((pattern) => pathMatchesPattern(targetPath, pattern));
  }

  assertOperationPermitted(
    sessionID: string,
    toolName: string,
    args: Record<string, unknown> = {},
    config?: ResolvedContextGuardConfig,
  ): void {
    if (this.isOperationPermittedInFinalization(sessionID, toolName, args, config)) return;

    const session = this.sessions.get(sessionID);
    if (!session) return;
    const effectiveConfig = config ?? this.configForSession(sessionID);
    const profile = this.resolveProfile(session.agentName, effectiveConfig);
    throw new CapacityLimitError({
      agentName: session.agentName,
      reason: session.exhaustionReason ?? "tool_limit",
      toolCount: session.toolCount,
      maxTools: profile.maxTools,
      tokensIngested: session.tokensIngested,
      maxTokens: profile.maxTokens,
    });
  }

  getRemainingBudget(sessionID: string): SessionBudgetStatus | undefined {
    const session = this.sessions.get(sessionID);
    if (!session) return undefined;

    const exempt = this.isAgentExempt(session.agentName, this.configForSession(sessionID));
    const profile = this.resolveProfile(session.agentName, this.configForSession(sessionID));
    const maxTools = exempt ? Infinity : profile.maxTools;
    const maxTokens = exempt ? Infinity : profile.maxTokens;

    return {
      sessionID: session.sessionID,
      agentName: session.agentName,
      stage: session.stage,
      toolCount: session.toolCount,
      maxTools,
      remainingTools: maxTools - session.toolCount,
      tokensIngested: session.tokensIngested,
      maxTokens,
      remainingTokens: maxTokens - session.tokensIngested,
      exhaustionReason: session.exhaustionReason,
      exempt,
    };
  }

  private advanceStage(session: SessionGuardState): void {
    if (session.stage === "finalization") return;
    const config = this.configForSession(session.sessionID);
    if (this.isAgentExempt(session.agentName, config)) return;

    const profile = this.resolveProfile(session.agentName, config);
    if (session.toolCount >= profile.maxTools) {
      this.transitionToFinalization(session.sessionID, "tool_limit");
      return;
    }
    if (session.tokensIngested >= profile.maxTokens) {
      this.transitionToFinalization(session.sessionID, "token_limit");
    }
  }
}
