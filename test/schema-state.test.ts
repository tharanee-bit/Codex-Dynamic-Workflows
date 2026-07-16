import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_API_VERSION,
  WorkflowValidationError,
  loadWorkflow,
  parseWorkflow,
} from "../src/schema/index.js";
import {
  InvalidRunIdError,
  RunLockedError,
  RunStateStore,
} from "../src/state/index.js";
import type { RunEvent, RunState } from "../src/types.js";
import {
  CanonicalJsonError,
  SelectorError,
  canonicalJson,
  renderPromptTemplate,
  selectDotted,
  sha256Canonical,
} from "../src/util/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-dw-schema-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

const MINIMAL_WORKFLOW = `
apiVersion: codex.openai.com/v1alpha1
kind: Workflow
metadata:
  name: review
  description: Review a change
argsSchema:
  type: object
  additionalProperties: false
phases:
  - id: inspect
    type: agent
    agent:
      id: reviewer
      prompt: Review {{ args.target }}
      outputSchema:
        type: object
        required: [ok]
        properties:
          ok: { type: boolean }
        additionalProperties: false
result: outputs.inspect
`;

function runState(id: string, createdAt = "2026-07-16T12:00:00.000Z"): RunState {
  return {
    schemaVersion: 1,
    id,
    status: "pending",
    workflowPath: "/tmp/workflow.yaml",
    workflowHash: "abc123",
    workflowKind: "declarative",
    workflowSnapshot: MINIMAL_WORKFLOW,
    args: {},
    workingDirectory: "/tmp/project",
    profile: "small",
    maxAgents: 4,
    concurrency: 4,
    agentCallsUsed: 0,
    allowMutation: false,
    createdAt,
    updatedAt: createdAt,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    calls: {},
    phases: {},
    outputs: {},
  };
}

describe("v1alpha1 workflow loader", () => {
  it("loads a typed YAML workflow", () => {
    const workflow = parseWorkflow(MINIMAL_WORKFLOW);
    expect(workflow.apiVersion).toBe(WORKFLOW_API_VERSION);
    expect(workflow.phases[0]).toMatchObject({ id: "inspect", type: "agent" });
  });

  it("loads JSON and YAML files and rejects unsupported extensions", async () => {
    const directory = await temporaryDirectory();
    const parsed = parseWorkflow(MINIMAL_WORKFLOW);
    const jsonPath = join(directory, "workflow.json");
    const yamlPath = join(directory, "workflow.yml");
    await writeFile(jsonPath, JSON.stringify(parsed), "utf8");
    await writeFile(yamlPath, MINIMAL_WORKFLOW, "utf8");

    await expect(loadWorkflow(jsonPath)).resolves.toEqual(parsed);
    await expect(loadWorkflow(yamlPath)).resolves.toEqual(parsed);
    await expect(loadWorkflow(join(directory, "workflow.txt"))).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("rejects unknown fields at every declared level", () => {
    const workflow = parseWorkflow(MINIMAL_WORKFLOW);
    const withRootField = { ...workflow, surprise: true };
    expect(() => parseWorkflow(JSON.stringify(withRootField), "json")).toThrow(WorkflowValidationError);

    const withAgentField = structuredClone(workflow) as unknown as Record<string, unknown>;
    const phases = withAgentField.phases as Array<Record<string, unknown>>;
    (phases[0]?.agent as Record<string, unknown>).surprise = true;
    expect(() => parseWorkflow(JSON.stringify(withAgentField), "json")).toThrow(WorkflowValidationError);
  });

  it("requires stable agent ids and an output schema", () => {
    const missingSchema = MINIMAL_WORKFLOW.replace(/\n      outputSchema:[\s\S]*?\nresult:/, "\nresult:");
    expect(() => parseWorkflow(missingSchema)).toThrow(WorkflowValidationError);

    const unstableId = MINIMAL_WORKFLOW.replace("id: reviewer", "id: reviewer with spaces");
    expect(() => parseWorkflow(unstableId)).toThrow(WorkflowValidationError);
  });

  it("requires ownership and verification for mutating agents", () => {
    const withoutSafety = MINIMAL_WORKFLOW.replace("id: reviewer\n", "id: reviewer\n      mode: mutating\n");
    expect(() => parseWorkflow(withoutSafety)).toThrow(WorkflowValidationError);

    const safeMutation = MINIMAL_WORKFLOW.replace(
      "id: reviewer\n",
      `id: reviewer
      mode: mutating
      ownership: [src/**]
      verification:
        prompt: Verify the owned changes
        outputSchema:
          type: object
          required: [accepted]
          properties:
            accepted: { type: boolean }
          additionalProperties: false
`,
    );
    expect(parseWorkflow(safeMutation).phases[0]).toMatchObject({ type: "agent" });
  });

  it("rejects duplicate phase and local agent ids", () => {
    const workflow = parseWorkflow(MINIMAL_WORKFLOW);
    workflow.phases.push(structuredClone(workflow.phases[0]!));
    expect(() => parseWorkflow(JSON.stringify(workflow), "json")).toThrowError(/duplicates phase id/);

    const parallel = parseWorkflow(MINIMAL_WORKFLOW);
    const agent = (parallel.phases[0] as { agent: unknown }).agent;
    parallel.phases = [{ id: "fanout", type: "parallel", agents: [agent, structuredClone(agent)] } as never];
    expect(() => parseWorkflow(JSON.stringify(parallel), "json")).toThrowError(/duplicates agent id/);
  });

  it("validates embedded argument, output, and verifier schemas", () => {
    const badArgs = MINIMAL_WORKFLOW.replace("type: object\n  additionalProperties", "type: not-a-json-type\n  additionalProperties");
    expect(() => parseWorkflow(badArgs)).toThrowError(/argsSchema.*valid JSON Schema/);

    const badOutput = MINIMAL_WORKFLOW.replace("required: \[ok\]", "required: ok");
    expect(() => parseWorkflow(badOutput)).toThrowError(/outputSchema.*valid JSON Schema/);
  });

  it("rejects duplicate YAML mapping keys", () => {
    expect(() => parseWorkflow(`${MINIMAL_WORKFLOW}\nkind: Workflow\n`)).toThrowError(/YAML could not be parsed/);
  });
});

describe("safe selectors and prompt templates", () => {
  const context = { args: { name: "Ada", items: [1, { ok: true }] } };

  it("selects own properties and array indexes", () => {
    expect(selectDotted(context, "args.items.1.ok")).toBe(true);
  });

  it("rejects prototype access, missing values, and accessors", () => {
    expect(() => selectDotted(context, "args.__proto__")).toThrow(SelectorError);
    expect(() => selectDotted(context, "args.missing")).toThrow(SelectorError);
    expect(() => selectDotted({ args: [1] }, "args.length")).toThrow(SelectorError);
    const accessor = Object.defineProperty({}, "secret", { get: () => "nope", enumerable: true });
    expect(() => selectDotted({ accessor }, "accessor.secret")).toThrow(/accessor/);
  });

  it("serializes every interpolation as JSON", () => {
    expect(renderPromptTemplate("Name={{ args.name }} items={{args.items}}", context)).toBe(
      'Name="Ada" items=[1,{"ok":true}]',
    );
    expect(() => renderPromptTemplate("Bad {{ args.name", context)).toThrow(SelectorError);
  });
});

describe("canonical hashing", () => {
  it("sorts object keys recursively and produces stable SHA-256", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
  });

  it("rejects values that JSON cannot represent deterministically", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(CanonicalJsonError);
  });
});

describe("run state store", () => {
  it("persists state atomically with private permissions", async () => {
    const codexHome = await temporaryDirectory();
    const store = new RunStateStore({ codexHome });
    const state = runState("run-one");
    await store.initializeRun(state);

    expect(await store.readRun(state.id)).toEqual(state);
    const leftovers = (await readdir(store.runDirectory(state.id))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(store.runDirectory(state.id))).mode & 0o777).toBe(0o700);
      expect((await stat(store.statePath(state.id))).mode & 0o777).toBe(0o600);
    }
    await expect(store.initializeRun(state)).rejects.toThrow(/already exists/);
  });

  it("rejects persisted state without a valid invocation budget counter", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    const invalid = { ...runState("invalid-budget"), agentCallsUsed: -1 } as RunState;
    await expect(store.initializeRun(invalid)).rejects.toThrow(/agentCallsUsed/);
  });

  it("appends and reads events.jsonl", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    await store.initializeRun(runState("event-run"));
    const first: RunEvent = { type: "run.started", timestamp: "2026-07-16T12:00:00.000Z", runId: "event-run" };
    const second: RunEvent = {
      type: "phase.completed",
      timestamp: "2026-07-16T12:01:00.000Z",
      runId: "event-run",
      phaseId: "inspect",
      data: { ok: true },
    };
    await store.appendEvent(first);
    await store.appendEvent("event-run", second);

    expect(await store.readEvents("event-run")).toEqual([first, second]);
    expect((await readFile(store.eventsPath("event-run"), "utf8")).trim().split("\n")).toHaveLength(2);
    if (process.platform !== "win32") {
      expect((await stat(store.eventsPath("event-run"))).mode & 0o777).toBe(0o600);
    }
  });

  it("lists newest runs first and finds the latest run", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    await store.initializeRun(runState("older", "2026-07-16T10:00:00.000Z"));
    await store.initializeRun(runState("newer", "2026-07-16T11:00:00.000Z"));

    expect((await store.listRuns()).map(({ id }) => id)).toEqual(["newer", "older"]);
    expect((await store.getLatestRun())?.id).toBe("newer");
  });

  it("rejects path traversal run ids", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    expect(() => store.runDirectory("../escape")).toThrow(InvalidRunIdError);
    await expect(store.readRun("../escape")).rejects.toBeInstanceOf(InvalidRunIdError);
  });

  it("excludes concurrent holders and permits release", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    const first = await store.acquireLock("locked-run");
    await expect(store.acquireLock("locked-run")).rejects.toBeInstanceOf(RunLockedError);
    await first.release();
    const second = await store.acquireLock("locked-run");
    await second.release();
  });

  it("clears locks belonging to stale PIDs", async () => {
    const store = new RunStateStore({
      codexHome: await temporaryDirectory(),
      processId: 1234,
      isProcessAlive: () => false,
    });
    await store.initializeRun(runState("stale-run"));
    await writeFile(
      store.lockPath("stale-run"),
      JSON.stringify({ pid: 999_999, token: "old", acquiredAt: "2020-01-01T00:00:00.000Z" }),
      { encoding: "utf8", mode: 0o600 },
    );

    const lock = await store.acquireLock("stale-run");
    expect(lock.pid).toBe(1234);
    await lock.release();
  });

  it("clears stale-heartbeat locks even when the PID was reused", async () => {
    const store = new RunStateStore({
      codexHome: await temporaryDirectory(),
      processId: 1234,
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    await store.initializeRun(runState("reused-pid"));
    await writeFile(
      store.lockPath("reused-pid"),
      JSON.stringify({
        pid: 1234,
        token: "old",
        acquiredAt: "2020-01-01T00:00:00.000Z",
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const lock = await store.acquireLock("reused-pid");
    await lock.release();
  });

  it("always releases withLock after failures", async () => {
    const store = new RunStateStore({ codexHome: await temporaryDirectory() });
    await expect(store.withLock("failure-run", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const lock = await store.acquireLock("failure-run");
    await lock.release();
  });
});
