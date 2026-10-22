// Store covers, step 2: lay the title over the Blender plates
// (scripts/blender/build_covers.py -> store/covers/plates/) in headless
// Chromium with the game's own title look (Rye, gold gradient, .menu.home h1
// in src/style.css). Writes store/covers/cover_<w>x<h>.png.
// Run: npm run build:covers (renders the plates first) or, plates already
// rendered, `node scripts/covers.mjs`.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const plates = process.env.COVER_OUT ?? resolve(root, 'store/covers/plates');
const out = process.env.COVER_FINAL ?? resolve(root, 'store/covers');
const font = readFileSync(resolve(root, 'src/assets/rye-latin.woff')).toString('base64');

// fit = title width / cover width; top = title top / cover height.
const COVERS = [
  { w: 1920, h: 1080, fit: 0.5, top: 0.07 },
  { w: 800, h: 1200, fit: 0.88, top: 0.08 },
  { w: 800, h: 800, fit: 0.78, top: 0.06 },
];

const html = (plate, c) => `<!doctype html><html><head><style>
@font-face { font-family: "Rye"; src: url(data:font/woff;base64,${font}) format("woff"); }
html, body { margin: 0; width: ${c.w}px; height: ${c.h}px; overflow: hidden; }
body { background: #2a1408 url(data:image/png;base64,${plate}) center / cover no-repeat; font-family: "Rye", serif; font-synthesis: none; }
h1 { position: absolute; left: 0; right: 0; top: ${c.top * c.h}px; margin: 0; display: flex; flex-direction: column; align-items: center; font-weight: normal; line-height: 0.95; }
.t1 { white-space: nowrap; letter-spacing: 0.04em;
  background: linear-gradient(180deg, #fff3cf 0%, #ffd678 46%, #c38a1c 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0.04em 0 #4a2c10) drop-shadow(0 0.1em 0.2em rgba(0, 0, 0, 0.75)); }
.t2 { display: flex; align-items: center; gap: 0.5em; margin-top: 0.12em; padding-left: 0.6em; letter-spacing: 0.6em; color: #ffe9bd;
  text-shadow: 0 0.05em 0 #4a2c10, 0 0.08em 0.3em rgba(0, 0, 0, 0.8); white-space: nowrap; }
.t2::before, .t2::after { content: ""; width: 2.2em; height: 0.08em; }
.t2::before { background: linear-gradient(90deg, rgba(255, 214, 120, 0), #ffd678); }
.t2::after { margin-left: -0.6em; background: linear-gradient(270deg, rgba(255, 214, 120, 0), #ffd678); }
</style></head><body><h1><span class="t1">HIGH NOON</span><span class="t2">DUEL</span></h1></body></html>`;

const browser = await chromium.launch({ headless: true });
for (const c of COVERS) {
  const name = `cover_${c.w}x${c.h}.png`;
  const src = resolve(plates, name);
  if (!existsSync(src)) throw new Error(`missing plate ${src}: run build_covers.py first`);
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 });
  await page.setContent(html(readFileSync(src).toString('base64'), c));
  await page.evaluate(async (c) => {
    await document.fonts.ready;
    const t1 = document.querySelector('.t1');
    const t2 = document.querySelector('.t2');
    t1.style.fontSize = '100px';
    const px = (100 * c.fit * c.w) / t1.getBoundingClientRect().width;
    t1.style.fontSize = `${px}px`;
    t2.style.fontSize = `${px * 0.46}px`;
  }, c);
  await page.screenshot({ path: resolve(out, name) });
  await page.close();
  console.log('cover', resolve(out, name));
}
await browser.close();
