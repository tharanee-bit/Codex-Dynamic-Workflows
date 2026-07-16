import type {
  AgentCallOptions,
  JsonObject,
  JsonValue,
} from "../types.js";
import type { WorkflowMetadata } from "../workflow-api.js";

export interface TypeScriptPhaseRpcRequest {
  method: "phase";
  id: string;
  action: "start" | "complete" | "fail";
  error?: string;
}

export interface TypeScriptAgentRpcRequest {
  method: "agent";
  id: string;
  prompt: string;
  options: AgentCallOptions;
}

export interface TypeScriptLogRpcRequest {
  method: "log";
  message: string;
  data?: JsonValue;
}

export type TypeScriptWorkflowRpcRequest =
  | TypeScriptPhaseRpcRequest
  | TypeScriptAgentRpcRequest
  | TypeScriptLogRpcRequest;

export type TypeScriptWorkflowRpcHandler = (
  request: TypeScriptWorkflowRpcRequest,
  signal: AbortSignal,
) => Promise<JsonValue | void>;

export interface BundleTypeScriptWorkflowOptions {
  workflowPath: string;
  outputDirectory?: string;
}

export interface TypeScriptWorkflowBundle {
  bundlePath: string;
  temporaryDirectory?: string;
}

export interface ExecuteTypeScriptWorkflowOptions {
  workflowPath: string;
  args: JsonValue;
  rpc: TypeScriptWorkflowRpcHandler;
  onMetadata?: (metadata: WorkflowMetadata) => void;
  onLateRpcDrain?: (drain: Promise<void>) => void;
  signal?: AbortSignal;
  workingDirectory?: string;
  wallTimeMs?: number;
  memoryLimitMb?: number;
  pipelineConcurrency?: number;
  maxLoopIterations?: number;
  keepArtifacts?: boolean;
}

export interface TypeScriptWorkflowExecution {
  meta: WorkflowMetadata;
  result: JsonValue;
  durationMs: number;
  permissionIsolation: boolean;
}

export interface TypeScriptRuntimeDiagnostics extends JsonObject {
  permissionIsolation: boolean;
  nodeVersion: string;
}
