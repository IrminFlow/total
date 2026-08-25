import { runSecurityAudit } from "./lib/security-audit.mjs";

const result = runSecurityAudit();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
