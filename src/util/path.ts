import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/**
 * Resolve symlinks in the existing prefix of a path while preserving any
 * not-yet-created suffix. This gives persisted paths and permission allowlists
 * one filesystem identity on platforms such as macOS, where /var aliases
 * /private/var.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const suffix: string[] = [];
  let candidate = absolute;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}
