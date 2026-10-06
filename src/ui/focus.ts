// Focus input: timing QTE ring (user ask 2026-10-05, replaces the bar). The
// ring sits on the foe's body and its radius IS the crosshair radius, so it
// shrinks/grows with every result. A marker swings back and forth around the
// ring (the gap at the top is where it turns); press while it is on the gold
// arc. Every press moves the arc; a hit narrows it and reverses the marker
// (which speeds up as the crosshair shrinks), a miss stalls the marker red
// for 0.4s. Logic lives in src/game/timingQte.ts; this file only draws.
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
  /** Miss stall running: the needle draws red (anti-spam feedback). */
  stunned?: boolean;
  /** Ring centre in viewport px (the foe's body) and radius in px. */
  x: number;
  y: number;
  r: number;
}

export interface FocusUI {
  destroy(): void;
  /** 0..1 bloom-shrink progress (slim bar under the ring). */
  setProgress(f: number): void;
  /** Marker + arc + ring placement, every rendered frame. */
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
/** Turnaround gap at the top of the ring (degrees): QTE 0 and 1 sit at its edges. */
const GAP_DEG = 28;
/** Room around the ring for the stroke + marker (px). */
const PAD = 14;
const SVG_NS = "http://www.w3.org/2000/svg";

/** QTE position 0..1 -> clockwise angle from 12 o'clock (radians). */
function angleOf(f: number): number {
  const t = Math.min(1, Math.max(0, f));
  return ((GAP_DEG / 2 + t * (360 - GAP_DEG)) * Math.PI) / 180;
}

export function mountFocusUI(root: HTMLElement, h: FocusHandlers): FocusUI {
  const ui = document.createElement("div");
  ui.className = "qte";
  ui.innerHTML =
    `<svg class="qtrack" xmlns="${SVG_NS}">` +
    `<path class="qbase"/><path class="qzone"/><path class="qperfect"/><path class="qneedle"/>` +
    `</svg>` +
    `<span class="qinfo"><span class="qres"></span><span class="qstreak"></span></span>` +
    `<span class="qprog"><span class="qfill"></span></span>`;
  root.appendChild(ui);
  const svg = ui.querySelector(".qtrack") as SVGSVGElement;
  const baseEl = ui.querySelector(".qbase") as SVGPathElement;
  const zoneEl = ui.querySelector(".qzone") as SVGPathElement;
  const perfEl = ui.querySelector(".qperfect") as SVGPathElement;
  const needleEl = ui.querySelector(".qneedle") as SVGPathElement;
  const resEl = ui.querySelector(".qres") as HTMLElement;
  const streakEl = ui.querySelector(".qstreak") as HTMLElement;
  const fill = ui.querySelector(".qfill") as HTMLElement;
  let flashTimer = 0;
  let lastSize = -1;

  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return; // holding is not timing
    h.onPress();
  };
  window.addEventListener("keydown", onKey);

  // Arc between two QTE positions on a ring of radius r centred at (c, c).
  const arc = (c: number, r: number, f0: number, f1: number): string => {
    const a0 = angleOf(f0), a1 = angleOf(f1);
    const p = (a: number) => `${(c + r * Math.sin(a)).toFixed(2)} ${(c - r * Math.cos(a)).toFixed(2)}`;
    return `M ${p(a0)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
  };

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(flashTimer);
      ui.remove();
    },
    setProgress(f: number) {
      fill.style.width = `${(Math.min(1, Math.max(0, f)) * 100).toFixed(2)}%`;
    },
    render(v: QteView) {
      const r = v.r;
      const c = r + PAD;
      const size = Math.ceil(2 * c);
      if (size !== lastSize) {
        lastSize = size;
        svg.setAttribute("width", `${size}`);
        svg.setAttribute("height", `${size}`);
        svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
      }
      const rr = root.getBoundingClientRect();
      ui.style.left = `${v.x - rr.left}px`;
      ui.style.top = `${v.y - rr.top}px`;
      ui.style.setProperty("--qr", `${c}px`);
      ui.classList.toggle("stunned", !!v.stunned);
      baseEl.setAttribute("d", arc(c, r, 0, 1));
      zoneEl.setAttribute("d", arc(c, r, v.zoneC - v.zoneW / 2, v.zoneC + v.zoneW / 2));
      perfEl.setAttribute("d", arc(c, r, v.zoneC - v.perfectW / 2, v.zoneC + v.perfectW / 2));
      // Marker: a radial tick across the ring at the needle's angle.
      const a = angleOf(v.needle);
      const s = Math.sin(a), k = -Math.cos(a);
      const r0 = Math.max(2, r - 9), r1 = r + 9;
      needleEl.setAttribute("d", `M ${(c + r0 * s).toFixed(2)} ${(c + r0 * k).toFixed(2)} L ${(c + r1 * s).toFixed(2)} ${(c + r1 * k).toFixed(2)}`);
      streakEl.textContent = v.streak > 1 ? `x${v.streak}` : "";
    },
    flash(res: QteResult) {
      resEl.textContent = RESULT_TEXT[res];
      ui.classList.remove("hit-perfect", "hit-good", "hit-miss");
      void ui.offsetWidth; // restart the CSS flash
      ui.classList.add(`hit-${res}`);
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        resEl.textContent = "";
        ui.classList.remove("hit-perfect", "hit-good", "hit-miss");
      }, 420);
    },
    setVisible(v: boolean) {
      ui.classList.toggle("hidden", !v);
    },
  };
}
