import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const files = [
  "README.md",
  "SKILL.md",
  "references/runtime.md",
  "references/workflow-patterns.md",
  "references/agent-contracts.md",
];
const missing = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target.split("#", 1)[0]));
    try {
      await access(path);
    } catch {
      missing.push(`${file}: ${target}`);
    }
  }
}
if (missing.length > 0) {
  throw new Error(`Missing Markdown link targets:\n${missing.join("\n")}`);
}
console.log(`Checked local Markdown links in ${files.length} files.`);
