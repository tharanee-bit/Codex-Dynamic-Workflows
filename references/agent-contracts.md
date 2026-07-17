# Agent Contracts

Use explicit contracts to reduce goal drift and make native or persisted workflow results verifiable.

## Workflow Spec

Record these fields before substantial orchestration:

- `Goal`: concrete terminal outcome.
- `Mode`: design-only, read-only, or mutating.
- `Surface`: native Codex orchestration or explicit `codex-dw` execution.
- `Pattern`: parallel, pipeline, adversarial verification, bounded loop, or combination.
- `Failure mode`: coverage gaps, self-grading, drift, unsafe overlap, or non-resumable work.
- `Coverage`: complete ledger of items and status.
- `Ownership`: read/write responsibility per unit.
- `Budget`: profile, concurrent calls, total calls, and loop/round caps.
- `Barrier`: when all branches must finish.
- `Stop gates`: exact unsafe/incomplete conditions.
- `Synthesis`: deduplication, conflict resolution, and result selection.
- `Acceptance`: checks that prove the outcome.

## Native Explorer Prompt

```text
You are a read-only explorer in a bounded Codex workflow.

Goal and constraints:
<original goal, non-goals, and mode>

Scope:
<exclusive paths, claims, or evidence>

Task:
<specific question>

Contract:
- Do not edit files or broaden scope.
- Prefer direct evidence and cite exact paths/checks.
- Mark uncertainty and skipped coverage.
- Do not duplicate other assigned scopes.

Return JSON or the requested structured shape with summary, evidence,
findings, checks, unknowns, and coverage status.
```

## Native Worker Prompt

```text
You are a mutating worker in a bounded Codex workflow. Other work may exist.

Goal and constraints:
<original goal, non-goals, and decisions>

Ownership:
<exclusive writable paths; everything else is read-only>

Task:
<one implementation unit>

Contract:
- Preserve unrelated/user changes.
- Do not broaden ownership or production effects.
- Run the smallest relevant checks.
- Stop on overlap, failing baseline, secret access, or unclear authority.

Return files changed, behavior changed, checks/results, evidence,
remaining risks, and integration notes.
```

Native agents inherit the configured Codex model and request `xhigh` reasoning where supported; do not embed a dated model ID in saved contracts.

## Runtime Leaf Worker Contract

The SDK adapter prepends this invariant to every runtime worker and verifier prompt:

- Complete exactly one parent-assigned call within its declared mode, ownership, tools, and network policy.
- Do not invoke `codex-dw`, start another dynamic workflow, or delegate work to subagents.
- Do not expand concurrency, retries, budgets, scope, or side effects.
- Return only the requested structured result; the parent runtime owns orchestration, verification, integration, and final decisions.

SDK subprocesses also receive `CODEX_DW_ACTIVE=1`. Integrations may use that internal marker to suppress nested lifecycle automation, but workflows must not depend on it as a public input. Parallelism and retries belong in the parent YAML/JSON/TypeScript definition so they remain bounded, visible, and resumable.

## Declarative Agent Contract

Every runtime agent declares:

```yaml
id: stable-id
prompt: Self-contained instruction with evidence and non-goals.
input: {}
outputSchema:
  type: object
  additionalProperties: false
  required: [summary, evidence, status]
  properties:
    summary: { type: string }
    evidence: { type: array, items: { type: string } }
    status: { enum: [complete, incomplete, blocked] }
```

The call hash covers ID, prompt, input, schema, mode, runtime options, ownership, and workspace key. Keep all semantically relevant dependencies in prompt or input so resume invalidation is correct.

## Finding Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["scope", "findings", "coverage"],
  "properties": {
    "scope": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "summary", "evidence"],
        "properties": {
          "severity": { "enum": ["high", "medium", "low"] },
          "summary": { "type": "string" },
          "evidence": { "type": "array", "items": { "type": "string" } },
          "suggestedAction": { "type": "string" }
        }
      }
    },
    "coverage": {
      "type": "object",
      "required": ["covered", "skipped"],
      "properties": {
        "covered": { "type": "array", "items": { "type": "string" } },
        "skipped": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

## Mutation Contract

A mutating runtime agent must declare non-empty ownership and a separate verifier:

```yaml
mode: mutating
ownership:
  - src/package/**
  - test/package/**
verification:
  prompt: >-
    Work read-only. Inspect the task changes and run the narrow acceptance
    checks. Accept only when behavior, ownership, and tests satisfy the task.
  outputSchema:
    type: object
    additionalProperties: false
    required: [accepted, evidence, checks]
    properties:
      accepted: { type: boolean }
      evidence: { type: array, items: { type: string } }
      checks: { type: array, items: { type: string } }
      reason: { type: string }
```

The runner accepts only literal `accepted: true`. The verifier is read-only, has network disabled, and counts against the call budget. Verification occurs before commit/integration.

## Refuter Contract

```text
Input: <claim, patch, candidate, or plan>
Rubric: <original requirements and acceptance checks>
Evidence scope: <paths, results, or sources>

Try to disprove the input. Reject unsupported claims, missing coverage,
severity inflation, hidden regressions, and self-reported success.

Return:
- survived: true | false
- refutation attempts
- evidence checked
- decisive checks
- unresolved risks
```

## Synthesis Contract

Synthesis must:

- Compare outputs to the full coverage ledger.
- Deduplicate by underlying cause/evidence, not wording.
- Preserve a minority finding when its evidence is stronger.
- Separate facts, hypotheses, and unresolved conflicts.
- Reject results that violate their output schema or ownership.
- Report cached, rerun, failed, stopped, and skipped work truthfully.
- Aggregate worker and verifier token use.
- State whether completion produced a report, persisted result, or integration branch.
- Never describe the integration branch as merged into the user's branch.
- List checks run and checks unavailable.

## Stop Gates

Stop rather than improvise when:

- Mutation or executable TypeScript was not directly authorized.
- Ownership overlaps another independent mutation unit.
- The Git base is dirty, active checkout drifts, or integration conflicts.
- A verifier rejects or cannot obtain required evidence.
- A loop, profile, call, token, or time budget is exhausted.
- Required network, credentials, connectors, or production effects are outside authority.
- The result cannot be represented in the declared schema without hiding uncertainty.
