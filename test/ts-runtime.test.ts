import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../src/types.js";
import {
  executeTypeScriptWorkflow,
  nodePermissionFlag,
  supportsNodePermissions,
  type TypeScriptWorkflowRpcRequest,
} from "../src/ts-runtime/index.js";

const temporaryDirectories: string[] = [];

async function fixture(source: string): Promise<{ directory: string; workflowPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-dw-ts-test-"));
  temporaryDirectories.push(directory);
  const workflowPath = join(directory, "workflow.ts");
  await writeFile(workflowPath, source, "utf8");
  return { directory, workflowPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

const metadata = `
export const meta = {
  name: "fixture",
  description: "A harmless test workflow",
  argsSchema: { type: "object" },
};`;

describe("TypeScript workflow execution", () => {
  it("selects the permission flag supported by the active Node release", () => {
    expect(nodePermissionFlag(new Set(["--permission", "--experimental-permission"]))).toBe("--permission");
    expect(nodePermissionFlag(new Set(["--experimental-permission"]))).toBe("--experimental-permission");
    expect(nodePermissionFlag(new Set())).toBeUndefined();
  });

  it("canonicalizes a symlinked temporary directory for Node permission paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-dw-ts-alias-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");
    const workflowDirectory = await mkdtemp(join(alias, "workflow-"));
    const workflowPath = join(workflowDirectory, "workflow.ts");
    await writeFile(workflowPath, `${metadata}\nexport async function run() { return { ok: true }; }`, "utf8");

    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = alias;
    try {
      const execution = await executeTypeScriptWorkflow({
        workflowPath,
        args: {},
        wallTimeMs: 5_000,
        rpc: async () => undefined,
      });
      expect(execution.result).toEqual({ ok: true });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });

  it("runs phase, agent, log, parallel, bounded pipeline, and bounded loop semantics over RPC", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run(context, args) {
  return context.phase("phase.main", async () => {
    await context.log("fixture-started", { safe: true });
    const parallel = await context.parallel("parallel.reviews", {
      left: () => context.agent("agent.left", "left", { input: "left", outputSchema: {} }),
      right: () => context.agent("agent.right", "right", { input: "right", outputSchema: {} }),
    });
    const pipeline = await context.pipeline(
      "pipeline.items",
      [1, 2, 3, 4],
      (item) => context.agent("agent.pipe-" + item, "pipe", { input: item, outputSchema: {} }),
      { concurrency: 2, key: (item) => "item-" + item },
    );
    const loop = await context.loop(
      "loop.until-two",
      (iteration) => context.agent("agent.loop-" + iteration, "loop", { input: iteration, outputSchema: {} }),
      { maxIterations: 4, until: (value) => value === 2 },
    );
    return { parallel, pipeline, loop, passthrough: args.value };
  });
}`);

    const requests: TypeScriptWorkflowRpcRequest[] = [];
    let activePipelineCalls = 0;
    let maximumPipelineCalls = 0;
    const parallelStarts: string[] = [];

    const execution = await executeTypeScriptWorkflow({
      workflowPath,
      args: { value: "ok" },
      pipelineConcurrency: 2,
      maxLoopIterations: 4,
      wallTimeMs: 10_000,
      rpc: async (request): Promise<JsonValue | void> => {
        requests.push(request);
        if (request.method !== "agent") return;
        if (request.id === "agent.left" || request.id === "agent.right") {
          parallelStarts.push(request.id);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        if (request.id.startsWith("agent.pipe-")) {
          activePipelineCalls += 1;
          maximumPipelineCalls = Math.max(maximumPipelineCalls, activePipelineCalls);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activePipelineCalls -= 1;
        }
        return request.options.input ?? null;
      },
    });

    expect(execution.meta.name).toBe("fixture");
    expect(execution.result).toEqual({
      parallel: { left: "left", right: "right" },
      pipeline: [1, 2, 3, 4],
      loop: 2,
      passthrough: "ok",
    });
    expect(parallelStarts).toEqual(["agent.left", "agent.right"]);
    expect(maximumPipelineCalls).toBe(2);
    expect(requests).toContainEqual({ method: "phase", id: "phase.main", action: "start" });
    expect(requests).toContainEqual({ method: "phase", id: "phase.main", action: "complete" });
    expect(requests).toContainEqual({ method: "log", message: "fixture-started", data: { safe: true } });
    expect(
      requests.filter((request) => request.method === "agent").every(
        (request) => request.options.phaseId === "phase.main",
      ),
    ).toBe(true);
  });

  it("requires named meta and run exports", async () => {
    const { workflowPath } = await fixture("export default { nope: true };");

    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      wallTimeMs: 5_000,
      rpc: async () => undefined,
    })).rejects.toThrow(/export a metadata object named 'meta'/);
  });

  it("rejects data imports and code imports that escape the workflow directory", async () => {
    const { directory, workflowPath } = await fixture(`${metadata}
import secret from "./inside.json" with { type: "json" };
export async function run() { return secret; }
`);
    await writeFile(join(directory, "inside.json"), '{"secret":true}', "utf8");
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      rpc: async () => undefined,
    })).rejects.toThrow(/must use an explicit code extension|could not be resolved|escapes/);

    const outsideName = `outside-${basename(directory)}.ts`;
    const parentCode = join(directory, "..", outsideName);
    await writeFile(parentCode, "export default { secret: true };", "utf8");
    await writeFile(workflowPath, `${metadata}
import secret from "../${outsideName}";
export async function run() { return secret; }
`, "utf8");
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      rpc: async () => undefined,
    })).rejects.toThrow(/escapes the workflow directory/);
    await rm(parentCode, { force: true });
  });

  it("rejects forged IPC agent requests with parent filesystem overrides", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run() {
  process.send({
    type: "rpc",
    requestId: "999",
    request: {
      method: "agent",
      id: "forged",
      prompt: "read elsewhere",
      options: { outputSchema: {}, workingDirectory: "/" },
    },
  });
  await new Promise(() => {});
}`);
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      wallTimeMs: 5_000,
      rpc: async () => null,
    })).rejects.toThrow(/unsupported fields: workingDirectory/);
  });

  it("rejects completion with an unawaited agent and drains the aborted parent RPC", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run(context) {
  void context.agent("orphan", "orphan", { outputSchema: {} });
  await context.log("orphan-dispatched");
  return { done: true };
}`);
    let aborted = false;
    let settled = false;
    const started = Date.now();
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      rpc: async (request, signal) => {
        if (request.method === "log") return;
        return new Promise((_resolve, reject) => {
        const finishAborted = () => {
          aborted = true;
          setTimeout(() => {
            settled = true;
            reject(signal.reason);
          }, 1_100);
        };
        if (signal.aborted) {
          finishAborted();
          return;
        }
        signal.addEventListener("abort", () => {
          finishAborted();
        }, { once: true });
        });
      },
    })).rejects.toThrow(/parent RPC calls were still running/);
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it("rejects unstable and duplicate operation ids in the child", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run(context) {
  await context.log("before");
  return context.agent("not stable!", "prompt", { outputSchema: {} });
}`);

    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      wallTimeMs: 5_000,
      rpc: async () => null,
    })).rejects.toThrow(/requires a stable id/);
  });

  it("terminates an unresponsive workflow at the wall-time limit", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run() {
  await new Promise(() => {});
}`);

    const started = Date.now();
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      wallTimeMs: 100,
      rpc: async () => undefined,
    })).rejects.toMatchObject({
      code: "ERR_CODEX_DW_TYPESCRIPT_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("enforces configured process-limit ceilings before launch", async () => {
    const { workflowPath } = await fixture(`${metadata}\nexport async function run() { return {}; }`);
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      memoryLimitMb: 20_000,
      rpc: async () => undefined,
    })).rejects.toThrow(/memoryLimitMb must be an integer/);
  });

  it("terminates cleanly when the caller aborts", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run() {
  await new Promise(() => {});
}`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      signal: controller.signal,
      wallTimeMs: 5_000,
      rpc: async () => undefined,
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
  });

  it("fails when a loop reaches its bound without satisfying the stop condition", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run(context) {
  return context.loop("never", async (iteration) => iteration, {
    maxIterations: 2,
    until: () => false,
  });
}
`);
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      maxLoopIterations: 2,
      rpc: async () => undefined,
    })).rejects.toThrow(/reached maxIterations/);
  });

  it("bounds shutdown when a parent RPC ignores cancellation", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run(context) {
  return context.agent("stuck", "stuck", { outputSchema: {} });
}`);
    const started = Date.now();
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      wallTimeMs: 50,
      rpc: async () => new Promise(() => undefined),
    })).rejects.toMatchObject({ code: "ERR_CODEX_DW_TYPESCRIPT_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("rejects computed dynamic imports before launching the coordinator", async () => {
    const { workflowPath } = await fixture(`${metadata}
export async function run() {
  const specifier = "node:" + "net";
  await import/* comment-separated bypass */(specifier);
  return {};
}`);
    await expect(executeTypeScriptWorkflow({
      workflowPath,
      args: {},
      rpc: async () => undefined,
    })).rejects.toThrow(/may not use dynamic import/);
  });

  it.skipIf(!supportsNodePermissions())(
    "denies unapproved reads, writes, child processes, and credential inheritance",
    async () => {
      const { directory, workflowPath } = await fixture(`${metadata}
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
export async function run(_context, args) {
  const denial = {};
  try { await readFile(args.secretPath, "utf8"); denial.read = false; }
  catch (error) { denial.read = error.code === "ERR_ACCESS_DENIED"; }
  try { await writeFile(args.writePath, "nope"); denial.write = false; }
  catch (error) { denial.write = error.code === "ERR_ACCESS_DENIED"; }
  try { spawnSync(process.execPath, ["--version"]); denial.spawn = false; }
  catch (error) { denial.spawn = error.code === "ERR_ACCESS_DENIED"; }
  try { new Worker("", { eval: true }); denial.worker = false; }
  catch (error) { denial.worker = error.code === "ERR_ACCESS_DENIED"; }
  try { await fetch("http://127.0.0.1:1"); denial.network = false; }
  catch (error) { denial.network = error.code === "ERR_ACCESS_DENIED"; }
  return {
    denial,
    credentials: {
      openai: process.env.OPENAI_API_KEY ?? null,
      codex: process.env.CODEX_API_KEY ?? null,
      aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    },
  };
}`);
      const secretPath = join(directory, "secret.txt");
      const writePath = join(directory, "attempted-write.txt");
      await writeFile(secretPath, "secret", "utf8");
      const originalOpenAi = process.env.OPENAI_API_KEY;
      const originalCodex = process.env.CODEX_API_KEY;
      const originalAws = process.env.AWS_SECRET_ACCESS_KEY;
      process.env.OPENAI_API_KEY = "must-not-leak";
      process.env.CODEX_API_KEY = "must-not-leak";
      process.env.AWS_SECRET_ACCESS_KEY = "must-not-leak";

      try {
        const execution = await executeTypeScriptWorkflow({
          workflowPath,
          args: { secretPath, writePath },
          wallTimeMs: 5_000,
          rpc: async () => undefined,
        });
        expect(execution.permissionIsolation).toBe(true);
        expect(execution.result).toEqual({
          denial: { read: true, write: true, spawn: true, worker: true, network: true },
          credentials: { openai: null, codex: null, aws: null },
        });
        await expect(readFile(writePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalOpenAi;
        if (originalCodex === undefined) delete process.env.CODEX_API_KEY;
        else process.env.CODEX_API_KEY = originalCodex;
        if (originalAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
        else process.env.AWS_SECRET_ACCESS_KEY = originalAws;
      }
    },
  );
});
