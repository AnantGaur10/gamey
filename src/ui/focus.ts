// Focus input split by device (locked 2026-09-26 §9):
// - Touch (coarse pointer): two bottom-corner pads, pointer tracked.
// - PC (fine pointer): NO pads. Centered "MASH SPACE / ENTER" key bar with
//   a live fill showing bloom-shrink progress. Mouse does zero focus work.
// Keyboard Space/Enter always active on both (re-press = tap, hold = slow
// shrink). Taps outside pads during focus = miss (boot routes it).

export interface FocusHandlers {
  onTap(pad: "left" | "right" | "key"): void;
  onMiss(): void;
  onHold(dtSec: number): void;
}

export interface FocusUI {
  destroy(): void;
  /** 0..1 shrink progress for the PC key-bar fill. No-op on touch. */
  setProgress(f: number): void;
  /** Hide pads/bar at DRAW (aim takes over). */
  setVisible(v: boolean): void;
}

export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}

export function mountFocusUI(root: HTMLElement, h: FocusHandlers): FocusUI {
  const coarse = isCoarsePointer();
  const cleanups: Array<() => void> = [];
  const shown: HTMLElement[] = [];
  let fill: HTMLElement | null = null;

  if (coarse) {
    const left = document.createElement("div");
    left.className = "pad left";
    left.innerHTML = "TAP<small>thumb</small>";
    const right = document.createElement("div");
    right.className = "pad right";
    right.innerHTML = "TAP<small>thumb</small>";
    root.append(left, right);
    shown.push(left, right);

    const press = (el: HTMLElement, pad: "left" | "right") => {
      el.classList.add("active");
      h.onTap(pad);
      window.setTimeout(() => el.classList.remove("active"), 90);
    };
    const onL = (e: PointerEvent) => {
      e.preventDefault();
      press(left, "left");
    };
    const onR = (e: PointerEvent) => {
      e.preventDefault();
      press(right, "right");
    };
    left.addEventListener("pointerdown", onL);
    right.addEventListener("pointerdown", onR);
    cleanups.push(() => {
      left.removeEventListener("pointerdown", onL);
      right.removeEventListener("pointerdown", onR);
    });
  } else {
    const bar = document.createElement("div");
    bar.className = "keybar";
    bar.innerHTML =
      `<span class="klabel">MASH <b>SPACE</b> / <b>ENTER</b> TO FOCUS</span>` +
      `<span class="ktrack"><span class="kfill"></span></span>`;
    root.appendChild(bar);
    shown.push(bar);
    fill = bar.querySelector(".kfill") as HTMLElement;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.code === "Space" || e.code === "Enter") {
      if (e.repeat) {
        h.onHold(1 / 60);
        return;
      }
      e.preventDefault();
      h.onTap("key");
      if (fill) {
        fill.classList.add("pulse");
        window.setTimeout(() => fill && fill.classList.remove("pulse"), 90);
      }
    }
  };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));

  const onTouch = (e: TouchEvent) => {
    if ((e.target as HTMLElement).closest?.(".pad")) e.preventDefault();
  };
  document.addEventListener("touchstart", onTouch, { passive: false });
  cleanups.push(() => document.removeEventListener("touchstart", onTouch));

  return {
    destroy() {
      for (const c of cleanups) c();
      for (const s of shown) s.remove();
    },
    setProgress(f: number) {
      if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
    },
    setVisible(v: boolean) {
      for (const s of shown) s.classList.toggle("hidden", !v);
    },
  };
}
