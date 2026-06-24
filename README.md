# Dynamic Workflows (Codex skill)

A [Codex](https://github.com/openai/codex) skill that turns large or high-risk work into a
Codex-native multi-agent workflow: a bounded phase plan, concrete subagent prompts, result contracts,
cross-check steps, and a final synthesis path.

It mimics the useful *shape* of Claude Code dynamic workflows without claiming Claude-only runtime
features (a background JavaScript workflow runtime, a `/workflows` UI, resumable script variables, or
`/deep-research`). It is the Codex-native counterpart of the Claude Code `dynamic-workflows` skill.

## When it loads

- Use it when the task shape calls for workflow structure - broad audits, migrations, review-and-fix
  passes, adversarial verification, cross-checked research, parallel-agent work, or phased verification.
- Skip it for routine single-threaded work where direct execution is enough.
- Treat implicit loading as a standing preference for autonomous, bounded workflow orchestration,
  not as standalone permission to mutate files.
- Codex chooses design-only, read-only execution, or mutating execution from the actual request: review-only
  prompts stay read-only, while clear mutating prompts may continue only when the workflow was explicitly
  invoked or the user confirms mutation after implicit loading.

Invoke explicitly with `$dynamic-workflows` (or ask for "ultracode" / "a workflow"), or let it load
implicitly when a task is workflow-shaped. The default cap is 4 total spawned agents, including child
agents and later-phase agents, with all child slots pre-allocated by the main thread. Larger recipes
fit this cap through batching and main-thread discovery, integration, and verification unless the user
explicitly grants more agents.

## Subagent runtime policy

Workflow subagents should spawn on the highest available Codex model with Extra High reasoning. As
of 2026-06-24, the current explicit spawn overrides are `model: "gpt-5.5"` and
`reasoning_effort: "xhigh"` when the runtime exposes those fields. Treat the model id as a dated
catalog value and use the highest available successor if the catalog changes. Cost and latency should
be managed by reducing scope, agent count, or rounds rather than routing workflow subagents to cheaper
or faster models, unless the user explicitly asks for that tradeoff.

This policy lives in the skill instructions and agent prompt contracts. `agents/openai.yaml` remains
limited to supported skill UI, invocation policy, and dependency metadata; it does not configure
subagent model or reasoning settings.

## Planning contract

Every workflow produces an explicit spec before execution: `Goal`, `Mode` (design-only / read-only /
mutating), `Pattern`, `Failure mode`, `Phases`, `Agent prompts`, `Agent runtime`, `Coverage` ledger,
`Ownership`, `Budget`, `Delegation` rules, `Synthesis`, and `Acceptance`. Coverage is tracked explicitly so broad
workflows cannot silently skip files, claims, rows, or checklist items. Hard stops remain for unclear
mutation requests, destructive or irreversible work, secrets, unrequested production impact, overlapping
mutation, unclear ownership, budget overruns, and runtime permission limits. See [`SKILL.md`](SKILL.md)
for the core loop and guardrails.

## Layout

- [`SKILL.md`](SKILL.md) - the skill definition: invocation policy, core loop, planning contract, guardrails.
- [`agents/openai.yaml`](agents/openai.yaml) - display name and implicit-invocation policy.
- [`references/workflow-patterns.md`](references/workflow-patterns.md) - recipes for audits, migrations, research, plan review, verification.
- [`references/agent-contracts.md`](references/agent-contracts.md) - result schemas, agent prompt templates, synthesis checklists, stop gates.

## Install

Place this directory where your Codex install discovers skills (identified by [`SKILL.md`](SKILL.md)).

## License

[MIT](LICENSE)
