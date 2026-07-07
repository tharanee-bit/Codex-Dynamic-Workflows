# Project Improvement Plan

An improvement plan for the `dynamic-workflows` Codex skill, covering content quality, repository
architecture, and maintainability. Items are ordered by priority; each includes rationale, concrete
steps, affected files, and an effort estimate.

## Summary

| # | Improvement | Impact | Effort |
| --- | --- | --- | --- |
| 1 | Single source of truth for the dated runtime policy | High | Low |
| 2 | Worked end-to-end examples | High | Medium |
| 3 | Pattern-selection decision guide | Medium | Low |
| 4 | CI quality gates (lint, link check, consistency check) | Medium | Medium |
| 5 | Versioning and changelog | Medium | Low |
| 6 | Concrete install instructions + smoke test | Medium | Low |
| 7 | Skill-discovery naming consistency | Low | Low |
| 8 | Design notes for key constants | Low | Low |
| 9 | Evaluation harness of golden prompts | Medium | High |
| 10 | Contribution hygiene (`CONTRIBUTING.md`, `.gitignore`) | Low | Low |

---

## 1. Single source of truth for the dated runtime policy

**Priority: High — this is the most likely future maintenance bug.**

The subagent runtime policy contains dated catalog values (`model: "gpt-5.5"`,
`reasoning_effort: "xhigh"`, "as of 2026-06-24") that will churn as the Codex model catalog
changes. Today those values are written out in two places and echoed in two more:

- `SKILL.md` — "Subagent Runtime Policy" section (canonical).
- `README.md` — "Subagent runtime policy" section (full duplicate, including the date and model id).
- `references/agent-contracts.md` — refers to the policy in the spec fields, delegation contract,
  and both prompt templates (correctly by reference, but the phrasing partially restates it).
- `references/workflow-patterns.md` — restates "highest available model with Extra High reasoning"
  inside the Classify-And-Act recipe.

When the catalog changes, four files must be edited in sync or the skill gives contradictory
instructions.

**Steps:**

1. Keep the full dated policy (model id, effort value, as-of date, fallback rule) only in
   `SKILL.md` under "Subagent Runtime Policy".
2. Reduce the README section to 2–3 sentences that describe the policy's intent and link to
   `SKILL.md` for current values.
3. In both reference files, replace restated values/superlatives with a uniform pointer phrase,
   e.g. "follows the Subagent Runtime Policy in `SKILL.md`" (agent-contracts.md already mostly
   does this — make it consistent everywhere).
4. Add a maintenance note next to the canonical block: "Update model id and as-of date here only."

**Files:** `README.md`, `SKILL.md`, `references/workflow-patterns.md`, `references/agent-contracts.md`
**Effort:** Low (an hour or less).

## 2. Worked end-to-end examples

**Priority: High — the largest content gap in the skill.**

`SKILL.md` defines a 13-field planning contract and the references provide templates, but nothing
shows the contract filled in. Abstract contracts are much harder for a model (and a human reader)
to apply correctly than one concrete instance. A worked example also acts as informal documentation
of intent: it demonstrates how the 4-agent cap, coverage ledger, and main-thread synthesis are
supposed to interact in practice.

**Steps:**

1. Create `examples/codebase-audit.md`: a full workflow spec for a realistic audit request
   ("review this branch for security and correctness issues") — Goal, Mode (read-only), Pattern,
   Failure mode, phase table, the actual explorer/cross-check prompts instantiated from
   `references/agent-contracts.md` templates, a filled-in coverage ledger, and a sample synthesis.
2. Create `examples/migration.md`: a mutating-execution example (e.g. renaming an API across
   packages) demonstrating slice design, disjoint write ownership, the pilot slice, and the stop
   gates from `references/workflow-patterns.md` "Large Migration".
3. Link the examples from `SKILL.md`'s Reference Map and from the README layout section.
4. Keep each example under ~150 lines so it can be loaded as a reference without blowing context.

**Files:** new `examples/codebase-audit.md`, new `examples/migration.md`; small edits to
`SKILL.md`, `README.md`
**Effort:** Medium.

## 3. Pattern-selection decision guide

**Priority: Medium.**

`references/workflow-patterns.md` describes six primitive patterns and five domain recipes, but the
reader must re-derive which one fits a given task on every load. A compact task-shape → pattern
mapping reduces that per-invocation reasoning cost and makes pattern choice more consistent.

**Steps:**

1. Add a short "Choosing a pattern" section at the top of `references/workflow-patterns.md`:
   a table mapping task signals ("many independent items" → fan-out-and-synthesize; "self-grading
   risk" → adversarial verification; "unknown amount of work" → loop-until-done; "quality is
   comparative" → tournament; "items need routing first" → classify-and-act; "breadth first,
   quality second" → generate-and-filter).
2. Include one row per domain recipe as well (audit, migration, research, plan review, triage).

**Files:** `references/workflow-patterns.md`
**Effort:** Low.

## 4. CI quality gates

**Priority: Medium — the repo currently has no automated checks at all.**

For a documentation-only project the failure modes are broken intra-repo links, malformed YAML,
frontmatter that a skill loader rejects, and cross-file drift (see item 1). All four are cheaply
machine-checkable.

**Steps:**

1. Add `.github/workflows/ci.yml` running on push/PR:
   - Markdown lint (`markdownlint-cli2` with a permissive config).
   - Intra-repo link check (e.g. `lychee --offline` or a small script) so `SKILL.md` ↔ references
     ↔ README links stay valid.
   - YAML validation of `agents/openai.yaml`.
   - Frontmatter check for `SKILL.md`: `name` matches `^[a-z0-9-]+$`, `description` is non-empty
     and within common loader length limits (~1024 chars).
2. Add `scripts/check-consistency.sh` (run in CI): grep-assert that the agent-cap number ("4")
   and the runtime-policy model id appear only where expected, failing when a duplicate full
   policy block reappears.

**Files:** new `.github/workflows/ci.yml`, new `scripts/check-consistency.sh`, new
`.markdownlint.yaml`
**Effort:** Medium.

## 5. Versioning and changelog

**Priority: Medium.**

Downstream users copy this directory into their Codex install; without a version they cannot tell
whether their copy is stale. This matters more than usual here because the runtime policy embeds
dated catalog values that are expected to churn.

**Steps:**

1. Add `version: 0.1.0` (or similar) to the `SKILL.md` frontmatter, if the Codex skill loader
   tolerates extra frontmatter keys — verify first; otherwise record the version in the README.
2. Add `CHANGELOG.md` (Keep a Changelog format) and backfill entries from the existing four
   commits.
3. Tag releases (`v0.1.0`) so installs can pin a ref.

**Files:** `SKILL.md`, new `CHANGELOG.md`
**Effort:** Low.

## 6. Concrete install instructions and smoke test

**Priority: Medium.**

The README's install section is one vague sentence: "Place this directory where your Codex install
discovers skills." A new user has to research where that is.

**Steps:**

1. Document the concrete skill-discovery path(s) for current Codex releases and a one-line install
   command (e.g. a `git clone` into the skills directory), noting the expected directory name
   (see item 7).
2. Add a smoke-test snippet: an example prompt (`$dynamic-workflows ...`) and what a correct
   skill-loaded response looks like, so users can verify discovery worked.
3. Note how to update (git pull / re-copy) and how versioning (item 5) helps.

**Files:** `README.md`
**Effort:** Low.

## 7. Skill-discovery naming consistency

**Priority: Low, but cheap.**

The repository directory is `Codex-Dynamic-Workflows` while the skill's frontmatter `name` is
`dynamic-workflows`. Skill loaders commonly key discovery on the directory name; a user who clones
the repo verbatim into their skills directory may get a name mismatch or a failed load.

**Steps:**

1. Verify whether the Codex loader uses the directory name or the frontmatter `name`.
2. Either way, state explicitly in the README install section that the directory should be named
   `dynamic-workflows` when installed (or rename the repo if directory-name discovery is
   confirmed).

**Files:** `README.md`
**Effort:** Low.

## 8. Design notes for key constants

**Priority: Low.**

The skill encodes several deliberate safety constants — the 4-agent total cap, one child layer of
delegation, main-thread pre-allocation of child slots, main-thread synthesis, stop-before-mutation
on implicit loading — but nowhere records *why* those values were chosen. Future edits (including
by an AI assistant asked to "loosen the cap") could silently break the safety rationale.

**Steps:**

1. Add `docs/design-notes.md` with a short entry per constant: the risk it defends against
   (runaway cost, overlapping mutation, goal drift, unauthorized edits) and what evidence or
   reasoning set the value.
2. Link it from the README layout section.

**Files:** new `docs/design-notes.md`, `README.md`
**Effort:** Low.

## 9. Evaluation harness of golden prompts

**Priority: Medium value, highest effort — a stretch goal.**

The invocation policy has subtle boundaries: implicit vs explicit loading, design-only vs
read-only vs mutating mode classification, and stop-before-mutation on implicit loads. Edits to
the `description` frontmatter or the Invocation Policy section can silently shift those boundaries.

**Steps:**

1. Create `eval/golden-prompts.md` with three suites:
   - *Should trigger*: broad audits, migrations, cross-checked research, "ultracode", `$dynamic-workflows`.
   - *Should not trigger*: routine single-file edits, quick questions, small fixes.
   - *Mode classification*: prompts whose expected mode is design-only / read-only / mutating,
     including the tricky implicit-load-plus-mutating-verbs case (expected: stop and confirm).
2. Document a manual regression procedure: after editing the invocation policy, run each prompt
   against a Codex session with the skill installed and compare against expected behavior.
3. Optionally script it later if Codex exposes a headless way to run such checks.

**Files:** new `eval/golden-prompts.md`
**Effort:** High (mostly in authoring good cases and running them).

## 10. Contribution hygiene

**Priority: Low.**

**Steps:**

1. Add a short `CONTRIBUTING.md`: how to propose changes, the single-source-of-truth rule for the
   runtime policy (item 1), the requirement to update `CHANGELOG.md`, and how to run the CI checks
   locally.
2. Add a minimal `.gitignore` (editor droppings, OS files).

**Files:** new `CONTRIBUTING.md`, new `.gitignore`
**Effort:** Low.

---

## Suggested sequencing

1. **Quick wins first (items 1, 3, 5, 6, 7, 10):** all low-effort; together they remove the main
   maintenance trap and make the project installable and versioned. Roughly one sitting.
2. **Content depth (item 2):** the worked examples — highest-value content work.
3. **Automation (item 4, then 8):** CI to lock in the consistency gained in step 1.
4. **Stretch (item 9):** the evaluation harness, once the invocation policy is otherwise stable.
