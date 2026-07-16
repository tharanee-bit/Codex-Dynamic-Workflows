import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

/** Produce a deterministic, collision-resistant component safe for Git refs and paths. */
export function safeComponent(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return `${normalized || "item"}-${shortHash(value)}`;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${sep}`);
}
