import type { Codex, ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { CodexAdapter, codexWorkerEnvironment } from "../src/adapter/codex.js";
import type { AgentEvent, AgentRequest } from "../src/types.js";

function eventStream(events: ThreadEvent[]): AsyncIterable<ThreadEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

describe("CodexAdapter", () => {
  it("repairs invalid structured output once and aggregates usage", async () => {
    const prompts: string[] = [];
    const responses = ["not json", '{"ok":true}'];
    const thread = {
      id: "thread-1",
      async runStreamed(prompt: string) {
        prompts.push(prompt);
        const response = responses.shift()!;
        return {
          events: eventStream([
            { type: "item.completed", item: { id: "item", type: "agent_message", text: response } },
            {
              type: "turn.completed",
              usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 4 },
            },
          ] as ThreadEvent[]),
        };
      },
    };
    const options: unknown[] = [];
    const codex = {
      startThread(value: unknown) {
        options.push(value);
        return thread;
      },
      resumeThread() {
        throw new Error("unexpected resume");
      },
    } as unknown as Codex;
    const emitted: AgentEvent[] = [];
    const adapter = new CodexAdapter({ codex, schemaRepairAttempts: 1 });
    const request: AgentRequest = {
      callId: "phase/call",
      prompt: "Return JSON",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { const: true } },
      },
      reasoningEffort: "xhigh",
      networkAccess: false,
      mode: "read-only",
    };
    const result = await adapter.run(request, async (value) => { emitted.push(value); });

    expect(result.output).toEqual({ ok: true });
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 4, cachedInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 8 });
    expect(prompts[0]).toContain("CODEX-DW BOUNDED WORKER CONTRACT");
    expect(prompts[0]).toContain("Do not invoke codex-dw or dynamic workflows");
    expect(prompts[0]).toContain("Return JSON");
    expect(prompts[1]).toContain("Return only a corrected JSON value");
    expect(emitted.some((entry) => entry.type === "agent.schema_repair")).toBe(true);
    expect(options[0]).toMatchObject({ modelReasoningEffort: "xhigh", networkAccessEnabled: false });
    expect(options[0]).not.toHaveProperty("model");
  });

  it("marks SDK subprocesses as bounded workflow workers without dropping inherited environment", () => {
    const environment = codexWorkerEnvironment({ PATH: "/bin", CODEX_DW_ACTIVE: "old", OMIT: undefined });
    expect(environment).toEqual({ PATH: "/bin", CODEX_DW_ACTIVE: "1" });
  });

  it("resumes a persisted thread id", async () => {
    let resumed: string | undefined;
    const thread = {
      id: "thread-existing",
      async runStreamed() {
        return {
          events: eventStream([
            { type: "item.completed", item: { id: "item", type: "agent_message", text: "{}" } },
            {
              type: "turn.completed",
              usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
            },
          ] as ThreadEvent[]),
        };
      },
    };
    const codex = {
      startThread() { throw new Error("unexpected start"); },
      resumeThread(id: string) { resumed = id; return thread; },
    } as unknown as Codex;
    const adapter = new CodexAdapter({ codex });
    await adapter.run({
      callId: "phase/call",
      prompt: "resume",
      outputSchema: { type: "object" },
      threadId: "thread-existing",
    }, async () => undefined);
    expect(resumed).toBe("thread-existing");
  });
});
