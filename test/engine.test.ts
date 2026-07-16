import { describe, expect, it } from "vitest";

import { FakeAdapter } from "../src/adapter/fake.js";
import { WorkflowEngine, type EngineStore } from "../src/engine/core.js";
import { AgentExecutionError, type RunEvent, type RunState } from "../src/types.js";

function state(overrides: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "run-test",
    status: "running",
    workflowPath: "/tmp/workflow.yaml",
    workflowHash: "hash",
    workflowKind: "declarative",
    workflowSnapshot: "workflow",
    args: {},
    workingDirectory: process.cwd(),
    profile: "medium",
    maxAgents: 14,
    agentCallsUsed: 0,
    concurrency: 4,
    allowMutation: false,
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    calls: {},
    phases: {},
    outputs: {},
    ...overrides,
  };
}

function memoryStore(): EngineStore & { events: RunEvent[]; saves: number } {
  return {
    events: [],
    saves: 0,
    async save() {
      this.saves += 1;
    },
    async appendEvent(_runId, event) {
      this.events.push(event);
    },
  };
}

const objectSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

describe("WorkflowEngine", () => {
  it("reuses an unchanged completed call without consuming another agent", async () => {
    const adapter = new FakeAdapter((request) => ({ id: request.callId }));
    const run = state();
    const engine = new WorkflowEngine(run, adapter, memoryStore());
    const first = await engine.phase("review", () => engine.agent("a", "review", { outputSchema: objectSchema }));
    const second = await engine.phase("review", () => engine.agent("a", "review", { outputSchema: objectSchema }));
    expect(first).toEqual(second);
    expect(adapter.requests).toHaveLength(1);
  });

  it("invalidates a call when an input changes", async () => {
    const adapter = new FakeAdapter((request) => ({ id: String(request.input) }));
    const engine = new WorkflowEngine(state(), adapter, memoryStore());
    await engine.phase("review", () => engine.agent("a", "review", { outputSchema: objectSchema, input: "one" }));
    await engine.phase("review", () => engine.agent("a", "review", { outputSchema: objectSchema, input: "two" }));
    expect(adapter.requests).toHaveLength(2);
  });

  it("implements a parallel barrier", async () => {
    const completions: string[] = [];
    const adapter = new FakeAdapter(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, request.callId.endsWith("slow") ? 30 : 5));
      completions.push(request.callId);
      return { id: request.callId };
    });
    const engine = new WorkflowEngine(state(), adapter, memoryStore());
    const result = await engine.phase("parallel", () =>
      engine.parallel("checks", {
        slow: () => engine.agent("slow", "slow", { outputSchema: objectSchema }),
        fast: () => engine.agent("fast", "fast", { outputSchema: objectSchema }),
      }),
    );
    expect(Object.keys(result).sort()).toEqual(["fast", "slow"]);
    expect(completions).toHaveLength(2);
  });

  it("streams pipeline items across stages without a global stage barrier", async () => {
    const order: string[] = [];
    const engine = new WorkflowEngine(state({ concurrency: 4 }), new FakeAdapter(() => ({})), memoryStore());
    await engine.pipeline("items", [0, 1], async (item) => {
      order.push(`start-${item}`);
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 5 : 30));
      order.push(`stage2-${item}`);
      return item;
    });
    expect(order.indexOf("stage2-0")).toBeLessThan(order.indexOf("stage2-1"));
  });

  it("enforces the total-call budget and aggregates token usage", async () => {
    const adapter = new FakeAdapter((request) => ({ id: request.callId }));
    const run = state({ maxAgents: 1 });
    const engine = new WorkflowEngine(run, adapter, memoryStore());
    await engine.agent("one", "one", { phaseId: "budget", outputSchema: objectSchema });
    await expect(engine.agent("two", "two", { phaseId: "budget", outputSchema: objectSchema })).rejects.toThrow(
      "Agent budget exhausted",
    );
    expect(run.agentCallsUsed).toBe(1);
    expect(run.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
  });

  it("persists failed-call thread and usage metadata", async () => {
    const run = state();
    const engine = new WorkflowEngine(run, {
      async run() {
        throw new AgentExecutionError("turn failed", {
          threadId: "thread-failed",
          attempts: 1,
          usage: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4 },
        });
      },
    }, memoryStore());
    await expect(engine.agent("failed", "failed", { phaseId: "failure", outputSchema: objectSchema })).rejects.toThrow("turn failed");
    expect(run.calls["failure/failed"]).toMatchObject({
      status: "failed",
      threadId: "thread-failed",
      attempts: 1,
      usage: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4 },
    });
    expect(run.usage.inputTokens).toBe(7);
  });

  it("finishes a persisted running output without relaunching the agent", async () => {
    const run = state();
    const first = new WorkflowEngine(run, new FakeAdapter((request) => ({ id: request.callId })), memoryStore());
    await first.agent("resume", "resume", { phaseId: "phase", outputSchema: objectSchema });
    const record = run.calls["phase/resume"]!;
    record.status = "running";
    delete record.completedAt;
    const adapter = new FakeAdapter(() => { throw new Error("must not relaunch"); });
    const resumed = new WorkflowEngine(run, adapter, memoryStore());
    await expect(resumed.agent("resume", "resume", { phaseId: "phase", outputSchema: objectSchema })).resolves.toEqual({ id: "phase/resume" });
    expect(adapter.requests).toHaveLength(0);
    expect(run.calls["phase/resume"]?.status).toBe("completed");
  });
});
