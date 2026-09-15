import { readFileSync } from "node:fs";
import { ManualAnalysisAdapter } from "./manual-analysis.js";
import { AnalysisStore } from "./store.js";

const dataDir = process.env.DATA_DIR?.trim() || "./data";
const adapter = new ManualAnalysisAdapter(dataDir, new AnalysisStore(dataDir));
const [command, batchId, filePath] = process.argv.slice(2);

if (command === "pending" && !batchId) {
  console.log(JSON.stringify(adapter.pending(), null, 2));
} else if (command === "export" && batchId && filePath) {
  console.log(JSON.stringify(adapter.export(batchId, filePath)));
} else if (command === "import" && batchId && filePath) {
  const results: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  console.log(JSON.stringify(adapter.import(batchId, results)));
} else {
  console.error("Usage: manual-analysis pending | export <batch-id> <private.json> | import <batch-id> <results.json>");
  process.exitCode = 2;
}
