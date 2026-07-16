#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { Command, Option } from "commander";

import { RunManager, summarizeRun, type RunSummary } from "./runtime/index.js";
import type { JsonValue, WorkflowProfile } from "./types.js";

const program = new Command();
program
  .name("codex-dw")
  .description("Experimental Codex-native dynamic workflow runner")
  .version("0.1.0");

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSummary(summary: RunSummary): void {
  const lines = [
    `${summary.id}  ${summary.status}`,
    `workflow: ${summary.workflow}`,
    `profile: ${summary.profile}`,
    `calls: ${summary.calls.completed} completed, ${summary.calls.running} running, ${summary.calls.failed} failed, ${summary.calls.total} total`,
    `tokens: ${summary.tokens}`,
  ];
  if (summary.integrationBranch) lines.push(`integration: ${summary.integrationBranch}`);
  if (summary.error) lines.push(`error: ${summary.error}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function parseArgs(options: { argsJson?: string; argsFile?: string }): Promise<JsonValue> {
  if (options.argsJson !== undefined && options.argsFile !== undefined) {
    throw new Error("Use only one of --args-json or --args-file");
  }
  const source = options.argsFile !== undefined
    ? await readFile(options.argsFile, "utf8")
    : options.argsJson ?? "{}";
  const value: unknown = JSON.parse(source);
  if (value === undefined) throw new Error("Workflow arguments must be JSON");
  return value as JsonValue;
}

function launchDetached(runId: string, resume = false): void {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine the codex-dw executable path");
  const child = spawn(process.execPath, [entry, "__execute", runId, ...(resume ? ["--resume"] : [])], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function selectedRunId(manager: RunManager, runId?: string): Promise<string> {
  if (runId) return runId;
  const latest = await manager.store.getLatestRun();
  if (!latest) throw new Error("No dynamic workflow runs exist");
  return latest.id;
}

function profileOption(): Option {
  return new Option("--profile <profile>", "small, medium, or large execution profile")
    .choices(["small", "medium", "large"]);
}

program
  .command("validate")
  .argument("<workflow>", "workflow file or namespaced workflow name")
  .option("--cwd <path>", "project working directory", process.cwd())
  .action(async (workflow: string, options: { cwd: string }) => {
    const result = await new RunManager().validate(workflow, options.cwd);
    print({ valid: true, ...result });
  });

program
  .command("run")
  .argument("<workflow>", "workflow file or namespaced workflow name")
  .option("--cwd <path>", "project working directory", process.cwd())
  .option("--args-json <json>", "workflow arguments as JSON")
  .option("--args-file <path>", "read workflow arguments from a JSON file")
  .option("--allow-mutation", "authorize declared mutating agents", false)
  .option("--detach", "continue the run in a detached process", false)
  .addOption(profileOption())
  .action(async (workflow: string, options: {
    cwd: string;
    argsJson?: string;
    argsFile?: string;
    allowMutation: boolean;
    detach: boolean;
    profile?: WorkflowProfile;
  }) => {
    const manager = new RunManager();
    const state = await manager.createRun({
      workflow,
      args: await parseArgs(options),
      workingDirectory: options.cwd,
      allowMutation: options.allowMutation,
      ...(options.profile ? { profileOverride: options.profile } : {}),
    });
    if (options.detach) {
      launchDetached(state.id);
      print({ id: state.id, status: "pending", detached: true });
      return;
    }
    const completed = await manager.execute(state.id);
    printSummary(summarizeRun(completed));
  });

program
  .command("resume")
  .argument("<run-id>", "persisted run id")
  .option("--workflow <path>", "resume against an updated workflow definition")
  .option("--detach", "continue the run in a detached process", false)
  .action(async (runId: string, options: { workflow?: string; detach: boolean }) => {
    if (options.detach) {
      if (options.workflow) {
        throw new Error("Detached resume does not accept --workflow; run a foreground resume first");
      }
      launchDetached(runId, true);
      print({ id: runId, status: "pending", detached: true });
      return;
    }
    const completed = await new RunManager().resume(runId, options.workflow);
    printSummary(summarizeRun(completed));
  });

program
  .command("status")
  .argument("[run-id]", "run id; defaults to the newest run")
  .option("--json", "print machine-readable JSON", false)
  .option("--watch", "refresh until the run reaches a terminal state", false)
  .action(async (runId: string | undefined, options: { json: boolean; watch: boolean }) => {
    const manager = new RunManager();
    const id = await selectedRunId(manager, runId);
    while (true) {
      const summary = await manager.status(id);
      if (options.json) print(summary);
      else printSummary(summary);
      if (!options.watch || ["completed", "failed", "stopped"].includes(summary.status)) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  });

program
  .command("inspect")
  .argument("[run-id]", "run id; defaults to the newest run")
  .argument("[call-id]", "optional stable call id")
  .action(async (runId?: string, callId?: string) => {
    const manager = new RunManager();
    print(await manager.inspect(await selectedRunId(manager, runId), callId));
  });

program
  .command("stop")
  .argument("<run-id>", "run id")
  .action(async (runId: string) => {
    const manager = new RunManager();
    printSummary(summarizeRun(await manager.stop(runId)));
  });

program
  .command("clean")
  .argument("<run-id>", "run id")
  .option("--force", "remove unintegrated task branches and dirty task worktrees", false)
  .action(async (runId: string, options: { force: boolean }) => {
    const result = await new RunManager().clean(runId, options.force);
    print(result ?? { message: "Run has no Git worktrees to clean" });
  });

program
  .command("__execute", { hidden: true })
  .argument("<run-id>")
  .option("--resume", "resume a previously started run", false)
  .action(async (runId: string, options: { resume: boolean }) => {
    const manager = new RunManager();
    if (options.resume) await manager.resume(runId);
    else await manager.execute(runId);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`codex-dw: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
