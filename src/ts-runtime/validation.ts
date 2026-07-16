import type { JsonValue } from "../types.js";
import type { WorkflowMetadata } from "../workflow-api.js";
import type { TypeScriptWorkflowRpcRequest } from "./types.js";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${label} contains unsupported fields: ${extras.join(", ")}`);
}

function stableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new TypeError(`${label} must be a stable id`);
  }
}

export function assertJsonValue(value: unknown, label = "value", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON-serializable`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen);
  } else {
    const object = record(value, label);
    for (const item of Object.values(object)) assertJsonValue(item, label, seen);
  }
  seen.delete(value);
}

export function assertWorkflowMetadata(value: unknown): asserts value is WorkflowMetadata {
  const metadata = record(value, "Workflow metadata");
  exactKeys(metadata, ["name", "description", "argsSchema", "profile"], "Workflow metadata");
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") throw new TypeError("Workflow metadata name is required");
  if (typeof metadata.description !== "string" || metadata.description.trim() === "") throw new TypeError("Workflow metadata description is required");
  record(metadata.argsSchema, "Workflow metadata argsSchema");
  assertJsonValue(metadata.argsSchema, "Workflow metadata argsSchema");
  if (metadata.profile !== undefined && !["small", "medium", "large"].includes(String(metadata.profile))) {
    throw new TypeError("Workflow metadata profile is invalid");
  }
}

export function assertTypeScriptRpcRequest(value: unknown): asserts value is TypeScriptWorkflowRpcRequest {
  const request = record(value, "Workflow RPC request");
  if (request.method === "phase") {
    exactKeys(request, ["method", "id", "action", "error"], "Phase RPC request");
    stableId(request.id, "Phase id");
    if (!["start", "complete", "fail"].includes(String(request.action))) throw new TypeError("Phase action is invalid");
    if (request.error !== undefined && typeof request.error !== "string") throw new TypeError("Phase error must be a string");
    return;
  }
  if (request.method === "log") {
    exactKeys(request, ["method", "message", "data"], "Log RPC request");
    if (typeof request.message !== "string" || request.message.trim() === "") throw new TypeError("Log message is required");
    if (request.data !== undefined) assertJsonValue(request.data, "Log data");
    return;
  }
  if (request.method !== "agent") throw new TypeError("Workflow RPC method is invalid");
  exactKeys(request, ["method", "id", "prompt", "options"], "Agent RPC request");
  stableId(request.id, "Agent id");
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new TypeError("Agent prompt is required");
  const options = record(request.options, "Agent options");
  exactKeys(options, [
    "mode", "model", "reasoningEffort", "networkAccess", "ownership", "verification",
    "outputSchema", "input", "phaseId", "workspaceKey",
  ], "Agent options");
  if (options.mode !== undefined && options.mode !== "read-only" && options.mode !== "mutating") throw new TypeError("Agent mode is invalid");
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.trim() === "")) throw new TypeError("Agent model is invalid");
  if (options.reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(String(options.reasoningEffort))) throw new TypeError("Agent reasoning effort is invalid");
  if (options.networkAccess !== undefined && typeof options.networkAccess !== "boolean") throw new TypeError("Agent networkAccess must be boolean");
  const outputSchema = record(options.outputSchema, "Agent outputSchema");
  assertJsonValue(outputSchema, "Agent outputSchema");
  if (options.input !== undefined) assertJsonValue(options.input, "Agent input");
  if (options.phaseId !== undefined) stableId(options.phaseId, "Agent phaseId");
  if (options.workspaceKey !== undefined) stableId(options.workspaceKey, "Agent workspaceKey");
  if (options.ownership !== undefined) {
    if (!Array.isArray(options.ownership) || options.ownership.length === 0 || options.ownership.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new TypeError("Agent ownership must be a non-empty string array");
    }
  }
  if (options.verification !== undefined) {
    const verification = record(options.verification, "Agent verification");
    exactKeys(verification, ["prompt", "outputSchema"], "Agent verification");
    if (typeof verification.prompt !== "string" || verification.prompt.trim() === "") throw new TypeError("Verifier prompt is required");
    const schema = record(verification.outputSchema, "Verifier outputSchema");
    assertJsonValue(schema, "Verifier outputSchema");
  }
}
