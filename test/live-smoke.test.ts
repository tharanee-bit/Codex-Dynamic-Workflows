import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RunManager } from "../src/runtime/index.js";

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
