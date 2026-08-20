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
  pathMatchesPattern,
  SessionStateManager,
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

describe("resolveConfig hierarchical resolution", () => {
  test("no options resolves to DEFAULT_CONFIG", () => {
    assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
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
      "Action required: Tool execution is restricted in finalization stage. Please summarize your findings, provide your final report, or complete task handover in your text response.",
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
    assert.equal(pathMatchesPattern(".opencode/handover.md", ".opencode/handover.md"), true);
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
      makeConfig({ agents: { coder: { enabled: false, maxTools: 1 } } }),
    );
    assert.equal(m.isAgentExempt("coder"), true);
    const s = m.getOrCreateSession("s1", "coder");
    m.recordToolSuccess("s1", 0, "");
    assert.equal(s.stage, "execution");
  });

  test("explicit enabled:true keeps non-primary agents guarded", () => {
    const m = new SessionStateManager(
      makeConfig({ agents: { coder: { enabled: true, maxTools: 1 } } }),
    );
    assert.equal(m.isAgentExempt("coder"), false);
    const s = m.getOrCreateSession("s1", "coder");
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
      agents: { coder: { enabled: false } },
    }) as unknown as PluginOptions);
    await callHook(hooks["chat.params"], { sessionID: "sC", agent: "coder" });
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

    assert.equal(await readStatusLine(hooks, "sF"), `[capacity-guard] tools: 1/1 (0 remaining); tokens: ${perCycleTokens}/10000000 (~${10_000_000 - perCycleTokens} remaining); stage: finalization`);
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
