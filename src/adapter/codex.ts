import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import { AgentExecutionError } from "../types.js";

import type {
  AgentAdapter,
  AgentEvent,
  AgentRequest,
  AgentResult,
  JsonValue,
  Usage,
} from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const BOUNDED_WORKER_CONTRACT = [
  "CODEX-DW BOUNDED WORKER CONTRACT:",
  "You are one leaf worker inside a centrally budgeted codex-dw run.",
  "Complete only the assigned call. Do not invoke codex-dw or dynamic workflows, and do not spawn or delegate to subagents.",
  "Return the requested structured result; the parent runtime owns orchestration, verification, and synthesis.",
].join("\n");

export function codexWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...inherited, CODEX_DW_ACTIVE: "1" };
}

function zeroUsage(): Usage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

function addUsage(target: Usage, value: Usage): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
}

function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (value === undefined) {
    throw new Error("Agent returned undefined instead of JSON");
  }
  return value as JsonValue;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown schema mismatch";
  return errors
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function safeEventData(event: ThreadEvent): JsonValue | undefined {
  if (event.type === "turn.completed") {
    return {
      inputTokens: event.usage.input_tokens,
      cachedInputTokens: event.usage.cached_input_tokens,
      outputTokens: event.usage.output_tokens,
      reasoningOutputTokens: event.usage.reasoning_output_tokens,
    };
  }
  if (event.type === "turn.failed") return { message: event.error.message };
  if (event.type === "error") return { message: event.message };
  if ("item" in event) {
    const item = event.item;
    const data: Record<string, JsonValue> = { itemType: item.type, itemId: item.id };
    if ("status" in item) data.status = String(item.status);
    if (item.type === "agent_message") data.length = item.text.length;
    if (item.type === "file_change") data.paths = item.changes.map((change) => change.path);
    return data;
  }
  return undefined;
}

interface TurnResult {
  response: string;
  usage: Usage;
}

export interface CodexAdapterOptions {
  codex?: Codex;
  schemaRepairAttempts?: number;
}

export class CodexAdapter implements AgentAdapter {
  readonly #codex: Codex;
  readonly #schemaRepairAttempts: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.#codex = options.codex ?? new Codex({ env: codexWorkerEnvironment() });
    this.#schemaRepairAttempts = options.schemaRepairAttempts ?? 1;
  }

  async run(request: AgentRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentResult> {
    const validator = ajv.compile(request.outputSchema) as ValidateFunction;
    const thread = request.threadId
      ? this.#codex.resumeThread(request.threadId, this.#threadOptions(request))
      : this.#codex.startThread(this.#threadOptions(request));

    const usage = zeroUsage();
    let attempts = 0;
    let prompt = `${BOUNDED_WORKER_CONTRACT}\n\n${request.prompt}`;
    let lastError = "Agent did not return valid structured output";

    if (thread.id) {
      await emit({
        type: "agent.thread",
        callId: request.callId,
        timestamp: new Date().toISOString(),
        data: { threadId: thread.id },
      });
    }

    try {
      while (attempts <= this.#schemaRepairAttempts) {
        attempts += 1;
        const turn = await this.#runTurn(thread, prompt, request, emit);
        addUsage(usage, turn.usage);
        try {
          const output = parseJson(turn.response);
          if (validator(output)) {
            return {
              output,
              usage,
              attempts,
              ...(thread.id ? { threadId: thread.id } : {}),
            };
          }
          lastError = describeErrors(validator.errors);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempts <= this.#schemaRepairAttempts) {
          prompt = [
            "Your prior response did not satisfy the required JSON Schema.",
            `Validation error: ${lastError}`,
            "Return only a corrected JSON value. Do not include Markdown fences or commentary.",
          ].join("\n");
          await emit({
            type: "agent.schema_repair",
            callId: request.callId,
            timestamp: new Date().toISOString(),
            data: { attempt: attempts + 1, error: lastError },
          });
        }
      }
      throw new Error(`Structured output validation failed after ${attempts} attempt(s): ${lastError}`);
    } catch (error) {
      throw new AgentExecutionError(
        error instanceof Error ? error.message : String(error),
        {
          ...(thread.id ? { threadId: thread.id } : {}),
          usage,
          attempts,
          cause: error,
        },
      );
    }
  }

  #threadOptions(request: AgentRequest) {
    return {
      sandboxMode: request.mode === "mutating" ? ("workspace-write" as const) : ("read-only" as const),
      modelReasoningEffort: request.reasoningEffort ?? ("xhigh" as const),
      networkAccessEnabled: request.networkAccess ?? false,
      webSearchMode: request.networkAccess ? ("live" as const) : ("disabled" as const),
      approvalPolicy: "never" as const,
      ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
      ...(request.model ? { model: request.model } : {}),
    };
  }

  async #runTurn(
    thread: Thread,
    prompt: string,
    request: AgentRequest,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<TurnResult> {
    const turn = await thread.runStreamed(prompt, {
      outputSchema: request.outputSchema,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    let response = "";
    const usage = zeroUsage();

    for await (const event of turn.events) {
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        response = event.item.text;
      }
      if (event.type === "turn.completed") {
        const completedUsage = {
          inputTokens: event.usage.input_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
          outputTokens: event.usage.output_tokens,
          reasoningOutputTokens: event.usage.reasoning_output_tokens,
        };
        addUsage(usage, completedUsage);
        await emit({
          type: "agent.usage",
          callId: request.callId,
          timestamp: new Date().toISOString(),
          data: completedUsage,
        });
      }
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
      const eventData = safeEventData(event);
      await emit({
        type: `codex.${event.type}`,
        callId: request.callId,
        timestamp: new Date().toISOString(),
        ...(eventData !== undefined ? { data: eventData } : {}),
      });
    }

    if (response.length === 0) throw new Error("Codex turn completed without an agent response");
    return { response, usage };
  }
}
