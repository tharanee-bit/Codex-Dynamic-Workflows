import { join } from "node:path";

import {
  assertActiveWorktreeUnchanged,
  commitTaskChanges,
  createTaskWorktree,
  initializeGitRun,
  inspectChangedPaths,
  integrateTask,
  recoverTaskCommit,
  snapshotTaskCandidate,
  type GitRunSession,
  type TaskWorktree,
} from "../git/index.js";
import type { AgentCallOptions, RunState } from "../types.js";
import type {
  FinalizedWorkspace,
  WorkspaceController,
  WorkspaceResult,
} from "./core.js";

export interface GitWorkspaceControllerOptions {
  runDirectory: string;
  save: (state: RunState) => Promise<void>;
}

export class GitWorkspaceController implements WorkspaceController {
  readonly #tasks = new Map<string, TaskWorktree>();
  readonly #activeWorkspaceKeys = new Set<string>();
  #session?: Promise<GitRunSession>;
  #integrationChain: Promise<void> = Promise.resolve();

  constructor(readonly options: GitWorkspaceControllerOptions) {}

  async prepare(callId: string, call: AgentCallOptions, state: RunState): Promise<WorkspaceResult> {
    const key = call.workspaceKey ?? callId;
    if (this.#activeWorkspaceKeys.has(key)) {
      throw new Error(`Mutation workspace ${key} is already active; overlapping mutation units are not allowed`);
    }
    this.#activeWorkspaceKeys.add(key);
    try {
      const session = await this.#getSession(state);
      const task = this.#tasks.get(key) ?? await createTaskWorktree(session, key);
      this.#tasks.set(key, task);
      return {
        workingDirectory: task.path,
        workspaceKey: key,
        worktreePath: task.path,
        branch: task.branch,
      };
    } catch (error) {
      this.#activeWorkspaceKeys.delete(key);
      throw error;
    }
  }

  release(callId: string, call: AgentCallOptions, workspace: WorkspaceResult): void {
    this.#activeWorkspaceKeys.delete(workspace.workspaceKey ?? call.workspaceKey ?? callId);
  }

  async finalize(
    callId: string,
    call: AgentCallOptions,
    workspace: WorkspaceResult,
    state: RunState,
    signal: AbortSignal,
  ): Promise<FinalizedWorkspace> {
    const result = this.#integrationChain.then(
      () => this.#finalizeExclusive(callId, call, workspace, state, signal),
      () => this.#finalizeExclusive(callId, call, workspace, state, signal),
    );
    this.#integrationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async candidate(
    callId: string,
    call: AgentCallOptions,
    workspace: WorkspaceResult,
    state: RunState,
  ): Promise<{ hash: string; changedPaths: string[] }> {
    await this.#getSession(state);
    const key = workspace.workspaceKey ?? call.workspaceKey ?? callId;
    const task = this.#tasks.get(key);
    if (!task) throw new Error(`No Git task worktree exists for ${key}`);
    const candidate = await snapshotTaskCandidate(task, call.ownership ?? []);
    return { hash: candidate.tree, changedPaths: candidate.changedPaths };
  }

  async #finalizeExclusive(
    callId: string,
    call: AgentCallOptions,
    workspace: WorkspaceResult,
    state: RunState,
    signal: AbortSignal,
  ): Promise<FinalizedWorkspace> {
    if (signal.aborted) throw signal.reason;
    const session = await this.#getSession(state);
    const key = workspace.workspaceKey ?? call.workspaceKey ?? callId;
    const task = this.#tasks.get(key);
    if (!task) throw new Error(`No Git task worktree exists for ${key}`);
    const ownership = call.ownership ?? [];
    const verifiedCandidate = state.calls[callId]?.candidateHash;
    const currentCandidate = await snapshotTaskCandidate(task, ownership);
    if (!verifiedCandidate || currentCandidate.tree !== verifiedCandidate) {
      throw new Error(`Mutation candidate for ${callId} changed after verification`);
    }
    const commitMessage = `codex-dw(${state.id}): ${callId}`;
    const committed = (await inspectChangedPaths(task.path)).length === 0
      ? await recoverTaskCommit(task, ownership, commitMessage)
      : await commitTaskChanges(task, {
          ownership,
          message: commitMessage,
        });
    const record = state.calls[callId];
    if (!record) throw new Error(`Mutating call ${callId} has no persisted call record`);
    record.commit = committed.commit;
    record.changedPaths = committed.changedPaths;
    await this.options.save(state);
    if (signal.aborted) throw signal.reason;
    const allowedOverlap = committed.changedPaths.filter(
      (path) => state.git?.pathOwners[path] === key,
    );
    const integrated = await integrateTask(session, committed, {
      verified: true,
      allowOverlappingPaths: allowedOverlap,
    });
    if (signal.aborted) throw signal.reason;
    if (!state.git) throw new Error("Git run state was not initialized");
    state.git.integrationHead = session.integrationHead;
    record.integrated = true;
    for (const path of integrated.changedPaths) {
      const owner = state.git.pathOwners[path];
      if (owner !== undefined && owner !== key) {
        throw new Error(`Integrated path ${path} is already owned by mutation unit ${owner}`);
      }
      state.git.pathOwners[path] = key;
    }
    state.git.integratedPaths = [...new Set([
      ...state.git.integratedPaths,
      ...integrated.changedPaths,
    ])].sort();
    await this.options.save(state);
    await assertActiveWorktreeUnchanged(session);
    return {
      commit: committed.commit,
      changedPaths: committed.changedPaths,
      integrated: true,
    };
  }

  async session(state: RunState): Promise<GitRunSession> {
    return this.#getSession(state);
  }

  async #getSession(state: RunState): Promise<GitRunSession> {
    const prior = state.git;
    const expected: GitRunSession | undefined = prior === undefined ? undefined : {
      repositoryRoot: prior.repositoryRoot,
      baseHead: prior.baseHead,
      activeBranch: prior.activeBranch,
      statusPorcelain: prior.statusPorcelain,
      runId: state.id,
      runKey: prior.runKey,
      worktreeRoot: prior.worktreeRoot,
      runWorktreeRoot: prior.runWorktreeRoot,
      integrationBranch: prior.integrationBranch,
      integrationWorktree: prior.integrationWorktree,
      integrationHead: prior.integrationHead,
    };
    this.#session ??= initializeGitRun({
      repository: state.workingDirectory,
      runId: state.id,
      worktreeRoot: join(this.options.runDirectory, "worktrees"),
      ...(expected === undefined ? {} : { expected }),
      recoverableIntegration: Object.values(state.calls)
        .filter((record) => record.integrated !== true && record.commit !== undefined && record.changedPaths !== undefined)
        .map((record) => ({
          callId: record.id,
          taskCommit: record.commit!,
          message: `codex-dw(${state.id}): ${record.id}`,
          changedPaths: record.changedPaths!,
        })),
    }).then(async (session) => {
      for (const callId of session.recoveredIntegrationCalls ?? []) {
        const record = state.calls[callId];
        if (!record?.changedPaths) throw new Error(`Recovered call ${callId} has no changed paths`);
        record.integrated = true;
        const ownerKey = record.workspaceKey ?? callId;
        for (const path of record.changedPaths) {
          const owner = prior?.pathOwners[path];
          if (owner !== undefined && owner !== ownerKey) {
            throw new Error(`Recovered path ${path} is already owned by mutation unit ${owner}`);
          }
          if (prior) prior.pathOwners[path] = ownerKey;
        }
        if (prior) prior.integratedPaths = [...new Set([...prior.integratedPaths, ...record.changedPaths])].sort();
      }
      state.git = {
        repositoryRoot: session.repositoryRoot,
        baseHead: session.baseHead,
        activeBranch: session.activeBranch,
        statusPorcelain: session.statusPorcelain,
        runKey: session.runKey,
        worktreeRoot: session.worktreeRoot,
        runWorktreeRoot: session.runWorktreeRoot,
        integrationBranch: session.integrationBranch,
        integrationWorktree: session.integrationWorktree,
        integrationHead: session.integrationHead,
        integratedPaths: state.git?.integratedPaths ?? [],
        pathOwners: state.git?.pathOwners ?? {},
      };
      await this.options.save(state);
      return session;
    });
    return this.#session;
  }
}
