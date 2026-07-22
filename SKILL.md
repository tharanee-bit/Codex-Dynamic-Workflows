---
name: dynamic-workflows
description: "Use for bounded native Codex multi-agent orchestration when a task has at least two independent workstreams or independent verification would materially improve confidence: broad or high-risk multi-step work, audits, migrations, multi-area review-and-fix, adversarial verification, cross-checked research, or explicit $dynamic-workflows, ultracode, workflow, subagent, or parallel-agent requests. Skip routine single-threaded tasks. Use the persisted codex-dw YAML/JSON/TypeScript runtime only after a direct run request; implicit loading never grants mutation, expanded budgets, network access, deployment, or production authority."
---

# Dynamic Workflows

Use workflow structure when it materially improves coverage, independence, verification, or resumability. Skip routine single-threaded tasks.

## Choose The Surface

1. **Native orchestration**: coordinate Codex subagents in the current conversation. Use for one-off work, repo-native collaboration, and tasks that do not need persisted workflow state.
2. **`codex-dw` runtime**: validate or execute a saved YAML/JSON/TypeScript workflow with persistent state. Use only after a direct workflow/run request or manual CLI invocation.

Do not imply that `codex-dw` is a native `/workflows` command or exact Claude Code parity.

## Invocation And Authority

- Load implicitly for broad or risky workflow-shaped tasks, but do not execute saved workflows or mutate files from implicit activation alone.
- An explicit `$dynamic-workflows`, `ultracode`, workflow, or run request authorizes bounded orchestration within the actual requested mode; it does not broaden file scope, budgets, network, deployment, or other effects.
- Review, audit, explain, or report requests remain read-only.
- Native mutation requires a clear implement/fix/edit request and current Codex permissions. If loading was implicit, confirm before the first mutation.
- Runtime mutation requires a direct run request plus `--allow-mutation`, a clean Git base, declared ownership, and independent verification.
- Never run TypeScript merely because this skill loaded. TypeScript has no trust prompt by user choice, so explicit execution is a hard boundary.

## Native Orchestration Loop

1. State the goal, mode, pattern, failure mode, coverage ledger, ownership, budget, stop gates, synthesis rule, and acceptance checks.
2. Prefer the smallest useful pattern: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, pipeline, or bounded loop.
3. Use bounded agents with non-overlapping responsibilities. Keep integration and final decisions in the main thread.
4. Default to four active agents unless the user or runtime grants a different bounded profile. Count delegated child work against the declared budget.
5. Preserve independence: a material producer result should be checked by a separate verifier or direct evidence review.
6. Track every item as covered, pending, skipped, or blocked. Never infer completeness from agent count.
7. Stop on unclear mutation authority, overlapping writes, secrets, destructive scope, production effects, budget exhaustion, or runtime permission limits.
8. Synthesize evidence, conflicts, skipped checks, and the actual terminal artifact. Close completed agents after integration.

For native subagents, inherit the configured Codex model rather than pinning a dated model identifier. Request `xhigh` reasoning where the active runtime supports it. Reduce scope, concurrency, or rounds before weakening verification quality unless the user requests a cost/latency tradeoff.

## `codex-dw` Runtime Policy

- Generate declarative YAML by default. Use TypeScript only when executable coordination logic is genuinely useful.
- Validate before execution. Require stable operation IDs and JSON Schema outputs.
- Default to the small profile: four concurrent calls and 25 total worker/verifier calls. Medium is 8/50; large is 16/100. Never exceed 16 concurrent or 100 total calls.
- Network defaults off. Inherit the configured Codex model and default to `xhigh` reasoning where supported.
- Treat every SDK worker and verifier as one bounded leaf call. It must not launch `codex-dw`, invoke another dynamic workflow, or delegate to unbudgeted subagents; express fan-out and retries in the parent workflow.
- Persist state under `$CODEX_HOME/dynamic-workflows/runs/<run-id>` and use call hashes to reuse only unchanged completed calls.
- On resume, restart interrupted/failed calls and invalidate downstream calls when rendered prompts or inputs change.
- Treat TypeScript subprocess controls as defense in depth, not a complete JavaScript sandbox. Do not execute untrusted TypeScript.
- For mutation, isolate each independent unit in a Git worktree; keep an item's pipeline stages in that worktree; reject ownership violations; verify read-only; integrate verified commits into the runner branch; preserve recovery branches on conflict.
- The integration branch is the output. Merging it into the active user branch remains a separate user-controlled action.
- In an interactive Codex session, a terminal mutating run with integrated changes publishes a `codex-dw.review-artifact/v1` Git-range pointer in run state for an optional read-only final review. This does not merge or modify the integration branch.
- Cleanup is conservative. Do not force-remove unintegrated task branches or dirty runner worktrees without explicit `--force` authority.

## Hard Stops

- Unclear authority for mutation or executable TypeScript.
- Destructive, irreversible, secret-bearing, production, or external side effects not directly requested.
- Overlapping mutation ownership, dirty Git base, detached HEAD, verifier rejection, integration conflict, or active-checkout drift.
- Unbounded loops, delegation, agent counts, or retry behavior.
- Missing required evidence, structured-output contract, or acceptance check.
- Runtime sandbox, approval, connector, network, or tool limitations.

## Reference Map

Read only what the task needs:

- `references/runtime.md` — `codex-dw` schema, operations, TypeScript API, CLI, resume, Git, and containment.
- `references/workflow-patterns.md` — native and persistent workflow recipes.
- `references/agent-contracts.md` — prompt, result, verifier, ownership, and synthesis contracts.
