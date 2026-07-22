import { lstat, mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CommandError, runGit } from "./command.js";
import {
  ActiveWorktreeChangedError,
  CherryPickConflictError,
  DirtyRepositoryError,
  PathOverlapError,
} from "./errors.js";
import { isPathInside, safeComponent } from "./names.js";
import { assertOwnedPaths } from "./ownership.js";
import { canonicalPath } from "../util/path.js";
import type {
  CleanupResult,
  GitRepositorySnapshot,
  GitRunSession,
  IntegrationRecoveryCandidate,
  IntegrationResult,
  TaskCommit,
  TaskCandidate,
  TaskWorktree,
} from "./types.js";

const COMMIT_CONFIG = [
  "-c",
  "user.name=Codex Dynamic Workflows",
  "-c",
  "user.email=codex-dw@localhost",
  "-c",
  "commit.gpgSign=false",
] as const;

interface RegisteredWorktree {
  path: string;
  head?: string;
  branch?: string;
}

export interface InitializeGitRunOptions {
  repository: string;
  runId: string;
  worktreeRoot: string;
  expected?: GitRunSession;
  recoverableIntegration?: readonly IntegrationRecoveryCandidate[];
}

const EXECUTABLE_GIT_CONFIG = "^(filter\\..*\\.(clean|smudge|process)|diff\\.external|diff\\..*\\.(command|textconv)|merge\\..*\\.driver)$";

async function assertNoExecutableGitConfiguration(repositoryRoot: string): Promise<void> {
  const result = await runGit(repositoryRoot, ["config", "--get-regexp", EXECUTABLE_GIT_CONFIG], {
    allowFailure: true,
  });
  if (result.exitCode === 0 && result.stdout.trim() !== "") {
    const key = result.stdout.trim().split(/\s+/, 1)[0] ?? "unknown";
    throw new Error(`Mutating workflows reject executable Git filters, diff drivers, and merge drivers: ${key}`);
  }
}

export interface CommitTaskOptions {
  ownership: readonly string[];
  message: string;
}

export interface IntegrateTaskOptions {
  verified: boolean;
  allowOverlappingPaths?: readonly string[];
}

export interface CleanupOptions {
  force?: boolean;
}

async function statusPorcelain(cwd: string): Promise<string> {
  return (
    await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ).stdout;
}

async function activeBranch(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true,
  });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error("Mutating workflows require an active branch; detached HEAD is not supported");
  }
  return result.stdout.trim();
}

async function head(cwd: string, ref = "HEAD"): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--verify", ref])).stdout.trim();
}

async function refExists(repositoryRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(
    repositoryRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFailure: true },
  );
  return result.exitCode === 0;
}

async function assertDescendsFrom(
  repositoryRoot: string,
  baseHead: string,
  ref: string,
): Promise<void> {
  const result = await runGit(
    repositoryRoot,
    ["merge-base", "--is-ancestor", baseHead, ref],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Existing ref ${ref} is not based on workflow base ${baseHead}`);
  }
}

async function registeredWorktrees(repositoryRoot: string): Promise<RegisteredWorktree[]> {
  const output = (await runGit(repositoryRoot, ["worktree", "list", "--porcelain"])).stdout;
  const worktrees = output
    .trim()
    .split(/\n\n+/)
    .filter((block) => block.length > 0)
    .map((block) => {
      const record: RegisteredWorktree = { path: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) record.path = resolve(line.slice("worktree ".length));
        if (line.startsWith("HEAD ")) record.head = line.slice("HEAD ".length);
        if (line.startsWith("branch refs/heads/")) {
          record.branch = line.slice("branch refs/heads/".length);
        }
      }
      return record;
    })
    .filter((record) => record.path.length > 0);
  return await Promise.all(worktrees.map(async (record) => ({
    ...record,
    path: await canonicalPath(record.path),
  })));
}

async function assertAvailablePath(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory or symbolic-link worktree path: ${path}`);
    }
    if ((await readdir(path)).length > 0) {
      throw new Error(`Refusing to replace non-empty unregistered worktree path: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ensureWorktree(
  repositoryRoot: string,
  branch: string,
  worktreePath: string,
  baseHead: string,
): Promise<void> {
  await assertNoExecutableGitConfiguration(repositoryRoot);
  await runGit(repositoryRoot, ["check-ref-format", "--branch", branch]);
  const worktrees = await registeredWorktrees(repositoryRoot);
  const branchWorktree = worktrees.find((worktree) => worktree.branch === branch);
  if (branchWorktree !== undefined) {
    if (resolve(branchWorktree.path) !== resolve(worktreePath)) {
      throw new Error(
        `Refusing to reuse ${branch}; it is checked out at unexpected path ${branchWorktree.path}`,
      );
    }
    if ((await activeBranch(worktreePath)) !== branch) {
      throw new Error(`Existing worktree ${worktreePath} is not on expected branch ${branch}`);
    }
    await assertDescendsFrom(repositoryRoot, baseHead, branch);
    return;
  }

  await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
  await assertAvailablePath(worktreePath);
  if (await refExists(repositoryRoot, branch)) {
    await assertDescendsFrom(repositoryRoot, baseHead, branch);
    await runGit(repositoryRoot, ["worktree", "add", worktreePath, branch]);
  } else {
    await runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, baseHead]);
  }
}

async function assertExpectedTaskBranch(task: TaskWorktree): Promise<void> {
  const branch = await activeBranch(task.path);
  if (branch !== task.branch) {
    throw new Error(`Task worktree ${task.path} is on ${branch}, expected ${task.branch}`);
  }
  await assertDescendsFrom(task.path, task.baseHead, "HEAD");
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

/** Parse porcelain v1 -z, retaining both sides of renames/copies for ownership checks. */
export function parseChangedPaths(status: string): string[] {
  const records = splitNul(status);
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new Error("Unexpected Git porcelain status record");
    }
    const state = record.slice(0, 2);
    paths.add(record.slice(3));
    if (/[RC]/.test(state)) {
      const original = records[index + 1];
      if (original === undefined) throw new Error("Incomplete Git rename/copy status record");
      paths.add(original);
      index += 1;
    }
  }
  return [...paths].sort();
}

async function changedPathsInCommits(cwd: string, commits: readonly string[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const commit of commits) {
    const output = (
      await runGit(cwd, [
        "diff-tree",
        "-m",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        commit,
        "--",
      ])
    ).stdout;
    for (const path of splitNul(output)) paths.add(path);
  }
  return [...paths].sort();
}

async function exactCommitDelta(cwd: string, commit: string): Promise<string> {
  return (await runGit(cwd, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    `${commit}^`,
    commit,
    "--",
  ])).stdout;
}

async function reconcileIntegrationHead(
  session: GitRunSession,
  expectedHead: string,
  candidates: readonly IntegrationRecoveryCandidate[],
): Promise<string[]> {
  if (session.integrationHead === expectedHead) return [];
  await assertDescendsFrom(session.repositoryRoot, expectedHead, session.integrationBranch);
  const extra = await commitsAfter(session.integrationWorktree, expectedHead, session.integrationHead);
  const recovered: string[] = [];
  for (const commit of extra) {
    const parents = (await runGit(session.integrationWorktree, ["rev-list", "--parents", "-n", "1", commit])).stdout.trim().split(/\s+/);
    if (parents.length !== 2) throw new Error("Unexpected merge commit on runner integration branch");
    const subject = (await runGit(session.integrationWorktree, ["show", "-s", "--format=%s", commit])).stdout.trim();
    const candidate = candidates.find((value) => value.message === subject && !recovered.includes(value.callId));
    if (candidate === undefined) {
      throw new Error(`Unexpected commit ${commit} on runner integration branch`);
    }
    const paths = await changedPathsInCommits(session.integrationWorktree, [commit]);
    if (JSON.stringify(paths) !== JSON.stringify([...candidate.changedPaths].sort())) {
      throw new Error(`Recovered integration commit ${commit} changed unexpected paths`);
    }
    if (await exactCommitDelta(session.integrationWorktree, commit) !== await exactCommitDelta(session.repositoryRoot, candidate.taskCommit)) {
      throw new Error(`Recovered integration commit ${commit} does not match verified task ${candidate.callId}`);
    }
    recovered.push(candidate.callId);
  }
  return recovered;
}

async function commitsAfter(cwd: string, base: string, tip: string): Promise<string[]> {
  return (await runGit(cwd, ["rev-list", "--reverse", `${base}..${tip}`])).stdout
    .split("\n")
    .map((commit) => commit.trim())
    .filter((commit) => commit.length > 0);
}

interface CherryStatus {
  integrated: string[];
  pending: string[];
}

async function cherryStatus(
  session: GitRunSession,
  taskHead: string,
): Promise<CherryStatus> {
  const history = (
    await runGit(session.repositoryRoot, [
      "rev-list",
      "--reverse",
      "--topo-order",
      "--parents",
      `${session.baseHead}..${taskHead}`,
    ])
  ).stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const historyCommits: string[] = [];
  for (const line of history) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) {
      throw new Error("Task branches must contain only linear, single-parent commits");
    }
    const commit = fields[0];
    if (commit === undefined) throw new Error("Could not read task commit history");
    historyCommits.push(commit);
  }
  const directlyIntegrated = await runGit(
    session.repositoryRoot,
    ["merge-base", "--is-ancestor", taskHead, session.integrationBranch],
    { allowFailure: true },
  );
  if (directlyIntegrated.exitCode === 0) {
    return { integrated: historyCommits, pending: [] };
  }
  const output = (
    await runGit(session.repositoryRoot, [
      "cherry",
      session.integrationBranch,
      taskHead,
      session.baseHead,
    ])
  ).stdout;
  const reportedIntegrated: string[] = [];
  const pending: string[] = [];
  for (const line of output.trim().split("\n")) {
    if (line.length === 0) continue;
    const marker = line[0];
    const commit = line.slice(2).trim();
    if (marker === "-") reportedIntegrated.push(commit);
    else if (marker === "+") pending.push(commit);
    else throw new Error(`Unexpected git cherry output: ${line}`);
  }
  const historySet = new Set(historyCommits);
  const reported = [...reportedIntegrated, ...pending];
  if (reported.some((commit) => !historySet.has(commit)) || new Set(reported).size !== reported.length) {
    throw new Error("Git reported an unexpected task commit while classifying integration state");
  }
  // Depending on Git version and reachability, patch-equivalent commits can be
  // omitted rather than printed with '-'. Every linear-history commit not
  // reported as pending is already represented on the integration branch.
  const integrated = historyCommits.filter((commit) => !pending.includes(commit));
  return { integrated, pending };
}

export async function discoverGitRepository(repository: string): Promise<GitRepositorySnapshot> {
  const repositoryRoot = await canonicalPath(
    (await runGit(resolve(repository), ["rev-parse", "--show-toplevel"])).stdout.trim(),
  );
  await assertNoExecutableGitConfiguration(repositoryRoot);
  const snapshot: GitRepositorySnapshot = {
    repositoryRoot,
    baseHead: await head(repositoryRoot),
    activeBranch: await activeBranch(repositoryRoot),
    statusPorcelain: await statusPorcelain(repositoryRoot),
  };
  return snapshot;
}

export async function initializeGitRun(
  options: InitializeGitRunOptions,
): Promise<GitRunSession> {
  if (options.runId.trim().length === 0) throw new Error("runId must not be empty");
  const snapshot = await discoverGitRepository(options.repository);
  if (snapshot.statusPorcelain.length > 0) {
    throw new DirtyRepositoryError(snapshot.statusPorcelain);
  }

  const worktreeRoot = await canonicalPath(options.worktreeRoot);
  const runKey = safeComponent(options.runId);
  const runWorktreeRoot = join(worktreeRoot, runKey);
  if (isPathInside(snapshot.repositoryRoot, runWorktreeRoot)) {
    throw new Error("The runner worktree root must be outside the active repository worktree");
  }

  const integrationBranch = `codex-dw/${runKey}/integration`;
  const integrationWorktree = join(runWorktreeRoot, "integration");
  const integrationExisted = await refExists(snapshot.repositoryRoot, integrationBranch);
  if (integrationExisted && options.expected === undefined) {
    throw new Error(`Existing integration branch ${integrationBranch} requires persisted run state`);
  }
  if (options.expected !== undefined) {
    const expected = options.expected;
    const actual = {
      repositoryRoot: snapshot.repositoryRoot,
      baseHead: snapshot.baseHead,
      activeBranch: snapshot.activeBranch,
      statusPorcelain: snapshot.statusPorcelain,
      runId: options.runId,
      runKey,
      worktreeRoot,
      runWorktreeRoot,
      integrationBranch,
      integrationWorktree,
    };
    for (const [key, value] of Object.entries(actual)) {
      const expectedValue = expected[key as keyof typeof actual];
      const pathValue = key.endsWith("Root") || key.endsWith("Worktree");
      if (
        (pathValue ? await canonicalPath(String(value)) : value)
        !== (pathValue ? await canonicalPath(String(expectedValue)) : expectedValue)
      ) {
        throw new Error(`Persisted Git run ${key} no longer matches the active checkout`);
      }
    }
  }
  await mkdir(runWorktreeRoot, { recursive: true, mode: 0o700 });
  await ensureWorktree(
    snapshot.repositoryRoot,
    integrationBranch,
    integrationWorktree,
    snapshot.baseHead,
  );
  if ((await statusPorcelain(integrationWorktree)).length > 0) {
    throw new Error(`Existing integration worktree is dirty: ${integrationWorktree}`);
  }

  const session: GitRunSession = {
    ...snapshot,
    runId: options.runId,
    runKey,
    worktreeRoot,
    runWorktreeRoot,
    integrationBranch,
    integrationWorktree,
    integrationHead: await head(integrationWorktree),
  };
  if (options.expected !== undefined) {
    session.recoveredIntegrationCalls = await reconcileIntegrationHead(
      session,
      options.expected.integrationHead,
      options.recoverableIntegration ?? [],
    );
  }
  await assertActiveWorktreeUnchanged(session);
  return session;
}

export async function createTaskWorktree(
  session: GitRunSession,
  taskId: string,
): Promise<TaskWorktree> {
  if (taskId.trim().length === 0) throw new Error("taskId must not be empty");
  await assertActiveWorktreeUnchanged(session);
  const taskKey = safeComponent(taskId);
  const branch = `codex-dw/${session.runKey}/tasks/${taskKey}`;
  const path = join(session.runWorktreeRoot, "tasks", taskKey);
  await ensureWorktree(session.repositoryRoot, branch, path, session.baseHead);
  const task: TaskWorktree = { taskId, taskKey, branch, path, baseHead: session.baseHead };
  await assertExpectedTaskBranch(task);
  await assertActiveWorktreeUnchanged(session);
  return task;
}

export async function inspectChangedPaths(worktreePath: string): Promise<string[]> {
  return parseChangedPaths(await statusPorcelain(worktreePath));
}

/** Build the exact candidate tree in a temporary Git index without staging the task worktree. */
export async function snapshotTaskCandidate(
  task: TaskWorktree,
  ownership: readonly string[],
): Promise<TaskCandidate> {
  await assertNoExecutableGitConfiguration(task.path);
  await assertExpectedTaskBranch(task);
  const changedPaths = await inspectChangedPaths(task.path);
  assertOwnedPaths(changedPaths, ownership);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-dw-index-"));
  const environment = { ...process.env, GIT_INDEX_FILE: join(temporaryDirectory, "index") };
  try {
    await runGit(task.path, ["read-tree", "HEAD"], { env: environment });
    await runGit(task.path, ["add", "-A", "--", "."], { env: environment });
    const tree = (await runGit(task.path, ["write-tree"], { env: environment })).stdout.trim();
    return { tree, changedPaths };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Reconstruct a clean, already-committed task after an interrupted finalize step. */
export async function recoverTaskCommit(
  task: TaskWorktree,
  ownership: readonly string[],
  expectedMessage?: string,
): Promise<TaskCommit> {
  await assertExpectedTaskBranch(task);
  if ((await statusPorcelain(task.path)).length > 0) {
    throw new Error(`Task worktree is not clean enough to recover: ${task.path}`);
  }
  let commit = await head(task.path);
  if (commit === task.baseHead) throw new Error(`Task ${task.taskId} has no committed candidate to recover`);
  if (expectedMessage !== undefined) {
    const records = splitNul((await runGit(task.path, [
      "log",
      "-z",
      "--format=%H%x00%s%x00",
      `${task.baseHead}..HEAD`,
    ])).stdout);
    const matches: string[] = [];
    for (let index = 0; index < records.length; index += 2) {
      if (records[index + 1] === expectedMessage && records[index] !== undefined) matches.push(records[index]!);
    }
    if (matches.length !== 1 || matches[0] !== commit) {
      throw new Error(`Task ${task.taskId} has no unique recoverable commit for ${expectedMessage}`);
    }
    commit = matches[0];
  }
  const changedPaths = await changedPathsInCommits(task.path, expectedMessage ? [commit] : await commitsAfter(task.path, task.baseHead, commit));
  assertOwnedPaths(changedPaths, ownership);
  return { task, commit, changedPaths, ownership: [...ownership] };
}

export async function commitTaskChanges(
  task: TaskWorktree,
  options: CommitTaskOptions,
): Promise<TaskCommit> {
  await assertNoExecutableGitConfiguration(task.path);
  if (options.message.trim().length === 0) throw new Error("Commit message must not be empty");
  await assertExpectedTaskBranch(task);
  const changedBeforeStage = await inspectChangedPaths(task.path);
  if (changedBeforeStage.length === 0) throw new Error(`Task ${task.taskId} has no changes to commit`);
  assertOwnedPaths(changedBeforeStage, options.ownership);

  await runGit(task.path, ["add", "-A", "--", "."]);
  const staged = splitNul(
    (await runGit(task.path, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"])).stdout,
  );
  if (staged.length === 0) throw new Error(`Task ${task.taskId} has no staged changes to commit`);
  assertOwnedPaths(staged, options.ownership);

  await runGit(task.path, [
    ...COMMIT_CONFIG,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    options.message,
  ]);
  const commit = await head(task.path);
  const changedPaths = await changedPathsInCommits(task.path, [commit]);
  assertOwnedPaths(changedPaths, options.ownership);
  const remaining = await inspectChangedPaths(task.path);
  if (remaining.length > 0) {
    throw new Error(`Task worktree changed while committing: ${remaining.join(", ")}`);
  }
  return { task, commit, changedPaths, ownership: [...options.ownership] };
}

export async function integrateTask(
  session: GitRunSession,
  taskCommit: TaskCommit,
  options: IntegrateTaskOptions,
): Promise<IntegrationResult> {
  await assertNoExecutableGitConfiguration(session.repositoryRoot);
  if (!options.verified) throw new Error("Refusing to integrate a task without verifier approval");
  await assertActiveWorktreeUnchanged(session);
  const actualIntegrationHead = await head(session.integrationWorktree);
  if (actualIntegrationHead !== session.integrationHead) {
    throw new Error(`Runner integration branch moved unexpectedly from ${session.integrationHead} to ${actualIntegrationHead}`);
  }
  await assertExpectedTaskBranch(taskCommit.task);
  const taskHead = await head(taskCommit.task.path);
  if (taskHead !== taskCommit.commit) {
    throw new Error(`Task branch moved after verification: ${taskCommit.task.branch}`);
  }
  if ((await statusPorcelain(taskCommit.task.path)).length > 0) {
    throw new Error(`Task worktree is dirty: ${taskCommit.task.path}`);
  }
  if ((await statusPorcelain(session.integrationWorktree)).length > 0) {
    throw new Error(`Integration worktree is dirty: ${session.integrationWorktree}`);
  }

  const cherry = await cherryStatus(session, taskHead);
  if (cherry.pending.length === 0) {
    return {
      commit: await head(session.integrationWorktree),
      changedPaths: [...taskCommit.changedPaths],
      reused: true,
    };
  }

  const pendingPaths = await changedPathsInCommits(taskCommit.task.path, cherry.pending);
  assertOwnedPaths(pendingPaths, taskCommit.ownership);
  const integrationHead = await head(session.integrationWorktree);
  const integratedPaths = await changedPathsInCommits(
    session.integrationWorktree,
    await commitsAfter(session.integrationWorktree, session.baseHead, integrationHead),
  );
  const allowedOverlap = new Set(options.allowOverlappingPaths ?? []);
  const overlap = pendingPaths.filter(
    (path) => integratedPaths.includes(path) && !allowedOverlap.has(path),
  );
  if (overlap.length > 0) throw new PathOverlapError(overlap);

  try {
    await runGit(session.integrationWorktree, [
      ...COMMIT_CONFIG,
      "cherry-pick",
      "--no-gpg-sign",
      ...cherry.pending,
    ]);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    const abort = await runGit(session.integrationWorktree, ["cherry-pick", "--abort"], {
      allowFailure: true,
    });
    const details = [error.result.stderr.trim(), abort.stderr.trim()].filter(Boolean).join("; ");
    throw new CherryPickConflictError(taskCommit.commit, details || "Git reported a conflict");
  }

  await assertActiveWorktreeUnchanged(session);
  session.integrationHead = await head(session.integrationWorktree);
  return {
    commit: session.integrationHead,
    changedPaths: pendingPaths,
    reused: false,
  };
}

export async function assertActiveWorktreeUnchanged(session: GitRunSession): Promise<void> {
  const currentBranch = await activeBranch(session.repositoryRoot);
  if (currentBranch !== session.activeBranch) {
    throw new ActiveWorktreeChangedError(
      `branch is ${currentBranch}, expected ${session.activeBranch}`,
    );
  }
  const currentHead = await head(session.repositoryRoot);
  if (currentHead !== session.baseHead) {
    throw new ActiveWorktreeChangedError(`HEAD is ${currentHead}, expected ${session.baseHead}`);
  }
  const currentStatus = await statusPorcelain(session.repositoryRoot);
  if (currentStatus !== session.statusPorcelain) {
    throw new ActiveWorktreeChangedError("working-tree status no longer matches the initial snapshot");
  }
}

export async function assertIntegrationWorktreeUnchanged(session: GitRunSession): Promise<void> {
  const branch = await activeBranch(session.integrationWorktree);
  if (branch !== session.integrationBranch) {
    throw new Error(`Runner integration worktree is on ${branch}, expected ${session.integrationBranch}`);
  }
  const currentHead = await head(session.integrationWorktree);
  if (currentHead !== session.integrationHead) {
    throw new Error(`Runner integration branch moved unexpectedly from ${session.integrationHead} to ${currentHead}`);
  }
  if ((await statusPorcelain(session.integrationWorktree)).length > 0) {
    throw new Error(`Runner integration worktree is dirty: ${session.integrationWorktree}`);
  }
}

async function listTaskBranches(session: GitRunSession): Promise<string[]> {
  const prefix = `refs/heads/codex-dw/${session.runKey}/tasks/`;
  const output = (
    await runGit(session.repositoryRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      prefix,
    ])
  ).stdout;
  return output
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0)
    .sort();
}

async function removeWorktree(
  session: GitRunSession,
  worktree: RegisteredWorktree,
  force: boolean,
): Promise<boolean> {
  if (!isPathInside(session.runWorktreeRoot, worktree.path)) return false;
  const dirty = (await statusPorcelain(worktree.path)).length > 0;
  if (dirty && !force) return false;
  await runGit(session.repositoryRoot, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    worktree.path,
  ]);
  return true;
}

export async function cleanupGitRun(
  session: GitRunSession,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const force = options.force === true;
  await assertActiveWorktreeUnchanged(session);
  const result: CleanupResult = {
    removedWorktrees: [],
    deletedBranches: [],
    preservedBranches: [session.integrationBranch],
    preservedWorktrees: [],
  };
  let worktrees = await registeredWorktrees(session.repositoryRoot);

  for (const branch of await listTaskBranches(session)) {
    const worktree = worktrees.find((candidate) => candidate.branch === branch);
    if (worktree !== undefined) {
      if (await removeWorktree(session, worktree, force)) result.removedWorktrees.push(worktree.path);
      else result.preservedWorktrees.push(worktree.path);
    }

    const branchHead = await head(session.repositoryRoot, branch);
    const integrated = (await cherryStatus(session, branchHead)).pending.length === 0;
    const stillCheckedOut = (await registeredWorktrees(session.repositoryRoot)).some(
      (candidate) => candidate.branch === branch,
    );
    if (!stillCheckedOut && (integrated || force)) {
      await runGit(session.repositoryRoot, ["branch", "-D", branch]);
      result.deletedBranches.push(branch);
    } else {
      result.preservedBranches.push(branch);
    }
  }

  worktrees = await registeredWorktrees(session.repositoryRoot);
  const integration = worktrees.find(
    (candidate) => candidate.branch === session.integrationBranch,
  );
  if (integration !== undefined) {
    if (resolve(integration.path) !== resolve(session.integrationWorktree)) {
      result.preservedWorktrees.push(integration.path);
    } else if (await removeWorktree(session, integration, force)) {
      result.removedWorktrees.push(integration.path);
    } else {
      result.preservedWorktrees.push(integration.path);
    }
  }

  await assertActiveWorktreeUnchanged(session);
  for (const directory of [join(session.runWorktreeRoot, "tasks"), session.runWorktreeRoot]) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
  return result;
}
