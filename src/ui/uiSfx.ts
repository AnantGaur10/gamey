// UI sounds for every <button> in the game (user 2026-11-02): one delegated
// listener pair on the document, so new screens get them for free. All the
// game's clickables are <button>s.
import type { AudioManager, UiSfx } from "../audio/AudioManager";

function soundOf(b: HTMLButtonElement): UiSfx {
  if (b.classList.contains("primary") || b.classList.contains("go")) return "confirm";
  const k = b.dataset.b ?? b.dataset.r ?? b.dataset.n;
  if (k === "back" || k === "home" || k === "no" || k === "skip" || b.classList.contains("mapback")) return "back";
  return "click";
}

function buttonAt(t: EventTarget | null): HTMLButtonElement | null {
  const b = t instanceof Element ? t.closest("button") : null;
  return b && !b.disabled ? b : null;
}

export function installUiSfx(audio: AudioManager): void {
  // Hover: mouse only (a touch "hover" lands right before its click), and
  // once per button entered, not per child element crossed.
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const b = buttonAt(e.target);
    if (!b || b.contains(e.relatedTarget as Node | null)) return;
    audio.playUiSfx("hover");
  });
  document.addEventListener("click", (e) => {
    const b = buttonAt(e.target);
    if (b) audio.playUiSfx(soundOf(b));
  }, true); // capture: a handler that swaps the screen can't drop the sound
}
