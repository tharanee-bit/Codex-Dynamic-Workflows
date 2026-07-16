import type { AgentAdapter, AgentEvent, AgentRequest, AgentResult, JsonValue } from "../types.js";

export type FakeAgentHandler = (request: AgentRequest) => Promise<JsonValue> | JsonValue;

export class FakeAdapter implements AgentAdapter {
  readonly requests: AgentRequest[] = [];
  active = 0;
  peakActive = 0;

  constructor(private readonly handler: FakeAgentHandler) {}

  async run(request: AgentRequest, emit: (event: AgentEvent) => Promise<void>): Promise<AgentResult> {
    this.requests.push(request);
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    await emit({ type: "fake.started", callId: request.callId, timestamp: new Date().toISOString() });
    try {
      const output = await this.handler(request);
      await emit({ type: "fake.completed", callId: request.callId, timestamp: new Date().toISOString() });
      return {
        output,
        threadId: `fake-${request.callId}`,
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
        },
        attempts: 1,
      };
    } finally {
      this.active -= 1;
    }
  }
}
