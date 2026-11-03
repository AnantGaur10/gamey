// Landscape only (user 2026-11-02): a touch device held in portrait gets a
// "rotate your phone" card over the game, and a running duel pauses (the
// `gamey:portrait` event). Never an orientation LOCK (CrazyGames forbids
// coding one; specs/crazygames/technical.md §3): just a prompt. On
// crazygames.com the portal draws its own rotate prompt (landscape is set in
// the submission), so the card stays off there; the duel still pauses.
const PHONE = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="20" y="6" width="24" height="44" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="44" r="2" fill="currentColor"/><path d="M50 40a18 18 0 0 1-12 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M36 50l3 5 5-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let portrait = false;

/** True while a touch device is held in portrait. */
export function isPortrait(): boolean {
  return portrait;
}

export function installRotatePrompt(showCard: boolean): void {
  if (typeof matchMedia !== "function") return;
  const mq = matchMedia("(orientation: portrait) and (pointer: coarse)");
  const card = document.createElement("div");
  card.className = "rotate-card";
  card.innerHTML = `<div class="rc-phone">${PHONE}</div><b>ROTATE YOUR PHONE</b><small>Dustbound Duel plays in landscape</small>`;
  const apply = (): void => {
    portrait = mq.matches;
    if (showCard) {
      if (portrait && !card.isConnected) document.body.appendChild(card);
      if (!portrait) card.remove();
    }
    window.dispatchEvent(new CustomEvent("gamey:portrait", { detail: portrait }));
  };
  mq.addEventListener?.("change", apply);
  addEventListener("resize", apply);
  apply();
}
