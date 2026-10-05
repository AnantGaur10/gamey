import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "dist-basic";
const budgetMB = Number(process.argv[3] ?? 20);

function bytes(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    return fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0);
  }
  return st.size;
}

if (!fs.existsSync(dir)) {
  console.error(`size-check: ${dir} missing (run build first)`);
  process.exit(1);
}
const mb = bytes(dir) / 1024 / 1024;
console.log(`size-check: ${dir} = ${mb.toFixed(2)}MB (budget ${budgetMB}MB)`);
if (mb > budgetMB) {
  console.error(`FAIL: exceeds budget`);
  process.exit(1);
}
console.log("PASS");
