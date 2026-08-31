import path from "node:path";

import { DEFAULT_CONFIG } from "../config.ts";
import type {
  ExhaustionReason,
  ResolvedAgentCapacityProfile,
  ResolvedContextGuardConfig,
  SessionGuardState,
  SessionStage,
  WhitelistedToolEntry,
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
  finalizationToolsUsed: number;
  /** Bounded finalization call cap; undefined when the profile does not configure it. */
  finalizationRemaining?: number;
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

  constructor(info: CapacityLimitErrorInfo, message?: string) {
    super(message ?? formatCapacityBreachMessage(info));
    this.name = "CapacityLimitError";
    this.agentName = info.agentName;
    this.reason = info.reason;
    this.toolCount = info.toolCount;
    this.maxTools = info.maxTools;
    this.tokensIngested = info.tokensIngested;
    this.maxTokens = info.maxTokens;
  }
}

function normalizePath(input: string, workspaceRoot?: string): string {
  if (!input || input.length === 0) return "";
  const normalized = input.replace(/\\/g, "/");
  let resolved = workspaceRoot
    ? path.resolve(workspaceRoot, normalized).replace(/\\/g, "/")
    : path.posix.normalize(normalized);
  if (resolved === ".") return "";
  if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
  return resolved;
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

export function pathMatchesPattern(
  candidate: string,
  pattern: string,
  workspaceRoot?: string,
): boolean {
  if (!pattern || pattern.length === 0) return false;
  const targetPath = normalizePath(candidate, workspaceRoot);
  const normalizedPattern = normalizePath(pattern, workspaceRoot);
  if (normalizedPattern.length === 0) return false;

  if (globPatternToRegExp(normalizedPattern).test(targetPath)) return true;

  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3);
    return targetPath === base || targetPath.startsWith(base + "/");
  }

  if (!/[?*]/.test(normalizedPattern)) {
    return targetPath === normalizedPattern || targetPath.startsWith(normalizedPattern + "/");
  }

  return false;
}

/**
 * Reference-parity whitelist matcher for non-counting tools.
 *
 * Always whitelisted regardless of configuration: any tool whose name starts
 * with "todo" and the exact tool "skill". Configured patterns match exact tool
 * names, or as prefixes when the pattern ends with a trailing "*"
 * (e.g. "context7*" matches "context7-docs"). Structured entries may specify
 * allowedPaths for wildcard path scoping; string entries or structured entries
 * omitting allowedPaths are unrestricted ("*").
 */
export function matchesWhitelist(
  toolName: string,
  patterns?: WhitelistedToolEntry[],
  args?: Record<string, unknown>,
  workspaceRoot?: string,
): boolean {
  if (toolName.startsWith("todo") || toolName === "skill") return true;
  if (!patterns || patterns.length === 0) return false;
  const targetPath = args !== undefined ? extractTargetPath(args) : undefined;
  return patterns.some((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const nameMatches = name.endsWith("*")
      ? toolName.startsWith(name.slice(0, -1))
      : toolName === name;
    if (!nameMatches) return false;
    if (typeof entry === "string" || entry.allowedPaths === undefined) {
      return true;
    }
    if (targetPath === undefined) return false;
    return entry.allowedPaths.some((pattern) =>
      pathMatchesPattern(targetPath, pattern, workspaceRoot),
    );
  });
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
  private workspaceRoot: string;

  constructor(config: ResolvedContextGuardConfig = DEFAULT_CONFIG, workspaceRoot = process.cwd()) {
    this.config = config;
    this.workspaceRoot = normalizePath(workspaceRoot);
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
      baselineContextTokens: null,
      latestContextTokens: null,
      lastTokenMessageId: null,
      finalizationToolsUsed: 0,
      exhaustionReason: null,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(sessionID, session);
    // Per-agent R >= maxTools: the tool threshold (maxTools - R) is <= 0, so a
    // newly created non-exempt session enters finalization immediately,
    // before any tool executes. Existing sessions returned above are
    // untouched, and profiles without a cap keep the maxTools threshold.
    this.advanceStage(session);
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
    toolName?: string,
    args?: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    if (callID !== undefined) {
      const seen = this.succeededCallIDs.get(sessionID) ?? new BoundedCallIDCache();
      if (!seen.add(callID)) return;
      this.succeededCallIDs.set(sessionID, seen);
    }
    // Whitelisted tools (always-free todo*/skill plus configured patterns from
    // the effective per-session agent profile) are accounted for in succeeded
    // metrics and token ingestion, but do not count against the tool budget.
    // No tool identity (legacy direct callers) counts as non-whitelisted.
    const effectiveProfile = this.resolveProfile(
      session.agentName,
      this.configForSession(sessionID),
    );
    const whitelisted =
      toolName !== undefined &&
      matchesWhitelist(toolName, effectiveProfile.whitelistedTools, args, this.workspaceRoot);
    // Calls that began in finalization (before this success could trigger the
    // phase transition) consume a finalization slot — including whitelisted
    // tools; the whitelist only exempts toolCount. Gated on a configured cap
    // so profiles without finalizationRemaining keep their previous state.
    const beganInFinalization = session.stage === "finalization";
    session.toolCallsSucceeded += 1;
    if (!whitelisted) session.toolCount += 1;
    session.tokensInput += Math.max(0, argsTokens);
    let outputTokens = 0;
    try {
      outputTokens = estimateTokens(extractOutputText(outputText));
    } catch {
      outputTokens = Number.POSITIVE_INFINITY;
    }
    session.tokensOutput += Math.max(0, outputTokens);
    session.tokensIngested = this.effectiveContextTokens(session, outputTokens);
    session.lastActiveAt = Date.now();
    this.advanceStage(session);
    if (
      beganInFinalization &&
      effectiveProfile.finalizationRemaining !== undefined
    ) {
      session.finalizationToolsUsed += 1;
    }
  }

  recordToolExecution(sessionID: string, outputText = ""): void {
    this.recordToolSuccess(sessionID, 0, outputText);
  }

  recordTokens(sessionID: string, tokenCount: number): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    session.tokensOutput += Math.max(0, tokenCount);
    session.tokensIngested = this.effectiveContextTokens(session, Math.max(0, tokenCount));
    session.lastActiveAt = Date.now();
    this.advanceStage(session);
  }

  /**
   * Records a provider ground-truth context-size observation derived from an
   * assistant message update (input + cache.read tokens).
   *
   * Reference dedup semantics: a repeated observation for the same message id
   * with a token count lower than or equal to the recorded latest is a stale
   * duplicate and is ignored; anything else updates the latest value, sets the
   * baseline on the first observation, and moves the last-token message id.
   *
   * Returns true when the observation was accepted, false when it was a stale
   * duplicate or no session exists for the id.
   */
  recordProviderTokens(sessionID: string, msgId: string, contextTokens: number): boolean {
    // Defensively reject non-finite or negative observations.
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
    const session = this.sessions.get(sessionID);
    if (!session) return false;
    if (
      session.lastTokenMessageId === msgId &&
      session.latestContextTokens !== null &&
      session.latestContextTokens >= contextTokens
    ) {
      return false;
    }
    session.lastTokenMessageId = msgId;
    if (session.baselineContextTokens === null) {
      session.baselineContextTokens = contextTokens;
    }
    session.latestContextTokens = contextTokens;
    session.lastActiveAt = Date.now();
    return true;
  }

  /**
   * Effective consumed context for enforcement: when provider ground truth
   * exists, provider delta (latest - baseline) plus the most recent locally
   * estimated output tokens; otherwise the legacy heuristic accumulation of
   * estimated input args and output tokens.
   */
  private effectiveContextTokens(session: SessionGuardState, latestOutputTokens: number): number {
    const { baselineContextTokens, latestContextTokens } = session;
    if (baselineContextTokens !== null && latestContextTokens !== null) {
      const providerDelta = Math.max(0, latestContextTokens - baselineContextTokens);
      return providerDelta + Math.max(0, latestOutputTokens);
    }
    return session.tokensInput + session.tokensOutput;
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

    // Resolve the effective profile exactly like every other enforcement
    // site; the defaults fallback never carries a finalization cap.
    const profile = this.resolveProfile(session.agentName, effectiveConfig);

    const policy = profile.finalization;

    // Bounded finalization: once every configured slot has been consumed,
    // every ordinary tool is blocked (exempt agents already returned above).
    if (profile.finalizationRemaining !== undefined) {
      if (session.finalizationToolsUsed >= profile.finalizationRemaining) return false;
    }

    if (!policy.allowedTools.includes(toolName)) return false;

    const targetPath = extractTargetPath(args);
    const allowedPaths = policy.allowedPaths;
    if (targetPath === undefined || !allowedPaths || allowedPaths.length === 0) return true;

    return allowedPaths.some((pattern) =>
      pathMatchesPattern(targetPath, pattern, this.workspaceRoot),
    );
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
    const limitInfo: CapacityLimitErrorInfo = {
      agentName: session.agentName,
      reason: session.exhaustionReason ?? "tool_limit",
      toolCount: session.toolCount,
      maxTools: profile.maxTools,
      tokensIngested: session.tokensIngested,
      maxTokens: profile.maxTokens,
    };
    if (session.stage === "finalization" && profile.finalizationRemaining !== undefined) {
      const remaining = profile.finalizationRemaining - session.finalizationToolsUsed;
      if (remaining <= 0) {
        const message =
          "Finalization calls exhausted for this subagent. Don't use more tools, henceforth they are blocked automatically. Proceed to report.";
        throw new CapacityLimitError(limitInfo, message);
      }
      throw new CapacityLimitError(
        limitInfo,
        `Finalization: ${remaining} call(s) remaining. Only ${profile.finalization.allowedTools.join(", ")} allowed.`,
      );
    }
    throw new CapacityLimitError(limitInfo);
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
      finalizationToolsUsed: session.finalizationToolsUsed,
      finalizationRemaining: profile.finalizationRemaining,
    };
  }

  private advanceStage(session: SessionGuardState): void {
    if (session.stage === "finalization") return;
    const config = this.configForSession(session.sessionID);
    if (this.isAgentExempt(session.agentName, config)) return;

    const profile = this.resolveProfile(session.agentName, config);
    // Bounded finalization begins R tool calls before the hard limit; profiles
    // without a configured cap keep the exact legacy maxTools threshold.
    const toolThreshold =
      profile.finalizationRemaining !== undefined
        ? profile.maxTools - profile.finalizationRemaining
        : profile.maxTools;
    if (session.toolCount >= toolThreshold) {
      this.transitionToFinalization(session.sessionID, "tool_limit");
      return;
    }
    if (session.tokensIngested >= profile.maxTokens) {
      this.transitionToFinalization(session.sessionID, "token_limit");
    }
  }
}
