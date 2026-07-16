import { AsyncLocalStorage } from "node:async_hooks";
import { AgentExecutionError } from "../types.js";

import type {
  AgentAdapter,
  AgentCallOptions,
  AgentEvent,
  CallRecord,
  JsonValue,
  RunEvent,
  RunState,
  Usage,
} from "../types.js";
import type { LoopOptions, PipelineOptions, WorkflowContext } from "../workflow-api.js";
import { sha256Canonical } from "../util/index.js";
import { AgentBudget, Semaphore } from "./budget.js";

export interface EngineStore {
  save(state: RunState): Promise<void>;
  appendEvent(runId: string, event: RunEvent): Promise<void>;
}

export interface WorkspaceResult {
  workingDirectory: string;
  workspaceKey?: string;
  worktreePath?: string;
  branch?: string;
}

export interface FinalizedWorkspace {
  commit?: string;
  changedPaths?: string[];
  integrated?: boolean;
}

export interface WorkspaceController {
  prepare(callId: string, options: AgentCallOptions, state: RunState): Promise<WorkspaceResult>;
  candidate(
    callId: string,
    options: AgentCallOptions,
    workspace: WorkspaceResult,
    state: RunState,
  ): Promise<{ hash: string; changedPaths: string[] }>;
  finalize(
    callId: string,
    options: AgentCallOptions,
    workspace: WorkspaceResult,
    state: RunState,
    signal: AbortSignal,
  ): Promise<FinalizedWorkspace>;
  release(callId: string, options: AgentCallOptions, workspace: WorkspaceResult): void;
}

function addUsage(target: Usage, value: Usage): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
}

function usageDelta(total: Usage, recorded: Usage): Usage {
  return {
    inputTokens: Math.max(0, total.inputTokens - recorded.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - recorded.cachedInputTokens),
    outputTokens: Math.max(0, total.outputTokens - recorded.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - recorded.reasoningOutputTokens),
  };
}

function eventUsage(data: JsonValue | undefined): Usage | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const values = [data.inputTokens, data.cachedInputTokens, data.outputTokens, data.reasoningOutputTokens];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return undefined;
  return {
    inputTokens: data.inputTokens as number,
    cachedInputTokens: data.cachedInputTokens as number,
    outputTokens: data.outputTokens as number,
    reasoningOutputTokens: data.reasoningOutputTokens as number,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkflowEngine implements WorkflowContext {
  readonly #semaphore: Semaphore;
  readonly #budget: AgentBudget;
  readonly #phaseContext = new AsyncLocalStorage<string>();
  readonly #abortController = new AbortController();
  readonly #activeCalls = new Set<string>();
  #persistChain: Promise<void> = Promise.resolve();

  constructor(
    readonly state: RunState,
    readonly adapter: AgentAdapter,
    readonly store: EngineStore,
    readonly workspace?: WorkspaceController,
  ) {
    this.#semaphore = new Semaphore(state.concurrency);
    this.#budget = new AgentBudget(state.maxAgents, state.agentCallsUsed);
  }

  cancel(): void {
    this.#abortController.abort(new Error("Workflow stopped"));
  }

  async phase<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`Invalid phase id: ${id}`);
    const prior = this.state.phases[id];
    this.state.phases[id] = {
      id,
      type: prior?.type ?? "phase",
      status: "running",
      startedAt: new Date().toISOString(),
      calls: prior?.calls ?? [],
    };
    await this.#event("phase.started", { phaseId: id });
    try {
      const value = await this.#phaseContext.run(id, work);
      if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
      Object.assign(this.state.phases[id], {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await this.#event("phase.completed", { phaseId: id });
      return value;
    } catch (error) {
      Object.assign(this.state.phases[id], {
        status: "failed",
        error: errorMessage(error),
        completedAt: new Date().toISOString(),
      });
      await this.#event("phase.failed", { phaseId: id, data: { error: errorMessage(error) } });
      throw error;
    }
  }

  async agent<T extends JsonValue>(id: string, prompt: string, options: AgentCallOptions): Promise<T> {
    if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
    const phaseId = options.phaseId ?? this.#phaseContext.getStore() ?? "workflow";
    const callId = `${phaseId}/${id}`;
    const hash = sha256Canonical({
      callId,
      prompt,
      outputSchema: options.outputSchema,
      input: options.input ?? null,
      mode: options.mode ?? "read-only",
      model: options.model ?? null,
      reasoningEffort: options.reasoningEffort ?? "xhigh",
      networkAccess: options.networkAccess ?? false,
      ownership: options.ownership ?? [],
      verification: options.verification ?? null,
      workspaceKey: options.workspaceKey ?? null,
    });
    const cached = this.state.calls[callId];
    if (cached?.status === "completed" && cached.hash === hash && cached.output !== undefined) {
      await this.#event("agent.cached", { phaseId, callId });
      return cached.output as T;
    }
    if (this.#activeCalls.has(callId)) throw new Error(`Call ${callId} is already active`);
    this.#activeCalls.add(callId);

    const resumable = cached?.status === "running"
      && cached.hash === hash
      && cached.output !== undefined;
    const record: CallRecord = resumable ? cached : {
        id: callId,
        hash,
        phaseId,
        status: "pending",
        prompt,
        outputSchema: options.outputSchema,
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        attempts: 0,
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
      };
    if (!resumable) this.state.calls[callId] = record;
    const phase = this.state.phases[phaseId];
    if (phase && !phase.calls.includes(callId)) phase.calls.push(callId);
    try {
      await this.#persist();
      return await this.#semaphore.use(async () => {
      let workspace: WorkspaceResult | undefined;
      try {
        if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
        workspace = options.mode === "mutating"
          ? await this.#prepareWorkspace(callId, options)
          : { workingDirectory: options.workingDirectory ?? this.state.workingDirectory };
        if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
        let output: JsonValue;
        if (resumable) {
          if (options.mode === "mutating") {
            if (!this.workspace || !record.candidateHash) throw new Error(`Mutating call ${callId} has no persisted candidate identity`);
            const candidate = await this.workspace.candidate(callId, options, workspace, this.state);
            if (candidate.hash !== record.candidateHash) {
              throw new Error(`Mutating candidate for ${callId} changed after interruption`);
            }
          }
          output = record.output!;
          await this.#event("agent.resumed", { phaseId, callId });
        } else {
          this.#consumeBudget();
          Object.assign(record, {
            status: "running",
            startedAt: new Date().toISOString(),
            ...(workspace.workspaceKey ? { workspaceKey: workspace.workspaceKey } : {}),
            ...(workspace.worktreePath ? { worktreePath: workspace.worktreePath } : {}),
            ...(workspace.branch ? { branch: workspace.branch } : {}),
          });
          await this.#event("agent.started", { phaseId, callId });
          const result = await this.adapter.run(
            {
              callId,
              prompt,
              outputSchema: options.outputSchema,
              mode: options.mode ?? "read-only",
              workingDirectory: workspace.workingDirectory,
              reasoningEffort: options.reasoningEffort ?? "xhigh",
              networkAccess: options.networkAccess ?? false,
              signal: this.#abortController.signal,
              ...(options.model ? { model: options.model } : {}),
              ...(options.input !== undefined ? { input: options.input } : {}),
              ...(cached?.threadId ? { threadId: cached.threadId } : {}),
              ...(options.ownership ? { ownership: options.ownership } : {}),
              ...(options.verification ? { verification: options.verification } : {}),
              ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
            },
            async (agentEvent: AgentEvent) => {
              if (agentEvent.type === "agent.thread"
                && typeof agentEvent.data === "object"
                && agentEvent.data !== null
                && !Array.isArray(agentEvent.data)
                && typeof agentEvent.data.threadId === "string") {
                record.threadId = agentEvent.data.threadId;
              }
              if (agentEvent.type === "agent.usage") {
                const usage = eventUsage(agentEvent.data);
                if (usage) {
                  addUsage(record.usage, usage);
                  addUsage(this.state.usage, usage);
                }
              }
              await this.#event(agentEvent.type, {
                phaseId,
                callId,
                ...(agentEvent.data !== undefined ? { data: agentEvent.data } : {}),
              });
            },
          );
          const delta = usageDelta(result.usage, record.usage);
          addUsage(record.usage, delta);
          addUsage(this.state.usage, delta);
          Object.assign(record, {
            output: result.output,
            usage: result.usage,
            attempts: result.attempts,
            ...(result.threadId ? { threadId: result.threadId } : {}),
          });
          output = result.output;
          if (options.mode === "mutating") {
            if (!this.workspace) throw new Error(`Mutating call ${callId} has no workspace controller`);
            const candidate = await this.workspace.candidate(callId, options, workspace, this.state);
            record.candidateHash = candidate.hash;
            record.changedPaths = candidate.changedPaths;
          }
          await this.#event("agent.output", { phaseId, callId });
        }
        if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
        if (options.mode === "mutating") {
          await this.#verifyMutation(callId, phaseId, options, workspace, record.candidateHash);
        }
        if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
        const finalized = options.mode === "mutating" && this.workspace
          ? await this.workspace.finalize(callId, options, workspace, this.state, this.#abortController.signal)
          : {};
        if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
        Object.assign(record, {
          status: "completed",
          completedAt: new Date().toISOString(),
          ...(finalized.commit ? { commit: finalized.commit } : {}),
          ...(finalized.changedPaths ? { changedPaths: finalized.changedPaths } : {}),
          ...(finalized.integrated !== undefined ? { integrated: finalized.integrated } : {}),
        });
        await this.#event("agent.completed", { phaseId, callId });
        return output as T;
      } catch (error) {
        if (error instanceof AgentExecutionError) {
          const delta = usageDelta(error.usage, record.usage);
          addUsage(record.usage, delta);
          addUsage(this.state.usage, delta);
          record.attempts = error.attempts;
          if (error.threadId) record.threadId = error.threadId;
        }
        Object.assign(record, {
          status: this.#abortController.signal.aborted ? "stopped" : "failed",
          error: errorMessage(error),
          completedAt: new Date().toISOString(),
        });
        await this.#event("agent.failed", {
          phaseId,
          callId,
          data: { error: errorMessage(error) },
        });
        throw error;
      } finally {
        if (options.mode === "mutating" && workspace && this.workspace) {
          this.workspace.release(callId, options, workspace);
        }
      }
      });
    } finally {
      this.#activeCalls.delete(callId);
    }
  }

  async parallel<T extends Record<string, () => Promise<unknown>>>(
    id: string,
    branches: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const entries = Object.entries(branches);
    const settled = await Promise.allSettled(entries.map(async ([key, work]) => [key, await work()] as const));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const values = settled.map((result) => (result as PromiseFulfilledResult<readonly [string, unknown]>).value);
    return Object.fromEntries(values) as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  }

  async pipeline<T, R>(
    id: string,
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    options: PipelineOptions<T> = {},
  ): Promise<R[]> {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? this.state.concurrency, items.length || 1));
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) throw new Error(`Pipeline ${id} lost item ${index}`);
        results[index] = await worker(item, index);
      }
    });
    const settled = await Promise.allSettled(runners);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    return results;
  }

  async loop<T>(id: string, work: (iteration: number) => Promise<T>, options: LoopOptions<T>): Promise<T> {
    if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > 100) {
      throw new Error(`Loop ${id} maxIterations must be between 1 and 100`);
    }
    let last: T | undefined;
    for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
      last = await work(iteration);
      if (await options.until(last, iteration)) return last;
    }
    if (last === undefined) throw new Error(`Loop ${id} did not execute`);
    throw new Error(`Loop ${id} reached maxIterations without satisfying its stop condition`);
  }

  async log(message: string, data?: JsonValue): Promise<void> {
    await this.#event("workflow.log", { ...(data !== undefined ? { data: { message, value: data } } : { data: { message } }) });
  }

  #consumeBudget(): void {
    this.#budget.consume();
    this.state.agentCallsUsed = this.#budget.used;
  }

  async #prepareWorkspace(callId: string, options: AgentCallOptions): Promise<WorkspaceResult> {
    if (!this.state.allowMutation) throw new Error("Mutating workflow requires --allow-mutation");
    if (!this.workspace) throw new Error("Mutating workflow requires a Git workspace controller");
    if (!options.ownership || options.ownership.length === 0) {
      throw new Error(`Mutating call ${callId} requires non-empty ownership globs`);
    }
    if (!options.verification) {
      throw new Error(`Mutating call ${callId} requires an independent verifier`);
    }
    return this.workspace.prepare(callId, options, this.state);
  }

  async #verifyMutation(
    callId: string,
    phaseId: string,
    options: AgentCallOptions,
    workspace: WorkspaceResult,
    candidateHash?: string,
  ): Promise<void> {
    const verification = options.verification;
    if (!verification) throw new Error(`Mutating call ${callId} requires an independent verifier`);
    const verifierId = `${callId}.verify`;
    const verifierHash = sha256Canonical({
      verifierId,
      prompt: verification.prompt,
      outputSchema: verification.outputSchema,
      workerHash: this.state.calls[callId]?.hash,
      candidateHash: candidateHash ?? null,
      workingDirectory: workspace.workingDirectory,
    });
    const cached = this.state.calls[verifierId];
    if (cached?.status === "completed" && cached.hash === verifierHash && cached.output !== undefined) {
      const accepted = typeof cached.output === "object" && cached.output !== null && !Array.isArray(cached.output)
        ? cached.output.accepted
        : undefined;
      if (accepted !== true) throw new Error(`Verifier rejected mutating call ${callId}`);
      return;
    }
    if (this.#abortController.signal.aborted) throw this.#abortController.signal.reason;
    this.#consumeBudget();
    const record: CallRecord = {
      id: verifierId,
      hash: verifierHash,
      phaseId,
      status: "running",
      prompt: verification.prompt,
      outputSchema: verification.outputSchema,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      attempts: 0,
      startedAt: new Date().toISOString(),
      workspaceKey: options.workspaceKey ?? callId,
      worktreePath: workspace.workingDirectory,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    };
    this.state.calls[verifierId] = record;
    const phase = this.state.phases[phaseId];
    if (phase && !phase.calls.includes(verifierId)) phase.calls.push(verifierId);
    await this.#event("verifier.started", { phaseId, callId: verifierId });
    try {
      const result = await this.adapter.run(
        {
          callId: verifierId,
          prompt: verification.prompt,
          outputSchema: verification.outputSchema,
          mode: "read-only",
          workingDirectory: workspace.workingDirectory,
          reasoningEffort: options.reasoningEffort ?? "xhigh",
          networkAccess: false,
          signal: this.#abortController.signal,
          ...(options.model ? { model: options.model } : {}),
          ...(cached?.threadId ? { threadId: cached.threadId } : {}),
        },
        async (agentEvent) => {
          if (agentEvent.type === "agent.thread"
            && typeof agentEvent.data === "object"
            && agentEvent.data !== null
            && !Array.isArray(agentEvent.data)
            && typeof agentEvent.data.threadId === "string") {
            record.threadId = agentEvent.data.threadId;
          }
          if (agentEvent.type === "agent.usage") {
            const usage = eventUsage(agentEvent.data);
            if (usage) {
              addUsage(record.usage, usage);
              addUsage(this.state.usage, usage);
            }
          }
          await this.#event(agentEvent.type, {
            phaseId,
            callId: verifierId,
            ...(agentEvent.data !== undefined ? { data: agentEvent.data } : {}),
          });
        },
      );
      const delta = usageDelta(result.usage, record.usage);
      addUsage(record.usage, delta);
      addUsage(this.state.usage, delta);
      const accepted = typeof result.output === "object" && result.output !== null && !Array.isArray(result.output)
        ? result.output.accepted
        : undefined;
      Object.assign(record, {
        status: accepted === true ? "completed" : "failed",
        output: result.output,
        usage: result.usage,
        attempts: result.attempts,
        completedAt: new Date().toISOString(),
        ...(result.threadId ? { threadId: result.threadId } : {}),
        ...(accepted === true ? {} : { error: "Verifier did not return accepted: true" }),
      });
      await this.#event(accepted === true ? "verifier.completed" : "verifier.rejected", {
        phaseId,
        callId: verifierId,
      });
      if (accepted !== true) throw new Error(`Verifier rejected mutating call ${callId}`);
    } catch (error) {
      if (error instanceof AgentExecutionError) {
        const delta = usageDelta(error.usage, record.usage);
        addUsage(record.usage, delta);
        addUsage(this.state.usage, delta);
        record.attempts = error.attempts;
        if (error.threadId) record.threadId = error.threadId;
      }
      Object.assign(record, {
        status: "failed",
        error: errorMessage(error),
        completedAt: new Date().toISOString(),
      });
      await this.#event("verifier.failed", {
        phaseId,
        callId: verifierId,
        data: { error: errorMessage(error) },
      });
      throw error;
    }
  }

  async #event(
    type: string,
    fields: { phaseId?: string; callId?: string; data?: JsonValue } = {},
  ): Promise<void> {
    const event: RunEvent = {
      type,
      timestamp: new Date().toISOString(),
      runId: this.state.id,
      ...fields,
    };
    await this.store.appendEvent(this.state.id, event);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    this.#persistChain = this.#persistChain.then(() => this.store.save(this.state));
    await this.#persistChain;
  }
}
