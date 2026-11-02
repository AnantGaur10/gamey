// Preview / store photos of the cowboy lineup (tools/lineup.html), headless.
// Needs the dev server (npm run dev, port 5174). Query reference: tools/lineup.html.
//   node scripts/shots.mjs <out dir> name:query [name:query ...]
//   SIZE=1920x1080 (default) | 800x1200 | ...
// e.g. npm run shots -- shots row:map=town&labels=1 night:map=street&tod=2&pose=draw
//      npm run shots -- shots close:map=saloon&who=hero,widow&cam=0.6,1.6,3&look=0,1.3,0
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [out = "shots", ...specs] = process.argv.slice(2);
const [w, h] = (process.env.SIZE ?? "1920x1080").split("x").map(Number);
const base = process.env.BASE ?? "http://localhost:5174";
if (!specs.length) specs.push("lineup:map=town&labels=1");
fs.mkdirSync(out, { recursive: true });
try {
  await fetch(`${base}/tools/lineup.html`);
} catch {
  console.error(`shots: no dev server at ${base} (npm run dev)`);
  process.exit(1);
}
const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
for (const spec of specs) {
  const i = spec.indexOf(":");
  const name = i < 0 ? spec : spec.slice(0, i);
  const query = i < 0 ? "" : spec.slice(i + 1);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => console.error(`  ${name}: ${e.message}`));
  await page.goto(`${base}/tools/lineup.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 120000 });
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`shots: ${file}`);
  await page.close();
}
await browser.close();
