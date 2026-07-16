export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type RunStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export type CallStatus = "pending" | "running" | "completed" | "failed" | "stopped";
export type WorkflowProfile = "small" | "medium" | "large";
export type AgentMode = "read-only" | "mutating";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export interface AgentRuntimeOptions {
  mode?: AgentMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  networkAccess?: boolean;
  workingDirectory?: string;
  ownership?: string[];
  verification?: VerificationSpec;
}

export interface VerificationSpec {
  prompt: string;
  outputSchema: JsonSchema;
}

export interface AgentCallOptions extends AgentRuntimeOptions {
  outputSchema: JsonSchema;
  input?: JsonValue;
  phaseId?: string;
  workspaceKey?: string;
}

export interface AgentRequest extends AgentCallOptions {
  callId: string;
  prompt: string;
  signal?: AbortSignal;
  threadId?: string;
}

export interface AgentResult {
  output: JsonValue;
  threadId?: string;
  usage: Usage;
  attempts: number;
}

export class AgentExecutionError extends Error {
  readonly threadId?: string;
  readonly usage: Usage;
  readonly attempts: number;

  constructor(
    message: string,
    details: { threadId?: string; usage: Usage; attempts: number; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "AgentExecutionError";
    if (details.threadId !== undefined) this.threadId = details.threadId;
    this.usage = details.usage;
    this.attempts = details.attempts;
  }
}

export interface AgentEvent {
  type: string;
  callId: string;
  timestamp: string;
  data?: JsonValue;
}

export interface AgentAdapter {
  run(request: AgentRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentResult>;
}

export interface CallRecord {
  id: string;
  hash: string;
  phaseId: string;
  status: CallStatus;
  prompt: string;
  outputSchema: JsonSchema;
  input?: JsonValue;
  output?: JsonValue;
  threadId?: string;
  usage: Usage;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  workspaceKey?: string;
  worktreePath?: string;
  branch?: string;
  commit?: string;
  candidateHash?: string;
  changedPaths?: string[];
  integrated?: boolean;
}

export interface PhaseRecord {
  id: string;
  type: string;
  status: CallStatus;
  startedAt?: string;
  completedAt?: string;
  calls: string[];
  error?: string;
}

export interface RunEvent {
  type: string;
  timestamp: string;
  runId: string;
  phaseId?: string;
  callId?: string;
  data?: JsonValue;
}

export interface GitRunState {
  repositoryRoot: string;
  baseHead: string;
  activeBranch: string;
  statusPorcelain: string;
  runKey: string;
  worktreeRoot: string;
  runWorktreeRoot: string;
  integrationBranch: string;
  integrationWorktree: string;
  integrationHead: string;
  integratedPaths: string[];
  pathOwners: Record<string, string>;
}

export interface RunState {
  schemaVersion: 1;
  id: string;
  status: RunStatus;
  workflowPath: string;
  workflowHash: string;
  workflowKind: "declarative" | "typescript";
  workflowSnapshot: string;
  args: JsonValue;
  workingDirectory: string;
  profile: WorkflowProfile;
  profileOverridden?: boolean;
  maxAgents: number;
  agentCallsUsed: number;
  concurrency: number;
  allowMutation: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  error?: string;
  result?: JsonValue;
  usage: Usage;
  calls: Record<string, CallRecord>;
  phases: Record<string, PhaseRecord>;
  outputs: Record<string, JsonValue>;
  git?: GitRunState;
}

export interface RunOptions {
  runId?: string;
  workflowPath: string;
  args: JsonValue;
  workingDirectory: string;
  allowMutation: boolean;
  profileOverride?: WorkflowProfile;
  detached?: boolean;
}

export const PROFILE_LIMITS: Record<WorkflowProfile, { concurrency: number; maxAgents: number }> = {
  small: { concurrency: 4, maxAgents: 25 },
  medium: { concurrency: 8, maxAgents: 50 },
  large: { concurrency: 16, maxAgents: 100 },
};

export const HARD_LIMITS = { concurrency: 16, maxAgents: 100 } as const;
