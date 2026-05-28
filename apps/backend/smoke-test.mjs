import { TOOLS } from './src/tools/registry.js';

const jq      = TOOLS.find(t => t.name === "jq_query");
const diff     = TOOLS.find(t => t.name === "json_diff");
const sandbox  = TOOLS.find(t => t.name === "shell_sandbox");
const scan     = TOOLS.find(t => t.name === "git_scan_secrets");
const lint     = TOOLS.find(t => t.name === "lint_js");
const ingest   = TOOLS.find(t => t.name === "vault_ingest_file");

console.log("registered:", [jq,diff,sandbox,scan,lint,ingest].map(t=>t?.name).join(", "));

const r1 = await jq.execute({ input: JSON.stringify([{a:1},{a:2}]), filter: ".[0].a" }, {});
console.log("jq_query =>", r1.result);

const r2 = diff.execute({ before: JSON.stringify({x:1,y:2}), after: JSON.stringify({x:1,y:3,z:4}) }, {});
console.log("json_diff =>", JSON.stringify(r2.changes));

const r3 = await sandbox.execute({ cmd: "node -e 'console.log(42)'" }, {});
console.log("shell_sandbox stdout =>", r3.stdout?.trim(), "exit", r3.exitCode);
