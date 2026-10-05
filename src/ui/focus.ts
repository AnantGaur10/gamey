// Focus input: timing QTE (user ask 2026-10-05, replaces Space mashing and
// the touch tap pads). A needle ping-pongs across a bar; stop it in the gold
// zone. Every hit spawns a new, narrower zone; chain as many as you can
// before DRAW. Logic lives in src/game/timingQte.ts; this file only draws it.
// - PC: Space / Enter presses (key repeat ignored). Mouse clicks are a miss
//   (home.ts routes them; the mouse stays in the holster).
// - Touch: a tap anywhere outside the holster presses (home.ts routes it).

import type { QteResult } from "../game/timingQte";

export interface FocusHandlers {
  onPress(): void;
}

export interface QteView {
  needle: number;
  zoneC: number;
  zoneW: number;
  perfectW: number;
  streak: number;
}

export interface FocusUI {
  destroy(): void;
  /** 0..1 bloom-shrink progress (slim line under the bar). */
  setProgress(f: number): void;
  /** Needle + zone, every rendered frame. */
  render(v: QteView): void;
  /** One-shot result flash. */
  flash(res: QteResult): void;
  /** Hide at DRAW (aim takes over). */
  setVisible(v: boolean): void;
}

export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}

const RESULT_TEXT: Record<QteResult, string> = { perfect: "PERFECT!", good: "GOOD", miss: "MISS" };

export function mountFocusUI(root: HTMLElement, h: FocusHandlers): FocusUI {
  const coarse = isCoarsePointer();
  const bar = document.createElement("div");
  bar.className = "qte";
  bar.innerHTML =
    `<span class="qlabel">${coarse ? "<b>TAP</b>" : "<b>SPACE</b>"} ON THE GOLD · CHAIN HITS</span>` +
    `<span class="qtrack"><span class="qzone"><span class="qperfect"></span></span><span class="qneedle"></span></span>` +
    `<span class="qinfo"><span class="qres"></span><span class="qstreak"></span></span>` +
    `<span class="qprog"><span class="qfill"></span></span>`;
  root.appendChild(bar);
  const zoneEl = bar.querySelector(".qzone") as HTMLElement;
  const perfEl = bar.querySelector(".qperfect") as HTMLElement;
  const needleEl = bar.querySelector(".qneedle") as HTMLElement;
  const resEl = bar.querySelector(".qres") as HTMLElement;
  const streakEl = bar.querySelector(".qstreak") as HTMLElement;
  const fill = bar.querySelector(".qfill") as HTMLElement;
  let flashTimer = 0;

  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return; // holding is not timing
    h.onPress();
  };
  window.addEventListener("keydown", onKey);

  const pct = (f: number) => `${(Math.min(1, Math.max(0, f)) * 100).toFixed(2)}%`;
  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(flashTimer);
      bar.remove();
    },
    setProgress(f: number) {
      fill.style.width = pct(f);
    },
    render(v: QteView) {
      zoneEl.style.left = pct(v.zoneC - v.zoneW / 2);
      zoneEl.style.width = pct(v.zoneW);
      const pw = v.perfectW / v.zoneW;
      perfEl.style.left = pct((1 - pw) / 2);
      perfEl.style.width = pct(pw);
      needleEl.style.left = pct(v.needle);
      streakEl.textContent = v.streak > 1 ? `x${v.streak}` : "";
    },
    flash(res: QteResult) {
      resEl.textContent = RESULT_TEXT[res];
      bar.classList.remove("hit-perfect", "hit-good", "hit-miss");
      void bar.offsetWidth; // restart the CSS flash
      bar.classList.add(`hit-${res}`);
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        resEl.textContent = "";
        bar.classList.remove("hit-perfect", "hit-good", "hit-miss");
      }, 420);
    },
    setVisible(v: boolean) {
      bar.classList.toggle("hidden", !v);
    },
  };
}
