import { createHash } from "node:crypto";

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function normalize(value: unknown, ancestors: Set<object>, location: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`${location} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new CanonicalJsonError(`${location} contains unsupported value type ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`${location} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) {
          throw new CanonicalJsonError(`${location}[${index}] is a sparse array entry`);
        }
        if (!("value" in descriptor)) {
          throw new CanonicalJsonError(`${location}[${index}] is an accessor property`);
        }
        result.push(normalize(descriptor.value, ancestors, `${location}[${index}]`));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`${location} is not a plain JSON object`);
    }

    const record = value as Record<string, unknown>;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new CanonicalJsonError(`${location}.${key} is an accessor property`);
      }
      result[key] = normalize(descriptor.value, ancestors, `${location}.${key}`);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(normalize(value, new Set<object>(), "$"));
  if (serialized === undefined) {
    throw new CanonicalJsonError("Value cannot be represented as canonical JSON");
  }
  return serialized;
}

export function sha256Text(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
