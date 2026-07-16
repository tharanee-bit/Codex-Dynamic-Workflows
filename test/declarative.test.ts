import { describe, expect, it } from "vitest";

import { FakeAdapter } from "../src/adapter/fake.js";
import { WorkflowEngine, type EngineStore } from "../src/engine/core.js";
import { runDeclarativeWorkflow } from "../src/engine/declarative.js";
import type { DeclarativeWorkflow } from "../src/schema/index.js";
import type { RunState } from "../src/types.js";

const schema = {
  type: "object",
  properties: { value: {} },
  required: ["value"],
  additionalProperties: false,
};

function runState(maxAgents = 14): RunState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "declarative",
    status: "running",
    workflowPath: "workflow.yaml",
    workflowHash: "hash",
    workflowKind: "declarative",
    workflowSnapshot: "",
    args: {},
    workingDirectory: process.cwd(),
    profile: "medium",
    maxAgents,
    agentCallsUsed: 0,
    concurrency: 4,
    allowMutation: false,
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    calls: {},
    phases: {},
    outputs: {},
  };
}

const store: EngineStore = { async save() {}, async appendEvent() {} };

describe("declarative execution", () => {
  it("executes parallel branches and selects the result", async () => {
    const workflow: DeclarativeWorkflow = {
      apiVersion: "codex.openai.com/v1alpha1",
      kind: "Workflow",
      metadata: { name: "parallel", description: "parallel test" },
      argsSchema: { type: "object" },
      phases: [
        {
          id: "checks",
          type: "parallel",
          agents: [
            { id: "a", prompt: "{{args.name}}", outputSchema: schema },
            { id: "b", prompt: "b", outputSchema: schema },
          ],
        },
      ],
      result: "outputs.checks",
    };
    const adapter = new FakeAdapter((request) => ({ value: request.callId }));
    const engine = new WorkflowEngine(runState(), adapter, store);
    const result = await runDeclarativeWorkflow(workflow, { name: "demo" }, engine);
    expect(result).toEqual({ a: { value: "checks/a" }, b: { value: "checks/b" } });
  });

  it("uses stable item keys and streams every pipeline stage", async () => {
    const workflow: DeclarativeWorkflow = {
      apiVersion: "codex.openai.com/v1alpha1",
      kind: "Workflow",
      metadata: { name: "pipeline", description: "pipeline test" },
      argsSchema: { type: "object" },
      phases: [
        {
          id: "work",
          type: "pipeline",
          items: [{ id: "one" }, { id: "two" }],
          key: "id",
          stages: [
            { id: "review", prompt: "{{item.id}}", outputSchema: schema },
            { id: "verify", prompt: "{{input.value}}", outputSchema: schema },
          ],
        },
      ],
    };
    const adapter = new FakeAdapter((request) => ({ value: request.callId }));
    const engine = new WorkflowEngine(runState(), adapter, store);
    await runDeclarativeWorkflow(workflow, {}, engine);
    expect(adapter.requests.map((request) => request.callId).sort()).toEqual([
      "work/review.one",
      "work/review.two",
      "work/verify.one",
      "work/verify.two",
    ]);
  });
});
