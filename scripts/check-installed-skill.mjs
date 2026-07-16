import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const files = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/agent-contracts.md",
  "references/runtime.md",
  "references/workflow-patterns.md",
];
const installedRoot = join(homedir(), ".codex", "skills", "dynamic-workflows");
const mismatches = [];
for (const file of files) {
  const [repository, installed] = await Promise.all([
    readFile(file, "utf8"),
    readFile(join(installedRoot, file), "utf8").catch(() => undefined),
  ]);
  if (installed !== repository) mismatches.push(file);
}
if (mismatches.length > 0) {
  throw new Error(`Installed dynamic-workflows skill differs: ${mismatches.join(", ")}`);
}
console.log(`Installed dynamic-workflows skill matches ${files.length} files.`);
