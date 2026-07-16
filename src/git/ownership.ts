import { minimatch } from "minimatch";

import { OwnershipViolationError } from "./errors.js";

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe repository-relative path: ${path}`);
  }
  return normalized;
}

function validatePattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("!") ||
    normalized.startsWith("#") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe ownership pattern: ${pattern}`);
  }
  return normalized;
}

export function assertOwnedPaths(paths: readonly string[], ownership: readonly string[]): void {
  if (paths.length === 0) return;
  if (ownership.length === 0) {
    throw new OwnershipViolationError(paths);
  }

  const patterns = ownership.map(validatePattern);
  const unexpected = paths
    .map(normalizeRepositoryPath)
    .filter(
      (path) =>
        !patterns.some((pattern) =>
          minimatch(path, pattern, {
            dot: true,
            matchBase: false,
            nocomment: true,
            nonegate: true,
          }),
        ),
    );
  if (unexpected.length > 0) {
    throw new OwnershipViolationError(unexpected);
  }
}
