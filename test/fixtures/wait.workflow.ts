export const meta = {
  name: "wait-fixture",
  description: "Detached CLI fixture for stop handling.",
  argsSchema: { type: "object", additionalProperties: false },
};

export async function run() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30_000));
  return { completedWithoutStop: true };
}
