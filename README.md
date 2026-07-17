# Codex Dynamic Workflows

An experimental Codex skill and local TypeScript runtime for bounded, structured multi-agent work.

The project has two complementary surfaces:

1. **Native Codex orchestration** — `SKILL.md` helps Codex plan and coordinate ordinary subagents in the current conversation.
2. **`codex-dw` runtime** — a persistent local runner for declarative YAML/JSON workflows and advanced TypeScript coordinators.

Inspired by [Claude Code workflow concepts](https://code.claude.com/docs/en/workflows) and built on the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), `codex-dw` approximates agents, parallel barriers, pipelines, phases, bounded loops, arguments, progress, and resume. It is not a native Codex `/workflows` command, UI, or claim of feature parity with Claude Code.

## Runtime highlights

- Strict `codex.openai.com/v1alpha1` YAML/JSON validation.
- TypeScript API with `phase()`, `agent()`, `parallel()`, `pipeline()`, `loop()`, and `log()`.
- Stable call IDs, JSON Schema outputs, structured-output repair, call/candidate hashing, crash-boundary recovery, and selective reuse.
- Atomic state and event logs under `$CODEX_HOME/dynamic-workflows/runs/<run-id>`.
- Streaming Codex SDK events, persisted thread IDs, live status, inspection, stop, and resume.
- Four-agent default concurrency, medium and large profiles, a 16-concurrent ceiling, and a 100-call ceiling.
- Configured Codex model inheritance rather than a pinned model ID; `xhigh` reasoning is the default when supported.
- Git worktree isolation, path ownership, independent verification, and integration-branch consolidation for mutation.
- Optional session-bound `codex-dw.review-artifact/v1` Git-range pointers for read-only final-artifact review.
- Constrained TypeScript child execution with a sanitized environment, a V8 heap/time limit, Node permissions, and no direct Codex credentials.

## Install locally

The prototype requires Node.js 20 or newer and a working local Codex SDK/CLI session.

```bash
npm install
npm run check
npm link
codex-dw --help
```

Publication to npm is intentionally deferred. `npm link` installs only the CLI package; the Codex skill is synchronized separately.

## Quick start

Declarative YAML is the recommended and Codex-generated default:

```bash
codex-dw validate examples/review.workflow.yaml
codex-dw run examples/review.workflow.yaml \
  --args-json '{"scopes":[{"id":"api","path":"src/api"}]}'
```

Inspect progress or resume a persisted run:

```bash
codex-dw status <run-id> --watch
codex-dw inspect <run-id>
codex-dw inspect <run-id> review/inspect.api
codex-dw resume <run-id>
```

Run the advanced TypeScript example explicitly:

```bash
codex-dw run examples/typescript-review.workflow.ts \
  --args-json '{"scopes":["src","test"]}'
```

There is no TypeScript trust prompt or hash allowlist. TypeScript is executed only after a direct `codex-dw run`/`resume` request or equivalent explicit user request—never because the skill loaded implicitly.

## Declarative format

A workflow declares metadata, an argument JSON Schema, optional runtime settings, ordered phases, and an optional result selector. Every agent requires a stable ID and output JSON Schema.

```yaml
apiVersion: codex.openai.com/v1alpha1
kind: Workflow
metadata:
  name: review
  description: Review two independent areas.
argsSchema:
  type: object
runtime:
  profile: small
phases:
  - id: checks
    type: parallel
    agents:
      - id: security
        prompt: Review authentication boundaries.
        outputSchema: { type: object }
      - id: tests
        prompt: Find material regression-test gaps.
        outputSchema: { type: object }
result: outputs.checks
```

Supported phase operations are `agent`, `parallel`, `pipeline`, and bounded `loop`. Phases are sequential. A `parallel` phase is a barrier; a `pipeline` streams each item through its stages without imposing a global stage barrier. Prompt placeholders such as `{{args.scope}}`, `{{item.path}}`, and `{{outputs.review}}` use safe dotted selectors.

See [runtime syntax](references/runtime.md) and [the complete example](examples/review.workflow.yaml).

## TypeScript surface

TypeScript workflow modules export named `meta` and `run` values:

```ts
import type { JsonValue, WorkflowContext, WorkflowMetadata } from "codex-dynamic-workflows";

export const meta: WorkflowMetadata = {
  name: "review",
  description: "Advanced executable coordinator",
  argsSchema: { type: "object" },
  profile: "small",
};

export async function run(context: WorkflowContext, args: JsonValue): Promise<JsonValue> {
  return context.phase("review", () =>
    context.agent("inspect", "Review the requested scope.", {
      input: args,
      outputSchema: { type: "object" },
    }),
  );
}
```

The coordinator is bundled and launched immediately in a separate Node process. Runtime imports are limited to static relative code files inside the workflow directory; package, data, dynamic, absolute, and escaping imports are rejected. Its environment omits OpenAI/Codex/cloud credentials; the parent runner validates the narrow IPC protocol and alone performs Codex calls. Filesystem write, child-process, worker, V8 heap, time, and network-interception controls reduce risk. These are defense in depth, not OS-level network isolation or a complete JavaScript security boundary. Prefer declarative workflows for untrusted or routine definitions.

## Mutation and Git safety

Mutating agents are rejected unless all of the following are true:

- The run was explicitly authorized with `--allow-mutation`.
- The active Git checkout is clean and on a branch.
- The agent declares non-empty ownership globs.
- The agent declares an independent read-only verifier.
- Changed paths remain inside ownership.
- The verifier returns `accepted: true`.

Each independent mutation unit receives a stable task branch and worktree. Pipeline stages for one item keep the same task worktree. Verified task commits are cherry-picked into `codex-dw/<run>/integration`; unrelated overlapping ownership or cherry-pick conflicts stop the run and preserve branches for recovery. The runner checks that the active user branch, HEAD, and Git working-tree status did not change.

Runner Git commands use a credential-free environment with system/global Git config ignored and hooks disabled. Mutation refuses repositories with executable Git filters, external diff/textconv commands, or merge drivers. The expected integration HEAD and original active branch/base are persisted; resume accepts only the expected tip or a byte-exact interrupted cherry-pick.

The integration branch is the terminal artifact. Merging it into the user's active branch is a separate user-controlled action. SDK workers and verifiers are bounded leaf calls: the adapter forbids nested `codex-dw` execution and unbudgeted subagent delegation, and marks them internally with `CODEX_DW_ACTIVE=1`.

Inside an interactive Codex session, a completed, failed, or stopped mutating run that integrated changes records an optional `codex-dw.review-artifact/v1` pointer in `state.json`. It identifies the parent session, repository, base and integration commits, branch, status, and stable artifact ID so a compatible read-only reviewer such as Claude Fusion can inspect the committed range even when the active checkout is clean. Resume clears stale pointers; read-only or unchanged runs and runs without a valid parent session publish none. The reviewer remains advisory and never merges the integration branch.

`codex-dw clean <run-id>` removes clean task worktrees, deletes integrated task branches, and preserves unintegrated task branches plus the integration branch. `--force` is required to remove unintegrated task branches or dirty task worktrees.

## Commands

| Command | Purpose |
| --- | --- |
| `validate <workflow>` | Validate YAML/JSON or bundle-check TypeScript without running it. |
| `run <workflow>` | Create and execute a persisted run. |
| `status [run-id]` | Show progress, call counts, token aggregation, and integration branch. |
| `inspect [run-id] [call-id]` | Print complete run state or one call record. |
| `resume <run-id>` | Reuse unchanged completed calls and restart interrupted/invalidated work. |
| `stop <run-id>` | Write a run-local cancellation request, including before detached startup. |
| `clean <run-id>` | Conservatively clean runner-owned Git worktrees and task branches. |

`run --detach` and `resume --detach` launch a background runner. Per-run heartbeat locks prevent concurrent execution and allow stale-run recovery without signaling persisted PIDs.

## Profiles and limits

| Profile | Concurrent calls | Total call budget |
| --- | ---: | ---: |
| `small` (default) | 4 | 25 |
| `medium` | 8 | 50 |
| `large` | 16 | 100 |

Verifier calls count against the total budget. Declarative runtime values may lower, but not exceed, their selected profile. Network access defaults off and must be explicitly enabled by the workflow.

## Workflow discovery

Direct paths are resolved first. Names such as `team/review` resolve, in order, from:

1. `<project>/.codex/dynamic-workflows/team/review.{yaml,yml,json,ts,mts,cts}`
2. `$CODEX_HOME/dynamic-workflows/workflows/team/review.{yaml,yml,json,ts,mts,cts}`

Run state is private to the local user (`0700` directories and `0600` state/event files where supported).

## Development and acceptance

```bash
npm run typecheck
npm test
npm run build
npm run check
```

The ordinary suite uses a fake Codex adapter and temporary Git repositories, so it needs no authentication or usage spend. The one-agent live SDK smoke is opt-in:

```bash
npm run test:live
```

`npm run check` also builds the CLI and exercises validation, detached completion, live status, inspection, resume, stop, and conservative cleanup end to end without making Codex calls. GitHub Actions runs the same acceptance gate on Node.js 20 and 22. The installed-skill consistency check remains local because hosted runners do not have the personal skill directory.

Additional skill validation uses `quick_validate.py` against both this repository and the installed skill copy, followed by byte-for-byte consistency checks.

## Skill layout

- [SKILL.md](SKILL.md) — invocation and orchestration policy.
- [runtime reference](references/runtime.md) — declarative grammar, TypeScript API, CLI, state, and Git behavior.
- [workflow patterns](references/workflow-patterns.md) — native and persisted runner recipes.
- [agent contracts](references/agent-contracts.md) — structured result and verifier contracts.
- [OpenAI invocation metadata](agents/openai.yaml) — skill UI and implicit invocation policy.

## License

[MIT](LICENSE)
