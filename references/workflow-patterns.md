# Workflow Patterns

Choose native orchestration for one-off conversation work. Choose `codex-dw` when the user directly requests a saved/run workflow and persistent progress, selective resume, or reusable syntax materially helps. Declarative YAML/JSON is the default persisted format; TypeScript is advanced executable coordination.

## Pattern Mapping

| Pattern | Native shape | Declarative runtime shape |
| --- | --- | --- |
| Classify and act | Explorer classifies; specialists handle bounded classes | Sequential classifier `agent`, then `pipeline` selected items |
| Fan out and synthesize | Bounded explorers plus main-thread barrier/synthesis | `parallel` for fixed branches or `pipeline` for item lists, then synthesis `agent` |
| Adversarial verification | Producer plus independent checker | Mutating `agent` with required `verification`, or sequential producer/checker agents |
| Generate and filter | Generators, filter, main decision | `parallel` generators then filter `agent` |
| Tournament | Independent candidates plus judge | `parallel` candidates then judge `agent` |
| Loop until done | Bounded rounds with explicit stop gate | `loop` with `maxIterations` and boolean result selector |
| Per-item migration | Disjoint native workers | `pipeline`; each item streams stages and keeps one mutation worktree |

## Parallel Versus Pipeline

Use `parallel` when all branches are known in the workflow and the next phase must wait for all of them. It is a completion barrier.

Use `pipeline` for a list of items that each pass through the same stages. Item A may begin stage 2 while item B is still in stage 1; there is no global barrier between stages. The phase ends only after every item finishes all stages.

For mutation, an item's stages share a stable task branch/worktree. Different items are independent mutation units and must own disjoint paths.

## Codebase Audit

Goal: complete, evidence-backed findings without duplicate review.

1. Build a coverage ledger from repository truth.
2. Split by subsystem or risk category.
3. Run read-only reviewers with structured findings.
4. Challenge high-severity findings against source evidence.
5. Synthesize, deduplicate, rank, and list skipped coverage.

Native: use a small bounded set of read-only agents and keep cross-check/synthesis in the main thread.

Runtime: use a pipeline over `{id,path}` scopes when the list is data-driven, or parallel agents for a fixed security/correctness/tests split. Add a final synthesis phase. See `examples/review.workflow.yaml`.

Avoid asking every agent to review the entire repository or treating duplicate findings as stronger evidence.

## Large Migration

Goal: make broad changes while preserving ownership and recoverability.

1. Inventory affected code, tests, generated files, configuration, and docs.
2. Partition by disjoint ownership.
3. Pilot one item and verify the strategy.
4. Process remaining items through inspect, mutate, and verify stages.
5. Consolidate on the runner integration branch.
6. Run targeted and broad regression checks outside the workflow as appropriate.

Native: use worker agents only for cleanly disjoint paths; integrate and verify in the main thread.

Runtime: use a pipeline keyed by package/module ID. Every mutating stage declares ownership and a separate verifier contract. Stop on dirty base, path overlap, verifier rejection, conflict, or active-checkout drift.

The runtime integration branch is the terminal artifact, not authority to merge into the user's branch.

## Cross-Checked Research

Goal: support current claims with independent sources and explicit uncertainty.

1. Decompose the question by subquestion or source type.
2. Gather sources independently.
3. Build a claim ledger.
4. Challenge weak or conflicting claims.
5. Report supported claims, caveats, dates, and links.

Network access is an explicit workflow setting and defaults off. Browser/tool authorization remains governed by the active Codex runtime; a workflow cannot grant itself connector or network authority.

## Adversarial Plan Review

Goal: expose correctness, product, operational, and testability risks before implementation.

1. Produce a candidate plan.
2. Review it from distinct, non-duplicative perspectives.
3. Resolve conflicts against original constraints.
4. Optionally run a final constraint checker.

Return keep/change/defer decisions, assumptions, and acceptance criteria that catch the highest-risk failure modes.

## Verification And Log Triage

Goal: rank causes from separate evidence rather than patching several guesses.

1. Establish the failing command, expected behavior, and change scope.
2. Split evidence: logs, tests, diff, environment/config.
3. Generate bounded hypotheses.
4. Refute the strongest hypotheses.
5. Apply one narrow fix only when requested and ownership is clear.
6. Rerun the smallest decisive check, then broader checks.

Avoid multiple agents repeating the same expensive command. Distinguish permission/environment failures from product defects.

## Generate And Filter

Goal: explore broadly but return only rubric-surviving results.

Run independent generators with different constraints or approaches. Feed their structured candidate lists to a filter that rejects duplicates, unsupported items, and rubric failures. Keep final product judgment with the main agent or an explicit final decision phase.

## Tournament

Goal: choose among viable alternatives when pairwise comparison is easier than absolute scoring.

Run candidates independently, then pass only their outputs and the original rubric to a judge. Preserve minority options when evidence shows a meaningful tradeoff. Do not present vote count as proof.

## Bounded Loop

Goal: continue until a machine-checkable condition, not until the run merely feels long.

Good stop conditions include:

- Coverage ledger complete.
- Known failures all pass.
- Output field `done` is true.
- No new confirmed findings in the configured bounded round.

Always set a finite iteration cap. Reaching the cap without the stop condition is a failed/incomplete run, not success.

## Selection Checklist

- Is the task broad/risky enough to justify orchestration?
- Is the request read-only or mutating?
- Did the user explicitly request runtime execution, especially TypeScript?
- Are item identities and call IDs stable across resume?
- Is every result structured enough to synthesize deterministically?
- Are mutation ownership sets disjoint?
- Where are barriers and stop conditions?
- Which independent verifier checks material outputs?
- What budget/profile bounds the run?
- What artifact proves completion: report, persisted result, integration branch, or tests?
