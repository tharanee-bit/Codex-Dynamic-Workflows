const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SELECTOR_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/;

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

export function parseDottedSelector(selector: string): string[] {
  if (selector.length === 0) {
    throw new SelectorError("Selector must not be empty");
  }
  if (selector.length > 512) {
    throw new SelectorError("Selector exceeds the 512 character limit");
  }

  const segments = selector.split(".");
  for (const segment of segments) {
    if (!SELECTOR_SEGMENT.test(segment)) {
      throw new SelectorError(`Invalid selector segment ${JSON.stringify(segment)}`);
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new SelectorError(`Forbidden selector segment ${JSON.stringify(segment)}`);
    }
  }
  return segments;
}

export function selectDotted(source: unknown, selector: string): unknown {
  const segments = parseDottedSelector(selector);
  let current = source;

  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      throw new SelectorError(`Selector ${JSON.stringify(selector)} cannot traverse segment ${JSON.stringify(segment)}`);
    }

    if (Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/.test(segment)) {
      throw new SelectorError(`Array selector segment must be a non-negative integer, received ${JSON.stringify(segment)}`);
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new SelectorError(`Selector ${JSON.stringify(selector)} did not resolve at segment ${JSON.stringify(segment)}`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new SelectorError(`Selector ${JSON.stringify(selector)} cannot access an accessor property`);
    }
    current = descriptor.value as unknown;
  }

  return current;
}

export function renderPromptTemplate(template: string, context: unknown): string {
  const placeholder = /{{\s*([^{}]+?)\s*}}/g;
  const unmatched = template.replace(placeholder, "");
  if (unmatched.includes("{{") || unmatched.includes("}}")) {
    throw new SelectorError("Prompt contains an unmatched or nested template delimiter");
  }
  const rendered = template.replace(placeholder, (_match, rawSelector: string) => {
    const selector = rawSelector.trim();
    const value = selectDotted(context, selector);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SelectorError(`Selector ${JSON.stringify(selector)} resolved to a non-JSON value: ${message}`);
    }
    if (serialized === undefined) {
      throw new SelectorError(`Selector ${JSON.stringify(selector)} resolved to a non-JSON value`);
    }
    return serialized;
  });
  return rendered;
}
