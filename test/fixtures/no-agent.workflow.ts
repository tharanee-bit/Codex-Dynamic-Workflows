export const meta = {
  name: "no-agent-fixture",
  description: "Detached CLI fixture that performs no Codex calls.",
  argsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string" } },
  },
};

export async function run(_context: unknown, args: { value: string }) {
  return { ok: true, value: args.value };
}
