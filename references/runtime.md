# `codex-dw` Runtime Reference

## Contents

1. [Execution boundary](#execution-boundary)
2. [Workflow discovery](#workflow-discovery)
3. [Declarative document](#declarative-document)
4. [Operations](#operations)
5. [Prompt context and selectors](#prompt-context-and-selectors)
6. [TypeScript API](#typescript-api)
7. [CLI](#cli)
8. [State, hashing, and resume](#state-hashing-and-resume)
9. [Profiles and budgets](#profiles-and-budgets)
10. [Git mutation protocol](#git-mutation-protocol)
11. [TypeScript containment](#typescript-containment)

## Execution boundary

`codex-dw` is a local prototype layered on the Codex SDK. It is separate from native conversation subagent orchestration and does not add a native `/workflows` command or UI.

Loading the `dynamic-workflows` skill, including implicit loading, never executes a saved workflow. Execution requires a direct workflow/run request from the user or a manual `codex-dw run`/`resume` command. Mutation additionally requires `--allow-mutation`.

Declarative YAML/JSON is interpreted inside the trusted runner and is the recommended default. TypeScript is an advanced executable coordinator with no trust prompt or hash allowlist.

## Workflow discovery

A direct absolute or working-directory-relative file path wins. A namespaced name such as `team/review` is searched under:

```text
<working-directory>/.codex/dynamic-workflows/team/review.<extension>
$CODEX_HOME/dynamic-workflows/workflows/team/review.<extension>
```

Extensions are tried as `.yaml`, `.yml`, `.json`, `.ts`, `.mts`, and `.cts`. Name traversal with `.` or `..` segments is rejected.

## Declarative document

The schema identifier is `codex.openai.com/v1alpha1`. Unknown fields fail validation.

```yaml
apiVersion: codex.openai.com/v1alpha1
kind: Workflow
metadata:
  name: stable-name
  namespace: optional-namespace
  description: Human-readable purpose
argsSchema:
  type: object
runtime:
  profile: small
  concurrency: 4
  maxAgents: 25
  reasoningEffort: xhigh
  networkAccess: false
phases: []
result: outputs.some-phase
```

`argsSchema` and every `outputSchema` are JSON Schemas. Output schemas must also follow the OpenAI [Structured Outputs supported subset](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas): the root is an object, every object disables additional properties, all fields are required, and property schemas declare their types. The runner validates arguments before the first agent call. The Codex adapter asks for structured output and performs one corrective turn if the response is not valid JSON or does not satisfy the schema.

Runtime `model` is optional. When omitted, the SDK inherits the configured Codex model. Reasoning defaults to `xhigh` where supported. Network defaults off.

## Operations

### `agent`

Runs one agent. Its ID is stable within the phase.

```yaml
- id: inspect
  type: agent
  agent:
    id: api
    prompt: Review {{args.path}}.
    input: { focus: correctness }
    outputSchema: { type: object }
```

Agent options may override `model`, `reasoningEffort`, and `networkAccess` and may set `mode: mutating`. A mutating agent must also declare `ownership` and `verification`.

### `parallel`

Starts all declared agents concurrently subject to the run semaphore. The phase completes only after every branch succeeds, making it a barrier.

```yaml
- id: checks
  type: parallel
  agents:
    - { id: security, prompt: Review security., outputSchema: { type: object } }
    - { id: tests, prompt: Review tests., outputSchema: { type: object } }
```

### `pipeline`

Resolves a literal item list or a dotted selector returning a list. Every item streams through all stages before waiting for other items' earlier stages.

```yaml
- id: migrate
  type: pipeline
  items: { select: args.packages }
  key: id
  concurrency: 4
  stages:
    - { id: inspect, prompt: Inspect {{item.path}}., outputSchema: { type: object } }
    - { id: decide, prompt: Decide from {{input}}., outputSchema: { type: object } }
```

`key` must select a unique string or number from each item. Without `key`, a canonical content hash identifies the item. All mutating stages for one item reuse the same Git task worktree through a stable `workspaceKey`.

### `loop`

Runs an agent until a safe dotted selector on its output equals `true`, or fails at the declared bound.

```yaml
- id: converge
  type: loop
  maxIterations: 5
  until: done
  agent:
    id: refine
    prompt: Refine iteration {{iteration}}.
    outputSchema:
      type: object
      required: [done]
      properties: { done: { type: boolean } }
```

The schema ceiling is 100 loop iterations. Reaching the bound without satisfying the condition is an error.

## Prompt context and selectors

Prompts interpolate `{{selector}}` placeholders using JSON serialization. Available roots are:

- `args` — validated workflow arguments.
- `outputs` — completed phase results.
- `item` and `index` — current pipeline item.
- `input` — prior pipeline stage or loop output.
- `iteration` — zero-based loop iteration.

Selectors accept safe dotted object keys and non-negative array indexes. Prototype-pollution segments, accessors, missing values, unmatched delimiters, and non-JSON values fail closed.

The workflow-level `result` uses the same selector rules. Without one, the last phase result is returned.

## TypeScript API

A `.ts`, `.mts`, or `.cts` module exports named `meta` and `run`:

```ts
export const meta = {
  name: "advanced",
  description: "Advanced coordinator",
  argsSchema: { type: "object" },
  profile: "small",
};

export async function run(context, args) {
  return context.phase("main", async () => {
    await context.log("started");
    return context.agent("inspect", "Inspect the scope.", {
      input: args,
      outputSchema: { type: "object" },
    });
  });
}
```

The context exposes:

- `phase(id, work)` — records a sequential/logical phase; async phase context propagates to agent call IDs.
- `agent(id, prompt, options)` — parent-side Codex SDK call with required `outputSchema`.
- `parallel(id, branches)` — concurrent branches plus a completion barrier.
- `pipeline(id, items, worker, options)` — bounded per-item streaming.
- `loop(id, work, {maxIterations, until})` — bounded convergence.
- `log(message, data?)` — persisted workflow event.

Every operation ID is stable and unique for one execution. The coordinator cannot directly access Codex credentials; `agent()` crosses the IPC boundary to the trusted parent.

Static runtime imports are deliberately narrow: relative `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, or `.cjs` files must resolve inside the workflow file's directory. Dynamic, package, URL, absolute, extensionless, data, and out-of-directory imports are rejected. Node built-ins remain external and are subject to child permissions; network and low-level networking built-ins are rejected. Type-only imports are erased by bundling and do not expand runtime access.

## CLI

```text
codex-dw validate <workflow> [--cwd PATH]
codex-dw run <workflow> [--cwd PATH] [--args-json JSON | --args-file PATH]
                         [--profile small|medium|large] [--allow-mutation] [--detach]
codex-dw status [run-id] [--json] [--watch]
codex-dw inspect [run-id] [call-id]
codex-dw resume <run-id> [--workflow PATH] [--detach]
codex-dw stop <run-id>
codex-dw clean <run-id> [--force]
```

`validate` fully validates declarative workflows. For TypeScript it bundle-checks syntax/imports without executing module code; export and metadata checks occur in the constrained child at run time.

Detached execution creates state first and then launches a background runner. `status --watch` polls persisted state and reconciles a missing/stale runner lock. `stop` writes a run-local cancellation request that also covers the pre-start race; it never signals a persisted PID. `inspect` prints full JSON for automation and debugging.

## State, hashing, and resume

State lives at:

```text
$CODEX_HOME/dynamic-workflows/runs/<run-id>/state.json
$CODEX_HOME/dynamic-workflows/runs/<run-id>/events.jsonl
$CODEX_HOME/dynamic-workflows/runs/<run-id>/workflow.snapshot.<extension>
```

Declarative snapshots preserve the source definition. TypeScript snapshots use a self-contained `.mjs` bundle, so relative helper imports participate in the workflow hash and remain resumable if the original files disappear.

Writes are atomic; run directories and files use private modes where supported. A per-run lock with a live heartbeat prevents concurrent execution. Stale heartbeats are recoverable even if an operating-system PID has been reused. If a TypeScript parent RPC outlives its shutdown grace period, the command may return while the run lease remains active; `resume` and `clean` refuse the quarantined run until that RPC drains.

The call hash includes the stable call ID, prompt, input, output schema, mode, model, reasoning, network flag, ownership, verifier contract, and workspace key. A completed call is reused only when the hash matches. Changed calls rerun. Downstream calls rerun when their rendered prompt or input changes. Failed and stopped calls rerun. Interrupted calls without a persisted output restart; interrupted calls with a persisted output continue from that output after checking the exact mutation candidate identity.

Thread IDs are persisted with call records. A rerun can resume the existing Codex SDK thread while still applying the current structured-output contract.

Usage and thread IDs from successful, repaired, failed, and interrupted workers/verifiers are aggregated into run state as streamed events arrive. Verifier calls count toward the total-call budget. Workflow results and phase outputs are persisted for resume and inspection; outputs from phases removed in an updated declarative definition are pruned.

## Profiles and budgets

| Profile | Semaphore | Total worker/verifier calls |
| --- | ---: | ---: |
| small | 4 | 25 |
| medium | 8 | 50 |
| large | 16 | 100 |

Declarative workflows may lower concurrency or total calls inside their selected profile. The hard prototype ceilings are 16 concurrent calls and 100 total calls. A budget applies across resume attempts; cached calls do not consume it again.

## Git mutation protocol

Mutation requires a direct run with `--allow-mutation`. Each mutating operation also declares:

```yaml
mode: mutating
ownership: ["src/package/**", "test/package/**"]
verification:
  prompt: Verify the task changes against its acceptance criteria.
  outputSchema:
    type: object
    required: [accepted]
    properties: { accepted: { const: true } }
```

The runner:

1. Resolves the repository and rejects a dirty base, detached HEAD, or repository-configured executable Git filter/diff/merge-driver configuration. Runner Git commands use a credential-free environment, ignore system/global Git config, and disable hooks.
2. Creates `codex-dw/<run>/integration` in a runner-owned external worktree.
3. Creates one task branch/worktree per independent mutation unit.
4. Runs the worker in that worktree and rejects changes outside ownership.
5. Hashes the exact candidate Git tree and runs a separate read-only verifier in the same worktree.
6. Commits only verifier-approved changes with runner-local Git identity.
7. Serializes acceptance and cherry-picks into the integration branch.
8. Stops on unrelated path overlap or cherry-pick conflict and preserves all recovery branches.
9. Rechecks that the active user's branch, HEAD, and Git working-tree status match the initial snapshot.

Later stages of the same pipeline item may edit paths already owned by that item. Different mutation units may not overlap.

Worker output, candidate identity, verifier result, task commit, expected integration HEAD, and integration state are persisted at recovery boundaries. Resume enforces the original active branch/base and can reconcile a clean task commit or an already-applied, byte-exact cherry-pick after process interruption. Any other integration-branch movement stops the run.

Normal cleanup removes clean task worktrees, deletes integrated task branches, and preserves unintegrated task branches plus the integration branch. `--force` is explicit authority to remove unintegrated task branches or dirty runner worktrees; it still does not merge or delete the integration branch.

## TypeScript containment

TypeScript coordinators run without a trust prompt by explicit product choice. They are bundled with esbuild, then executed in a separate Node process with:

- An allowlisted environment containing locale/platform values and serialized run configuration only.
- No OpenAI, Codex, cloud, or arbitrary parent environment credentials.
- A V8 old-space heap ceiling and wall-time timeout.
- Exact read permissions for the generated bootstrap and workflow bundle where Node permissions are available.
- No filesystem writes, child processes, workers, or direct parent process access under those permissions.
- Static and dynamic import restrictions plus network-module, low-level binding, and web-global guards. These intercept common network paths; they are not OS-level network isolation.
- A narrow IPC protocol for metadata, phases, agents, and logs.
- Parent-side validation of every IPC request; child-supplied working-directory overrides are rejected.

These controls reduce accidental and opportunistic access. They are not a complete JavaScript sandbox, a VM security boundary, or a reason to execute untrusted TypeScript. Use declarative workflows when executable code is unnecessary.
