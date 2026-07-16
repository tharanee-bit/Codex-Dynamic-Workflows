import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

const files = [
  ".github/workflows/ci.yml",
  "agents/openai.yaml",
  "examples/review.workflow.yaml",
  "examples/live-smoke.workflow.yaml",
];
for (const file of files) {
  const document = parseDocument(await readFile(file, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${file}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
}
console.log(`Parsed ${files.length} YAML files.`);
