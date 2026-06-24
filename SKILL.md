---
name: dynamic-workflows
description: "Autonomously design and run bounded Codex-native dynamic workflow patterns when task shape calls for them: large or high-risk work, multi-step execution, broad audits, migrations, review-and-fix passes, adversarial verification, cross-checked research, parallel-agent work, or phased verification. Treat this as standing preference for conservative workflow orchestration; implicit loading does not authorize mutation without confirmation. Skip routine single-threaded work. Also use when invoked as $dynamic-workflows or when the user asks for ultracode, workflow, workflows, dynamic workflow, or subagent workflow."
---

# Dynamic Workflows

Turn large or high-risk work into a Codex-native multi-agent workflow: a bounded phase plan, concrete subagent prompts, result contracts, cross-check steps, and a final synthesis path. This skill mimics the useful shape of Claude Code dynamic workflows without claiming Claude-only runtime features such as a background JavaScript workflow runtime, `/workflows` UI, resumable script variables, or `/deep-research`.

## Invocation Policy

- Load this skill when the task shape calls for dynamic workflow structure, even if the user does not mention the skill by name.
- Skip it for routine single-threaded work where normal direct execution is enough.
- Treat an implicit or explicit trigger as the user's standing preference for autonomous bounded workflow orchestration, not as standalone permission to mutate files.
- Choose `design-only`, `read-only execution`, or `mutating execution` from the user's actual request. Review-only or audit-only prompts stay read-only. Mutating execution requires the active prompt to clearly ask for workspace changes, such as fix, implement, edit, update, refactor, migrate, deploy, or handling an identified issue.
- When this skill is loaded implicitly rather than explicitly invoked, stop before the first workspace mutation and ask for confirmation, even when the active prompt contains mutating verbs. Implicit loading may plan, explore, and verify; it does not silently authorize edits.
- Subagents, tool use, and file edits still follow current Codex runtime, tool, permission, and user-request rules.

## Subagent Runtime Policy

- Spawn every workflow subagent on the highest available Codex model with Extra High reasoning.
- As of 2026-06-24, the current explicit spawn overrides are `model: "gpt-5.5"` and `reasoning_effort: "xhigh"`. Treat that model id as a dated current-catalog value, not a permanent constant.
- If the spawn interface or model catalog changes, use the highest available successor or closest stronger model, keep Extra High reasoning when supported, and report the exact fallback used.
- Do not route workflow subagents to cheaper or faster models unless the user explicitly asks for that downgrade. Manage cost and latency by reducing scope, agent count, or rounds first.

## Core Loop

1. Identify which failure mode the workflow must defeat: agentic laziness, self-preferential bias, goal drift, or a combination.
2. Classify the orchestration pattern: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, loop-until-done, or a domain recipe built from those patterns.
3. Decide whether the user asked to design a workflow or run one. If they only asked to design, output the workflow spec without spawning agents.
4. Treat either an implicit workflow-shaped need or explicit `$dynamic-workflows`/`ultracode` invocation as standing preference to run a bounded workflow autonomously, subject to current Codex subagent, tool, permission, and runtime rules. Do not let the workflow trigger itself upgrade a read-only or unclear request into mutating execution.
5. Draft a short workflow spec with mode, phases, agent count, subagent runtime policy, read/write ownership, delegation policy, stop gates, expected outputs, and synthesis rules.
6. Default to at most 4 total spawned agents per workflow, including child agents and agents used across later phases. The main thread pre-allocates all parent and child slots before execution, such as 2 parent agents plus 2 child slots.
7. Start with a small slice when cost, runtime, blast radius, or permissions are uncertain.
8. Spawn only bounded agents with non-overlapping work. Prefer `explorer` agents for read-heavy audits and `worker` agents only when write ownership is disjoint and the request's mode permits mutation.
9. Allow one child layer by default when it improves coverage and the workflow spec pre-allocates slots. Deeper recursion requires an explicit request in the active prompt.
10. Keep integration, user-facing decisions, and final judgment in the main thread.
11. Cross-check findings before reporting or fixing. Prefer evidence-backed findings over consensus by volume.
12. Close completed agent threads and descendants when their outputs have been integrated.

## Planning Contract

For every workflow, produce these fields before execution:

- `Goal`: the concrete outcome.
- `Mode`: design-only, read-only execution, or mutating execution.
- `Pattern`: the named orchestration pattern or combination.
- `Failure mode`: the context-window failure being addressed and the structural defense.
- `Phases`: ordered phases with purpose, agent roles, barriers, and stop gates.
- `Agent prompts`: self-contained prompts with input scope and output schema.
- `Agent runtime`: all spawned agents follow the Subagent Runtime Policy above; include the current explicit override values from that section when the spawn interface supports them.
- `Coverage`: the ledger that proves every item, claim, file, or rule was handled.
- `Ownership`: read/write paths or responsibility boundaries for each agent.
- `Budget`: token/time/agent cap, default maximum 4 total spawned agents including children, small-slice calibration, and when to stop early.
- `Delegation`: allowed or forbidden, max depth, main-thread pre-allocated parent and child slots, inherited scope/permissions, and parent synthesis responsibility.
- `Synthesis`: how to merge, deduplicate, verify, and rank results.
- `Acceptance`: tests, checks, or human review needed before completion.

If the task is ambiguous or potentially expensive, choose conservative defaults, record assumptions, and proceed. Ask only when a hard stop applies or no safe default exists.

## Autonomy Policy

- Proceed with conservative defaults for large, risky, multi-step, broad, review-and-fix, migration, adversarial, cross-check, parallel-agent, or verification-heavy tasks.
- Treat the selected mode as coming from the original request, not from a separate workflow sign-off. Review/audit/find-only requests remain read-only. Clear fix/implement/edit/update/refactor/migrate/deploy/handle-an-identified-issue requests may continue from verified findings into safe requested changes only when the workflow was explicitly invoked or the user confirms mutation after implicit loading.
- Record assumptions, skipped coverage, budget limits, and why each agent split was chosen.
- Fit broad recipes under the default cap by using the main thread for discovery, integration, and some verification; batching items; and reusing the main thread as producer or checker when that preserves independence. If the cap is reached, report remaining coverage instead of silently spawning extra agents.
- Manage cost and latency by reducing scope, agent count, or rounds rather than lowering subagent model or reasoning effort. Use lower-cost or faster subagents only when the user explicitly requests that tradeoff.
- If the active prompt does not clearly ask for workspace changes, stop after read-only synthesis and ask before the first mutation.
- Never claim the skill overrides Codex sandboxing, approvals, connector authorization, or runtime tool limits.

## Hard Stops

- Stop before destructive, irreversible, or broad data-loss actions unless the active prompt explicitly requests them and current permissions allow them.
- Stop before ordinary workspace mutation when the active prompt does not clearly ask for code, docs, config, or other file changes.
- Stop before reading, exposing, or moving secrets, credentials, tokens, private keys, or unrelated sensitive files.
- Stop before production-impacting actions unless deployment, production work, or external side effects are requested in the active prompt.
- Stop before parallel mutating work when ownership is overlapping, unclear, or shared state cannot be protected.
- Stop before exceeding the default 4-agent cap, the pre-allocated child budget, one child layer, or the user's explicit budget.
- Stop before the first workspace mutation when the workflow was triggered implicitly and the user has not confirmed mutation.
- Stop before silently spawning a lower-model or lower-reasoning subagent when the requested highest-model policy cannot be honored; report the limitation and the strongest available fallback.
- Stop when Codex runtime, sandbox, approval, network, connector, or tool rules do not permit the planned action.

## Guardrails

- Do not invent a persistent workflow runtime. Save reusable workflow artifacts as Markdown runbooks only when the user asks.
- Do not spawn agents for routine single-threaded work.
- Do not run parallel mutating agents on overlapping files or shared state.
- Do not allow unbounded nested delegation. Child agents must inherit the parent goal, non-goals, scope, permissions, output schema, and budget limits.
- Do not let child agents broaden file scope, tool access, network access, or write ownership. Mutating child agents require `mutating execution` mode clearly derived from the original request and a strict subset of the parent's ownership.
- Do not let agents make final product decisions independently; agents return evidence and proposals.
- Do not import project-specific protocols, file names, branch rituals, or handoff conventions unless the prompt or discovered repo context establishes them.
- Restate the original goal and constraints in each agent prompt to reduce goal drift.
- Use separate verifier or refuter agents for material claims, findings, candidates, or patches when self-preferential bias is a risk.
- Track coverage explicitly so broad workflows cannot silently skip files, claims, rows, issues, rules, or checklist items.
- Do not hide uncertainty. Mark conflicts, unsupported claims, skipped checks, and assumptions in the synthesis.
- Keep raw logs, noisy exploration, and speculative trails out of the final synthesis unless they are needed as evidence.

## Reference Map

Read only the relevant reference:

- `references/workflow-patterns.md`: choose a workflow recipe for audits, migrations, research, plan review, or verification.
- `references/agent-contracts.md`: copy result schemas, agent prompt templates, synthesis checklists, and stop gates.
