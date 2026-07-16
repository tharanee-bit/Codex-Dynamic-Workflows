import type {
  DeclarativeAgentSpec,
  DeclarativePhase,
  DeclarativeWorkflow,
  PipelinePhase,
} from "../schema/index.js";
import type { AgentCallOptions, JsonValue } from "../types.js";
import { renderPromptTemplate, selectDotted, sha256Canonical } from "../util/index.js";
import { WorkflowEngine } from "./core.js";

interface TemplateContext {
  args: JsonValue;
  outputs: Record<string, JsonValue>;
  item?: JsonValue;
  input?: JsonValue;
  index?: number;
  iteration?: number;
}

function asJsonValue(value: unknown, label: string): JsonValue {
  if (value === undefined) throw new Error(`${label} resolved to undefined`);
  return value as JsonValue;
}

function stableItemKey(phase: PipelinePhase, item: JsonValue): string {
  const value = phase.key ? selectDotted(item, phase.key) : sha256Canonical(item).slice(0, 16);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Pipeline ${phase.id} key must resolve to a string or number`);
  }
  const normalized = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) throw new Error(`Pipeline ${phase.id} produced an empty item key`);
  return normalized.slice(0, 80);
}

function agentOptions(
  workflow: DeclarativeWorkflow,
  spec: DeclarativeAgentSpec,
  context: TemplateContext,
  phaseId: string,
  input?: JsonValue,
  workspaceKey?: string,
): AgentCallOptions {
  const runtime = workflow.runtime ?? {};
  return {
    outputSchema: spec.outputSchema,
    phaseId,
    mode: spec.mode ?? "read-only",
    reasoningEffort: spec.reasoningEffort ?? runtime.reasoningEffort ?? "xhigh",
    networkAccess: spec.networkAccess ?? runtime.networkAccess ?? false,
    ...(spec.model ?? runtime.model ? { model: spec.model ?? runtime.model } : {}),
    ...(spec.ownership ? { ownership: spec.ownership } : {}),
    ...(spec.verification
      ? {
          verification: {
            prompt: renderPromptTemplate(spec.verification.prompt, context),
            outputSchema: spec.verification.outputSchema,
          },
        }
      : {}),
    ...(input !== undefined ? { input } : spec.input !== undefined ? { input: spec.input } : {}),
    ...(workspaceKey ? { workspaceKey } : spec.workspaceKey ? { workspaceKey: spec.workspaceKey } : {}),
  };
}

async function runAgentSpec(
  workflow: DeclarativeWorkflow,
  phaseId: string,
  spec: DeclarativeAgentSpec,
  context: TemplateContext,
  engine: WorkflowEngine,
  callId = spec.id,
  input?: JsonValue,
  workspaceKey?: string,
): Promise<JsonValue> {
  const prompt = renderPromptTemplate(spec.prompt, context);
  return engine.agent(callId, prompt, agentOptions(workflow, spec, context, phaseId, input, workspaceKey));
}

function pipelineItems(phase: PipelinePhase, context: TemplateContext): JsonValue[] {
  if (Array.isArray(phase.items)) return phase.items;
  const selected = selectDotted(context, phase.items.select);
  if (!Array.isArray(selected)) throw new Error(`Pipeline ${phase.id} items selector must resolve to an array`);
  return selected as JsonValue[];
}

async function runPhase(
  workflow: DeclarativeWorkflow,
  phase: DeclarativePhase,
  context: TemplateContext,
  engine: WorkflowEngine,
): Promise<JsonValue> {
  switch (phase.type) {
    case "agent":
      return runAgentSpec(workflow, phase.id, phase.agent, context, engine);
    case "parallel": {
      const mutationKeys = phase.agents
        .filter((spec) => spec.mode === "mutating")
        .map((spec) => spec.workspaceKey ?? `${phase.id}/${spec.id}`);
      if (new Set(mutationKeys).size !== mutationKeys.length) {
        throw new Error(`Parallel phase ${phase.id} assigns the same mutation workspace more than once`);
      }
      const branches: Record<string, () => Promise<JsonValue>> = {};
      for (const spec of phase.agents) {
        branches[spec.id] = () => runAgentSpec(workflow, phase.id, spec, context, engine);
      }
      return engine.parallel(phase.id, branches) as Promise<Record<string, JsonValue>>;
    }
    case "pipeline": {
      const items = pipelineItems(phase, context);
      const keys = items.map((item) => stableItemKey(phase, item));
      if (new Set(keys).size !== keys.length) {
        throw new Error(`Pipeline ${phase.id} item keys must be unique`);
      }
      const results = await engine.pipeline(
        phase.id,
        items,
        async (item, index) => {
          const itemKey = keys[index];
          if (!itemKey) throw new Error(`Pipeline ${phase.id} has no key for item ${index}`);
          let stageInput: JsonValue = item;
          const workspaceKey = `${phase.id}-${itemKey}`;
          for (const stage of phase.stages) {
            const stageContext: TemplateContext = {
              args: context.args,
              outputs: context.outputs,
              item,
              input: stageInput,
              index,
            };
            stageInput = await runAgentSpec(
              workflow,
              phase.id,
              stage,
              stageContext,
              engine,
              `${stage.id}.${itemKey}`,
              stageInput,
              workspaceKey,
            );
          }
          return stageInput;
        },
        { concurrency: phase.concurrency ?? engine.state.concurrency },
      );
      return results;
    }
    case "loop": {
      let input: JsonValue | undefined;
      return engine.loop(
        phase.id,
        async (iteration) => {
          const loopContext: TemplateContext = {
            args: context.args,
            outputs: context.outputs,
            iteration,
            ...(input !== undefined ? { input } : {}),
          };
          input = await runAgentSpec(
            workflow,
            phase.id,
            phase.agent,
            loopContext,
            engine,
            `${phase.agent.id}.${iteration}`,
            input,
            phase.agent.workspaceKey ?? `${phase.id}-loop`,
          );
          return input;
        },
        {
          maxIterations: phase.maxIterations,
          until: (value) => selectDotted(value, phase.until) === true,
        },
      );
    }
  }
}

export async function runDeclarativeWorkflow(
  workflow: DeclarativeWorkflow,
  args: JsonValue,
  engine: WorkflowEngine,
): Promise<JsonValue> {
  const context: TemplateContext = { args, outputs: engine.state.outputs };
  for (const phase of workflow.phases) {
    const output = await engine.phase(phase.id, () => runPhase(workflow, phase, context, engine));
    engine.state.outputs[phase.id] = output;
    await engine.store.save(engine.state);
  }
  if (workflow.result) {
    return asJsonValue(selectDotted(context, workflow.result), `Workflow result selector ${workflow.result}`);
  }
  const last = workflow.phases.at(-1);
  if (!last) throw new Error("Workflow has no phases");
  return engine.state.outputs[last.id] ?? null;
}
