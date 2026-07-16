import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";

import workflowV1Alpha1Schema from "../../schemas/workflow-v1alpha1.json" with { type: "json" };
import type { DeclarativeAgentSpec, DeclarativePhase, DeclarativeWorkflow } from "./types.js";

export type WorkflowSourceFormat = "json" | "yaml";

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validateDocument = ajv.compile(workflowV1Alpha1Schema) as ValidateFunction<DeclarativeWorkflow>;

export const workflowSchemaV1Alpha1 = workflowV1Alpha1Schema;

function formatAjvError(error: ErrorObject): string {
  const location = error.instancePath.length > 0 ? error.instancePath : "/";
  const suffix = error.params && "additionalProperty" in error.params
    ? `: ${String(error.params.additionalProperty)}`
    : "";
  return `${location} ${error.message ?? "is invalid"}${suffix}`;
}

function parseSource(source: string, format: WorkflowSourceFormat): unknown {
  if (format === "json") {
    try {
      return JSON.parse(source) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowValidationError("Workflow JSON could not be parsed", [message]);
    }
  }

  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new WorkflowValidationError(
      "Workflow YAML could not be parsed",
      document.errors.map((error) => error.message),
    );
  }
  return document.toJS({ maxAliasCount: 100 }) as unknown;
}

function agentsInPhase(phase: DeclarativePhase): DeclarativeAgentSpec[] {
  switch (phase.type) {
    case "agent":
    case "loop":
      return [phase.agent];
    case "parallel":
      return phase.agents;
    case "pipeline":
      return phase.stages;
  }
}

function validateJsonSchema(schema: Record<string, unknown>, location: string, issues: string[]): void {
  try {
    if (!ajv.validateSchema(schema)) {
      const details = (ajv.errors ?? []).map(formatAjvError).join("; ");
      issues.push(`${location} is not a valid JSON Schema${details.length > 0 ? `: ${details}` : ""}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`${location} is not a valid JSON Schema: ${message}`);
  }
}

function semanticIssues(workflow: DeclarativeWorkflow): string[] {
  const issues: string[] = [];
  const phaseIds = new Set<string>();

  validateJsonSchema(workflow.argsSchema, "/argsSchema", issues);

  for (const [phaseIndex, phase] of workflow.phases.entries()) {
    if (phaseIds.has(phase.id)) {
      issues.push(`/phases/${phaseIndex}/id duplicates phase id ${JSON.stringify(phase.id)}`);
    }
    phaseIds.add(phase.id);

    const agentIds = new Set<string>();
    for (const [agentIndex, agent] of agentsInPhase(phase).entries()) {
      const prefix = `/phases/${phaseIndex}/${phase.type === "pipeline" ? "stages" : phase.type === "parallel" ? "agents" : "agent"}${phase.type === "pipeline" || phase.type === "parallel" ? `/${agentIndex}` : ""}`;
      if (agentIds.has(agent.id)) {
        issues.push(`${prefix}/id duplicates agent id ${JSON.stringify(agent.id)} within phase ${JSON.stringify(phase.id)}`);
      }
      agentIds.add(agent.id);
      validateJsonSchema(agent.outputSchema, `${prefix}/outputSchema`, issues);
      if (agent.verification !== undefined) {
        validateJsonSchema(agent.verification.outputSchema, `${prefix}/verification/outputSchema`, issues);
      }
    }
  }

  return issues;
}

export function validateWorkflow(value: unknown): value is DeclarativeWorkflow {
  return validateDocument(value) && semanticIssues(value).length === 0;
}

export function assertWorkflow(value: unknown): asserts value is DeclarativeWorkflow {
  if (!validateDocument(value)) {
    throw new WorkflowValidationError(
      "Workflow does not conform to codex.openai.com/v1alpha1",
      (validateDocument.errors ?? []).map(formatAjvError),
    );
  }

  const issues = semanticIssues(value);
  if (issues.length > 0) {
    throw new WorkflowValidationError("Workflow failed semantic validation", issues);
  }
}

export function parseWorkflow(source: string, format: WorkflowSourceFormat = "yaml"): DeclarativeWorkflow {
  const value = parseSource(source, format);
  assertWorkflow(value);
  return value;
}

export async function loadWorkflow(filePath: string): Promise<DeclarativeWorkflow> {
  const extension = extname(filePath).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new WorkflowValidationError(
      "Unsupported declarative workflow file extension",
      [`Expected .json, .yaml, or .yml but received ${extension || "no extension"}`],
    );
  }
  const source = await readFile(filePath, "utf8");
  return parseWorkflow(source, extension === ".json" ? "json" : "yaml");
}
