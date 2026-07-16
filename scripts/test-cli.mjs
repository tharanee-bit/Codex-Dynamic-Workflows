import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "dist", "cli.js");
const noAgentWorkflow = join(projectRoot, "test", "fixtures", "no-agent.workflow.ts");
const waitWorkflow = join(projectRoot, "test", "fixtures", "wait.workflow.ts");
const codexHome = await mkdtemp(join(tmpdir(), "codex-dw-cli-"));
const environment = { ...process.env, CODEX_HOME: codexHome };

async function cli(args, timeout = 20_000) {
  return executeFile(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env: environment,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

async function status(runId) {
  const { stdout } = await cli(["status", runId, "--json"]);
  return JSON.parse(stdout);
}

async function waitFor(runId, predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await status(runId);
    if (predicate(latest)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last status was ${latest?.status ?? "unknown"}`);
}

async function waitForUnlock(runId) {
  const lockPath = join(codexHome, "dynamic-workflows", "runs", runId, "run.lock");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(lockPath);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out waiting for run ${runId} to release its lock`);
}

try {
  const validated = JSON.parse((await cli(["validate", noAgentWorkflow])).stdout);
  assert.equal(validated.valid, true);
  assert.equal(validated.kind, "typescript");

  const detached = JSON.parse((await cli([
    "run",
    noAgentWorkflow,
    "--cwd",
    projectRoot,
    "--args-json",
    JSON.stringify({ value: "cli-e2e" }),
    "--detach",
  ])).stdout);
  assert.equal(detached.detached, true);

  const completed = await waitFor(detached.id, (value) => value.status === "completed", "detached completion");
  assert.equal(completed.calls.total, 0);
  await waitForUnlock(detached.id);

  const inspected = JSON.parse((await cli(["inspect", detached.id])).stdout);
  assert.deepEqual(inspected.result, { ok: true, value: "cli-e2e" });

  const resumed = JSON.parse((await cli(["resume", detached.id, "--detach"])).stdout);
  assert.equal(resumed.id, detached.id);
  assert.equal(resumed.detached, true);
  await waitFor(detached.id, (value) => value.status === "completed", "detached resume");
  await waitForUnlock(detached.id);

  const stoppable = JSON.parse((await cli([
    "run",
    waitWorkflow,
    "--cwd",
    projectRoot,
    "--args-json",
    "{}",
    "--detach",
  ])).stdout);
  await waitFor(stoppable.id, (value) => value.status === "running", "detached runner startup");

  const liveInspection = JSON.parse((await cli(["inspect", stoppable.id])).stdout);
  assert.equal(liveInspection.status, "running");

  await cli(["stop", stoppable.id]);
  const stopped = await waitFor(stoppable.id, (value) => value.status === "stopped", "stopped run");
  await waitForUnlock(stoppable.id);
  assert.match(stopped.error, /stopped|aborted/i);

  const immediate = JSON.parse((await cli([
    "run",
    waitWorkflow,
    "--cwd",
    projectRoot,
    "--args-json",
    "{}",
    "--detach",
  ])).stdout);
  await cli(["stop", immediate.id]);
  await waitFor(immediate.id, (value) => value.status === "stopped", "immediate detached stop");
  await waitForUnlock(immediate.id);

  const cleanup = JSON.parse((await cli(["clean", detached.id])).stdout);
  assert.equal(cleanup.message, "Run has no Git worktrees to clean");

  const stuckWorkflow = join(codexHome, "stuck.workflow.ts");
  await writeFile(stuckWorkflow, `
    export const meta = { name: "stuck", description: "stuck", argsSchema: { type: "object" } };
    export async function run(context) { return context.agent("stuck", "stuck", { outputSchema: {} }); }
  `);
  const { executeTypeScriptWorkflow } = await import("../dist/index.js");
  await assert.rejects(
    executeTypeScriptWorkflow({
      workflowPath: stuckWorkflow,
      args: {},
      wallTimeMs: 50,
      rpc: async () => new Promise(() => undefined),
    }),
    (error) => error?.code === "ERR_CODEX_DW_TYPESCRIPT_TIMEOUT",
  );

  process.stdout.write("CLI end-to-end checks passed.\n");
} finally {
  await rm(codexHome, { recursive: true, force: true });
}
