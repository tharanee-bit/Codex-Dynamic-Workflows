import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeAdapter } from "../src/adapter/fake.js";
import { runGit } from "../src/git/index.js";
import { RunManager } from "../src/runtime/index.js";
import { RunStateStore } from "../src/state/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function workflow(phases: string, extra = ""): string {
  return `apiVersion: codex.openai.com/v1alpha1
kind: Workflow
metadata:
  name: test
  description: Runtime manager test
argsSchema:
  type: object
  additionalProperties: false
runtime:
  profile: small
${extra}phases:
${phases}
result: outputs.last
`;
}

const objectSchema = " { type: object, additionalProperties: false, required: [value], properties: { value: { type: string } } }";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunManager", () => {
  it("persists runs, resumes failed work, and reuses completed calls", async () => {
    const root = await temporaryDirectory("codex-dw-manager-");
    const project = join(root, "project");
    await mkdir(project);
    const path = join(project, "workflow.yaml");
    await writeFile(path, workflow(`  - id: first
    type: agent
    agent:
      id: first
      prompt: first
      outputSchema:${objectSchema}
  - id: last
    type: agent
    agent:
      id: second
      prompt: '{{outputs.first.value}}'
      outputSchema:${objectSchema}
`));

    let failSecond = true;
    const adapter = new FakeAdapter((request) => {
      if (request.callId === "last/second" && failSecond) {
        failSecond = false;
        throw new Error("interrupted");
      }
      return { value: request.callId };
    });
    const manager = new RunManager({
      adapter,
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
    });
    const created = await manager.createRun({
      workflow: path,
      args: {},
      workingDirectory: project,
      allowMutation: false,
    });
    await expect(manager.execute(created.id)).rejects.toThrow("interrupted");
    const completed = await manager.resume(created.id);

    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ value: "last/second" });
    expect(adapter.requests.map((request) => request.callId)).toEqual([
      "first/first",
      "last/second",
      "last/second",
    ]);
    expect((await manager.store.readEvents(created.id)).some((entry) => entry.type === "agent.cached")).toBe(true);
  });

  it("invalidates a changed call and its prompt-dependent downstream call", async () => {
    const root = await temporaryDirectory("codex-dw-invalidate-");
    const project = join(root, "project");
    await mkdir(project);
    const path = join(project, "workflow.yaml");
    const definition = (version: string) => workflow(`  - id: first
    type: agent
    agent:
      id: first
      prompt: first-${version}
      outputSchema:${objectSchema}
  - id: last
    type: agent
    agent:
      id: second
      prompt: 'downstream {{outputs.first.value}}'
      outputSchema:${objectSchema}
`);
    await writeFile(path, definition("v1"));
    const adapter = new FakeAdapter((request) => ({ value: request.prompt }));
    const manager = new RunManager({
      adapter,
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
    });
    const created = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: false });
    await manager.execute(created.id);
    await writeFile(path, definition("v2"));
    await manager.resume(created.id);

    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests.map((request) => request.prompt)).toEqual([
      "first-v1",
      'downstream "first-v1"',
      "first-v2",
      'downstream "first-v2"',
    ]);
  });

  it("reapplies declarative profiles and prunes outputs removed from an updated workflow", async () => {
    const root = await temporaryDirectory("codex-dw-profile-resume-");
    const project = join(root, "project");
    await mkdir(project);
    const path = join(project, "workflow.yaml");
    await writeFile(path, workflow(`  - id: removed
    type: agent
    agent:
      id: old
      prompt: old
      outputSchema:${objectSchema}
  - id: last
    type: agent
    agent:
      id: final
      prompt: final-v1
      outputSchema:${objectSchema}
`));
    const adapter = new FakeAdapter((request) => ({ value: request.prompt }));
    const manager = new RunManager({ adapter, store: new RunStateStore({ codexHome: join(root, "codex-home") }) });
    const created = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: false });
    await manager.execute(created.id);
    const updated = workflow(`  - id: last
    type: agent
    agent:
      id: final
      prompt: final-v2
      outputSchema:${objectSchema}
`).replace("profile: small", "profile: medium");
    await writeFile(path, updated);
    const resumed = await manager.resume(created.id);
    expect(resumed.profile).toBe("medium");
    expect(resumed.concurrency).toBe(8);
    expect(resumed.outputs).toEqual({ last: { value: "final-v2" } });
  });

  it("validates TypeScript arguments before accepting agent RPC", async () => {
    const root = await temporaryDirectory("codex-dw-ts-args-");
    const project = join(root, "project");
    await mkdir(project);
    const path = join(project, "workflow.ts");
    await writeFile(path, `
      export const meta = {
        name: "args",
        description: "args",
        argsSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } }
      };
      export async function run(context) {
        return context.agent("never", "never", { outputSchema: { type: "object" } });
      }
    `);
    const adapter = new FakeAdapter(() => ({}));
    const manager = new RunManager({
      adapter,
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
    });
    const created = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: false });
    await expect(manager.execute(created.id)).rejects.toThrow(/arguments are invalid/);
    expect(adapter.requests).toHaveLength(0);
  });

  it("hashes imported TypeScript helpers and resumes from a self-contained snapshot", async () => {
    const root = await temporaryDirectory("codex-dw-ts-snapshot-");
    const project = join(root, "project");
    await mkdir(project);
    const workflowPath = join(project, "workflow.ts");
    const helperPath = join(project, "helper.ts");
    await writeFile(helperPath, `export const value = "v1";\n`);
    await writeFile(workflowPath, `
      import { value } from "./helper.ts";
      export const meta = { name: "snapshot", description: "snapshot", argsSchema: { type: "object" } };
      export async function run() { return { value }; }
    `);
    const manager = new RunManager({
      adapter: new FakeAdapter(() => ({})),
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
    });
    const created = await manager.createRun({ workflow: workflowPath, args: {}, workingDirectory: project, allowMutation: false });
    const initialHash = created.workflowHash;

    await writeFile(helperPath, `export const value = "v2";\n`);
    const completed = await manager.execute(created.id);
    expect(completed.result).toEqual({ value: "v2" });
    expect(completed.workflowHash).not.toBe(initialHash);

    await rm(workflowPath);
    await rm(helperPath);
    const resumed = await manager.resume(created.id);
    expect(resumed.result).toEqual({ value: "v2" });
    expect(resumed.workflowHash).toBe(completed.workflowHash);
  });

  it("stops pending runs and reconciles orphaned running state without signaling a PID", async () => {
    const root = await temporaryDirectory("codex-dw-stop-state-");
    const project = join(root, "project");
    await mkdir(project);
    const path = join(project, "workflow.ts");
    await writeFile(path, `
      export const meta = { name: "stop", description: "stop", argsSchema: { type: "object" } };
      export async function run() { return { ok: true }; }
    `);
    const manager = new RunManager({
      adapter: new FakeAdapter(() => ({})),
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
    });
    const pending = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: false });
    expect((await manager.stop(pending.id)).status).toBe("stopped");
    expect((await manager.execute(pending.id)).status).toBe("stopped");

    const orphan = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: false });
    orphan.status = "running";
    orphan.pid = 999_999;
    await manager.store.save(orphan);
    const summary = await manager.status(orphan.id);
    expect(summary.status).toBe("stopped");
    expect(summary.error).toMatch(/no longer alive/);
  });

  it("keeps pipeline mutation stages in one worktree and integrates verified commits", async () => {
    const root = await temporaryDirectory("codex-dw-manager-git-");
    const project = join(root, "project");
    await mkdir(project);
    await runGit(project, ["init", "-b", "main"]);
    const path = join(project, "workflow.yaml");
    await writeFile(join(project, "base.txt"), "base\n");
    await writeFile(path, workflow(`  - id: work
    type: pipeline
    items:
      - { id: one }
    key: id
    stages:
      - id: edit
        prompt: edit
        mode: mutating
        ownership: [owned.txt]
        outputSchema:${objectSchema}
        verification:
          prompt: verify edit
          outputSchema:
            type: object
            required: [accepted]
            properties: { accepted: { type: boolean } }
      - id: refine
        prompt: refine
        mode: mutating
        ownership: [owned.txt]
        outputSchema:${objectSchema}
        verification:
          prompt: verify refine
          outputSchema:
            type: object
            required: [accepted]
            properties: { accepted: { type: boolean } }
  - id: last
    type: agent
    agent:
      id: finish
      prompt: done
      outputSchema:${objectSchema}
`));
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);

    const adapter = new FakeAdapter(async (request) => {
      if (request.callId.endsWith(".verify")) return { accepted: true };
      if (request.mode === "mutating") {
        const owned = join(request.workingDirectory!, "owned.txt");
        const prior = await readFile(owned, "utf8").catch(() => "");
        await writeFile(owned, `${prior}${request.callId}\n`);
      }
      return { value: request.callId };
    });
    const manager = new RunManager({
      adapter,
      store: new RunStateStore({ codexHome: join(root, "codex-home") }),
      reviewSessionId: "parent-session",
    });
    const created = await manager.createRun({ workflow: path, args: {}, workingDirectory: project, allowMutation: true });
    const completed = await manager.execute(created.id);

    expect(completed.git?.integrationBranch).toMatch(/^codex-dw\/.+\/integration$/);
    expect(completed.git?.pathOwners["owned.txt"]).toBe("work-one");
    expect(completed.reviewArtifacts).toEqual([expect.objectContaining({
      protocol: "codex-dw.review-artifact/v1",
      id: `${created.id}.integration`,
      reviewSessionId: "parent-session",
      repositoryRoot: completed.git?.repositoryRoot,
      baseCommit: completed.git?.baseHead,
      headCommit: completed.git?.integrationHead,
      branch: completed.git?.integrationBranch,
      runStatus: "completed",
    })]);
    expect(await readFile(join(completed.git!.integrationWorktree, "owned.txt"), "utf8")).toContain("work/refine.one");
    expect((await runGit(project, ["status", "--porcelain"])).stdout).toBe("");

    const snapshots: Array<{ status: string; hasArtifact: boolean }> = [];
    const save = manager.store.save.bind(manager.store);
    manager.store.save = async (state) => {
      snapshots.push({ status: state.status, hasArtifact: state.reviewArtifacts !== undefined });
      await save(state);
    };
    completed.status = "running";
    completed.pid = 999_999;
    delete completed.reviewArtifacts;
    await save(completed);
    const stopped = await manager.status(created.id);
    expect(stopped.status).toBe("stopped");
    expect((await manager.store.readRun(created.id)).reviewArtifacts?.[0]).toMatchObject({ runStatus: "stopped" });
    const resumed = await manager.resume(created.id);
    expect(snapshots.some((snapshot) => !snapshot.hasArtifact && ["pending", "running"].includes(snapshot.status))).toBe(true);
    expect(resumed.reviewArtifacts?.[0]).toMatchObject({ runStatus: "completed", reviewSessionId: "parent-session" });

    const cleaned = await manager.clean(created.id);
    expect(cleaned?.preservedBranches).toContain(completed.git!.integrationBranch);
  });

  it("publishes a failed partial integration and omits artifacts without a valid parent session", async () => {
    const root = await temporaryDirectory("codex-dw-review-artifact-failure-");
    const project = join(root, "project");
    await mkdir(project);
    await runGit(project, ["init", "-b", "main"]);
    await writeFile(join(project, "base.txt"), "base\n");
    const definition = join(project, "workflow.yaml");
    await writeFile(definition, workflow(`  - id: edit
    type: agent
    agent:
      id: worker
      prompt: edit
      mode: mutating
      ownership: [owned.txt]
      outputSchema:${objectSchema}
      verification:
        prompt: verify
        outputSchema:
          type: object
          required: [accepted]
          properties: { accepted: { const: true } }
  - id: fail
    type: agent
    agent:
      id: worker
      prompt: fail after integration
      outputSchema:${objectSchema}
`));
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);

    const handler = async (request: Parameters<FakeAdapter["run"]>[0]) => {
      if (request.callId.endsWith(".verify")) return { accepted: true };
      if (request.mode === "mutating") {
        await writeFile(join(request.workingDirectory!, "owned.txt"), "integrated\n");
        return { value: "edited" };
      }
      throw new Error("intentional final failure");
    };
    const store = new RunStateStore({ codexHome: join(root, "codex-home") });
    const manager = new RunManager({ adapter: new FakeAdapter(handler), store, reviewSessionId: "parent-session" });
    const created = await manager.createRun({ workflow: definition, args: {}, workingDirectory: project, allowMutation: true });
    await expect(manager.execute(created.id)).rejects.toThrow(/intentional final failure/);
    const failed = await store.readRun(created.id);
    expect(failed.reviewArtifacts?.[0]).toMatchObject({ runStatus: "failed", reviewSessionId: "parent-session" });

    const noSessionStore = new RunStateStore({ codexHome: join(root, "codex-home-no-session") });
    const noSessionManager = new RunManager({
      adapter: new FakeAdapter(async (request) => {
        if (request.callId.endsWith(".verify")) return { accepted: true };
        if (request.mode === "mutating") await writeFile(join(request.workingDirectory!, "owned.txt"), "integrated\n");
        if (request.prompt === "fail after integration") throw new Error("intentional final failure");
        return { value: "edited" };
      }),
      store: noSessionStore,
      reviewSessionId: "invalid session id",
    });
    const noSession = await noSessionManager.createRun({ workflow: definition, args: {}, workingDirectory: project, allowMutation: true });
    await expect(noSessionManager.execute(noSession.id)).rejects.toThrow(/intentional final failure/);
    expect((await noSessionStore.readRun(noSession.id)).reviewArtifacts).toBeUndefined();

    await manager.clean(created.id, true);
    await noSessionManager.clean(noSession.id, true);
  });

  it("serializes integration while independent mutation items execute in parallel", async () => {
    const root = await temporaryDirectory("codex-dw-parallel-git-");
    const project = join(root, "project");
    await mkdir(project);
    await runGit(project, ["init", "-b", "main"]);
    await writeFile(join(project, "base.txt"), "base\n");
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
    const definition = join(root, "parallel.workflow.yaml");
    await writeFile(definition, workflow(`  - id: work
    type: pipeline
    concurrency: 2
    items:
      - { id: one }
      - { id: two }
    key: id
    stages:
      - id: edit
        prompt: 'edit {{item.id}}'
        mode: mutating
        ownership: [owned/**]
        outputSchema:${objectSchema}
        verification:
          prompt: verify
          outputSchema:
            type: object
            required: [accepted]
            properties: { accepted: { const: true } }
  - id: last
    type: agent
    agent:
      id: finish
      prompt: done
      outputSchema:${objectSchema}
`));
    const adapter = new FakeAdapter(async (request) => {
      if (request.callId.endsWith(".verify")) return { accepted: true };
      if (request.mode === "mutating") {
        const id = (request.input as { id: string }).id;
        await mkdir(join(request.workingDirectory!, "owned"), { recursive: true });
        await writeFile(join(request.workingDirectory!, "owned", `${id}.txt`), `${id}\n`);
      }
      return { value: request.callId };
    });
    const manager = new RunManager({ adapter, store: new RunStateStore({ codexHome: join(root, "codex-home") }) });
    const created = await manager.createRun({ workflow: definition, args: {}, workingDirectory: project, allowMutation: true });
    const completed = await manager.execute(created.id);
    expect(await readFile(join(completed.git!.integrationWorktree, "owned", "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(completed.git!.integrationWorktree, "owned", "two.txt"), "utf8")).toBe("two\n");
    expect(completed.git?.integratedPaths).toEqual(["owned/one.txt", "owned/two.txt"]);
    await manager.clean(created.id, true);
  });

  it("does not verify or integrate an unawaited TypeScript mutation", async () => {
    const root = await temporaryDirectory("codex-dw-orphan-mutation-");
    const project = join(root, "project");
    await mkdir(project);
    await runGit(project, ["init", "-b", "main"]);
    await writeFile(join(project, "base.txt"), "base\n");
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
    const definition = join(root, "orphan.workflow.ts");
    await writeFile(definition, `
      export const meta = { name: "orphan", description: "orphan", argsSchema: { type: "object" } };
      export async function run(context) {
        void context.agent("orphan", "orphan", {
          mode: "mutating",
          ownership: ["owned.txt"],
          outputSchema: { type: "object" },
          verification: {
            prompt: "verify",
            outputSchema: { type: "object", required: ["accepted"], properties: { accepted: { const: true } } },
          },
        });
        await context.log("orphan-dispatched");
        return { done: true };
      }
    `);
    const adapter = new FakeAdapter(async (request) => {
      if (request.callId.endsWith(".verify")) return { accepted: true };
      await writeFile(join(request.workingDirectory!, "owned.txt"), "orphan\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      return {};
    });
    const manager = new RunManager({ adapter, store: new RunStateStore({ codexHome: join(root, "codex-home") }) });
    const created = await manager.createRun({ workflow: definition, args: {}, workingDirectory: project, allowMutation: true });
    await expect(manager.execute(created.id)).rejects.toThrow(/parent RPC calls were still running/);
    const failed = await manager.store.readRun(created.id);
    expect(failed.status).toBe("failed");
    expect(adapter.requests.some((request) => request.callId.endsWith(".verify"))).toBe(false);
    expect(failed.git?.integratedPaths ?? []).toEqual([]);
    await manager.clean(created.id, true);
  });

  it("holds the run lease until a late mutating RPC finishes", async () => {
    const root = await temporaryDirectory("codex-dw-late-mutation-");
    const project = join(root, "project");
    await mkdir(project);
    await runGit(project, ["init", "-b", "main"]);
    await writeFile(join(project, "base.txt"), "base\n");
    await runGit(project, ["add", "."]);
    await runGit(project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
    const definition = join(root, "late.workflow.ts");
    await writeFile(definition, `
      export const meta = { name: "late", description: "late", argsSchema: { type: "object" } };
      export async function run(context) {
        void context.agent("late", "late", {
          mode: "mutating",
          ownership: ["owned.txt"],
          outputSchema: { type: "object" },
          verification: {
            prompt: "verify",
            outputSchema: { type: "object", required: ["accepted"], properties: { accepted: { const: true } } },
          },
        });
        await context.log("late-dispatched");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
        return { done: true };
      }
    `);
    let resolveAdapter!: () => void;
    const adapterFinished = new Promise<void>((resolvePromise) => { resolveAdapter = resolvePromise; });
    const adapter = new FakeAdapter(async (request) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
      await writeFile(join(request.workingDirectory!, "owned.txt"), "late\n");
      resolveAdapter();
      return {};
    });
    const manager = new RunManager({ adapter, store: new RunStateStore({ codexHome: join(root, "codex-home") }) });
    const created = await manager.createRun({ workflow: definition, args: {}, workingDirectory: project, allowMutation: true });

    await expect(manager.execute(created.id)).rejects.toThrow(/parent RPC calls were still running/);
    expect(await manager.store.isRunLocked(created.id)).toBe(true);
    await expect(manager.resume(created.id)).rejects.toThrow(/active or draining/);
    await expect(manager.clean(created.id, true)).rejects.toThrow(/active or draining/);

    await adapterFinished;
    for (let attempt = 0; attempt < 100 && await manager.store.isRunLocked(created.id); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(await manager.store.isRunLocked(created.id)).toBe(false);
    const failed = await manager.store.readRun(created.id);
    expect(failed.git?.integratedPaths ?? []).toEqual([]);
    expect(adapter.requests.some((request) => request.callId.endsWith(".verify"))).toBe(false);
    await manager.clean(created.id, true);
  });

  it("serializes concurrent resume and force cleanup under one run lease", async () => {
    const root = await temporaryDirectory("codex-dw-resume-clean-race-");
    const project = join(root, "project");
    await mkdir(project);
    const definition = join(project, "wait.workflow.ts");
    await writeFile(definition, `
      export const meta = { name: "wait", description: "wait", argsSchema: { type: "object" } };
      export async function run() {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
        return { done: true };
      }
    `);
    const store = new RunStateStore({ codexHome: join(root, "codex-home") });
    const manager = new RunManager({ adapter: new FakeAdapter(() => ({})), store });
    const created = await manager.createRun({
      workflow: definition,
      args: {},
      workingDirectory: project,
      allowMutation: false,
    });

    const acquireLock = store.acquireLock.bind(store);
    let pauseNextLock = true;
    let announceCleanLock!: () => void;
    let releaseCleanLock!: () => void;
    const cleanLockAcquired = new Promise<void>((resolvePromise) => { announceCleanLock = resolvePromise; });
    const continueClean = new Promise<void>((resolvePromise) => { releaseCleanLock = resolvePromise; });
    store.acquireLock = async (runId) => {
      const lock = await acquireLock(runId);
      if (pauseNextLock) {
        pauseNextLock = false;
        announceCleanLock();
        await continueClean;
      }
      return lock;
    };

    const cleaning = manager.clean(created.id, true);
    await cleanLockAcquired;
    await expect(manager.resume(created.id)).rejects.toThrow(/active or draining/);
    releaseCleanLock();
    await expect(cleaning).resolves.toBeUndefined();

    const resuming = manager.resume(created.id);
    for (let attempt = 0; attempt < 20 && !await store.isRunLocked(created.id); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(await store.isRunLocked(created.id)).toBe(true);
    await expect(manager.clean(created.id, true)).rejects.toThrow(/active or draining/);
    await expect(resuming).resolves.toMatchObject({ status: "completed", result: { done: true } });
  });
});
