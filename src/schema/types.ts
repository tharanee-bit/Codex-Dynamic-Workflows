import type { JsonSchema, JsonValue, ReasoningEffort, WorkflowProfile } from "../types.js";

export const WORKFLOW_API_VERSION = "codex.openai.com/v1alpha1" as const;

export interface DeclarativeWorkflowMetadata {
  name: string;
  namespace?: string;
  description: string;
}

export interface DeclarativeRuntimeOptions {
  profile?: WorkflowProfile;
  concurrency?: number;
  maxAgents?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  networkAccess?: boolean;
}

export interface DeclarativeVerificationSpec {
  prompt: string;
  outputSchema: JsonSchema;
}

export interface DeclarativeAgentSpec {
  id: string;
  prompt: string;
  outputSchema: JsonSchema;
  input?: JsonValue;
  mode?: "read-only" | "mutating";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  networkAccess?: boolean;
  ownership?: string[];
  verification?: DeclarativeVerificationSpec;
  workspaceKey?: string;
}

export interface AgentPhase {
  id: string;
  type: "agent";
  agent: DeclarativeAgentSpec;
}

export interface ParallelPhase {
  id: string;
  type: "parallel";
  agents: DeclarativeAgentSpec[];
}

export type PipelineItems = JsonValue[] | { select: string };

export interface PipelinePhase {
  id: string;
  type: "pipeline";
  items: PipelineItems;
  key?: string;
  concurrency?: number;
  stages: DeclarativeAgentSpec[];
}

export interface LoopPhase {
  id: string;
  type: "loop";
  maxIterations: number;
  until: string;
  agent: DeclarativeAgentSpec;
}

export type DeclarativePhase = AgentPhase | ParallelPhase | PipelinePhase | LoopPhase;

export interface DeclarativeWorkflow {
  apiVersion: typeof WORKFLOW_API_VERSION;
  kind: "Workflow";
  metadata: DeclarativeWorkflowMetadata;
  argsSchema: JsonSchema;
  runtime?: DeclarativeRuntimeOptions;
  phases: DeclarativePhase[];
  result?: string;
}
