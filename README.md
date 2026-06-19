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
- Planning can be implicit, but spawning subagents or doing mutating work still follows Codex tool,
  permission, and user-request rules.

Invoke explicitly with `$dynamic-workflows` (or ask for "ultracode" / "a workflow"), or let it load
implicitly when a task is workflow-shaped.

## Planning contract

Every workflow produces an explicit spec before execution: `Goal`, `Mode` (design-only / read-only /
mutating), `Pattern`, `Failure mode`, `Phases`, `Agent prompts`, `Coverage` ledger, `Ownership`,
`Budget`, `Delegation` rules, `Synthesis`, and `Acceptance`. Coverage is tracked explicitly so broad
workflows cannot silently skip files, claims, rows, or checklist items. See [`SKILL.md`](SKILL.md) for
the core loop and guardrails.

## Layout

- [`SKILL.md`](SKILL.md) - the skill definition: invocation policy, core loop, planning contract, guardrails.
- [`agents/openai.yaml`](agents/openai.yaml) - display name and implicit-invocation policy.
- [`references/workflow-patterns.md`](references/workflow-patterns.md) - recipes for audits, migrations, research, plan review, verification.
- [`references/agent-contracts.md`](references/agent-contracts.md) - result schemas, agent prompt templates, synthesis checklists, stop gates.

## Install

Place this directory where your Codex install discovers skills (identified by [`SKILL.md`](SKILL.md)).

## License

[MIT](LICENSE)
