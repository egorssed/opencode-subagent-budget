import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";
import {
  countNewlines,
  estimateArgsTokens,
  estimateTokens,
  estimateToolOutputTokens,
  extractOutputText,
} from "../src/core/estimator.ts";
import {
  CALLID_DEDUP_CAPACITY,
  CapacityLimitError,
  formatCapacityBreachMessage,
  matchesWhitelist,
  pathMatchesPattern,
  SessionStateManager,
  toolMatchesPattern,
} from "../src/core/state.ts";
import type { ContextGuardOptions, ResolvedContextGuardConfig } from "../src/types.ts";
import { server } from "../src/index.ts";

const ENV_KEYS = [
  "OPENCODE_CONTEXT_GUARD_ENABLED",
  "OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS",
  "OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS",
  "OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS",
] as const;

function withEnv(entries: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(entries)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

function makeConfig(options: ContextGuardOptions): ResolvedContextGuardConfig {
  return resolveConfig(options as unknown as PluginOptions);
}

async function callHook(
  hook: unknown,
  input: Record<string, unknown>,
  output: Record<string, unknown> = {},
): Promise<void> {
  await (hook as (i: Record<string, unknown>, o: Record<string, unknown>) => Promise<unknown>)(
    input,
    output,
  );
}

describe("agent budget resolution and overrides", () => {
  test("partial agent override inherits every untouched field", () => {
    const [agentName, baseline] = Object.entries(DEFAULT_CONFIG.agents)[0] ?? [];
    assert.ok(agentName, "DEFAULT_CONFIG must define at least one agent");
    assert.ok(baseline, "DEFAULT_CONFIG agent entry must be defined");

    const overriddenMaxTools = baseline.maxTools + 1;
    const config = resolveConfig({ agents: { [agentName]: { maxTools: overriddenMaxTools } } } as PluginOptions);
    const { maxTools, ...untouchedResolvedFields } = config.agents[agentName];
    const { maxTools: baselineMaxTools, ...untouchedBaselineFields } = baseline;

    assert.equal(maxTools, overriddenMaxTools);
    assert.deepEqual(untouchedResolvedFields, untouchedBaselineFields);
  });

  test("explicit finalizationRemaining 0 falls back to unset", () => {
    const config = makeConfig({ agents: { custom: { finalizationRemaining: 0 } } });
    assert.equal(config.agents.custom.finalizationRemaining, undefined);
  });

  test("resolved whitelistedTools is a copy, not the configured array", () => {
    const entry = { name: "read", allowedPaths: [".cheatsheet.md"] };
    const whitelistedTools = ["lsp", entry];
    const config = makeConfig({ agents: { custom: { whitelistedTools } } });
    assert.deepEqual(config.agents.custom.whitelistedTools, ["lsp", entry]);
    assert.notEqual(config.agents.custom.whitelistedTools, whitelistedTools);
    assert.notEqual(config.agents.custom.whitelistedTools![1], entry);
    assert.notEqual(
      (config.agents.custom.whitelistedTools![1] as { allowedPaths?: string[] }).allowedPaths,
      entry.allowedPaths,
    );
  });

  test("agent only present in options still resolves with defaults", () => {
    const config = makeConfig({ agents: { explore: { maxTools: 3 } } });
    assert.equal(config.agents.explore.maxTools, 3);
    assert.equal(config.agents.explore.maxTokens, 40000);
  });
});

describe("resolveConfig hierarchical resolution", () => {
  test("no options resolves to DEFAULT_CONFIG", () => {
    const config = resolveConfig();
    assert.equal(config.defaults.maxTools, DEFAULT_CONFIG.defaults.maxTools);
    assert.equal(config.defaults.maxTokens, DEFAULT_CONFIG.defaults.maxTokens);
    assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  });

  test("defaults override via options", () => {
    const config = makeConfig({ defaults: { maxTools: 5, maxTokens: 10000 } });
    assert.equal(config.defaults.maxTools, 5);
    assert.equal(config.defaults.maxTokens, 10000);
  });

  test("invalid option values fall back to defaults", () => {
    const config = makeConfig({ defaults: { maxTools: 0, maxTokens: -3 } });
    assert.equal(config.defaults.maxTools, 15);
    assert.equal(config.defaults.maxTokens, 40000);
  });

  test("Infinity accepted as unlimited", () => {
    const config = makeConfig({ defaults: { maxTools: Infinity, maxTokens: Infinity } });
    assert.equal(config.defaults.maxTools, Infinity);
    assert.equal(config.defaults.maxTokens, Infinity);
  });

  test("per-agent overrides resolve with defaults for missing keys", () => {
    const config = makeConfig({
      agents: {
        explore: { maxTools: 3, finalization: { allowedTools: ["read"] } },
      },
    });
    assert.deepEqual(config.agents.explore, {
      enabled: true,
      enabledExplicit: false,
      maxTools: 3,
      maxTokens: 40000,
      finalization: { allowedTools: ["read"], allowedPaths: [] },
      whitelistedTools: undefined,
      finalizationRemaining: undefined,
    });
  });

  test("agent disabled flag respected", () => {
    const config = makeConfig({ agents: { legacy: { enabled: false } } });
    assert.equal(config.agents.legacy.enabled, false);
  });

  test("explicit enabled:true sets enabledExplicit", () => {
    const config = makeConfig({ agents: { build: { enabled: true, maxTools: 2 } } });
    assert.equal(config.agents.build.enabledExplicit, true);
    assert.equal(config.agents.build.enabled, true);
  });

  test("agent finalization merges with defaults", () => {
    const config = makeConfig({
      agents: { w: { finalization: { allowedTools: ["write"] } } },
    });
    assert.deepEqual(config.agents.w.finalization.allowedPaths, []);
    assert.deepEqual(config.agents.w.finalization.allowedTools, ["write"]);
  });

  test("env enabled=false applies when no explicit option", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_ENABLED: "false" }, () => {
      assert.equal(resolveConfig().enabled, false);
    });
  });

  test("env enabled=0 applies when no explicit option", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_ENABLED: "0" }, () => {
      assert.equal(resolveConfig().enabled, false);
    });
  });

  test("explicit enabled option wins over env", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_ENABLED: "false" }, () => {
      assert.equal(makeConfig({ enabled: true }).enabled, true);
    });
  });

  test("env default limits apply without explicit option", () => {
    withEnv(
      {
        OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS: "7",
        OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOKENS: "9000",
      },
      () => {
        const config = resolveConfig();
        assert.equal(config.defaults.maxTools, 7);
        assert.equal(config.defaults.maxTokens, 9000);
      },
    );
  });

  test("explicit defaults win over env", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS: "7" }, () => {
      assert.equal(makeConfig({ defaults: { maxTools: 5 } }).defaults.maxTools, 5);
    });
  });

  test("env primary agents list parsed", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS: "arch, reviewer" }, () => {
      assert.deepEqual(resolveConfig().primaryAgents, ["arch", "reviewer"]);
    });
  });

  test("explicit primaryAgents win over env", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS: "arch" }, () => {
      assert.deepEqual(makeConfig({ primaryAgents: ["build"] }).primaryAgents, ["build"]);
    });
  });

  test("invalid env values fall back to defaults", () => {
    withEnv(
      {
        OPENCODE_CONTEXT_GUARD_ENABLED: "banana",
        OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS: "abc",
        OPENCODE_CONTEXT_GUARD_PRIMARY_AGENTS: "",
      },
      () => {
        const config = resolveConfig();
        assert.equal(config.enabled, true);
        assert.equal(config.defaults.maxTools, 15);
        assert.deepEqual(config.primaryAgents, ["build", "plan", "orchestrator"]);
      },
    );
  });

  test("env Infinity limit accepted", () => {
    withEnv({ OPENCODE_CONTEXT_GUARD_DEFAULT_MAX_TOOLS: "Infinity" }, () => {
      assert.equal(resolveConfig().defaults.maxTools, Infinity);
    });
  });
});

describe("token estimation and payload extraction", () => {
  test("empty string is zero tokens", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("~4 chars per token with ceiling", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("a".repeat(100)), 25);
  });

  test("12000 chars estimate ~3000 tokens", () => {
    assert.equal(estimateTokens("a".repeat(12000)), 3000);
  });

  test("countNewlines counts line breaks", () => {
    assert.equal(countNewlines(""), 0);
    assert.equal(countNewlines("a\nb\nc"), 2);
    assert.equal(countNewlines("x".repeat(10)), 0);
  });

  test("plain string output passed through", () => {
    assert.equal(extractOutputText("hello world"), "hello world");
  });

  test("structured output.output extracted", () => {
    assert.equal(extractOutputText({ output: "hello" }), "hello");
  });

  test("nested output object stringified", () => {
    assert.equal(extractOutputText({ output: { nested: "x" } }), '{"nested":"x"}');
  });

  test("array of outputs joined by newline", () => {
    assert.equal(extractOutputText([{ output: "a" }, { output: "b" }]), "a\nb");
  });

  test("plain object stringified", () => {
    assert.equal(extractOutputText({ a: 1 }), '{"a":1}');
  });

  test("primitives stringified", () => {
    assert.equal(extractOutputText(42), "42");
    assert.equal(extractOutputText(true), "true");
  });

  test("error message extracted", () => {
    assert.equal(extractOutputText(new Error("boom")), "boom");
  });

  test("nullish output is empty", () => {
    assert.equal(extractOutputText(null), "");
    assert.equal(extractOutputText(undefined), "");
  });

  test("circular object does not throw", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(typeof extractOutputText(circular), "string");
  });

  test("JSON string with output field parsed", () => {
    assert.equal(extractOutputText('{"output":"hi"}'), "hi");
  });

  test("JSON string literal parsed", () => {
    assert.equal(extractOutputText('"hi"'), "hi");
  });

  test("non-JSON string starting with brace stays raw", () => {
    assert.equal(extractOutputText("{not json"), "{not json");
  });

  test("string output token estimation", () => {
    assert.equal(estimateToolOutputTokens("a".repeat(12000)), 3000);
  });

  test("structured output counts text content only", () => {
    assert.equal(
      estimateToolOutputTokens({ output: "a".repeat(400), extra: "x".repeat(4000) }),
      100,
    );
  });

  test("empty and nullish outputs are zero", () => {
    assert.equal(estimateToolOutputTokens(""), 0);
    assert.equal(estimateToolOutputTokens(null), 0);
  });
});

describe("SessionStateManager lifecycle", () => {
  test("session initialized in execution with zero metrics", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 3, maxTokens: 100 } }));
    const s = m.getOrCreateSession("s1", "explore");
    assert.equal(s.stage, "execution");
    assert.equal(s.toolCount, 0);
    assert.equal(s.toolCallsAttempted, 0);
    assert.equal(s.toolCallsSucceeded, 0);
    assert.equal(s.tokensInput, 0);
    assert.equal(s.tokensOutput, 0);
    assert.equal(s.tokensIngested, 0);
    assert.equal(s.finalizationToolsUsed, 0);
    assert.equal(s.exhaustionReason, null);
    assert.equal(s.agentName, "explore");
    assert.equal(s.sessionID, "s1");
    assert.equal(typeof s.createdAt, "number");
    assert.equal(typeof s.lastActiveAt, "number");
  });

  test("getOrCreateSession is idempotent per sessionID", () => {
    const m = new SessionStateManager(makeConfig({}));
    const first = m.getOrCreateSession("s1", "explore");
    const second = m.getOrCreateSession("s1", "explore");
    assert.equal(first, second);
    assert.equal(m.getSession("s1"), first);
  });

  test("getSession returns undefined for unknown session", () => {
    const m = new SessionStateManager(makeConfig({}));
    assert.equal(m.getSession("nope"), undefined);
  });

  test("tool threshold transitions at exact limit", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 3, maxTokens: 1000 } }));
    m.getOrCreateSession("s1", "explore");
    m.recordToolExecution("s1", "");
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "execution");
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
    assert.equal(m.getSession("s1")!.exhaustionReason, "tool_limit");
  });

  test("token threshold transitions at exact limit", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 100 } }));
    m.getOrCreateSession("s1", "explore");
    m.recordTokens("s1", 99);
    assert.equal(m.getSession("s1")!.stage, "execution");
    m.recordTokens("s1", 1);
    assert.equal(m.getSession("s1")!.stage, "finalization");
    assert.equal(m.getSession("s1")!.exhaustionReason, "token_limit");
  });

  test("overshoot token ingestion finalizes", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTokens: 2000 } }));
    m.getOrCreateSession("s1", "explore");
    m.recordTokens("s1", 3000);
    assert.equal(m.getSession("s1")!.stage, "finalization");
    assert.equal(m.getSession("s1")!.exhaustionReason, "token_limit");
  });

  test("recordToolExecution accumulates output tokens", () => {
    const m = new SessionStateManager(
      makeConfig({ defaults: { maxTools: 99, maxTokens: 10000 } }),
    );
    m.getOrCreateSession("s1", "explore");
    m.recordToolExecution("s1", "a".repeat(400));
    assert.equal(m.getSession("s1")!.tokensIngested, 100);
    assert.equal(m.getSession("s1")!.toolCount, 1);
  });

  test("records on unknown session are no-ops", () => {
    const m = new SessionStateManager(makeConfig({}));
    assert.doesNotThrow(() => m.recordToolExecution("ghost", "x"));
    assert.doesNotThrow(() => m.recordTokens("ghost", 5));
    assert.doesNotThrow(() => m.recordToolAttempt("ghost"));
    assert.doesNotThrow(() => m.recordToolSuccess("ghost", 0, "x"));
  });

  test("transitionToFinalization is one-way", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1 } }));
    m.getOrCreateSession("s1", "explore");
    const s = m.transitionToFinalization("s1", "manual")!;
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "manual");
    m.recordToolExecution("s1", "");
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "manual");
  });

  test("manual transition does not downgrade existing reason", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1 } }));
    m.getOrCreateSession("s1", "explore");
    m.recordToolExecution("s1", "");
    m.transitionToFinalization("s1", "manual");
    assert.equal(m.getSession("s1")!.exhaustionReason, "tool_limit");
  });

  test("getRemainingBudget reports remaining metrics", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 5, maxTokens: 100 } }));
    m.getOrCreateSession("s1", "explore");
    m.recordToolExecution("s1", "a".repeat(40));
    const budget = m.getRemainingBudget("s1")!;
    assert.equal(budget.remainingTools, 4);
    assert.equal(budget.tokensIngested, 10);
    assert.equal(budget.remainingTokens, 90);
    assert.equal(budget.exempt, false);
    assert.equal(budget.stage, "execution");
    assert.equal(m.getRemainingBudget("unknown"), undefined);
  });

  test("sessions are isolated per sessionID", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1 } }));
    m.getOrCreateSession("a", "explore");
    m.getOrCreateSession("b", "explore");
    m.recordToolExecution("a", "");
    assert.equal(m.getSession("a")!.stage, "finalization");
    assert.equal(m.getSession("b")!.stage, "execution");
  });

  test("per-session config overrides global config", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 5 } }));
    m.getOrCreateSession("s1", "explore", makeConfig({ defaults: { maxTools: 1 } }));
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
  });

  test("default config guards at 15 tools", () => {
    const m = new SessionStateManager();
    m.getOrCreateSession("s1", "explore");
    for (let i = 0; i < 14; i++) m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "execution");
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
  });

  test("resolveProfile falls back to defaults for unknown agent", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 7, maxTokens: 500 } }));
    assert.deepEqual(m.resolveProfile("ghost"), {
      enabled: true,
      enabledExplicit: false,
      maxTools: 7,
      maxTokens: 500,
      finalization: { allowedTools: [], allowedPaths: [] },
    });
  });
});

describe("finalization whitelist enforcement", () => {
  test("allowedTools support glob wildcards", () => {
    const manager = new SessionStateManager(
      makeConfig({
        agents: {
          tester: {
            maxTools: 1,
            finalization: { allowedTools: ["write*"] },
          },
        },
      }),
    );
    manager.getOrCreateSession("s1", "tester");
    manager.transitionToFinalization("s1", "tool_limit");

    assert.equal(manager.isOperationPermittedInFinalization("s1", "write_file"), true);
    assert.equal(manager.isOperationPermittedInFinalization("s1", "read"), false);
  });

  const writerConfig = (): ContextGuardOptions => ({
    defaults: { maxTools: 99, maxTokens: 99000, finalization: { allowedTools: [], allowedPaths: [] } },
    agents: {
      writer: {
        maxTools: 2,
        maxTokens: 99000,
        finalization: { allowedTools: ["write", "edit"], allowedPaths: ["./reports/**"] },
      },
    },
  });

  function exhaustedWriter(): SessionStateManager {
    const m = new SessionStateManager(makeConfig(writerConfig()));
    m.getOrCreateSession("s1", "writer");
    m.recordToolExecution("s1", "");
    m.recordToolExecution("s1", "");
    return m;
  }

  test("execution stage permits any operation", () => {
    const m = new SessionStateManager(makeConfig(writerConfig()));
    m.getOrCreateSession("s1", "writer");
    assert.equal(m.isOperationPermittedInFinalization("s1", "bash", {}), true);
  });

  test("unknown session permits", () => {
    const m = new SessionStateManager(makeConfig({}));
    assert.equal(m.isOperationPermittedInFinalization("ghost", "bash", {}), true);
  });

  test("tool name not in whitelist is blocked", () => {
    const m = exhaustedWriter();
    assert.equal(m.isOperationPermittedInFinalization("s1", "read", { filePath: "./reports/x.md" }), false);
    assert.equal(m.isOperationPermittedInFinalization("s1", "bash", {}), false);
  });

  test("whitelisted tool with matching path allowed", () => {
    const m = exhaustedWriter();
    assert.equal(
      m.isOperationPermittedInFinalization("s1", "write", { filePath: "./reports/summary.md" }),
      true,
    );
    assert.equal(
      m.isOperationPermittedInFinalization("s1", "edit", { path: "./reports/deep/nested.md" }),
      true,
    );
  });

  test("whitelisted tool with out-of-scope path blocked", () => {
    const m = exhaustedWriter();
    assert.equal(
      m.isOperationPermittedInFinalization("s1", "write", { filePath: "./src/index.ts" }),
      false,
    );
  });

  test("whitelisted tool with undefined path allowed", () => {
    const m = exhaustedWriter();
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), true);
  });

  test("filePath argument wins over path argument", () => {
    const m = exhaustedWriter();
    assert.equal(
      m.isOperationPermittedInFinalization("s1", "write", {
        filePath: "./src/index.ts",
        path: "./reports/x.md",
      }),
      false,
    );
  });

  test("empty allowedPaths leaves paths unconstrained", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          w: { maxTools: 1, finalization: { allowedTools: ["write"], allowedPaths: [] } },
        },
      }),
    );
    m.getOrCreateSession("s1", "w");
    m.transitionToFinalization("s1", "manual");
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", { filePath: "/anywhere/x.md" }), true);
  });

  test("assertOperationPermitted allows whitelisted operation", () => {
    const m = exhaustedWriter();
    assert.doesNotThrow(() =>
      m.assertOperationPermitted("s1", "write", { filePath: "./reports/summary.md" }),
    );
  });

  test("assertOperationPermitted throws with contract message and fields", () => {
    const m = exhaustedWriter();
    const expected = [
      '[Capacity Guard] Session limit reached for agent "@writer".',
      "Current stage: FINALIZATION",
      "Limit exceeded: tool_limit (Used: 2/2 tools, 0/99000 tokens).",
      "Action required: Tool execution is restricted in finalization stage. Please summarize your findings or provide your final report in your text response.",
    ].join("\n");

    let caught: unknown;
    try {
      m.assertOperationPermitted("s1", "bash", {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CapacityLimitError);
    const error = caught as CapacityLimitError;
    assert.equal(error.name, "CapacityLimitError");
    assert.equal(error.message, expected);
    assert.equal(error.agentName, "writer");
    assert.equal(error.reason, "tool_limit");
    assert.equal(error.toolCount, 2);
    assert.equal(error.maxTools, 2);
    assert.equal(error.tokensIngested, 0);
    assert.equal(error.maxTokens, 99000);
    assert.equal(
      formatCapacityBreachMessage({
        agentName: "writer",
        reason: "tool_limit",
        toolCount: 2,
        maxTools: 2,
        tokensIngested: 0,
        maxTokens: 99000,
      }),
      expected,
    );
  });

  test("pathMatchesPattern glob semantics", () => {
    assert.equal(pathMatchesPattern("./reports/x.md", "./reports/*"), true);
    assert.equal(pathMatchesPattern("./reports/a/b.md", "./reports/*"), false);
    assert.equal(pathMatchesPattern("./reports/a/b/c.md", "./reports/**"), true);
    assert.equal(pathMatchesPattern("./reports", "./reports/**"), true);
    assert.equal(pathMatchesPattern(".opencode/notes.md", ".opencode/notes.md"), true);
    assert.equal(pathMatchesPattern("./reports/x.md", "./reports"), true);
    assert.equal(pathMatchesPattern("./reports2/x.md", "./reports"), false);
    assert.equal(pathMatchesPattern("reports/x.md", "./reports/*"), true);
    assert.equal(pathMatchesPattern("./src/a.ts", "./reports/**"), false);
    assert.equal(pathMatchesPattern("./x.md", ""), false);
  });
});

describe("primary agent exemption", () => {
  test("primary agent never transitions", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1, maxTokens: 10 } }));
    m.getOrCreateSession("s1", "build");
    for (let i = 0; i < 25; i++) m.recordToolExecution("s1", "x".repeat(1000));
    assert.equal(m.getSession("s1")!.stage, "execution");
    assert.equal(m.getSession("s1")!.toolCount, 25);
  });

  test("primary agent budget is infinite", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 3, maxTokens: 100 } }));
    m.getOrCreateSession("s1", "build");
    const budget = m.getRemainingBudget("s1")!;
    assert.equal(budget.exempt, true);
    assert.equal(budget.maxTools, Infinity);
    assert.equal(budget.maxTokens, Infinity);
    assert.equal(budget.remainingTools, Infinity);
    assert.equal(budget.remainingTokens, Infinity);
  });

  test("isAgentExempt true for primary and explicitly disabled agents", () => {
    const m = new SessionStateManager(makeConfig({ agents: { legacy: { enabled: false } } }));
    assert.equal(m.isAgentExempt("build"), true);
    assert.equal(m.isAgentExempt("plan"), true);
    assert.equal(m.isAgentExempt("legacy"), true);
    assert.equal(m.isAgentExempt("explore"), false);
  });

  test("explicitly disabled non-primary agent stays exempt", () => {
    const m = new SessionStateManager(
      makeConfig({ agents: { legacy: { enabled: false, maxTools: 1 } } }),
    );
    m.getOrCreateSession("s1", "legacy");
    m.recordToolExecution("s1", "x");
    assert.equal(m.getSession("s1")!.stage, "execution");
  });

  test("primary agent permitted even when manually finalized", () => {
    const m = new SessionStateManager(
      makeConfig({ defaults: { maxTools: 1, finalization: { allowedTools: [] } } }),
    );
    m.getOrCreateSession("s1", "build");
    m.transitionToFinalization("s1", "manual");
    assert.equal(m.isOperationPermittedInFinalization("s1", "bash", {}), true);
    assert.doesNotThrow(() => m.assertOperationPermitted("s1", "bash", {}));
  });
});

describe("plugin server hooks", () => {
  test("scenario A: normal ingestion tracked without disruption", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 5, maxTokens: 10000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sA", agent: "explore" });
    await callHook(hooks["tool.execute.before"], { sessionID: "sA", tool: "grep" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sA" }, { output: "x".repeat(6000) });
    await callHook(hooks["tool.execute.before"], { sessionID: "sA", tool: "read" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sA" }, { output: "y".repeat(1000) });
    await callHook(hooks["tool.execute.before"], { sessionID: "sA", tool: "glob" }, { args: {} });
  });

  test("scenario B: 4th tool call blocked at tool limit", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 3, maxTokens: 10000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sB", agent: "general" });
    for (let i = 0; i < 3; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sB" }, { output: "" });
    }
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "tool_limit",
    );
  });

  test("scenario C: token exhaustion blocks next call", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTokens: 2000, maxTools: 99 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sC", agent: "explore" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sC" }, { output: "a".repeat(12000) });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sC", tool: "glob" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });

  test("scenario D: finalization whitelist enforced through hooks", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: 99000, finalization: { allowedTools: [], allowedPaths: [] } },
      agents: {
        writer: {
          maxTools: 2,
          maxTokens: 99000,
          finalization: { allowedTools: ["write"], allowedPaths: ["./reports/**"] },
        },
      },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sD", agent: "writer" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sD" }, { output: "" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sD" }, { output: "" });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sD", tool: "read" }, { args: { filePath: "./package.json" } }),
      CapacityLimitError,
    );
    await callHook(hooks["tool.execute.before"], { sessionID: "sD", tool: "write" }, { args: { filePath: "./reports/summary.md" } });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sD", tool: "write" }, { args: { filePath: "./src/index.ts" } }),
      CapacityLimitError,
    );
  });

  test("scenario E: primary agent bypasses all capacity restrictions", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 2, maxTokens: 50 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sE", agent: "build" });
    for (let i = 0; i < 25; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sE", tool: "bash" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sE" }, { output: "x".repeat(5000) });
    }
  });

  test("after-hook estimates tokens from structured output", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: 100 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sT", agent: "explore" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sT" }, { output: { output: "a".repeat(400) } });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sT", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });

  test("plugin disabled via options returns no hooks", async () => {
    const hooks = await server(
      {} as unknown as PluginInput,
      makeConfig({ enabled: false }) as unknown as PluginOptions,
    );
    assert.deepEqual(hooks, {});
  });

  test("tool calls without registered session are ignored", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1 },
    }) as unknown as PluginOptions);
    await callHook(hooks["tool.execute.before"], { sessionID: "ghost", tool: "bash" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "ghost" }, { output: "x" });
    await callHook(hooks["tool.execute.before"], { sessionID: "ghost", tool: "bash" }, { args: {} });
  });
});

describe("T007 explicit profiles override primary exemption", () => {
  test("primary agent without profile stays exempt", () => {
    const m = new SessionStateManager(makeConfig({}));
    assert.equal(m.isAgentExempt("build"), true);
    assert.equal(m.isAgentExempt("plan"), true);
    assert.equal(m.isAgentExempt("orchestrator"), true);
  });

  test("explicit enabled:true profile constrains a primary agent", () => {
    const m = new SessionStateManager(
      makeConfig({ agents: { build: { enabled: true, maxTools: 2 } } }),
    );
    assert.equal(m.isAgentExempt("build"), false);
    const s = m.getOrCreateSession("s1", "build");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolSuccess("s1", 0, "");
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "tool_limit");
    const budget = m.getRemainingBudget("s1")!;
    assert.equal(budget.exempt, false);
    assert.equal(budget.maxTools, 2);
    assert.equal(budget.maxTokens, 40000);
  });

  test("explicit enabled:false keeps primary exemption", () => {
    const m = new SessionStateManager(makeConfig({ agents: { build: { enabled: false } } }));
    assert.equal(m.isAgentExempt("build"), true);
    const s = m.getOrCreateSession("s1", "build");
    for (let i = 0; i < 25; i++) m.recordToolSuccess("s1", 0, "x".repeat(1000));
    assert.equal(s.stage, "execution");
  });

  test("explicit enabled:false keeps non-primary agents exempt", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-disabled": {
            enabled: false,
            maxTools: 1,
            maxTokens: 10,
            finalization: { allowedTools: [] },
            whitelistedTools: [],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    assert.equal(m.isAgentExempt("fixture-disabled"), true);
    const s = m.getOrCreateSession("s1", "fixture-disabled");
    m.recordToolSuccess("s1", 0, "");
    assert.equal(s.stage, "execution");
  });

  test("explicit enabled:true keeps non-primary agents guarded", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-enabled": {
            enabled: true,
            maxTools: 1,
            maxTokens: 10,
            finalization: { allowedTools: [] },
            whitelistedTools: [],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    assert.equal(m.isAgentExempt("fixture-enabled"), false);
    const s = m.getOrCreateSession("s1", "fixture-enabled");
    m.recordToolSuccess("s1", 0, "");
    assert.equal(s.stage, "finalization");
  });

  test("explicitly enabled primary agent obeys finalization whitelist", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: { build: { enabled: true, maxTools: 1, finalization: { allowedTools: [] } } },
      }),
    );
    m.getOrCreateSession("s1", "build");
    m.transitionToFinalization("s1", "manual");
    assert.equal(m.isOperationPermittedInFinalization("s1", "bash", {}), false);
    assert.throws(() => m.assertOperationPermitted("s1", "bash", {}), CapacityLimitError);
  });

  test("explicitly enabled primary agent blocked at hooks after limit", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 10000 },
      agents: { build: { enabled: true, maxTools: 1 } },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sB", agent: "build" });
    await callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sB" }, { output: "" });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "tool_limit",
    );
  });

  test("hooks bypass exempt primary agents entirely", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 10 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sE", agent: "build" });
    for (let i = 0; i < 25; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sE", tool: "bash" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sE" }, { output: "x".repeat(5000) });
    }
  });

  test("hooks bypass explicitly disabled non-primary agents", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 10 },
      agents: {
        "fixture-disabled": {
          enabled: false,
          maxTools: 1,
          maxTokens: 10,
          finalization: { allowedTools: [] },
          whitelistedTools: [],
          finalizationRemaining: 1,
        },
      },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sC", agent: "fixture-disabled" });
    for (let i = 0; i < 5; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sC", tool: "bash" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sC" }, { output: "x".repeat(5000) });
    }
  });
});

describe("T008 attempted vs succeeded accounting", () => {
  test("successful cycles count attempted and succeeded exactly once", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 2, maxTokens: 10000 } }));
    m.getOrCreateSession("s1", "worker");
    m.recordToolAttempt("s1");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolAttempt("s1");
    m.recordToolSuccess("s1", 0, "");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsAttempted, 2);
    assert.equal(s.toolCallsSucceeded, 2);
    assert.equal(s.toolCount, 2);
    assert.equal(s.stage, "finalization");
  });

  test("blocked call counts as attempted only, no double-count", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1, maxTokens: 10000 } }));
    m.getOrCreateSession("s1", "worker");
    m.recordToolAttempt("s1");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolAttempt("s1");
    assert.throws(() => m.assertOperationPermitted("s1", "bash", {}), CapacityLimitError);
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsAttempted, 2);
    assert.equal(s.toolCallsSucceeded, 1);
    assert.equal(s.toolCount, 1);
  });

  test("hooks block call #maxTools+1 with contract message", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 2, maxTokens: 10000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sB", agent: "general" });
    for (let i = 0; i < 2; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sB" }, { output: "" });
    }
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "bash" }, { args: {} }),
      (err: unknown) => {
        assert.ok(err instanceof CapacityLimitError);
        assert.equal(
          err.message,
          formatCapacityBreachMessage({
            agentName: "general",
            reason: "tool_limit",
            toolCount: 2,
            maxTools: 2,
            tokensIngested: 0,
            maxTokens: 10000,
          }),
        );
        return true;
      },
    );
  });

  test("success counted per after-hook call; attempts only from before-hook", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 10000 } }));
    m.getOrCreateSession("s1", "worker");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolSuccess("s1", 0, "");
    assert.equal(m.getSession("s1")!.toolCallsSucceeded, 2);
    assert.equal(m.getSession("s1")!.toolCallsAttempted, 0);
  });
});

describe("whitelisted tool accounting", () => {
  test("tool patterns support glob wildcards", () => {
    assert.equal(toolMatchesPattern("todowrite", "todo*"), true);
    assert.equal(toolMatchesPattern("todo1", "todo?"), true);
    assert.equal(toolMatchesPattern("read", "todo*"), false);
  });

  test("path-restricted wildcard whitelist entries require a matching path", () => {
    const entries = [{ name: "read*", allowedPaths: ["docs/**"] }];
    assert.equal(matchesWhitelist("read", entries, { filePath: "docs/a.md" }), true);
    assert.equal(matchesWhitelist("read", entries, { filePath: "package.json" }), false);
  });

  test("matchesWhitelist: always-free todo prefix and exact skill", () => {
    assert.equal(matchesWhitelist("todo"), true);
    assert.equal(matchesWhitelist("todowrite"), true);
    assert.equal(matchesWhitelist("todo_write"), true);
    assert.equal(matchesWhitelist("skill"), true);
    assert.equal(matchesWhitelist("skills"), false);
    assert.equal(matchesWhitelist("mytodo"), false);
  });

  test("matchesWhitelist: exact and trailing-star prefix patterns", () => {
    assert.equal(matchesWhitelist("lsp", ["lsp"]), true);
    assert.equal(matchesWhitelist("lsp", ["context7*", "lsp"]), true);
    assert.equal(matchesWhitelist("context7-docs", ["context7*"]), true);
    assert.equal(matchesWhitelist("context7-docs", ["context7"]), false);
    assert.equal(matchesWhitelist("bash", ["context7*", "lsp"]), false);
    assert.equal(matchesWhitelist("anything", ["*"]), true);
    // Only a trailing star means prefix; no other glob syntax is supported.
    assert.equal(matchesWhitelist("webfoo", ["web*"]), true);
    assert.equal(matchesWhitelist("webxfoo", ["web*x"]), false);
    assert.equal(matchesWhitelist("lsp"), false);
  });

  test("whitelisted success keeps succeeded metrics and token ingestion but not toolCount", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-whitelist": {
            enabled: true,
            maxTools: 99,
            maxTokens: 99000,
            finalization: { allowedTools: [] },
            whitelistedTools: ["lsp"],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    m.getOrCreateSession("s1", "fixture-whitelist");
    m.recordToolSuccess("s1", 30, "a".repeat(400), "c1", "lsp");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsSucceeded, 1);
    assert.equal(s.toolCount, 0);
    assert.equal(s.tokensInput, 30);
    assert.equal(s.tokensOutput, 100);
    assert.equal(s.tokensIngested, 130);
  });

  test("non-whitelisted success still increments toolCount", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-whitelist": {
            enabled: true,
            maxTools: 99,
            maxTokens: 99000,
            finalization: { allowedTools: [] },
            whitelistedTools: ["lsp"],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    m.getOrCreateSession("s1", "fixture-whitelist");
    m.recordToolSuccess("s1", 0, "", undefined, "bash");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsSucceeded, 1);
    assert.equal(s.toolCount, 1);
  });

  test("always-free todo*/skill apply via fallback profile without configured patterns", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99 } }));
    m.getOrCreateSession("s1", "unknown-agent");
    m.recordToolSuccess("s1", 0, "", undefined, "todowrite");
    m.recordToolSuccess("s1", 0, "", undefined, "skill");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCount, 0);
    assert.equal(s.toolCallsSucceeded, 2);
    m.recordToolSuccess("s1", 0, "", undefined, "context7-docs");
    assert.equal(m.getSession("s1")!.toolCount, 1);
  });

  test("configured patterns come from the effective per-session agent profile", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-whitelist": {
            enabled: true,
            maxTools: 99,
            maxTokens: 99000,
            finalization: { allowedTools: [] },
            whitelistedTools: ["context7*"],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    m.getOrCreateSession("s1", "fixture-whitelist");
    m.recordToolSuccess("s1", 0, "", undefined, "context7-resolve");
    m.recordToolSuccess("s1", 0, "", undefined, "context7");
    assert.equal(m.getSession("s1")!.toolCount, 0);
    m.recordToolSuccess("s1", 0, "", undefined, "lsp");
    assert.equal(m.getSession("s1")!.toolCount, 1);
  });

  test("backward compatibility: no tool identity counts as non-whitelisted", () => {
    const m = new SessionStateManager(makeConfig({
      agents: {
        "fixture-no-tool-identity": {
          enabled: true,
          maxTools: 99,
          maxTokens: 99000,
          finalization: { allowedTools: [] },
          whitelistedTools: [],
          finalizationRemaining: 1,
        },
      },
    }));
    m.getOrCreateSession("s1", "fixture-no-tool-identity");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolSuccess("s1", 0, "", "c1");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCount, 2);
    assert.equal(s.toolCallsSucceeded, 2);
  });

  test("callID deduplication still applies for whitelisted tools", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          "fixture-whitelist": {
            enabled: true,
            maxTools: 99,
            maxTokens: 99000,
            finalization: { allowedTools: [] },
            whitelistedTools: ["lsp"],
            finalizationRemaining: 1,
          },
        },
      }),
    );
    m.getOrCreateSession("s1", "fixture-whitelist");
    m.recordToolSuccess("s1", 0, "", "c1", "lsp");
    m.recordToolSuccess("s1", 0, "", "c1", "lsp");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsSucceeded, 1);
    assert.equal(s.toolCount, 0);
  });

  test("whitelisted token ingestion can still finalize on token limit", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: { tester: { maxTools: 99, maxTokens: 50, whitelistedTools: ["lsp"] } },
      }),
    );
    m.getOrCreateSession("s1", "tester");
    m.recordToolSuccess("s1", 0, "a".repeat(400), "c1", "lsp");
    const s = m.getSession("s1")!;
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "token_limit");
    assert.equal(s.toolCount, 0);
  });

  test("hook plumbing: whitelisted after-hook calls do not exhaust tool budget", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 99000 },
      agents: {
        writer: { maxTools: 1, maxTokens: 99000, whitelistedTools: ["lsp", "context7*"] },
      },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sW", agent: "writer" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sW", tool: "lsp" }, { output: "" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sW", tool: "context7-docs" }, { output: "" });
    // Budget untouched by whitelisted calls: the first counting call is still permitted.
    await callHook(hooks["tool.execute.before"], { sessionID: "sW", tool: "read" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sW", tool: "read" }, { output: "" });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sW", tool: "glob" }, { args: {} }),
      CapacityLimitError,
    );
  });

  test("hook plumbing: always-free todo*/skill pass through hooks without counting", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 99000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sX", agent: "explore" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sX", tool: "todowrite" }, { output: "" });
    await callHook(hooks["tool.execute.after"], { sessionID: "sX", tool: "skill" }, { output: "" });
    await callHook(hooks["tool.execute.before"], { sessionID: "sX", tool: "glob" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sX", tool: "glob" }, { output: "" });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sX", tool: "read" }, { args: {} }),
      CapacityLimitError,
    );
  });
});

describe("bounded finalization (finalizationRemaining)", () => {
  const boundedConfig = makeConfig({
    agents: {
      tester: {
        maxTools: 15,
        maxTokens: 18000,
        finalizationRemaining: 2,
        finalization: { allowedTools: ["write", "edit", "apply_patch"] },
      },
    },
  });

  test("bounded agent (R=2) transitions at 13 of 15 tools, not at maxTools", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    for (let i = 0; i < 12; i++) m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "execution");
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
    assert.equal(m.getSession("s1")!.exhaustionReason, "tool_limit");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 0);
  });

  test("bounded profiles transition at maxTools - R", () => {
    const cfg = makeConfig({
      agents: {
        a1: { maxTools: 10, finalizationRemaining: 2 },
        a2: { maxTools: 24, finalizationRemaining: 3 },
      },
    });
    const m = new SessionStateManager(cfg);
    m.getOrCreateSession("d1", "a1");
    for (let i = 0; i < 7; i++) m.recordToolExecution("d1", "");
    assert.equal(m.getSession("d1")!.stage, "execution");
    m.recordToolExecution("d1", "");
    assert.equal(m.getSession("d1")!.stage, "finalization");

    m.getOrCreateSession("c1", "a2");
    for (let i = 0; i < 20; i++) m.recordToolExecution("c1", "");
    assert.equal(m.getSession("c1")!.stage, "execution");
    m.recordToolExecution("c1", "");
    assert.equal(m.getSession("c1")!.stage, "finalization");
  });

  test("token exhaustion still transitions a configured profile", () => {
    const m = new SessionStateManager(makeConfig({ agents: { tester: { maxTokens: 50, finalizationRemaining: 2 } } }));
    m.getOrCreateSession("s1", "tester");
    m.recordTokens("s1", 50);
    const s = m.getSession("s1")!;
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "token_limit");
    assert.equal(s.finalizationToolsUsed, 0);
  });

  test("phase-entry call does not consume a finalization slot", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    for (let i = 0; i < 13; i++) m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
    // The 13th (entry-triggering) execution call left the allowance untouched.
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), true);
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 0);
  });

  test("finalization permits allowed policy calls and blocks others with remaining-count text", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    m.transitionToFinalization("s1", "tool_limit");
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), true);
    assert.equal(m.isOperationPermittedInFinalization("s1", "edit", {}), true);
    assert.equal(m.isOperationPermittedInFinalization("s1", "read", {}), false);
    assert.equal(m.isOperationPermittedInFinalization("s1", "bash", {}), false);
    let caught: unknown;
    try {
      m.assertOperationPermitted("s1", "read", {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CapacityLimitError);
    assert.equal(
      (caught as CapacityLimitError).message,
      "Finalization: 2 call(s) remaining. Only write, edit, apply_patch allowed.",
    );
  });

  test("successful finalization calls consume slots; blocked and attempted-only calls do not", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    m.transitionToFinalization("s1", "tool_limit");
    m.recordToolAttempt("s1");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 0);
    // A blocked call never reaches a success record: rejection leaves the count.
    assert.equal(m.isOperationPermittedInFinalization("s1", "read", {}), false);
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 0);
    m.recordToolSuccess("s1", 0, "", "c1", "write");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 1);
    m.recordToolSuccess("s1", 0, "", "c2", "edit");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 2);
    // Exhausted: every ordinary tool is blocked, allowed ones included.
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), false);
    assert.equal(m.isOperationPermittedInFinalization("s1", "read", {}), false);
    let caught: unknown;
    try {
      m.assertOperationPermitted("s1", "write", {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CapacityLimitError);
    const message = (caught as CapacityLimitError).message;
    assert.ok(message.includes("Finalization calls exhausted for this subagent."));
    assert.ok(message.includes("Proceed to report."));
  });

  test("duplicate after-hook delivery is idempotent for finalization accounting", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    m.transitionToFinalization("s1", "tool_limit");
    m.recordToolSuccess("s1", 0, "", "c1", "write");
    m.recordToolSuccess("s1", 0, "", "c1", "write");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 1);
  });

  test("whitelisted finalization call consumes a slot but not toolCount", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          w: {
            maxTools: 5,
            finalizationRemaining: 2,
            finalization: { allowedTools: ["write", "lsp"] },
            whitelistedTools: ["lsp"],
          },
        },
      }),
    );
    m.getOrCreateSession("s1", "w");
    m.transitionToFinalization("s1", "tool_limit");
    m.recordToolSuccess("s1", 0, "", "c1", "lsp");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCount, 0);
    assert.equal(s.finalizationToolsUsed, 1);
    m.recordToolSuccess("s1", 0, "", "c2", "lsp");
    assert.equal(m.getSession("s1")!.finalizationToolsUsed, 2);
    // Two whitelisted successes exhausted the allowance.
    assert.equal(m.isOperationPermittedInFinalization("s1", "lsp", {}), false);
  });

  test("getRemainingBudget surfaces finalization values without changing legacy fields", () => {
    const m = new SessionStateManager(boundedConfig);
    m.getOrCreateSession("s1", "tester");
    m.recordToolExecution("s1", "");
    const execution = m.getRemainingBudget("s1")!;
    assert.equal(execution.finalizationRemaining, 2);
    assert.equal(execution.finalizationToolsUsed, 0);
    assert.equal(execution.stage, "execution");
    for (let i = 0; i < 12; i++) m.recordToolExecution("s1", "");
    const budget = m.getRemainingBudget("s1")!;
    assert.equal(budget.stage, "finalization");
    assert.equal(budget.finalizationToolsUsed, 0);
    assert.equal(budget.finalizationRemaining, 2);
    assert.equal(budget.toolCount, 13);
  });

  test("hook plumbing: entry notice, remaining-count block, LAST CALL, and exhausted block", async () => {
    const hooks = await server({} as unknown as PluginInput, boundedConfig as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sP", agent: "tester" });
    for (let i = 0; i < 13; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "grep" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sP", tool: "grep" }, { output: "" });
    }
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sP", model: "m" },
      { system },
    );
    assert.equal(system.length, 1);
    assert.equal(
      system[0],
      "[capacity-guard] tools: 13/15 (2 remaining); tokens: 0/18000 (~18000 remaining); stage: finalization; finalization: 0/2 used ⚠️ FORCEFUL WRAP-UP: You have exactly 2 finalization call(s) remaining. Stop exploring and start producing your deliverable immediately.",
    );

    // Non-allowed tool blocked with remaining-count message before the cap.
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "read" }, { args: {} }),
      (err: unknown) =>
        err instanceof CapacityLimitError &&
        err.message ===
          "Finalization: 2 call(s) remaining. Only write, edit, apply_patch allowed.",
    );

    // First allowed finalization call: LAST CALL notice with one slot left.
    await callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "write" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sP", tool: "write" }, { output: "" });
    const lastCall: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sP", model: "m" },
      { system: lastCall },
    );
    assert.equal(
      lastCall[0],
      "[capacity-guard] tools: 14/15 (1 remaining); tokens: 0/18000 (~18000 remaining); stage: finalization; finalization: 1/2 used 🚨 LAST CALL: This is your FINAL tool call. You must produce your deliverable NOW.",
    );

    // Second and final allowed call consumes the last slot.
    await callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "edit" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sP", tool: "edit" }, { output: "" });
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "write" }, { args: {} }),
      (err: unknown) =>
        err instanceof CapacityLimitError &&
        err.message.includes("Finalization calls exhausted for this subagent.") &&
        err.message.includes("Proceed to report."),
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sP", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.message.includes("exhausted"),
    );

    // Exhausted status has no wrap-up notice.
    const exhaustedStatus: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sP", model: "m" },
      { system: exhaustedStatus },
    );
    assert.equal(
      exhaustedStatus[0],
      "[capacity-guard] tools: 15/15 (0 remaining); tokens: 0/18000 (~18000 remaining); stage: finalization; finalization: 2/2 used",
    );
  });

  test("legacy compatibility: profiles without R keep maxTools transition, unlimited finalization, and plain status line", async () => {
    const m = new SessionStateManager(
      makeConfig({
        defaults: { maxTools: 3, maxTokens: 99000, finalization: { allowedTools: ["read"] } },
      }),
    );
    m.getOrCreateSession("s1", "explore");
    for (let i = 0; i < 2; i++) m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "execution");
    m.recordToolExecution("s1", "");
    assert.equal(m.getSession("s1")!.stage, "finalization");
    // Unlimited finalization: repeated allowed calls never exhaust.
    for (let i = 0; i < 5; i++) {
      assert.equal(m.isOperationPermittedInFinalization("s1", "read", {}), true);
      m.recordToolSuccess("s1", 0, "", `c${i}`, "read");
    }
    assert.doesNotThrow(() => m.assertOperationPermitted("s1", "read", {}));
    // A policy violation in the uncapped profile keeps the legacy breach format.
    let caught: unknown;
    try {
      m.assertOperationPermitted("s1", "write", {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CapacityLimitError);
    assert.ok(
      (caught as CapacityLimitError).message.startsWith(
        '[Capacity Guard] Session limit reached for agent "@explore".',
      ),
    );
    // Unconfigured agents keep the legacy status line.
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 3, maxTokens: 99000, finalization: { allowedTools: ["read"] } },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sL", agent: "explore" });
    for (let i = 0; i < 3; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sL", tool: "grep" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sL", tool: "grep" }, { output: "" });
    }
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sL", model: "m" },
      { system },
    );
    assert.deepEqual(system, [
      "[capacity-guard] tools: 3/3 (0 remaining); tokens: 0/99000 (~99000 remaining); stage: finalization",
    ]);
  });

  test("configured execution-stage status line stays unchanged before finalization", async () => {
    const hooks = await server({} as unknown as PluginInput, boundedConfig as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sC", agent: "tester" });
    await callHook(hooks["tool.execute.before"], { sessionID: "sC", tool: "grep" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sC", tool: "grep" }, { output: "" });
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sC", model: "m" },
      { system },
    );
    assert.deepEqual(system, [
      "[capacity-guard] tools: 1/15 (14 remaining); tokens: 0/18000 (~18000 remaining); stage: execution",
    ]);
  });

  test("R == maxTools finalizes a new non-exempt session at creation before any tool runs", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          even: {
            maxTools: 5,
            maxTokens: 40000,
            finalizationRemaining: 5,
            finalization: { allowedTools: ["write"] },
          },
        },
      }),
    );
    const s = m.getOrCreateSession("s1", "even");
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "tool_limit");
    assert.equal(s.toolCount, 0);
    assert.equal(s.finalizationToolsUsed, 0);
    // No clamping: the cap is surfaced verbatim even though R == maxTools.
    assert.equal(m.getRemainingBudget("s1")!.finalizationRemaining, 5);
  });

  test("R > maxTools finalizes at creation without clamping and honors the full allowance", () => {
    const m = new SessionStateManager(
      makeConfig({
        agents: {
          greedy: {
            maxTools: 5,
            maxTokens: 40000,
            finalizationRemaining: 7,
            finalization: { allowedTools: ["write"] },
          },
        },
      }),
    );
    const s = m.getOrCreateSession("s1", "greedy");
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "tool_limit");
    // No clamping: the over-max cap stays as configured.
    assert.equal(m.getRemainingBudget("s1")!.finalizationRemaining, 7);
    // The full R-call allowance is honored in finalization.
    for (let i = 0; i < 7; i++) {
      assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), true);
      m.recordToolSuccess("s1", 0, "", `c${i}`, "write");
    }
    assert.equal(m.isOperationPermittedInFinalization("s1", "write", {}), false);
  });

  test("exempt agent with R > maxTools skips creation-time finalization", () => {
    const m = new SessionStateManager(
      makeConfig({
        primaryAgents: ["boss"],
        agents: {
          boss: {
            maxTools: 5,
            maxTokens: 40000,
            finalizationRemaining: 6,
            finalization: { allowedTools: ["write"] },
          },
        },
      }),
    );
    const s = m.getOrCreateSession("s1", "boss");
    assert.equal(s.stage, "execution");
    assert.equal(s.exhaustionReason, null);
  });
});

describe("callID idempotent accounting for duplicate hook delivery", () => {
  const hookConfig = {
    defaults: { maxTools: 99, maxTokens: 10_000_000 },
  } as ContextGuardOptions;
  const args = { query: "a".repeat(400) };
  const outputText = "b".repeat(400);
  const argsTokens = estimateArgsTokens(args);
  const perCycleTokens = argsTokens + estimateTokens(outputText);

  async function readStatusLine(
    hooks: Awaited<ReturnType<typeof server>>,
    sessionID: string,
  ): Promise<string> {
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID, model: "m" },
      { system },
    );
    return system[0] ?? "";
  }

  test("duplicate before/after with same callID counts one attempt, one success, one token contribution", async () => {
    const hooks = await server(
      {} as unknown as PluginInput,
      hookConfig as unknown as PluginOptions,
    );
    await callHook(hooks["chat.params"], { sessionID: "sD", agent: "worker" });

    await callHook(
      hooks["tool.execute.before"],
      { sessionID: "sD", tool: "bash", callID: "c1" },
      { args },
    );
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sD", callID: "c1" },
      { output: outputText, args },
    );
    await callHook(
      hooks["tool.execute.before"],
      { sessionID: "sD", tool: "bash", callID: "c1" },
      { args },
    );
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sD", callID: "c1" },
      { output: outputText, args },
    );

    const m = new SessionStateManager(makeConfig(hookConfig));
    m.getOrCreateSession("sD", "worker");
    m.recordToolAttempt("sD", "c1");
    m.recordToolAttempt("sD", "c1");
    m.recordToolSuccess("sD", argsTokens, outputText, "c1");
    m.recordToolSuccess("sD", argsTokens, outputText, "c1");
    const expected = m.getSession("sD")!;
    assert.equal(expected.toolCallsAttempted, 1);
    assert.equal(expected.toolCallsSucceeded, 1);
    assert.equal(expected.toolCount, 1);
    assert.equal(expected.tokensIngested, perCycleTokens);

    assert.equal(
      await readStatusLine(hooks, "sD"),
      `[capacity-guard] tools: 1/99 (98 remaining); tokens: ${perCycleTokens}/10000000 (~${10_000_000 - perCycleTokens} remaining); stage: execution`,
    );
  });

  test("distinct callIDs count independently", async () => {
    const hooks = await server(
      {} as unknown as PluginInput,
      hookConfig as unknown as PluginOptions,
    );
    await callHook(hooks["chat.params"], { sessionID: "sE", agent: "worker" });
    for (const callID of ["c1", "c2", "c3"]) {
      await callHook(
        hooks["tool.execute.before"],
        { sessionID: "sE", tool: "bash", callID },
        { args },
      );
      await callHook(
        hooks["tool.execute.after"],
        { sessionID: "sE", callID },
        { output: outputText, args },
      );
    }

    const m = new SessionStateManager(makeConfig(hookConfig));
    m.getOrCreateSession("sE", "worker");
    for (const callID of ["c1", "c2", "c3"]) {
      m.recordToolAttempt("sE", callID);
      m.recordToolSuccess("sE", argsTokens, outputText, callID);
    }
    const expected = m.getSession("sE")!;
    assert.equal(expected.toolCallsAttempted, 3);
    assert.equal(expected.toolCallsSucceeded, 3);
    assert.equal(expected.toolCount, 3);
    assert.equal(expected.tokensIngested, 3 * perCycleTokens);

    assert.equal(
      await readStatusLine(hooks, "sE"),
      `[capacity-guard] tools: 3/99 (96 remaining); tokens: ${3 * perCycleTokens}/10000000 (~${10_000_000 - 3 * perCycleTokens} remaining); stage: execution`,
    );
  });

  test("blocked call with a callID remains attempted-only", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 10_000_000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sF", agent: "worker" });
    await callHook(
      hooks["tool.execute.before"],
      { sessionID: "sF", tool: "bash", callID: "c1" },
      { args },
    );
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sF", callID: "c1" },
      { output: outputText, args },
    );

    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sF", tool: "read", callID: "c2" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "tool_limit",
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sF", tool: "read", callID: "c2" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "tool_limit",
    );

    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sF", "worker");
    m.recordToolAttempt("sF", "c1");
    m.recordToolSuccess("sF", argsTokens, outputText, "c1");
    m.recordToolAttempt("sF", "c2");
    m.recordToolAttempt("sF", "c2");
    const expected = m.getSession("sF")!;
    assert.equal(expected.toolCallsAttempted, 2);
    assert.equal(expected.toolCallsSucceeded, 1);
    assert.equal(expected.toolCount, 1);
    assert.equal(expected.tokensIngested, perCycleTokens);

    assert.equal(
      await readStatusLine(hooks, "sF"),
      `[capacity-guard] tools: 1/1 (0 remaining); tokens: ${perCycleTokens}/10000000 (~${10_000_000 - perCycleTokens} remaining); stage: finalization`,
    );
  });

  test("direct state API calls without callID retain per-call accounting", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 10000 } }));
    m.getOrCreateSession("s1", "worker");
    m.recordToolAttempt("s1");
    m.recordToolAttempt("s1");
    m.recordToolSuccess("s1", 0, "");
    m.recordToolSuccess("s1", 0, "");
    const s = m.getSession("s1")!;
    assert.equal(s.toolCallsAttempted, 2);
    assert.equal(s.toolCallsSucceeded, 2);
    assert.equal(s.toolCount, 2);
  });

  test("attempted callID dedup window stays bounded far beyond capacity", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 10_000_000, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sBounded", "worker");
    const total = CALLID_DEDUP_CAPACITY * 5;
    for (let i = 0; i < total; i++) {
      m.recordToolAttempt("sBounded", `a-${i}`);
    }
    assert.equal(m.getSession("sBounded")!.toolCallsAttempted, total);
    const sizes = m.getDiagnosticCallIDCacheSizes();
    assert.ok(sizes.attemptedBySession["sBounded"]! <= CALLID_DEDUP_CAPACITY);
    assert.equal(sizes.succeededBySession["sBounded"], undefined);
  });

  test("succeeded callID dedup window stays bounded far beyond capacity", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 10_000_000, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sBounded", "worker");
    const total = CALLID_DEDUP_CAPACITY * 3;
    for (let i = 0; i < total; i++) {
      m.recordToolSuccess("sBounded", 0, "", `s-${i}`);
    }
    assert.equal(m.getSession("sBounded")!.toolCallsSucceeded, total);
    const sizes = m.getDiagnosticCallIDCacheSizes();
    assert.ok(sizes.succeededBySession["sBounded"]! <= CALLID_DEDUP_CAPACITY);
    assert.equal(sizes.attemptedBySession["sBounded"], undefined);
  });

  test("blocked unique callIDs do not grow retained state beyond the bound", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 1, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sBlocked", "worker");
    m.recordToolSuccess("sBlocked", 0, "", "allowed-1");
    const total = CALLID_DEDUP_CAPACITY * 4;
    for (let i = 0; i < total; i++) {
      m.recordToolAttempt("sBlocked", `blocked-${i}`);
    }
    const s = m.getSession("sBlocked")!;
    assert.equal(s.toolCallsAttempted, total);
    assert.equal(s.toolCallsSucceeded, 1);
    const sizes = m.getDiagnosticCallIDCacheSizes();
    assert.ok(sizes.attemptedBySession["sBlocked"]! <= CALLID_DEDUP_CAPACITY);
    assert.ok(sizes.succeededBySession["sBlocked"]! <= CALLID_DEDUP_CAPACITY);
  });

  test("callID dedup windows are isolated per session", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sIsolatedA", "worker");
    m.getOrCreateSession("sIsolatedB", "worker");
    m.recordToolAttempt("sIsolatedA", "shared");
    m.recordToolSuccess("sIsolatedA", 0, "", "shared");
    m.recordToolAttempt("sIsolatedB", "shared");
    m.recordToolSuccess("sIsolatedB", 0, "", "shared");
    m.recordToolAttempt("sIsolatedA", "shared");
    m.recordToolAttempt("sIsolatedB", "shared");
    m.recordToolSuccess("sIsolatedA", 0, "", "shared");
    m.recordToolSuccess("sIsolatedB", 0, "", "shared");
    assert.equal(m.getSession("sIsolatedA")!.toolCallsAttempted, 1);
    assert.equal(m.getSession("sIsolatedA")!.toolCallsSucceeded, 1);
    assert.equal(m.getSession("sIsolatedB")!.toolCallsAttempted, 1);
    assert.equal(m.getSession("sIsolatedB")!.toolCallsSucceeded, 1);
    const sizes = m.getDiagnosticCallIDCacheSizes();
    assert.deepEqual(sizes.attemptedBySession, { sIsolatedA: 1, sIsolatedB: 1 });
    assert.deepEqual(sizes.succeededBySession, { sIsolatedA: 1, sIsolatedB: 1 });
  });

  test("callID evicted from the dedup window is recounted, newest stays deduplicated", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 10_000_000, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("sWindow", "worker");
    m.recordToolAttempt("sWindow", "oldest");
    for (let i = 0; i < CALLID_DEDUP_CAPACITY; i++) {
      m.recordToolAttempt("sWindow", `fill-${i}`);
    }
    const s = m.getSession("sWindow")!;
    const before = s.toolCallsAttempted;
    m.recordToolAttempt("sWindow", "fill-0");
    m.recordToolAttempt("sWindow", "oldest");
    assert.equal(m.getSession("sWindow")!.toolCallsAttempted, before + 1);
    assert.ok(
      m.getDiagnosticCallIDCacheSizes().attemptedBySession["sWindow"]! <= CALLID_DEDUP_CAPACITY,
    );
  });
});

describe("T009 input/payload and output token accounting", () => {
  test("estimateArgsTokens counts serialized args", () => {
    const args = { query: "a".repeat(400), filePath: "/tmp/x.md" };
    assert.equal(estimateArgsTokens(args), estimateTokens(JSON.stringify(args)));
    assert.equal(estimateArgsTokens({}), 0);
    assert.equal(estimateArgsTokens(undefined), 0);
  });

  test("estimateArgsTokens counts full serialized volume without truncation", () => {
    const huge = { blob: "x".repeat(1_000_000) };
    assert.equal(estimateArgsTokens(huge), estimateTokens(JSON.stringify(huge)));
    const circular: Record<string, unknown> = { blob: "x".repeat(1_000_000) };
    circular.self = circular;
    assert.equal(estimateArgsTokens(circular), Number.POSITIVE_INFINITY);
  });

  test("estimateArgsTokens fails safe to Infinity when serialization is impossible", () => {
    const unserializable = {
      toJSON() {
        throw new Error("no json");
      },
      toString() {
        throw new Error("no string");
      },
    };
    assert.equal(estimateArgsTokens(unserializable), Number.POSITIVE_INFINITY);
  });

  test("estimateArgsTokens never undercounts via String fallback on stringify failure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(String(circular), "[object Object]");
    assert.equal(estimateArgsTokens(circular), Number.POSITIVE_INFINITY);
  });

  test("recordToolSuccess accounts input and output tokens separately", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 100000 } }));
    m.getOrCreateSession("s1", "worker");
    const args = { filePath: "a".repeat(400) };
    m.recordToolSuccess("s1", estimateArgsTokens(args), "a".repeat(400));
    const s = m.getSession("s1")!;
    assert.equal(s.tokensInput, estimateArgsTokens(args));
    assert.equal(s.tokensOutput, 100);
    assert.equal(s.tokensIngested, s.tokensInput + s.tokensOutput);
    assert.equal(s.toolCallsSucceeded, 1);
  });

  test("output accounting counts full volume without truncation", () => {
    const m = new SessionStateManager(makeConfig({ defaults: { maxTools: 99, maxTokens: 10_000_000 } }));
    m.getOrCreateSession("s1", "worker");
    m.recordToolSuccess("s1", 0, "x".repeat(1_000_000));
    assert.equal(
      m.getSession("s1")!.tokensOutput,
      estimateTokens("x".repeat(1_000_000)),
    );
  });

  test("hooks account args and output toward the token budget", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: 100 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sA", agent: "explore" });
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sA" },
      { output: "a".repeat(400), args: { query: "x".repeat(400) } },
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sA", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });
});

describe("T010 budget status surfacing", () => {
  test("constrained session receives deterministic status line", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 15, maxTokens: 40000 },
    }) as unknown as PluginOptions);
    const args = { query: "a".repeat(400) };
    const outputText = "b".repeat(400);
    await callHook(hooks["chat.params"], { sessionID: "s1", agent: "explore" });
    for (let i = 0; i < 5; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "s1", tool: "grep" }, { args });
      await callHook(hooks["tool.execute.after"], { sessionID: "s1" }, { output: outputText, args });
    }
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "s1", model: "test-model" },
      { system },
    );
    const tokens = 5 * (estimateArgsTokens(args) + estimateTokens(outputText));
    assert.equal(system.length, 1);
    assert.equal(
      system[0],
      `[capacity-guard] tools: 5/15 (10 remaining); tokens: ${tokens}/40000 (~${40000 - tokens} remaining); stage: execution`,
    );
  });

  test("exempt agent sessions leave system prompt unchanged", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 1, maxTokens: 10 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sE", agent: "build" });
    await callHook(hooks["tool.execute.before"], { sessionID: "sE", tool: "bash" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sE" }, { output: "x".repeat(5000) });
    const system = ["existing system prompt"];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sE", model: "m" },
      { system },
    );
    assert.deepEqual(system, ["existing system prompt"]);
  });

  test("unknown sessionID no-ops without throwing", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({}) as unknown as PluginOptions);
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "ghost", model: "m" },
      { system },
    );
    assert.deepEqual(system, []);
  });

  test("missing sessionID no-ops without throwing", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({}) as unknown as PluginOptions);
    const system: string[] = [];
    await callHook(hooks["experimental.chat.system.transform"], { model: "m" }, { system });
    assert.deepEqual(system, []);
  });

  test("injected line matches getRemainingBudget values", async () => {
    const config = makeConfig({ defaults: { maxTools: 15, maxTokens: 40000 } });
    const hooks = await server({} as unknown as PluginInput, config as unknown as PluginOptions);
    const args = { query: "a".repeat(400) };
    await callHook(hooks["chat.params"], { sessionID: "s1", agent: "explore" });
    for (let i = 0; i < 5; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "s1", tool: "grep" }, { args });
      await callHook(hooks["tool.execute.after"], { sessionID: "s1" }, { output: "b".repeat(400), args });
    }
    const m = new SessionStateManager(config);
    m.getOrCreateSession("s1", "explore");
    for (let i = 0; i < 5; i++) {
      m.recordToolAttempt("s1");
      m.recordToolSuccess("s1", estimateArgsTokens(args), "b".repeat(400));
    }
    const budget = m.getRemainingBudget("s1")!;
    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "s1", model: "m" },
      { system },
    );
    assert.equal(
      system[0],
      `[capacity-guard] tools: ${budget.toolCount}/${budget.maxTools} (${budget.remainingTools} remaining); tokens: ${budget.tokensIngested}/${budget.maxTokens} (~${budget.remainingTokens} remaining); stage: ${budget.stage}`,
    );
  });

  test("sessions are isolated; each line reflects only its own budget", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 15, maxTokens: 40000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sA", agent: "explore" });
    await callHook(hooks["chat.params"], { sessionID: "sB", agent: "worker" });
    await callHook(hooks["chat.params"], { sessionID: "sC", agent: "build" });
    for (let i = 0; i < 3; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sA", tool: "grep" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sA" }, { output: "" });
    }
    for (let i = 0; i < 7; i++) {
      await callHook(hooks["tool.execute.before"], { sessionID: "sB", tool: "grep" }, { args: {} });
      await callHook(hooks["tool.execute.after"], { sessionID: "sB" }, { output: "" });
    }
    const systemA: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sA", model: "m" },
      { system: systemA },
    );
    assert.deepEqual(systemA, [
      "[capacity-guard] tools: 3/15 (12 remaining); tokens: 0/40000 (~40000 remaining); stage: execution",
    ]);
    const systemB: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sB", model: "m" },
      { system: systemB },
    );
    assert.deepEqual(systemB, [
      "[capacity-guard] tools: 7/15 (8 remaining); tokens: 0/40000 (~40000 remaining); stage: execution",
    ]);
    const systemC = ["keep"];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sC", model: "m" },
      { system: systemC },
    );
    assert.deepEqual(systemC, ["keep"]);
  });
});

describe("T012 oversized payload full-volume accounting and fail-safe finalization", () => {
  const OVERSIZED_CHARS = 1_000_000;
  const OLD_TRUNCATED_ESTIMATE = 200_000 / 4;
  const TRUE_OUTPUT_ESTIMATE = estimateTokens("x".repeat(OVERSIZED_CHARS));

  test("oversized output fully accounted; cap between old truncated and true volume finalizes", () => {
    const m = new SessionStateManager(
      makeConfig({ defaults: { maxTools: 99, maxTokens: OLD_TRUNCATED_ESTIMATE + 1 } }),
    );
    m.getOrCreateSession("s1", "worker");
    m.recordToolSuccess("s1", 0, "x".repeat(OVERSIZED_CHARS));
    const s = m.getSession("s1")!;
    assert.equal(s.tokensOutput, TRUE_OUTPUT_ESTIMATE);
    assert.ok(TRUE_OUTPUT_ESTIMATE > OLD_TRUNCATED_ESTIMATE + 1);
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "token_limit");
  });

  test("oversized args fully accounted; cap between old truncated and true volume finalizes", () => {
    const args = { blob: "x".repeat(OVERSIZED_CHARS) };
    const argsTokens = estimateArgsTokens(args);
    assert.equal(argsTokens, estimateTokens(JSON.stringify(args)));
    assert.ok(argsTokens > OLD_TRUNCATED_ESTIMATE + 1);
    const m = new SessionStateManager(
      makeConfig({ defaults: { maxTools: 99, maxTokens: OLD_TRUNCATED_ESTIMATE + 1 } }),
    );
    m.getOrCreateSession("s1", "worker");
    m.recordToolSuccess("s1", argsTokens, "");
    const s = m.getSession("s1")!;
    assert.equal(s.tokensInput, argsTokens);
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "token_limit");
  });

  test("oversized output through hooks finalizes and blocks the next call", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: OLD_TRUNCATED_ESTIMATE + 1 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sH", agent: "explore" });
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sH" },
      { output: "x".repeat(OVERSIZED_CHARS), args: {} },
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sH", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });

  test("oversized normal args through hooks finalize and block the next call", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: OLD_TRUNCATED_ESTIMATE + 1 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sG", agent: "explore" });
    const args = { blob: "x".repeat(OVERSIZED_CHARS) };
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sG", tool: "read", callID: "sG-oversize-args", args },
      { output: "" },
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sG", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });

  test("large circular args reach the hook path, finalize, and block the next call", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: { maxTools: 99, maxTokens: 60_000 },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sF", agent: "explore" });
    const circular: Record<string, unknown> = { blob: "x".repeat(OVERSIZED_CHARS) };
    circular.self = circular;
    await callHook(
      hooks["tool.execute.after"],
      { sessionID: "sF", tool: "read", callID: "sF-circular-args", args: circular },
      { output: "" },
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID: "sF", tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "token_limit",
    );
  });
});

describe("T011 interceptor overhead benchmark", () => {
  test("full interceptor path averages under 1ms and counters stay intact", async (t) => {
    const iterations = 2000;
    const warmup = 200;
    const totalCycles = warmup + iterations;
    const maxTools = totalCycles + 1;
    const maxTokens = 10_000_000;
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      defaults: {
        maxTools,
        maxTokens,
        finalization: { allowedTools: ["bash"], allowedPaths: [] },
      },
    }) as unknown as PluginOptions);
    const sessionID = "bench";
    const args = { cmd: "echo hi" };
    const outputText = "ok";
    await callHook(hooks["chat.params"], { sessionID, agent: "worker" });

    const cycle = async (callID: string): Promise<void> => {
      await callHook(hooks["tool.execute.before"], { sessionID, tool: "bash", callID }, { args });
      await callHook(hooks["tool.execute.after"], { sessionID, callID }, { output: outputText, args });
    };

    for (let i = 0; i < warmup; i++) await cycle(`warmup-${i}`);

    const started = performance.now();
    for (let i = 0; i < iterations; i++) await cycle(`measured-${i}`);
    const avgMs = (performance.now() - started) / iterations;

    const expectedTokens = totalCycles * (estimateArgsTokens(args) + estimateTokens(outputText));

    const readStatus = async (): Promise<string> => {
      const system: string[] = [];
      await callHook(
        hooks["experimental.chat.system.transform"],
        { sessionID, model: "m" },
        { system },
      );
      return system[0] ?? "";
    };

    const line = await readStatus();
    assert.match(line, /^\[capacity-guard\] tools: \d+\/\d+ \(-?\d+ remaining\)/);
    assert.ok(
      line.includes(`tools: ${totalCycles}/${maxTools}`),
      "every cycle counted exactly one success",
    );
    assert.ok(
      line.includes(`tokens: ${expectedTokens}/${maxTokens} (~${maxTokens - expectedTokens} remaining)`),
      "every cycle counted its args and output tokens exactly once",
    );
    assert.ok(
      line.includes("stage: execution"),
      "warmup and measured cycles must stay in execution stage",
    );

    await cycle("finalization-1");
    assert.ok(
      (await readStatus()).includes("stage: finalization"),
      "finalization assertion runs outside the timed loop",
    );
    await assert.rejects(
      callHook(hooks["tool.execute.before"], { sessionID, tool: "read" }, { args: {} }),
      (err: unknown) => err instanceof CapacityLimitError && err.reason === "tool_limit",
    );
    assert.ok(
      (await readStatus()).includes(`tools: ${maxTools}/${maxTools}`),
      "blocked call does not double-count a success",
    );

    assert.ok(
      avgMs < 1.0,
      `T011 interceptor overhead: avg ${avgMs.toFixed(4)}ms over ${iterations} iterations (warmup ${warmup}) exceeds 1ms target`,
    );
    t.diagnostic(
      `T011 interceptor overhead: avg ${avgMs.toFixed(4)}ms over ${iterations} iterations (warmup ${warmup}); counters intact (tools ${totalCycles}/${maxTools}, tokens ${expectedTokens})`,
    );
  });
});

describe("provider token ground truth accounting", () => {
  const bigConfig = { defaults: { maxTools: 10_000_000, maxTokens: 10_000_000 } };

  test("stale duplicate observations for the same message id are ignored", () => {
    const m = new SessionStateManager(makeConfig(bigConfig));
    m.getOrCreateSession("s1", "worker");
    assert.equal(m.recordProviderTokens("s1", "m1", 1000), true);
    // Same message id with a lower count is a stale duplicate.
    assert.equal(m.recordProviderTokens("s1", "m1", 900), false);
    assert.equal(m.getSession("s1")!.latestContextTokens, 1000);
    // A higher count for the same message id is accepted.
    assert.equal(m.recordProviderTokens("s1", "m1", 1200), true);
    assert.equal(m.getSession("s1")!.latestContextTokens, 1200);
  });

  test("baseline/latest/message-id track observations; unknown sessions rejected", () => {
    const m = new SessionStateManager(makeConfig(bigConfig));
    m.getOrCreateSession("s1", "worker");
    m.recordProviderTokens("s1", "m1", 1000);
    m.recordProviderTokens("s1", "m2", 1500);
    const s = m.getSession("s1")!;
    assert.equal(s.baselineContextTokens, 1000);
    assert.equal(s.latestContextTokens, 1500);
    assert.equal(s.lastTokenMessageId, "m2");
    assert.equal(m.recordProviderTokens("nope", "m1", 10), false);
  });

  test("non-finite or negative observations are rejected without state change", () => {
    const m = new SessionStateManager(makeConfig(bigConfig));
    m.getOrCreateSession("s1", "worker");
    m.recordProviderTokens("s1", "m1", 1000);
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -500, 0]) {
      assert.equal(m.recordProviderTokens("s1", "m2", bad), false);
    }
    const s = m.getSession("s1")!;
    assert.equal(s.latestContextTokens, 1000);
    assert.equal(s.baselineContextTokens, 1000);
    assert.equal(s.lastTokenMessageId, "m1");
  });

  test("effective consumption is provider delta plus last output estimate", () => {
    const m = new SessionStateManager(makeConfig(bigConfig));
    m.getOrCreateSession("s2", "custom");
    m.recordProviderTokens("s2", "m1", 1000);
    m.recordProviderTokens("s2", "m2", 3000);
    // "a".repeat(400) ≈ 100 tokens per the estimator.
    m.recordToolSuccess("s2", 0, "a".repeat(400));
    assert.equal(m.getSession("s2")!.tokensIngested, 2100);
    // A second cycle against the same latest is not cumulative: only the last
    // call's estimate is added, matching reference parity.
    m.recordToolSuccess("s2", 0, "a".repeat(400));
    assert.equal(m.getSession("s2")!.tokensIngested, 2100);
  });

  test("heuristic fallback without provider observations", () => {
    const m = new SessionStateManager(makeConfig(bigConfig));
    m.getOrCreateSession("s3", "custom");
    m.recordToolSuccess("s3", 30, "a".repeat(400));
    assert.equal(m.getSession("s3")!.tokensIngested, 130);
  });

  test("provider growth drives token_limit finalization on the next tool success", () => {
    const m = new SessionStateManager(
      makeConfig({ defaults: { maxTools: 10_000_000, maxTokens: 1000 } }),
    );
    m.getOrCreateSession("s4", "custom");
    m.recordProviderTokens("s4", "m1", 1000);
    m.recordProviderTokens("s4", "m2", 5000);
    m.recordToolSuccess("s4", 0, "");
    const s = m.getSession("s4")!;
    assert.equal(s.stage, "finalization");
    assert.equal(s.exhaustionReason, "token_limit");
  });
});

describe("event hook plumbing (provider token sync)", () => {
  const tokenEvent = (id: string, inputTokens: number, cacheRead: number) => ({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          role: "assistant",
          sessionID: "sE",
          tokens: { input: inputTokens, cache: { read: cacheRead } },
        },
      },
    },
  });

  test("message.updated observations drive provider-based accounting end to end", async () => {
    const hooks = await server({} as unknown as PluginInput, makeConfig({
      agents: {
        "fixture-event": {
          enabled: true,
          maxTools: 9,
          maxTokens: 18000,
          finalization: { allowedTools: [] },
          whitelistedTools: [],
          finalizationRemaining: 1,
        },
      },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sE", agent: "fixture-event" });

    await callHook(hooks["event"], tokenEvent("m1", 1000, 500));
    await callHook(hooks["event"], tokenEvent("m2", 2500, 1000));
    // A stale duplicate of m2 with lower tokens must be ignored.
    await callHook(hooks["event"], tokenEvent("m2", 2400, 1000));

    await callHook(hooks["tool.execute.before"], { sessionID: "sE", tool: "grep" }, { args: {} });
    await callHook(hooks["tool.execute.after"], { sessionID: "sE", tool: "grep" }, { output: "a".repeat(400) });

    const system: string[] = [];
    await callHook(
      hooks["experimental.chat.system.transform"],
      { sessionID: "sE", model: "m" },
      { system },
    );
    // Provider delta (3500 - 1500 = 2000) plus the last output estimate (~100).
    assert.ok(system[0]!.includes("tokens: 2100/18000"));
  });

  test("event hook is not registered when the guard is disabled", async () => {
    const hooks = await server(
      {} as unknown as PluginInput,
      makeConfig({ enabled: false }) as unknown as PluginOptions,
    );
    assert.ok(!("event" in hooks));
  });
});
