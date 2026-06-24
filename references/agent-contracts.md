# Agent Contracts

Copy and adapt these contracts when designing or running a workflow.

## Phase Table

Use this compact structure before execution:

| Phase | Purpose | Agents | Scope | Output | Stop Gate |
| --- | --- | --- | --- | --- | --- |
| Discovery | Map facts and risks | Main or explorers | Read-only | Inventory and uncertainties | Unknown blast radius |
| Coverage | Prove all items are assigned | Main | Item ledger | Covered/pending/skipped list | Unbounded or missing scope |
| Parallel work | Gather or change bounded slices | Explorers or workers | Disjoint scopes | Contracted results | Overlap or failing baseline |
| Cross-check | Challenge high-risk outputs | Main or checker | Evidence only | Confirmed/rejected items | Unsupported critical claim |
| Integration | Merge and decide | Main | Whole task | Final changes/report | Hard stop, unclear mutation request, or unsafe assumption |
| Verification | Prove acceptance | Main or verifier | Targeted checks | Pass/fail with evidence | Required check unavailable |

## Workflow Spec Fields

Use these fields when drafting a workflow:

- `Pattern`: classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, loop-until-done, or a combination.
- `Failure mode`: agentic laziness, self-preferential bias, goal drift, or a combination.
- `Coverage ledger`: every item, file, claim, rule, row, issue, or failure and its assigned status.
- `Agent runtime`: every spawned agent follows `SKILL.md` Subagent Runtime Policy. Copy the current explicit override values from that section when the spawn interface supports them, and report any fallback.
- `Budget`: token budget if provided, default maximum 4 total spawned agents per workflow including children, maximum rounds, timeout expectations, batching strategy, and small-slice calibration.
- `Delegation`: allowed or forbidden, maximum child depth, main-thread pre-allocated parent and child slots, inherited scope and permissions, and who synthesizes child outputs.
- `Barrier`: where the workflow must wait for all prior outputs before synthesis.
- `Stop condition`: exact condition that ends a loop or broad run.
- `Trust boundary`: which agents may read untrusted input, edit files, run commands, or access external tools.

## Nested Delegation Contract

Use this only when a workflow spec explicitly allows child subagents.

- Default total cap is 4 spawned agents including children unless the active prompt explicitly grants a larger cap.
- Parent and child agents inherit the workflow runtime policy from `SKILL.md`: highest available Codex model and Extra High reasoning, with the current explicit override values from that section when available.
- The main thread pre-allocates all parent and child slots before execution. A parent agent may use only its assigned child slots and may not expand the shared cap independently.
- Default maximum depth is one child layer. Deeper recursion requires an explicit request in the active prompt.
- Count every child against the total cap; for example, 2 parent agents plus 2 child agents uses all 4 slots.
- Child agents inherit the parent goal, non-goals, scope, permissions, output schema, and budget limits.
- Child scopes must be strict subsets of the parent scope. Child agents may not broaden file scope, tool access, network access, or write ownership.
- Mutating child agents require `mutating execution` mode clearly derived from the original request and disjoint ownership inside the parent ownership boundary.
- Parent agents synthesize child results and return the child prompts, scopes, evidence, checks, coverage impact, and unresolved risks.
- If the current runtime or tool rules do not permit child spawning, the parent returns a delegation request for the main orchestrator to run or chain.

## Explorer Prompt Template

```text
You are an explorer in a Codex dynamic workflow. Work read-only.

Task:
<specific question>

Scope:
<paths, diff range, docs, or sources>

Runtime:
Spawn with the workflow runtime policy from SKILL.md: highest available Codex model and Extra High reasoning. Include the current explicit override values from that policy when the spawn interface supports them, and report any fallback.

Delegation:
<autonomous bounded delegation is allowed only when the workflow spec allocates child slots; include max child depth, assigned child-slot count, inherited constraints, and when to return a delegation request>

Rules:
- Do not edit files.
- Do not duplicate other agents' scopes.
- Restate and preserve the original goal and constraints.
- Prefer source evidence over inference.
- Report uncertainty and skipped checks.

Return:
- Summary: 2-4 sentences.
- Findings: ordered list with evidence references.
- Risks or unknowns.
- Suggested next checks.
```

## Worker Prompt Template

```text
You are a worker in a Codex dynamic workflow. You are not alone in the codebase.

Task:
<specific implementation slice>

Ownership:
You may edit only <paths/modules/responsibility>. Do not revert or rewrite unrelated changes.

Runtime:
Spawn with the workflow runtime policy from SKILL.md: highest available Codex model and Extra High reasoning. Include the current explicit override values from that policy when the spawn interface supports them, and report any fallback.

Delegation:
<autonomous bounded delegation is allowed only when the workflow spec allocates child slots; include max child depth, assigned child-slot count, inherited constraints, and child write scopes inside your ownership>

Context:
<relevant decisions, interfaces, and constraints>

Rules:
- Keep changes narrow and compatible with other workers.
- Preserve user changes.
- Restate and preserve the original goal, constraints, and non-goals.
- Run the smallest relevant checks available in your scope.
- List every file changed.

Return:
- Files changed.
- Behavior changed.
- Checks run and results.
- Remaining risks or integration notes.
```

## Cross-Check Prompt Template

```text
Review these proposed findings or changes as a checker.

Input:
<findings, patch summary, or plan>

Scope:
<source paths or evidence>

Rules:
- Verify each material claim against source evidence.
- Reject duplicates, unsupported claims, and severity inflation.
- Look for missing tests or hidden regressions.

Return:
- Confirmed items.
- Rejected or downgraded items, with reasons.
- New high-confidence concerns.
- Checks that would decide unresolved questions.
```

## Refuter Prompt Template

```text
You are a refuter in a Codex dynamic workflow. Work read-only.

Input:
<claim, finding, hypothesis, patch summary, or candidate answer>

Rubric:
<acceptance criteria>

Rules:
- Try to disprove the input against source evidence.
- Do not rely on the producer's confidence or reasoning trail.
- Reject unsupported claims, missing coverage, weak evidence, and severity inflation.
- If the input survives, explain why the evidence is sufficient.

Return:
- Survived: yes | no | unresolved
- Refutation attempts.
- Evidence checked.
- Missing evidence or decisive next check.
```

## Result Schema

Ask agents to return this shape when consistency matters:

```markdown
## Summary
<short synthesis>

## Evidence
- <file/source/check>: <what it proves>

## Findings Or Changes
- Severity/Status: <item>
  Evidence: <reference>
  Reasoning: <brief causal logic>
  Suggested action: <next step>

## Delegated Work
- Child prompt/scope: <what was delegated, or none>
- Child evidence/checks: <what returned, or none>
- Coverage impact: <items covered or still pending>
- Unresolved risks: <risks passed back to parent/main>

## Checks
- Run: <command or review step>
- Result: <pass/fail/skipped and why>

## Open Questions
- <question or none>
```

## Synthesis Checklist

- Deduplicate overlapping agent results.
- Compare all outputs against the coverage ledger.
- Preserve minority findings when the evidence is stronger.
- Separate confirmed facts from hypotheses.
- Tie every high-severity claim to source evidence.
- State skipped checks and why they were skipped.
- Flatten delegated child outputs into the coverage ledger before final ranking.
- Confirm each spawned agent used the highest available model and Extra High reasoning, or report the exact runtime limitation and strongest fallback used.
- Confirm the main-thread pre-allocated parent and child slots were not exceeded.
- Report budget, agent cap, round cap, delegation depth, or stop-condition limits that affected coverage.
- Decide the next action: stop, ask, implement, verify, or save as a runbook.
- Close completed subagent threads after extracting their useful output.

## Save-For-Reuse Runbook

When the user asks to save a workflow for reuse, create a Markdown artifact that acts as an adaptable template:

- Workflow name and goal.
- Inputs the user must provide.
- Pattern and failure mode.
- Coverage ledger format.
- Budget, agent cap, round cap, and stop condition.
- Phase table.
- Agent prompts.
- Result schema.
- Stop gates.
- Verification commands.
- Notes on Codex limitations and permissions.

Treat saved runbooks as templates to adapt to the current task, not fixed scripts to replay blindly. Do not present the runbook as a Claude workflow script, Claude saved workflow, Codex slash command, or resumable runtime unless the user separately asks to build that packaging.
