---
name: dynamic-workflows
description: "Design and run Codex-native dynamic workflow patterns for large tasks. Use when the user invokes $dynamic-workflows or asks for a workflow, workflows, dynamic workflow, subagent workflow, parallel agents, large migration, multi-agent audit, cross-checked research, adversarial plan review, or phased verification workflow."
---

# Dynamic Workflows

Turn large or high-risk work into a Codex-native multi-agent workflow: a bounded phase plan, concrete subagent prompts, result contracts, cross-check steps, and a final synthesis path. This skill mimics the useful shape of Claude Code dynamic workflows without claiming Claude-only runtime features such as a background JavaScript workflow runtime, `/workflows` UI, resumable script variables, or `/deep-research`.

## Core Loop

1. Identify which failure mode the workflow must defeat: agentic laziness, self-preferential bias, goal drift, or a combination.
2. Classify the orchestration pattern: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, loop-until-done, or a domain recipe built from those patterns.
3. Decide whether the user asked to design a workflow or run one. If they only asked to design, output the workflow spec without spawning agents.
4. Before spawning agents, confirm the prompt explicitly authorizes subagents, delegation, or parallel agent work. Treat explicit `$dynamic-workflows` invocation as authorization to plan; actual agent spawning still follows the current Codex subagent rules.
5. Draft a short workflow spec with phases, agent count, read/write ownership, stop gates, expected outputs, and synthesis rules.
6. Start with a small slice when cost, runtime, blast radius, or permissions are uncertain.
7. Spawn only bounded agents with non-overlapping work. Prefer `explorer` agents for read-heavy audits and `worker` agents only when write ownership is disjoint and explicit.
8. Keep integration, user-facing decisions, and final judgment in the main thread.
9. Cross-check findings before reporting. Prefer evidence-backed findings over consensus by volume.
10. Close completed agent threads when their outputs have been integrated.

## Planning Contract

For every workflow, produce these fields before execution:

- `Goal`: the concrete outcome.
- `Mode`: design-only, read-only execution, or mutating execution.
- `Pattern`: the named orchestration pattern or combination.
- `Failure mode`: the context-window failure being addressed and the structural defense.
- `Phases`: ordered phases with purpose, agent roles, barriers, and stop gates.
- `Agent prompts`: self-contained prompts with input scope and output schema.
- `Coverage`: the ledger that proves every item, claim, file, or rule was handled.
- `Ownership`: read/write paths or responsibility boundaries for each agent.
- `Budget`: token/time/agent cap, small-slice calibration, and when to stop early.
- `Synthesis`: how to merge, deduplicate, verify, and rank results.
- `Acceptance`: tests, checks, or human review needed before completion.

If the task is ambiguous or potentially expensive, ask for the smallest missing decision. Otherwise choose conservative defaults and proceed.

## Guardrails

- Do not invent a persistent workflow runtime. Save reusable workflow artifacts as Markdown runbooks only when the user asks.
- Do not spawn agents for routine single-threaded work.
- Do not run parallel mutating agents on overlapping files or shared state.
- Do not let agents make final product decisions independently; agents return evidence and proposals.
- Do not import project-specific protocols, file names, branch rituals, or handoff conventions unless the prompt or discovered repo context establishes them.
- Restate the original goal and constraints in each agent prompt to reduce goal drift.
- Use separate verifier or refuter agents for material claims, findings, candidates, or patches when self-preferential bias is a risk.
- Track coverage explicitly so broad workflows cannot silently skip files, claims, rows, issues, rules, or checklist items.
- Do not hide uncertainty. Mark conflicts, unsupported claims, skipped checks, and assumptions in the synthesis.
- Ask for sign-off between read-only discovery and mutating implementation when the request does not already authorize edits.
- Keep raw logs, noisy exploration, and speculative trails out of the final synthesis unless they are needed as evidence.

## Reference Map

Read only the relevant reference:

- `references/workflow-patterns.md`: choose a workflow recipe for audits, migrations, research, plan review, or verification.
- `references/agent-contracts.md`: copy result schemas, agent prompt templates, synthesis checklists, and stop gates.
