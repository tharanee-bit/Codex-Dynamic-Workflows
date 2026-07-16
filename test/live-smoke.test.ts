import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RunManager } from "../src/runtime/index.js";
import { parseWorkflow } from "../src/schema/index.js";

describe("live smoke workflow contract", () => {
  it("uses an OpenAI Structured Outputs compatible schema", async () => {
    const workflow = parseWorkflow(await readFile(resolve("examples/live-smoke.workflow.yaml"), "utf8"), "yaml");
    const phase = workflow.phases[0];
    expect(phase?.type).toBe("agent");
    if (!phase || phase.type !== "agent") throw new Error("Live smoke workflow must contain one agent phase");
    expect(phase.agent.reasoningEffort).toBe("low");
    expect(phase.agent.outputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["ok", "message"],
      properties: {
        ok: { type: "boolean" },
        message: { type: "string" },
      },
    });
  });
});

describe.skipIf(process.env.CODEX_DW_LIVE !== "1")("live Codex adapter smoke", () => {
  it("executes one read-only structured-output agent", async () => {
    const manager = new RunManager();
    const state = await manager.createRun({
      workflow: resolve("examples/live-smoke.workflow.yaml"),
      args: {},
      workingDirectory: process.cwd(),
      allowMutation: false,
    });
    const completed = await manager.execute(state.id);
    expect(completed.result).toEqual({ ok: true, message: "codex-dw-live-smoke" });
  }, 120_000);
});
