# Workflow Patterns

Use these recipes as starting points. Adjust scope, agent count, and stop gates to the user's task.

## Primitive Patterns

Use these named patterns directly when they fit. Combine them for complex workflows.

### Classify-And-Act

Use when items need routing before work begins: issues, tickets, files, failures, tasks, or documents.

Shape:

1. Classifier agent assigns each item a type, risk, owner, verification depth, or action.
2. Main agent checks the classification rubric and spot-checks edge cases.
3. Specialist agents handle each class with class-specific prompts.
4. Main agent synthesizes by class and reports unresolved or low-confidence classifications.

Good for:

- Triage, role routing, support queues, issue queues, mixed test failures.
- Choosing agent count, scope, and verification depth. This skill still launches workflow subagents on the highest available model with Extra High reasoning unless the user explicitly requests a cheaper or faster tradeoff.

### Fan-Out-And-Synthesize

Use when many independent items need the same operation.

Shape:

1. Main agent builds a complete coverage ledger.
2. One agent handles each item or bounded batch.
3. A synthesis barrier waits for all required outputs.
4. Main agent deduplicates, ranks, and verifies final results.

Good for:

- Codebase audits, many-file reviews, source gathering, checklist sweeps.

Guardrail:

- The synthesis step must compare against the coverage ledger so no item silently falls through.
- Do not expand coverage by downgrading subagent model or reasoning effort. Batch work, reduce agent count, or report remaining coverage instead.
- Nested delegation is allowed only as a bounded way to split discovered sub-batches. It must preserve the parent scope, stay inside the main-thread pre-allocated parent and child slots, and never create an open-ended swarm.
- If the coverage ledger outgrows the default 4-agent cap, batch items conservatively and report remaining coverage instead of silently exceeding the cap. Treat the cap as total spawned agents for the workflow unless the user explicitly grants more.

### Adversarial Verification

Use when self-grading would be risky.

Shape:

1. Producer agent or the main thread creates a finding, patch, claim, plan, or candidate answer.
2. Separate verifier or refuter agent receives the result, rubric, and source scope without the producer's reasoning trail.
3. Main agent accepts only items that survive verification or clearly marks unresolved ones.

Under the default 4-agent cap, run this as a small batch: use the main thread as producer when practical, or allocate one producer and one verifier for the highest-risk batch instead of spawning producer/verifier pairs per item.

Good for:

- Security findings, factual claims, root-cause hypotheses, patch review, plan review.

### Generate-And-Filter

Use when the first pass should be intentionally broad.

Shape:

1. Generator agents produce many candidate ideas, fixes, names, test cases, attacks, or refactors.
2. Filter agents apply a rubric, remove duplicates, and reject weak candidates.
3. Main agent returns only the strongest survivors with rationale.

Good for:

- Brainstorming, attack-surface discovery, design alternatives, refactor candidates.

### Tournament

Use when quality is easier to compare than score absolutely.

Shape:

1. Several agents attempt the same task with different approaches.
2. Judge agents compare candidates pairwise against a rubric.
3. Main agent selects the winner or ranked shortlist and explains tradeoffs.

Good for:

- Architecture options, naming, UX copy, ranking, hard planning choices.

### Loop-Until-Done

Use when the amount of work is unknown.

Shape:

1. Run a bounded discovery or fix round.
2. Synthesize what changed or what was found.
3. Continue until a stop condition is met.
4. Stop only after the configured condition, not because the conversation feels long.

Good stop conditions:

- No new findings for two rounds.
- All known failing tests pass.
- Coverage ledger is complete.
- Budget or agent cap is reached and remaining work is reported.

## Codebase Audit

Use for branch reviews, security sweeps, auth checks, dependency risks, or architecture audits.

Default phases:

1. Scope discovery: main agent identifies target diff, directories, behavior, and coverage ledger.
2. Parallel review: spawn read-only agents by risk category or subsystem.
3. Cross-check: one agent or the main thread challenges high-severity findings against source evidence.
4. Synthesis: rank confirmed findings by severity with file references and test gaps.

Under the default 4-agent cap, fit the common security/correctness/test/maintainability split by using the main thread for cross-check, or batch fewer review categories and report the remaining ledger. Do not spawn a fifth checker unless the user explicitly expands the cap.

Bootstrap from actual repo evidence. Inspect local guidance, branch state, and scope documents when they exist, but do not assume a particular project has handoff files, phase docs, or branch rituals.

Good splits:

- Security, correctness, test coverage, maintainability.
- API layer, data layer, frontend boundary, deployment/config.
- One agent per package or service when boundaries are clean.

Avoid:

- Asking every agent to review everything.
- Treating duplicate findings as stronger evidence.
- Reporting issues without file paths, line references, or reproduction logic when the repo can provide them.

## Large Migration

Use for broad refactors, framework upgrades, API migration, naming changes, or multi-package mechanical edits.

Default phases:

1. Inventory: map all affected call sites, generated files, config, tests, and docs. Prefer the main thread for inventory when the write budget is tight.
2. Slice design: group work by disjoint ownership boundaries.
3. Pilot: run one small slice first and verify the strategy.
4. Parallel implementation: spawn workers only for disjoint write sets.
5. Adversarial verification: separate reviewers or the main thread challenge representative patches or risky slices before integration.
6. Integration: main agent reviews conflicts, runs shared formatting/tests, and resolves seams.
7. Verification: run targeted checks, then broader regression checks.

Under the default 4-agent cap, treat inventory, integration, and final verification as main-thread work unless the user grants a larger cap. Use at most one pilot worker, two implementation workers, and one verifier, or a smaller batch when ownership is not clean.

Good splits:

- Package/module ownership.
- Client/server boundaries.
- Tests/docs/tooling separated from runtime code.

Stop gates:

- After inventory when blast radius is larger than expected.
- After pilot if the pattern causes incompatible public API changes.
- Before broad writes when tests are failing at baseline.

## Cross-Checked Research

Use for research questions that need independent source gathering, claim verification, or competing interpretations.

Default phases:

1. Question decomposition: split by angle, geography, timeframe, stakeholder, or source type.
2. Source gathering: agents collect sources independently and summarize claims.
3. Claim ledger: main agent deduplicates claims and tags source support.
4. Challenge pass: separate verifier agents test weak claims against primary sources.
5. Report: present only supported claims, caveats, dates, and links.

Good splits:

- Primary sources, technical analysis, market/user evidence, opposing evidence.
- One agent per subquestion when the subquestions do not depend on each other.

Avoid:

- Long quotes. Prefer concise paraphrase and links.
- Current factual claims without fresh verification.

## Adversarial Plan Review

Use before high-impact implementation, ambiguous product decisions, or risky architecture changes.

Default phases:

1. Main agent drafts a candidate plan.
2. Agents critique from distinct perspectives: correctness, UX/product, operational risk, testability.
3. Main agent resolves conflicts and revises the plan.
4. Optional final checker verifies the revised plan against constraints.

Good outputs:

- "Keep", "change", and "defer" decisions.
- Explicit assumptions.
- Acceptance criteria that would catch the highest-risk mistakes.

## Verification And Log Triage

Use for failing CI, flaky tests, production logs, performance regressions, or multi-signal debugging.

Default phases:

1. Main agent establishes the failing command, expected behavior, and recent change scope.
2. Agents split by evidence source: logs, tests, recent diff, environment/config.
3. Hypothesis agents propose causes from disjoint evidence.
4. Refuter agents challenge the strongest hypotheses.
5. Main agent builds a ranked cause tree.
6. Optional worker applies a narrow fix if ownership is clear.
7. Main agent reruns the smallest decisive check, then broader checks.

Avoid:

- Multiple agents rerunning the same expensive failing command.
- Fixing several plausible causes at once.
- Treating sandbox or permission failures as product failures without evidence.
