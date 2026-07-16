import type { AgentCallOptions, JsonValue } from "./types.js";

export interface PipelineOptions<T> {
  concurrency?: number;
  key?: (item: T, index: number) => string;
}
export interface LoopOptions<T> {
  maxIterations: number;
  until: (value: T, iteration: number) => boolean | Promise<boolean>;
}

export interface WorkflowContext {
  phase<T>(id: string, work: () => Promise<T>): Promise<T>;
  agent<T extends JsonValue>(id: string, prompt: string, options: AgentCallOptions): Promise<T>;
  parallel<T extends Record<string, () => Promise<unknown>>>(
    id: string,
    branches: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
  pipeline<T, R>(
    id: string,
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    options?: PipelineOptions<T>,
  ): Promise<R[]>;
  loop<T>(id: string, work: (iteration: number) => Promise<T>, options: LoopOptions<T>): Promise<T>;
  log(message: string, data?: JsonValue): Promise<void>;
}

export interface WorkflowMetadata {
  name: string;
  description: string;
  argsSchema: Record<string, unknown>;
  profile?: "small" | "medium" | "large";
}

export interface TypeScriptWorkflowModule<Args extends JsonValue = JsonValue, Result extends JsonValue = JsonValue> {
  meta: WorkflowMetadata;
  run(context: WorkflowContext, args: Args): Promise<Result>;
}

export function defineWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: TypeScriptWorkflowModule<Args, Result>,
): TypeScriptWorkflowModule<Args, Result> {
  return workflow;
}
