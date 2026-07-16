export interface GitRepositorySnapshot {
  repositoryRoot: string;
  baseHead: string;
  activeBranch: string;
  statusPorcelain: string;
}

export interface GitRunSession extends GitRepositorySnapshot {
  runId: string;
  runKey: string;
  worktreeRoot: string;
  runWorktreeRoot: string;
  integrationBranch: string;
  integrationWorktree: string;
  integrationHead: string;
  recoveredIntegrationCalls?: string[];
}

export interface IntegrationRecoveryCandidate {
  callId: string;
  taskCommit: string;
  message: string;
  changedPaths: string[];
}

export interface TaskWorktree {
  taskId: string;
  taskKey: string;
  branch: string;
  path: string;
  baseHead: string;
}

export interface TaskCommit {
  task: TaskWorktree;
  commit: string;
  changedPaths: string[];
  ownership: string[];
}

export interface TaskCandidate {
  tree: string;
  changedPaths: string[];
}

export interface IntegrationResult {
  commit: string;
  changedPaths: string[];
  reused: boolean;
}

export interface CleanupResult {
  removedWorktrees: string[];
  deletedBranches: string[];
  preservedBranches: string[];
  preservedWorktrees: string[];
}
