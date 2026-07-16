import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ActiveWorktreeChangedError,
  CherryPickConflictError,
  DirtyRepositoryError,
  assertActiveWorktreeUnchanged,
  assertIntegrationWorktreeUnchanged,
  cleanupGitRun,
  commitTaskChanges,
  createTaskWorktree,
  discoverGitRepository,
  initializeGitRun,
  inspectChangedPaths,
  integrateTask,
  recoverTaskCommit,
  runGit,
  safeComponent,
  snapshotTaskCandidate,
} from "../src/git/index.js";
import type { GitRunSession, TaskCommit, TaskWorktree } from "../src/git/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function createRepository(): Promise<{ repository: string; worktreeRoot: string }> {
  const root = await temporaryDirectory("codex-dw-git-");
  const repository = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repository);
  await runGit(repository, ["init", "-b", "main"]);
  await writeFile(join(repository, "base.txt"), "base\n");
  await runGit(repository, ["add", "base.txt"]);
  await runGit(repository, [
    "-c",
    "user.name=Test Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return { repository, worktreeRoot };
}

async function startSession(runId = "test run"): Promise<{
  repository: string;
  worktreeRoot: string;
  session: GitRunSession;
}> {
  const fixture = await createRepository();
  return {
    ...fixture,
    session: await initializeGitRun({ ...fixture, runId }),
  };
}

async function writeTaskFile(task: TaskWorktree, path: string, contents: string): Promise<void> {
  await mkdir(join(task.path, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(task.path, path), contents);
}

async function commitFile(
  task: TaskWorktree,
  path: string,
  contents: string,
): Promise<TaskCommit> {
  await writeTaskFile(task, path, contents);
  return await commitTaskChanges(task, { ownership: [path], message: `Add ${path}` });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("Git repository discovery and isolation", () => {
  it("discovers the clean base and rejects a dirty active worktree", async () => {
    const { repository, worktreeRoot } = await createRepository();
    const snapshot = await discoverGitRepository(repository);
    expect(snapshot.activeBranch).toBe("main");
    expect(snapshot.statusPorcelain).toBe("");
    expect(snapshot.baseHead).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(repository, "untracked.txt"), "dirty\n");
    await expect(
      initializeGitRun({ repository, worktreeRoot, runId: "dirty" }),
    ).rejects.toBeInstanceOf(DirtyRepositoryError);
  });

  it("creates stable safe task and integration refs outside the active checkout", async () => {
    const { repository, worktreeRoot, session } = await startSession("Run / unsafe ; $(touch nope)");
    const task = await createTaskWorktree(session, "Task ../ unsafe; touch nope");

    expect(session.integrationBranch).toMatch(
      /^codex-dw\/[a-z0-9-]+\/[a-z]+$/,
    );
    expect(task.branch).toMatch(/^codex-dw\/[a-z0-9-]+\/tasks\/[a-z0-9-]+$/);
    expect(task.path.startsWith(worktreeRoot)).toBe(true);
    expect(safeComponent("same")).toBe(safeComponent("same"));
    expect(safeComponent("different")).not.toBe(safeComponent("same"));
    expect((await runGit(repository, ["status", "--porcelain"])).stdout).toBe("");

    await cleanupGitRun(session, { force: true });
  });

  it("safely reuses deterministic worktrees on resume", async () => {
    const { repository, worktreeRoot, session } = await startSession("resume");
    const firstTask = await createTaskWorktree(session, "one");
    const resumed = await initializeGitRun({ repository, worktreeRoot, runId: "resume", expected: session });
    const resumedTask = await createTaskWorktree(resumed, "one");

    expect(resumed.integrationWorktree).toBe(session.integrationWorktree);
    expect(resumedTask).toEqual(firstTask);
    await cleanupGitRun(resumed, { force: true });
  });

  it("refuses a worktree root inside the active repository", async () => {
    const { repository } = await createRepository();
    await expect(
      initializeGitRun({
        repository,
        worktreeRoot: join(repository, ".runner"),
        runId: "inside",
      }),
    ).rejects.toThrow(/outside the active repository/);
  });

  it("disables repository hooks and rejects executable filter configuration", async () => {
    const { repository, worktreeRoot } = await createRepository();
    const visibleConfig = await runGit(repository, ["config", "--show-scope", "--list"]);
    expect(visibleConfig.stdout).not.toMatch(/^(?:system|global)\s/m);
    const marker = join(repository, "hook-ran");
    const hook = join(repository, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(hook, 0o755);

    const session = await initializeGitRun({ repository, worktreeRoot, runId: "hooks" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupGitRun(session, { force: true });

    await runGit(repository, ["config", "filter.evil.smudge", "touch should-not-run"]);
    await expect(initializeGitRun({ repository, worktreeRoot, runId: "filter" })).rejects.toThrow(
      /reject executable Git filters/,
    );
    await expect(access(join(repository, "should-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the persisted active branch when resuming", async () => {
    const { repository, worktreeRoot, session } = await startSession("persisted-branch");
    await runGit(repository, ["switch", "-c", "alternate"]);
    await expect(initializeGitRun({
      repository,
      worktreeRoot,
      runId: "persisted-branch",
      expected: session,
    })).rejects.toThrow(/activeBranch no longer matches/);
    await runGit(repository, ["switch", "main"]);
    await cleanupGitRun(session, { force: true });
  });
});

describe("changed paths, ownership, and commits", () => {
  it("includes tracked and untracked paths and fails closed on ownership violations", async () => {
    const { session } = await startSession();
    const task = await createTaskWorktree(session, "ownership");
    await writeFile(join(task.path, "base.txt"), "edited\n");
    await writeTaskFile(task, "new/untracked.txt", "new\n");

    expect(await inspectChangedPaths(task.path)).toEqual(["base.txt", "new/untracked.txt"]);
    await expect(
      commitTaskChanges(task, { ownership: ["new/**"], message: "Out of scope" }),
    ).rejects.toMatchObject({
      unexpectedPaths: ["base.txt"],
    });
    expect((await runGit(task.path, ["rev-list", "--count", task.baseHead, "..HEAD"])).stdout.trim()).toBe(
      "0",
    );
    await cleanupGitRun(session, { force: true });
  });

  it("retains both sides of a tracked rename for fail-closed ownership checks", async () => {
    const { session } = await startSession("rename");
    const task = await createTaskWorktree(session, "rename");
    await runGit(task.path, ["mv", "base.txt", "renamed.txt"]);

    expect(await inspectChangedPaths(task.path)).toEqual(["base.txt", "renamed.txt"]);
    await expect(
      commitTaskChanges(task, { ownership: ["renamed.txt"], message: "Rename" }),
    ).rejects.toMatchObject({ unexpectedPaths: ["base.txt"] });
    await cleanupGitRun(session, { force: true });
  });

  it("commits with per-command identity without persisting repository identity", async () => {
    const { session } = await startSession();
    const task = await createTaskWorktree(session, "commit");
    const committed = await commitFile(task, "owned.txt", "owned\n");

    expect(committed.changedPaths).toEqual(["owned.txt"]);
    expect(
      (await runGit(task.path, ["show", "-s", "--format=%cn <%ce>", committed.commit])).stdout.trim(),
    ).toBe("Codex Dynamic Workflows <codex-dw@localhost>");
    expect(
      (
        await runGit(task.path, ["config", "--local", "--get", "user.name"], {
          allowFailure: true,
        })
      ).exitCode,
    ).not.toBe(0);
    await cleanupGitRun(session, { force: true });
  });

  it("keeps candidate tree identity stable across commit and recovers an interrupted finalize", async () => {
    const { session } = await startSession("candidate-recovery");
    const task = await createTaskWorktree(session, "candidate");
    await writeTaskFile(task, "candidate.txt", "candidate\n");
    const before = await snapshotTaskCandidate(task, ["candidate.txt"]);
    const committed = await commitTaskChanges(task, { ownership: ["candidate.txt"], message: "candidate commit" });
    const after = await snapshotTaskCandidate(task, ["candidate.txt"]);
    const recovered = await recoverTaskCommit(task, ["candidate.txt"], "candidate commit");

    expect(before.tree).toBe(after.tree);
    expect(recovered).toEqual(committed);
    await expect(integrateTask(session, recovered, { verified: true })).resolves.toMatchObject({ changedPaths: ["candidate.txt"] });
    await cleanupGitRun(session, { force: true });
  });
});

describe("verified integration", () => {
  it("rejects unexpected integration commits and reconciles an interrupted verified cherry-pick", async () => {
    const { worktreeRoot, session } = await startSession("integration-integrity");
    const expected = { ...session };
    await writeFile(join(session.integrationWorktree, "unverified.txt"), "unverified\n");
    await runGit(session.integrationWorktree, ["add", "unverified.txt"]);
    await runGit(session.integrationWorktree, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "unverified",
    ]);
    await expect(assertIntegrationWorktreeUnchanged(session)).rejects.toThrow(/moved unexpectedly/);
    await expect(initializeGitRun({
      repository: session.repositoryRoot,
      worktreeRoot,
      runId: session.runId,
      expected,
    })).rejects.toThrow(/Unexpected commit/);
    await cleanupGitRun(session, { force: true });

    const forgedFixture = await startSession("integration-forgery");
    const forgedExpected = { ...forgedFixture.session };
    const forgedTask = await createTaskWorktree(forgedFixture.session, "work");
    await writeTaskFile(forgedTask, "owned.txt", "hello world\n");
    const forgedMessage = "codex-dw(integration-forgery): work";
    const verifiedCommit = await commitTaskChanges(forgedTask, { ownership: ["owned.txt"], message: forgedMessage });
    await writeFile(join(forgedFixture.session.integrationWorktree, "owned.txt"), "helloworld\n");
    await runGit(forgedFixture.session.integrationWorktree, ["add", "owned.txt"]);
    await runGit(forgedFixture.session.integrationWorktree, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", forgedMessage,
    ]);
    await expect(initializeGitRun({
      repository: forgedFixture.repository,
      worktreeRoot: forgedFixture.worktreeRoot,
      runId: "integration-forgery",
      expected: forgedExpected,
      recoverableIntegration: [{
        callId: "work",
        taskCommit: verifiedCommit.commit,
        message: forgedMessage,
        changedPaths: verifiedCommit.changedPaths,
      }],
    })).rejects.toThrow(/does not match verified task/);
    await cleanupGitRun(forgedFixture.session, { force: true });

    const recoveredFixture = await startSession("integration-recovery");
    const recoveredExpected = { ...recoveredFixture.session };
    const task = await createTaskWorktree(recoveredFixture.session, "work");
    await writeTaskFile(task, "verified.txt", "verified\n");
    const message = "codex-dw(integration-recovery): work";
    const committed = await commitTaskChanges(task, { ownership: ["verified.txt"], message });
    await integrateTask(recoveredFixture.session, committed, { verified: true });
    const resumed = await initializeGitRun({
      repository: recoveredFixture.repository,
      worktreeRoot: recoveredFixture.worktreeRoot,
      runId: "integration-recovery",
      expected: recoveredExpected,
      recoverableIntegration: [{
        callId: "work",
        taskCommit: committed.commit,
        message,
        changedPaths: committed.changedPaths,
      }],
    });
    expect(resumed.recoveredIntegrationCalls).toEqual(["work"]);
    await cleanupGitRun(resumed, { force: true });
  });

  it("requires verification, cherry-picks once, and preserves the active checkout", async () => {
    const { repository, session } = await startSession();
    const task = await createTaskWorktree(session, "integrate");
    const committed = await commitFile(task, "feature.txt", "feature\n");

    await expect(integrateTask(session, committed, { verified: false })).rejects.toThrow(
      /verifier approval/,
    );
    const integrated = await integrateTask(session, committed, { verified: true });
    expect(integrated.reused).toBe(false);
    expect(integrated.changedPaths).toEqual(["feature.txt"]);
    expect((await runGit(session.integrationWorktree, ["show", "HEAD:feature.txt"])).stdout).toBe(
      "feature\n",
    );

    const resumed = await integrateTask(session, committed, { verified: true });
    expect(resumed.reused).toBe(true);
    expect((await runGit(repository, ["rev-parse", "HEAD"])).stdout.trim()).toBe(session.baseHead);
    expect((await runGit(repository, ["status", "--porcelain"])).stdout).toBe("");
    await cleanupGitRun(session);
  });

  it("detects actual path overlap before integration", async () => {
    const { session } = await startSession();
    const first = await createTaskWorktree(session, "first");
    const second = await createTaskWorktree(session, "second");
    const firstCommit = await commitFile(first, "shared.txt", "first\n");
    const secondCommit = await commitFile(second, "shared.txt", "second\n");

    await integrateTask(session, firstCommit, { verified: true });
    await expect(integrateTask(session, secondCommit, { verified: true })).rejects.toMatchObject({
      overlappingPaths: ["shared.txt"],
    });
    expect((await runGit(session.integrationWorktree, ["show", "HEAD:shared.txt"])).stdout).toBe(
      "first\n",
    );
    await cleanupGitRun(session, { force: true });
  });

  it("aborts a cherry-pick conflict and preserves both task branches", async () => {
    const { repository, session } = await startSession("conflict");
    const fileTask = await createTaskWorktree(session, "file");
    const directoryTask = await createTaskWorktree(session, "directory");
    const fileCommit = await commitFile(fileTask, "collision", "file\n");
    const directoryCommit = await commitFile(
      directoryTask,
      "collision/child.txt",
      "directory\n",
    );

    await integrateTask(session, fileCommit, { verified: true });
    await expect(
      integrateTask(session, directoryCommit, { verified: true }),
    ).rejects.toBeInstanceOf(CherryPickConflictError);
    expect((await runGit(session.integrationWorktree, ["status", "--porcelain"])).stdout).toBe("");
    expect(
      (await runGit(repository, ["show-ref", "--verify", `refs/heads/${fileTask.branch}`])).exitCode,
    ).toBe(0);
    expect(
      (await runGit(repository, ["show-ref", "--verify", `refs/heads/${directoryTask.branch}`]))
        .exitCode,
    ).toBe(0);
    await cleanupGitRun(session, { force: true });
  });

  it("detects changes made to the user's active checkout", async () => {
    const { repository, session } = await startSession();
    await writeFile(join(repository, "unexpected.txt"), "unexpected\n");
    await expect(assertActiveWorktreeUnchanged(session)).rejects.toBeInstanceOf(
      ActiveWorktreeChangedError,
    );
  });
});

describe("conservative cleanup", () => {
  it("deletes integrated task branches, preserves unintegrated branches, and keeps integration", async () => {
    const { repository, session } = await startSession("cleanup");
    const integratedTask = await createTaskWorktree(session, "integrated");
    const pendingTask = await createTaskWorktree(session, "pending");
    const integratedCommit = await commitFile(integratedTask, "integrated.txt", "yes\n");
    await commitFile(pendingTask, "pending.txt", "no\n");
    await integrateTask(session, integratedCommit, { verified: true });

    const result = await cleanupGitRun(session);
    expect(result.deletedBranches).toContain(integratedTask.branch);
    expect(result.preservedBranches).toContain(pendingTask.branch);
    expect(result.preservedBranches).toContain(session.integrationBranch);
    expect(result.removedWorktrees).toContain(integratedTask.path);
    expect(result.removedWorktrees).toContain(pendingTask.path);
    expect(result.removedWorktrees).toContain(session.integrationWorktree);
    expect(
      (
        await runGit(repository, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${session.integrationBranch}`,
        ], { allowFailure: true })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runGit(repository, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${pendingTask.branch}`,
        ], { allowFailure: true })
      ).exitCode,
    ).toBe(0);

    const forced = await cleanupGitRun(session, { force: true });
    expect(forced.deletedBranches).toContain(pendingTask.branch);
  });

  it("preserves dirty task worktrees unless cleanup is forced", async () => {
    const { session } = await startSession("dirty cleanup");
    const task = await createTaskWorktree(session, "dirty");
    await writeFile(join(task.path, "uncommitted.txt"), "keep me\n");

    const safe = await cleanupGitRun(session);
    expect(safe.preservedWorktrees).toContain(task.path);
    expect(safe.preservedBranches).toContain(task.branch);

    const forced = await cleanupGitRun(session, { force: true });
    expect(forced.removedWorktrees).toContain(task.path);
    expect(forced.deletedBranches).toContain(task.branch);
  });
});
