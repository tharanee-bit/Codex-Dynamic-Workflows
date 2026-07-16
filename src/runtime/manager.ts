import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import { Ajv, type ErrorObject } from "ajv";

import { CodexAdapter } from "../adapter/codex.js";
import { WorkflowEngine } from "../engine/core.js";
import { runDeclarativeWorkflow } from "../engine/declarative.js";
import { GitWorkspaceController } from "../engine/git-workspace.js";
import { cleanupGitRun, type CleanupResult, type GitRunSession } from "../git/index.js";
import {
  parseWorkflow,
  type DeclarativeWorkflow,
  type WorkflowSourceFormat,
} from "../schema/index.js";
import { RunLockedError, RunStateStore, type RunLock } from "../state/index.js";
import { executeTypeScriptWorkflow, type TypeScriptWorkflowRpcRequest } from "../ts-runtime/index.js";
import type {
  AgentAdapter,
  JsonValue,
  PhaseRecord,
  RunEvent,
  RunOptions,
  RunState,
  WorkflowProfile,
} from "../types.js";
import { EMPTY_USAGE, HARD_LIMITS, PROFILE_LIMITS } from "../types.js";
import { sha256Canonical } from "../util/index.js";
import type { WorkflowMetadata } from "../workflow-api.js";

const DECLARATIVE_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const WORKFLOW_EXTENSIONS = [...DECLARATIVE_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS];
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

export interface RunManagerOptions {
  store?: RunStateStore;
  adapter?: AgentAdapter;
}

export interface CreateRunOptions extends Omit<RunOptions, "workflowPath"> {
  workflow: string;
}

export interface RunSummary {
  id: string;
  status: RunState["status"];
  workflow: string;
  profile: WorkflowProfile;
  calls: { completed: number; failed: number; running: number; total: number };
  tokens: number;
  integrationBranch?: string;
  error?: string;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 12)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function validateArguments(schema: Record<string, unknown>, args: JsonValue): void {
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid workflow argument schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(args)) {
    throw new Error(`Workflow arguments are invalid: ${formatSchemaErrors(validate.errors)}`);
  }
}

function workflowKind(path: string): RunState["workflowKind"] {
  const extension = extname(path).toLowerCase();
  if (DECLARATIVE_EXTENSIONS.has(extension)) return "declarative";
  if (TYPESCRIPT_EXTENSIONS.has(extension)) return "typescript";
  throw new Error(`Unsupported workflow extension ${extension || "(none)"}`);
}

async function bundledTypeScriptSource(path: string): Promise<string> {
  const { bundleTypeScriptWorkflow } = await import("../ts-runtime/index.js");
  const bundle = await bundleTypeScriptWorkflow({ workflowPath: path });
  try {
    return await readFile(bundle.bundlePath, "utf8");
  } finally {
    if (bundle.temporaryDirectory) {
      await rm(bundle.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function sourceFormat(path: string): WorkflowSourceFormat {
  return extname(path).toLowerCase() === ".json" ? "json" : "yaml";
}

function applyProfile(
  state: Pick<RunState, "profile" | "concurrency" | "maxAgents" | "agentCallsUsed">,
  profile: WorkflowProfile,
  concurrency?: number,
  maxAgents?: number,
): void {
  const profileLimits = PROFILE_LIMITS[profile];
  const requestedConcurrency = concurrency ?? profileLimits.concurrency;
  const requestedMaxAgents = maxAgents ?? profileLimits.maxAgents;
  if (requestedConcurrency < 1 || requestedConcurrency > profileLimits.concurrency) {
    throw new Error(
      `${profile} profile concurrency must be between 1 and ${profileLimits.concurrency}`,
    );
  }
  if (requestedMaxAgents < 1 || requestedMaxAgents > profileLimits.maxAgents) {
    throw new Error(
      `${profile} profile maxAgents must be between 1 and ${profileLimits.maxAgents}`,
    );
  }
  if (requestedConcurrency > HARD_LIMITS.concurrency || requestedMaxAgents > HARD_LIMITS.maxAgents) {
    throw new Error("Workflow exceeds the prototype hard limits");
  }
  if (state.agentCallsUsed > requestedMaxAgents) {
    throw new Error(
      `Run already used ${state.agentCallsUsed} calls, above the requested budget ${requestedMaxAgents}`,
    );
  }
  state.profile = profile;
  state.concurrency = requestedConcurrency;
  state.maxAgents = requestedMaxAgents;
}

function createId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkflow(
  workflow: string,
  workingDirectory: string,
  store: RunStateStore,
): Promise<string> {
  const direct = resolve(workingDirectory, workflow);
  if (isAbsolute(workflow) || workflow.includes("/") || extname(workflow) !== "") {
    if (await exists(direct)) return direct;
    if (isAbsolute(workflow) && await exists(workflow)) return resolve(workflow);
  }

  if (workflow.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("Workflow names may only use a namespace/name path without traversal");
  }
  const roots = [
    join(resolve(workingDirectory), ".codex", "dynamic-workflows"),
    join(store.codexHome, "dynamic-workflows", "workflows"),
  ];
  const candidates = roots.flatMap((root) => WORKFLOW_EXTENSIONS.map((extension) => join(root, `${workflow}${extension}`)));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    `Workflow ${JSON.stringify(workflow)} was not found as a file or under project/personal dynamic-workflows directories`,
  );
}

function event(state: RunState, type: string, fields: Partial<RunEvent> = {}): RunEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    runId: state.id,
    ...fields,
  };
}

export class RunManager {
  readonly store: RunStateStore;
  readonly adapter: AgentAdapter;

  constructor(options: RunManagerOptions = {}) {
    this.store = options.store ?? new RunStateStore();
    this.adapter = options.adapter ?? new CodexAdapter();
  }

  async validate(workflow: string, workingDirectory = process.cwd()): Promise<{
    path: string;
    kind: RunState["workflowKind"];
    name?: string;
  }> {
    const path = await resolveWorkflow(workflow, workingDirectory, this.store);
    const kind = workflowKind(path);
    if (kind === "declarative") {
      const parsed = parseWorkflow(await readFile(path, "utf8"), sourceFormat(path));
      return { path, kind, name: parsed.metadata.name };
    }
    const { bundleTypeScriptWorkflow } = await import("../ts-runtime/index.js");
    const bundle = await bundleTypeScriptWorkflow({ workflowPath: path });
    if (bundle.temporaryDirectory) {
      const { rm } = await import("node:fs/promises");
      await rm(bundle.temporaryDirectory, { recursive: true, force: true });
    }
    return { path, kind };
  }

  async createRun(options: CreateRunOptions): Promise<RunState> {
    const workingDirectory = resolve(options.workingDirectory);
    const path = await resolveWorkflow(options.workflow, workingDirectory, this.store);
    const kind = workflowKind(path);
    const entrySource = await readFile(path, "utf8");
    const source = kind === "typescript" ? await bundledTypeScriptSource(path) : entrySource;
    let declarative: DeclarativeWorkflow | undefined;
    if (kind === "declarative") {
      declarative = parseWorkflow(entrySource, sourceFormat(path));
      validateArguments(declarative.argsSchema, options.args);
    }
    const profile = options.profileOverride ?? declarative?.runtime?.profile ?? "small";
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: 1,
      id: options.runId ?? createId(),
      status: "pending",
      workflowPath: path,
      workflowHash: sha256Canonical(source),
      workflowKind: kind,
      workflowSnapshot: source,
      args: options.args,
      workingDirectory,
      profile,
      ...(options.profileOverride ? { profileOverridden: true } : {}),
      concurrency: 1,
      maxAgents: 1,
      agentCallsUsed: 0,
      allowMutation: options.allowMutation,
      createdAt: now,
      updatedAt: now,
      usage: { ...EMPTY_USAGE },
      calls: {},
      phases: {},
      outputs: {},
    };
    applyProfile(
      state,
      profile,
      declarative?.runtime?.concurrency,
      declarative?.runtime?.maxAgents,
    );
    await this.store.initializeRun(state);
    await writeFile(
      join(
        this.store.runDirectory(state.id),
        kind === "typescript" ? "workflow.snapshot.mjs" : `workflow.snapshot${extname(path)}`,
      ),
      source,
      { encoding: "utf8", mode: 0o600 },
    );
    await this.store.appendEvent(event(state, "run.created"));
    return state;
  }

  async execute(runId: string, workflowOverride?: string): Promise<RunState> {
    const lock = await this.store.acquireLock(runId);
    return this.#executeLocked(runId, workflowOverride, lock);
  }

  async #executeLocked(runId: string, workflowOverride: string | undefined, lock: RunLock): Promise<RunState> {
    let handedToExecution = false;
    try {
      const state = await this.store.readRun(runId);
      handedToExecution = true;
      return await this.#executeStateLocked(runId, workflowOverride, lock, state);
    } finally {
      if (!handedToExecution) await lock.release();
    }
  }

  async #executeStateLocked(
    runId: string,
    workflowOverride: string | undefined,
    lock: RunLock,
    state: RunState,
  ): Promise<RunState> {
    let engine: WorkflowEngine | undefined;
    let lateRpcDrain: Promise<void> | undefined;
    const controller = new AbortController();
    let interrupted = false;
    const interrupt = (): void => {
      if (controller.signal.aborted) return;
      interrupted = true;
      state.status = "stopping";
      state.updatedAt = new Date().toISOString();
      void this.store.save(state);
      controller.abort(new Error("Workflow stopped"));
      engine?.cancel();
    };
    process.once("SIGTERM", interrupt);
    process.once("SIGINT", interrupt);
    const stopPoll = setInterval(() => {
      void this.store.hasStopRequest(runId).then((requested) => {
        if (requested) interrupt();
      }).catch(() => undefined);
    }, 100);
    stopPoll.unref();

    try {
      if (state.status === "stopped" || await this.store.hasStopRequest(runId)) {
        if (state.status !== "stopped") {
          state.status = "stopped";
          state.error = "Workflow stopped before runner startup";
          state.completedAt = new Date().toISOString();
          state.updatedAt = state.completedAt;
          await this.store.save(state);
        }
        return state;
      }
      if (workflowOverride) {
        state.workflowPath = await resolveWorkflow(workflowOverride, state.workingDirectory, this.store);
        state.workflowKind = workflowKind(state.workflowPath);
      }
      const source = state.workflowKind === "typescript"
        ? (await exists(state.workflowPath) ? await bundledTypeScriptSource(state.workflowPath) : state.workflowSnapshot)
        : await readFile(state.workflowPath, "utf8").catch(() => state.workflowSnapshot);
      state.workflowSnapshot = source;
      state.workflowHash = sha256Canonical(source);
      state.status = "running";
      state.startedAt ??= new Date().toISOString();
      delete state.completedAt;
      delete state.error;
      state.pid = process.pid;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      await this.store.appendEvent(event(state, "run.started"));

      const workspace = new GitWorkspaceController({
        runDirectory: this.store.runDirectory(state.id),
        save: (value) => this.store.save(value),
      });

      let result: JsonValue;
      if (state.workflowKind === "declarative") {
        const workflow = parseWorkflow(source, sourceFormat(state.workflowPath));
        validateArguments(workflow.argsSchema, state.args);
        const selectedProfile = state.profileOverridden
          ? state.profile
          : workflow.runtime?.profile ?? state.profile;
        applyProfile(
          state,
          selectedProfile,
          workflow.runtime?.concurrency,
          workflow.runtime?.maxAgents,
        );
        const activePhaseIds = new Set(workflow.phases.map((phase) => phase.id));
        for (const outputId of Object.keys(state.outputs)) {
          if (!activePhaseIds.has(outputId)) delete state.outputs[outputId];
        }
        engine = new WorkflowEngine(state, this.adapter, this.store, workspace);
        result = await runDeclarativeWorkflow(workflow, state.args, engine);
      } else {
        const executionPath = join(this.store.runDirectory(state.id), "workflow.snapshot.mjs");
        await writeFile(executionPath, source, { encoding: "utf8", mode: 0o600 });
        const execution = await executeTypeScriptWorkflow({
          workflowPath: executionPath,
          args: state.args,
          workingDirectory: state.workingDirectory,
          signal: controller.signal,
          onLateRpcDrain: (drain) => {
            lateRpcDrain = drain;
          },
          pipelineConcurrency: HARD_LIMITS.concurrency,
          onMetadata: (metadata) => {
            this.#prepareTypeScriptMetadata(state, metadata);
            engine = new WorkflowEngine(state, this.adapter, this.store, workspace);
          },
          rpc: async (request, signal) => {
            if (signal.aborted) throw signal.reason;
            if (!engine) throw new Error("TypeScript workflow called the runner before metadata validation");
            const cancelEngine = (): void => engine?.cancel();
            signal.addEventListener("abort", cancelEngine, { once: true });
            try {
              if (signal.aborted) {
                cancelEngine();
                throw signal.reason;
              }
              return await this.#handleTypeScriptRpc(state, engine, request);
            } finally {
              signal.removeEventListener("abort", cancelEngine);
            }
          },
        });
        result = execution.result;
      }

      if (interrupted || controller.signal.aborted) throw controller.signal.reason ?? new Error("Workflow stopped");
      if (state.git) await workspace.session(state).then(assertActiveSession);
      if (interrupted || controller.signal.aborted) throw controller.signal.reason ?? new Error("Workflow stopped");
      state.result = result;
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      delete state.pid;
      await this.store.save(state);
      await this.store.appendEvent(event(state, "run.completed"));
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.status = interrupted || controller.signal.aborted ? "stopped" : "failed";
      state.error = message;
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      delete state.pid;
      await this.store.save(state);
      await this.store.appendEvent(event(state, state.status === "stopped" ? "run.stopped" : "run.failed", {
        data: { error: message },
      }));
      throw error;
    } finally {
      clearInterval(stopPoll);
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGINT", interrupt);
      await this.store.clearStopRequest(runId);
      if (lateRpcDrain === undefined) {
        await lock.release();
      } else {
        void lateRpcDrain.then(() => lock.release()).catch(() => undefined);
      }
    }
  }

  async resume(runId: string, workflowOverride?: string): Promise<RunState> {
    let lock: RunLock;
    try {
      lock = await this.store.acquireLock(runId);
    } catch (error) {
      if (error instanceof RunLockedError) {
        throw new Error(`Run ${JSON.stringify(runId)} is locked by active or draining runner work`, { cause: error });
      }
      throw error;
    }
    let handedToExecution = false;
    try {
      await this.store.clearStopRequest(runId);
      const state = await this.store.readRun(runId);
      if (state.status === "stopped" || state.status === "stopping") {
        state.status = "pending";
        delete state.error;
        delete state.completedAt;
        state.updatedAt = new Date().toISOString();
        await this.store.save(state);
      }
      handedToExecution = true;
      return await this.#executeLocked(runId, workflowOverride, lock);
    } finally {
      if (!handedToExecution) await lock.release();
    }
  }

  async stop(runId: string): Promise<RunState> {
    const state = await this.store.readRun(runId);
    if (["completed", "failed", "stopped"].includes(state.status)) return state;
    await this.store.requestStop(runId);
    if (state.status === "pending") {
      state.status = "stopped";
      state.error = "Workflow stopped before runner startup";
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      await this.store.save(state);
      await this.store.appendEvent(event(state, "run.stopped", { data: { error: state.error } }));
      return state;
    }
    state.status = "stopping";
    state.updatedAt = new Date().toISOString();
    await this.store.save(state);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      const current = await this.store.readRun(runId);
      if (current.status === "stopped" || current.status === "failed" || current.status === "completed") {
        return current;
      }
    }
    return this.#reconcileOrphanedRun(await this.store.readRun(runId));
  }

  async clean(runId: string, force = false): Promise<CleanupResult | undefined> {
    let lock: RunLock;
    try {
      lock = await this.store.acquireLock(runId);
    } catch (error) {
      if (error instanceof RunLockedError) {
        throw new Error("Refusing to clean while runner work is still active or draining", { cause: error });
      }
      throw error;
    }
    try {
      const state = await this.store.readRun(runId);
      if (state.status === "running" || state.status === "stopping") {
        throw new Error("Refusing to clean a running workflow");
      }
      if (!state.git) return undefined;
      return await cleanupGitRun(this.#gitSession(state), { force });
    } finally {
      await lock.release();
    }
  }

  async inspect(runId: string, callId?: string): Promise<RunState | RunState["calls"][string]> {
    const state = await this.store.readRun(runId);
    if (!callId) return state;
    const call = state.calls[callId];
    if (!call) throw new Error(`Run ${runId} has no call ${callId}`);
    return call;
  }

  async status(runId: string): Promise<RunSummary> {
    return summarizeRun(await this.#reconcileOrphanedRun(await this.store.readRun(runId)));
  }

  async #reconcileOrphanedRun(state: RunState): Promise<RunState> {
    if ((state.status === "running" || state.status === "stopping") && !await this.store.isRunLocked(state.id)) {
      state.status = "stopped";
      state.error = "Runner process is no longer alive";
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      delete state.pid;
      await this.store.save(state);
      await this.store.appendEvent(event(state, "run.stopped", { data: { error: state.error } }));
    }
    return state;
  }

  #prepareTypeScriptMetadata(state: RunState, metadata: WorkflowMetadata): void {
    validateArguments(metadata.argsSchema, state.args);
    if (metadata.profile && !state.profileOverridden) {
      applyProfile(state, metadata.profile);
    }
  }

  async #handleTypeScriptRpc(
    state: RunState,
    engine: WorkflowEngine,
    request: TypeScriptWorkflowRpcRequest,
  ): Promise<JsonValue | void> {
    if (request.method === "agent") {
      return engine.agent(request.id, request.prompt, request.options);
    }
    if (request.method === "log") {
      return engine.log(request.message, request.data);
    }
    const prior = state.phases[request.id];
    if (request.action === "start") {
      if (prior?.status === "running") throw new Error(`Phase ${request.id} is already running`);
      state.phases[request.id] = {
        id: request.id,
        type: "phase",
        status: "running",
        startedAt: new Date().toISOString(),
        calls: prior?.calls ?? [],
      };
    } else {
      if (prior?.status !== "running") throw new Error(`Phase ${request.id} is not running`);
      const record: PhaseRecord = prior ?? {
        id: request.id,
        type: "phase",
        status: "running",
        calls: [],
      };
      record.status = request.action === "complete" ? "completed" : "failed";
      record.completedAt = new Date().toISOString();
      if (request.error) record.error = request.error;
      state.phases[request.id] = record;
    }
    state.updatedAt = new Date().toISOString();
    await this.store.save(state);
    await this.store.appendEvent(event(state, `phase.${request.action === "complete" ? "completed" : request.action === "start" ? "started" : "failed"}`, {
      phaseId: request.id,
      ...(request.error ? { data: { error: request.error } } : {}),
    }));
  }

  #gitSession(state: RunState): GitRunSession {
    const git = state.git;
    if (!git) throw new Error("Run has no Git session");
    return {
      repositoryRoot: git.repositoryRoot,
      baseHead: git.baseHead,
      activeBranch: git.activeBranch,
      statusPorcelain: git.statusPorcelain,
      runId: state.id,
      runKey: git.runKey,
      worktreeRoot: git.worktreeRoot,
      runWorktreeRoot: git.runWorktreeRoot,
      integrationBranch: git.integrationBranch,
      integrationWorktree: git.integrationWorktree,
      integrationHead: git.integrationHead,
    };
  }
}

async function assertActiveSession(session: GitRunSession): Promise<void> {
  const { assertActiveWorktreeUnchanged, assertIntegrationWorktreeUnchanged } = await import("../git/index.js");
  await assertActiveWorktreeUnchanged(session);
  await assertIntegrationWorktreeUnchanged(session);
}

export function summarizeRun(state: RunState): RunSummary {
  const calls = Object.values(state.calls);
  const summary: RunSummary = {
    id: state.id,
    status: state.status,
    workflow: state.workflowPath,
    profile: state.profile,
    calls: {
      completed: calls.filter((call) => call.status === "completed").length,
      failed: calls.filter((call) => call.status === "failed").length,
      running: calls.filter((call) => call.status === "running").length,
      total: calls.length,
    },
    tokens: state.usage.inputTokens + state.usage.outputTokens + state.usage.reasoningOutputTokens,
    ...(state.git ? { integrationBranch: state.git.integrationBranch } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
  return summary;
}
