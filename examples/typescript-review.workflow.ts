import type { JsonValue } from "../src/types.js";
import type { WorkflowContext, WorkflowMetadata } from "../src/workflow-api.js";

export const meta: WorkflowMetadata = {
  name: "typescript-review",
  description: "Review several scopes concurrently and synthesize their structured findings.",
  argsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scopes"],
    properties: {
      scopes: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12 },
    },
  },
  profile: "small",
};

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "findings"],
  properties: {
    scope: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
} as const;

interface ReviewArgs {
  scopes: string[];
}

export async function run(context: WorkflowContext, rawArgs: JsonValue): Promise<JsonValue> {
  const args = rawArgs as unknown as ReviewArgs;
  return context.phase("review", async () => {
    await context.log("Starting scoped review", { scopeCount: args.scopes.length });
    const reviews = await context.pipeline(
      "review-scopes",
      args.scopes,
      async (scope, index) => context.agent(
        `review-${index}`,
        `Review ${scope}. Return only findings supported by direct evidence.`,
        { input: { scope }, outputSchema: reviewSchema },
      ),
      { concurrency: 4, key: (_scope, index) => `scope-${index}` },
    );

    return context.agent(
      "synthesize",
      "Deduplicate the scoped review results and rank the remaining findings by severity.",
      {
        input: reviews,
        outputSchema: {
          type: "object",
          required: ["findings"],
          properties: { findings: { type: "array", items: { type: "object" } } },
        },
      },
    );
  });
}
