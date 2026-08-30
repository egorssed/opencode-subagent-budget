import type { PluginInput, Hooks } from "@opencode-ai/plugin";

// --- Placeholder: agent-specific restriction table ---
// Resolved at runtime per-agent. Later steps will populate real entries.
// Structure: agentType -> restriction overrides (tool cap, token cap, finalization policy, etc.)
type AgentRestriction = {
  toolCap: number;
  tokenCap: number;
  finalizationRemaining?: number;
  finalizationAllowedTools?: string[];
  whitelistedTools?: string[];
};

const AGENT_RESTRICTION_TABLE: Record<string, AgentRestriction> = {
  "web-researcher": { toolCap: 9, tokenCap: 24000 },
  "unbiased-collector": { toolCap: 14, tokenCap: 48000 },
  "file-explorer": { toolCap: 15, tokenCap: 50000, whitelistedTools: ["lsp"] },
  "hoare-spec-formalizer": { toolCap: 4, tokenCap: 10000 },
  "hoare-checks": { toolCap: 10, tokenCap: 18000 },
  "hoare-planner": { toolCap: 4, tokenCap: 12000 },
  "hoare-plan-verifier": { toolCap: 5, tokenCap: 12000 },
  "hoare-impl-verifier": { toolCap: 12, tokenCap: 24000 },
  "code-reviewer": { toolCap: 12, tokenCap: 18000, whitelistedTools: ["lsp"] },
  "security-reviewer": { toolCap: 14, tokenCap: 24000, whitelistedTools: ["lsp"] },
  "planner": { toolCap: 15, tokenCap: 18000, finalizationRemaining: 2, finalizationAllowedTools: ["write", "edit", "apply_patch"], whitelistedTools: ["lsp"] },
  "doc-writer": { toolCap: 10, tokenCap: 10000, finalizationRemaining: 2, finalizationAllowedTools: ["write", "edit", "apply_patch"], whitelistedTools: ["lsp"] },
  "coder": { toolCap: 24, tokenCap: 48000, finalizationRemaining: 3, finalizationAllowedTools: ["write", "edit", "apply_patch"], whitelistedTools: ["context7*", "task", "lsp"] },
  "test-builder": { toolCap: 1, tokenCap: 4000 },
};

// --- Unified session state (one per sessionID) ---
// Core runtime model: all facts, restrictions, and outcomes are stored here.
// Additional fields for accounting and notification will be appended in later steps.
type SessionState = {
  sessionID: string;
  agentType: string | null;
  toolsCap: number | null;
  tokensCap: number | null;
  finalizationRemaining: number | null;
  finalizationAllowedTools: string[] | null;
  toolsUsed: number;
  whitelistedTools: string[] | null;
  baselineContextTokens: number | null;
  latestContextTokens: number | null;
  contextTokensConsumed: number | null;
  lastTokenMessageId: string | null;
  isHandoverWritten: boolean;
  lastBlockReason: string | null;
  phase: "execution" | "finalization";
  finalizationToolsUsed: number;
};

// --- In-memory store keyed by sessionID ---
// Sole runtime store; all primitives read/write through this map.
const sessions = new Map<string, SessionState>();

// --- Helpers ---

function ensureSession(sid: string): SessionState {
  let state = sessions.get(sid);
  if (!state) {
    state = {
      sessionID: sid,
      agentType: null,
      toolsCap: null,
      tokensCap: null,
      finalizationRemaining: null,
      finalizationAllowedTools: null,
      toolsUsed: 0,
      whitelistedTools: null,
      baselineContextTokens: null,
      latestContextTokens: null,
      contextTokensConsumed: null,
      lastTokenMessageId: null,
      isHandoverWritten: false,
      lastBlockReason: null,
      phase: "execution",
      finalizationToolsUsed: 0,
    };
    sessions.set(sid, state);
  }
  return state;
}

function resolveRestriction(agentType: string): AgentRestriction | null {
  return AGENT_RESTRICTION_TABLE[agentType] ?? null;
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function matchesWhitelist(tool: string, patterns: string[] | null): boolean {
  if (tool.startsWith("todo") || tool === "skill") return true;
  if (!patterns) return false;
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return tool.startsWith(pattern.slice(0, -1));
    }
    return tool === pattern;
  });
}

// --- Internal accounting payload ---
// Discriminated union so accounting can act on typed payloads
// instead of raw hook input.
type AccountingPayload =
  | {
      kind: "chat.params";
      agentType: string | null;
      toolsCap: number | null;
      tokensCap: number | null;
      finalizationRemaining: number | null;
      finalizationAllowedTools: string[] | null;
      whitelistedTools: string[] | null;
    }
    | { kind: "tool.execute.after"; tool: string; outputText: string }
  // Internal accounting kind (not an opencode hook name) — derived from "event" hook.
  | { kind: "event.token"; msgId: string; contextTokens: number };

// --- Primitive stubs (placeholder dispatch points) ---
// Each stub receives the session state and relevant hook input.
// Real logic will be filled in later steps.

function accounting(state: SessionState, payload: AccountingPayload): Record<string, unknown> {
  switch (payload.kind) {
    // Record session metadata and restriction policy from chat.params hook.
    case "chat.params": {
      const materialChanges: string[] = [];
      if (state.agentType !== payload.agentType) {
        materialChanges.push("agentType");
      }
      if (state.toolsCap !== payload.toolsCap) {
        materialChanges.push("toolsCap");
      }
      if (state.tokensCap !== payload.tokensCap) {
        materialChanges.push("tokensCap");
      }
      if (state.finalizationRemaining !== payload.finalizationRemaining) {
        materialChanges.push("finalizationRemaining");
      }
      if (JSON.stringify(state.finalizationAllowedTools) !== JSON.stringify(payload.finalizationAllowedTools)) {
        materialChanges.push("finalizationAllowedTools");
      }
      if (JSON.stringify(state.whitelistedTools) !== JSON.stringify(payload.whitelistedTools)) {
        materialChanges.push("whitelistedTools");
      }

      state.agentType = payload.agentType;
      state.toolsCap = payload.toolsCap;
      state.tokensCap = payload.tokensCap;
      state.finalizationRemaining = payload.finalizationRemaining;
      state.finalizationAllowedTools = payload.finalizationAllowedTools;
      state.whitelistedTools = payload.whitelistedTools;

      return {
        agentType: payload.agentType,
        toolsCap: payload.toolsCap,
        tokensCap: payload.tokensCap,
        finalizationRemaining: payload.finalizationRemaining,
        finalizationAllowedTools: payload.finalizationAllowedTools,
        materialChanges,
      };
    }
    // Track tool usage count and estimate context tokens consumed from tool output.
    case "tool.execute.after": {
      const previousToolsUsed = state.toolsUsed;
      const previousContextTokensConsumed = state.contextTokensConsumed;
      const baseline = state.baselineContextTokens;
      const latest = state.latestContextTokens;
      
      if (!matchesWhitelist(payload.tool, state.whitelistedTools)) {
        state.toolsUsed += 1;
      }

      const providerDelta =
        latest !== null && baseline !== null
          ? Math.max(0, latest - baseline)
          : 0;

      const estimatedOutputTokens = estimateTokens(payload.outputText);
      state.contextTokensConsumed = providerDelta + estimatedOutputTokens;

      return {
        outputLength: payload.outputText.length,
        estimatedOutputTokens,
        providerDelta,
        baselineContextTokens: baseline,
        latestContextTokens: latest,
        previousToolsUsed,
        newToolsUsed: state.toolsUsed,
        previousContextTokensConsumed,
        newContextTokensConsumed: state.contextTokensConsumed,
      };
    }
    // Track context token consumption from assistant message updates.
    // Effective input context is computed as input + cache.read (not cache.write, not reasoning).
    // NOTE: "event.token" is an internal accounting payload kind derived from
    // the generic "event" hook — it is not an opencode hook name.
    case "event.token": {
      const previousBaseline = state.baselineContextTokens;
      const previousLatest = state.latestContextTokens;
      const previousLastTokenMessageId = state.lastTokenMessageId;

      if (
        state.lastTokenMessageId === payload.msgId &&
        state.latestContextTokens !== null &&
        state.latestContextTokens >= payload.contextTokens
      ) {
        return {
          accepted: false,
          duplicate: true,
          ignoredReason: "same msgId with higher-or-equal token count already recorded",
          msgId: payload.msgId,
          contextTokens: payload.contextTokens,
          previousBaseline,
          previousLatest,
          previousLastTokenMessageId,
          newBaseline: state.baselineContextTokens,
          newLatest: state.latestContextTokens,
          newLastTokenMessageId: state.lastTokenMessageId,
        };
      }

      state.lastTokenMessageId = payload.msgId;

      if (state.baselineContextTokens === null) {
        state.baselineContextTokens = payload.contextTokens;
      }

      state.latestContextTokens = payload.contextTokens;

      return {
        accepted: true,
        duplicate: false,
        msgId: payload.msgId,
        contextTokens: payload.contextTokens,
        previousBaseline,
        previousLatest,
        previousLastTokenMessageId,
        newBaseline: state.baselineContextTokens,
        newLatest: state.latestContextTokens,
        newLastTokenMessageId: state.lastTokenMessageId,
      };
    }
  }
}

function notification(
  state: SessionState,
  _hookInput: Record<string, unknown>,
): string | null {
  const configured =
    state.finalizationRemaining != null &&
    state.finalizationAllowedTools != null &&
    Array.isArray(state.finalizationAllowedTools);
  const inFinalization = state.phase === "finalization" && configured;

  const budgetParts: string[] = [];
  let finalizationNotice: string | null = null;

  if (inFinalization) {
    budgetParts.push(
      `Finalization: ${state.finalizationToolsUsed}/${state.finalizationRemaining} finalization calls used (${state.finalizationRemaining! - state.finalizationToolsUsed} remaining). Allowed: ${state.finalizationAllowedTools!.join(", ")}.`,
    );
  } else if (state.toolsCap !== null) {
    const remaining = state.toolsCap - state.toolsUsed;
    const usage = `Tool budget: ${state.toolsUsed}/${state.toolsCap} used`;
    if (remaining > 0) {
      budgetParts.push(`${usage} (${remaining} remaining).`);
    } else if (remaining === 0) {
      budgetParts.push(`${usage} (No tool calls left).`);
    } else {
      budgetParts.push(`${usage}. Tool calls overdrafted by ${Math.abs(remaining)}. Finish immediately.`);
    }
  }

  if (state.tokensCap !== null && state.contextTokensConsumed !== null) {
    const consumed = state.contextTokensConsumed;
    const budget = state.tokensCap;
    const tokenRemaining = budget - consumed;

    if (consumed >= budget) {
      budgetParts.push(
        `🚫 TOKEN BUDGET EXCEEDED (${consumed}/${budget}).`,
      );
    } else {
      const ratio = budget > 0 ? consumed / budget : 0;
      if (ratio >= 0.75) {
        budgetParts.push(
          `🚨 CRITICAL: Only ${tokenRemaining} tokens remaining (${consumed}/${budget}).`,
        );
      } else if (ratio >= 0.50) {
        budgetParts.push(
          `⚠️ WARNING: ${tokenRemaining} tokens remaining (${consumed}/${budget}).`,
        );
      } else {
        budgetParts.push(
          `📊 Token budget: ${consumed}/${budget} used (${tokenRemaining} remaining).`,
        );
      }
    }
  }

  if (inFinalization) {
    if (state.finalizationToolsUsed === 0) {
      finalizationNotice =
        `⚠️ FORCEFUL WRAP-UP: You have exactly ${state.finalizationRemaining} finalization call(s) remaining. Stop exploring and start producing your deliverable immediately.`;
    } else if (state.finalizationToolsUsed === state.finalizationRemaining! - 1) {
      finalizationNotice =
        `🚨 LAST CALL: This is your FINAL tool call. You must produce your deliverable NOW.`;
    }
  } else if (state.finalizationRemaining !== null && state.toolsCap !== null) {
    const remaining = state.toolsCap - state.toolsUsed;

    if (remaining === state.finalizationRemaining) {
      finalizationNotice =
        `⚠️ FORCEFUL WRAP-UP: You have exactly ${remaining} tool calls remaining. Stop exploring and start producing your deliverable immediately.`;
    } else if (remaining === 1) {
      finalizationNotice =
        `🚨 LAST CALL: This is your FINAL tool call. You must produce your deliverable NOW.`;
    }
  }

  const resultParts: string[] = [];
  if (budgetParts.length > 0) {
    resultParts.push(`\n\n---\n${budgetParts.join(" ")}`);
  }
  if (finalizationNotice) {
    resultParts.push(`\n\n${finalizationNotice}`);
  }

  const handoverSuffix = handoverAdvice(state);
  if (handoverSuffix) {
    if (inFinalization) {
      if (
        state.finalizationToolsUsed >= state.finalizationRemaining! ||
        state.isHandoverWritten
      ) {
        resultParts.push(`\n\n${handoverSuffix}`);
      }
    } else {
      const toolsExhausted = state.toolsCap !== null && state.toolsCap - state.toolsUsed === 0;
      const finalizationStart = state.toolsCap !== null && state.finalizationRemaining !== null && state.toolsCap - state.toolsUsed === state.finalizationRemaining;
      const tokensExhausted = state.tokensCap !== null && state.contextTokensConsumed !== null && state.contextTokensConsumed >= state.tokensCap;
      if (toolsExhausted || finalizationStart || tokensExhausted) {
        resultParts.push(`\n\n${handoverSuffix}`);
      }
    }
  }

  if (resultParts.length === 0) return null;
  return resultParts.join("");
}

function isAllowedHandover(
  state: SessionState,
  hookInput: Record<string, unknown>,
): boolean {
  if (state.isHandoverWritten) return false;
  if (!state.agentType) return false;
  if (!state.finalizationAllowedTools || !Array.isArray(state.finalizationAllowedTools)) return false;
  if (typeof hookInput.tool !== "string") return false;
  if (!state.finalizationAllowedTools.includes(hookInput.tool)) return false;

  const args = hookInput.args as Record<string, unknown> | undefined;
  if (!args) return false;
  const filePath = args.filePath;
  if (typeof filePath !== "string") return false;

  const handoverFile = `Handovers/SCRATCH_${state.agentType}_${state.sessionID}.md`;
  if (filePath === handoverFile) return true;
  if (filePath.endsWith(`/${handoverFile}`)) return true;

  return false;
}

function handoverAdvice(state: SessionState): string {
  if (!state.agentType || !state.finalizationAllowedTools || !Array.isArray(state.finalizationAllowedTools)) {
    return "";
  }
  if (state.isHandoverWritten) {
    return ` Handover has been written to Handovers/SCRATCH_${state.agentType}_${state.sessionID}.md.`;
  }
  return ` If the task remains unfinished, you may preserve the critical context so another agent can complete it efficiently. For that write handover to Handovers/SCRATCH_${state.agentType}_${state.sessionID}.md.`;
}

function isHandoverWriteCall(
  state: SessionState,
  hookInput: Record<string, unknown>,
): boolean {
  if (!state.agentType) return false;
  const args = hookInput.args as Record<string, unknown> | undefined;
  if (!args) return false;
  const filePath = args.filePath;
  if (typeof filePath !== "string") return false;

  const handoverFile = `Handovers/SCRATCH_${state.agentType}_${state.sessionID}.md`;
  if (filePath === handoverFile) return true;
  if (filePath.endsWith(`/${handoverFile}`)) return true;

  return false;
}

function evaluateTransition(state: SessionState): void {
  if (state.phase !== "execution") return;
  if (
    state.finalizationRemaining == null ||
    state.finalizationAllowedTools == null ||
    state.toolsCap == null
  ) {
    return;
  }
  const toolThreshold = state.toolsCap - state.finalizationRemaining;
  const tokenHit =
    state.tokensCap != null &&
    state.contextTokensConsumed != null &&
    state.contextTokensConsumed >= state.tokensCap;
  const toolHit = state.toolsUsed >= toolThreshold;
  if (toolHit || tokenHit) state.phase = "finalization";
}

function restriction(
  state: SessionState,
  _hookInput: Record<string, unknown>,
): { block: boolean; reason?: string } {
  const configured =
    state.finalizationRemaining != null &&
    state.finalizationAllowedTools != null &&
    Array.isArray(state.finalizationAllowedTools);

  if (!configured) {
    if (
      state.tokensCap !== null &&
      state.contextTokensConsumed !== null &&
      state.contextTokensConsumed >= state.tokensCap
    ) {
      if (isAllowedHandover(state, _hookInput)) {
        state.isHandoverWritten = true;
        return { block: false };
      }
      return {
        block: true,
        reason: `CONTEXT TOKEN BUDGET EXCEEDED. ${state.tokensCap}-token limit reached. Don't use more tools, henceforth they are blocked automatically. Proceed to report.` + handoverAdvice(state),
      };
    }

    if (
      state.toolsCap !== null &&
      state.toolsUsed >= state.toolsCap
    ) {
      if (isAllowedHandover(state, _hookInput)) {
        state.isHandoverWritten = true;
        return { block: false };
      }
      return {
        block: true,
        reason: `Tool-call budget exhausted for this subagent. Don't use more tools, henceforth they are blocked automatically. Proceed to report.` + handoverAdvice(state),
      };
    }

    return { block: false };
  }

  if (state.phase === "execution") {
    return { block: false };
  }

  const remainingFinalization = state.finalizationRemaining! - state.finalizationToolsUsed;

  if (state.finalizationToolsUsed >= state.finalizationRemaining!) {
    if (isAllowedHandover(state, _hookInput)) {
      state.isHandoverWritten = true;
      return { block: false };
    }
    return {
      block: true,
      reason: `Finalization calls exhausted for this subagent. Don't use more tools, henceforth they are blocked automatically. Proceed to report.` + handoverAdvice(state),
    };
  }

  if (
    typeof _hookInput.tool === "string" &&
    state.finalizationAllowedTools!.includes(_hookInput.tool)
  ) {
    return { block: false };
  }

  return {
    block: true,
    reason: `Finalization: ${remainingFinalization} call(s) remaining. Only ${state.finalizationAllowedTools!.join(", ")} allowed.`,
  };
}

// --- Plugin export ---

async function handleAssistantTokenUpdate(
  event: Record<string, unknown>,
): Promise<void> {
  const evt = (event as any).event as Record<string, unknown> | undefined;
  if (!evt) return;

  if (evt.type !== "message.updated") return;

  const info = (evt.properties as Record<string, unknown> | undefined)
    ?.info as Record<string, unknown> | undefined;
  if (!info || info.role !== "assistant") return;

  const tokens = info.tokens as Record<string, unknown> | undefined;
  if (!tokens) return;
  const inputVal = Number(tokens.input) || 0;
  const cacheReadVal = Number((tokens.cache as Record<string, unknown> | undefined)?.read) || 0;
  const contextTokens = inputVal + cacheReadVal;
  if (contextTokens <= 0) return;

  const sid =
    (info.sessionID as string) ||
    ((evt.properties as Record<string, unknown>)?.sessionID as string);
  if (typeof sid !== "string") return;

  const msgId = info.id as string;
  if (typeof msgId !== "string") return;

  const state = ensureSession(sid);

  accounting(state, {
    kind: "event.token",
    msgId,
    contextTokens,
  });
}

export const server = async (_input: PluginInput): Promise<Hooks> => {
  return {
    "chat.params": async (input) => {
      if (typeof input.sessionID !== "string") return;
      if (typeof input.agent !== "string") return;
      const state = ensureSession(input.sessionID);

      const agentType = input.agent;
      const restriction = resolveRestriction(input.agent);

      accounting(state, {
        kind: "chat.params",
        agentType,
        toolsCap: restriction?.toolCap ?? null,
        tokensCap: restriction?.tokenCap ?? null,
        finalizationRemaining: restriction?.finalizationRemaining ?? null,
        finalizationAllowedTools: restriction?.finalizationAllowedTools ?? null,
        whitelistedTools: restriction?.whitelistedTools ?? null,
      });
    },

    "tool.execute.before": async (input, output) => {
      if (typeof input.sessionID !== "string") return;
      const state = sessions.get(input.sessionID);
      if (!state || !state.agentType) return;

      const result = restriction(state, { ...input, args: (output as Record<string, unknown>)?.args } as unknown as Record<string, unknown>);
      if (result.block) {
        throw new Error(result.reason);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (typeof input.sessionID !== "string") return;
      const state = sessions.get(input.sessionID);
      if (!state || !state.agentType) return;

      accounting(state, {
        kind: "tool.execute.after",
        tool: String(input.tool ?? ""),
        outputText: String(output.output ?? ""),
      });

      const wasFinalization = state.phase === "finalization";
      evaluateTransition(state);
      if (
        state.phase === "finalization" &&
        wasFinalization &&
        !isHandoverWriteCall(state, input as unknown as Record<string, unknown>)
      ) {
        state.finalizationToolsUsed += 1;
      }

      const notice = notification(
        state,
        input as unknown as Record<string, unknown>,
      );

      if (notice) {
        if (typeof output.output === "string") {
          output.output = output.output + notice;
        } else if (output.output === undefined || output.output === null || output.output === "") {
          output.output = notice;
        }
      }

      if (state.isHandoverWritten && isHandoverWriteCall(state, input as unknown as Record<string, unknown>)) {
        const reminder = `\n\nIn your final report, explicitly mention that you wrote a handover to Handovers/SCRATCH_${state.agentType}_${state.sessionID}.md.`;
        if (typeof output.output === "string") {
          output.output = output.output + reminder;
        } else {
          output.output = reminder;
        }
      }

    },

    event: handleAssistantTokenUpdate,
  };
};