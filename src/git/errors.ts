export class DirtyRepositoryError extends Error {
  readonly statusPorcelain: string;

  constructor(statusPorcelain: string) {
    super("The active Git worktree must be clean before a mutating workflow can start");
    this.name = "DirtyRepositoryError";
    this.statusPorcelain = statusPorcelain;
  }
}

export class OwnershipViolationError extends Error {
  readonly unexpectedPaths: string[];

  constructor(unexpectedPaths: readonly string[]) {
    const sorted = [...unexpectedPaths].sort();
    super(`Changed paths fall outside declared ownership: ${sorted.join(", ")}`);
    this.name = "OwnershipViolationError";
    this.unexpectedPaths = sorted;
  }
}

export class PathOverlapError extends Error {
  readonly overlappingPaths: string[];

  constructor(overlappingPaths: readonly string[]) {
    const sorted = [...overlappingPaths].sort();
    super(`Task changes overlap paths already integrated: ${sorted.join(", ")}`);
    this.name = "PathOverlapError";
    this.overlappingPaths = sorted;
  }
}

export class CherryPickConflictError extends Error {
  readonly taskCommit: string;

  constructor(taskCommit: string, details: string) {
    super(`Cherry-pick conflict for ${taskCommit}: ${details}`);
    this.name = "CherryPickConflictError";
    this.taskCommit = taskCommit;
  }
}

export class ActiveWorktreeChangedError extends Error {
  constructor(details: string) {
    super(`The user's active Git worktree changed during the workflow: ${details}`);
    this.name = "ActiveWorktreeChangedError";
  }
}
