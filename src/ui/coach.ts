// Tutorial coach (user 2026-10-12: "the tutorial should be the gateway to
// the game and there should be text to teach the player how to play the game
// every detail and also a skip button"). Two parts:
//  - live steps during the tutorial duel (holster, focus, draw, shots, hit):
//    a card beside the holster zone, pointing at it, that follows what the
//    player does. Never pauses the duel: timings stay the real game's.
//  - rule cards once the dummy is down (round over, gameplay stopped): the
//    rest of the game, NEXT / BACK, then PLAY.
// CrazyGames onboarding (specs/crazygames/quality-guidelines.md): in
// gameplay, skippable (the SKIP button stays up throughout), key / mouse /
// touch glyphs next to the words, no Esc. DOM only, pointer-events none on
// the live card so it never eats an aim or a tap.

export type CoachStep = "holster" | "retry" | "focus" | "draw" | "shot" | "hit";

export interface Coach {
  step(s: CoachStep, ammoLeft?: number): void;
  /** Re-anchor beside the holster zone (resize / camera refit). */
  place(zone: DOMRect): void;
  hide(): void;
  /** Rule cards over the finished round; `done` runs on PLAY. */
  rules(done: () => void): void;
  destroy(): void;
}

const key = (k: string) => `<kbd>${k}</kbd>`;
const MOUSE = `<svg class="ico" viewBox="0 0 16 22" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="19" rx="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="8" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.8"/></svg>`;
const TAP = `<svg class="ico" viewBox="0 0 20 22" aria-hidden="true"><circle cx="10" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".6"/><path d="M8 7v9l-2-2-1.6 1.4L9 21h7l1.5-7-6-1.4V7a1.5 1.5 0 0 0-3 0z" fill="currentColor"/></svg>`;

function live(s: CoachStep, coarse: boolean, ammoLeft: number): { t: string; b: string } {
  switch (s) {
    case "holster":
    case "retry":
      return {
        t: "1 · HOLSTER UP",
        b: (s === "retry" ? `<em>Out of bullets before he went down: that round is a draw. Again!</em> ` : "")
          + (coarse
            ? `${TAP} TAP the <b>HOLSTER</b> box to start the 3-second FOCUS countdown.`
            : `${MOUSE} Move your mouse INTO the <b>HOLSTER</b> box to start the 3-second FOCUS countdown. Keep it there: leaving the box restarts the countdown.`),
      };
    case "focus":
      return {
        t: "2 · FOCUS",
        b: (coarse
          ? `A marker swings round the ring. ${TAP} TAP anywhere when it is on the <b class="gold">GOLD</b> arc.`
          : `A marker swings round the ring. Press ${key("SPACE")} or ${key("ENTER")} when it is on the <b class="gold">GOLD</b> arc. Don't click.`)
          + ` Every hit shrinks your crosshair (the bright middle is a PERFECT). A miss freezes the marker for a moment.`,
      };
    case "draw":
      return {
        t: "3 · DRAW!",
        b: (coarse ? `${TAP} DRAG to aim at the outlaw, TAP to fire.` : `${MOUSE} Aim at the outlaw with the mouse, CLICK to fire.`)
          + ` Bullets land anywhere inside the circle. Go for the <b>HEAD</b>: a headshot kills instantly.`,
      };
    case "shot":
      return {
        t: "4 · PACE YOUR SHOTS",
        b: `Every shot kicks the crosshair wider; it settles back in about half a second. Six bullets a round (the cylinder, bottom right): <b>${ammoLeft} left</b>.`,
      };
    case "hit":
      return {
        t: "HIT!",
        b: `A body hit hurts, but it takes three or more to drop a man. A wounded duelist drops into a crouch (later hits can floor him), so his head moves: re-aim and finish him.`,
      };
  }
}

const RULES: Array<{ t: string; b: string }> = [
  {
    t: "WINNING",
    b: `<b>STANDARD</b>: best of 3 rounds, first to 2 wins.<br><b>DEATHMATCH</b>: duel after duel. Your health carries over, a win heals 10%, one loss ends the run.<br>Real outlaws shoot back, and they react faster every round.`,
  },
  {
    t: "HEADSHOTS",
    b: `A <b>headshot</b> always kills.`,
  },
  {
    t: "WOUNDS & RECOIL",
    b: `The first hit drops a duelist into a crouch; later hits can put him on his back. Both keep shooting while wounded.<br>Every shot kicks your crosshair wider for about half a second, and every hit you take throws it wide: don't spam.`,
  },
  {
    t: "NOON · DUSK · NIGHT",
    b: `Round 1 is at noon, round 2 in the dusk haze, round 3 at night.<br>At night the outlaw is invisible: only his muzzle flash gives him away.`,
  },
  {
    t: "SUDDEN DEATH",
    b: `Both go down at the same moment? <b>SUDDEN DEATH</b>: one round, full cylinders, the first hit wins.`,
  },
  {
    t: "GOLD & GEAR",
    b: `Wins pay gold. Spend it in the <b>SHOP</b> on new revolvers and a revive token (get back up once per game at 1 HP).<br>Pick where you fight with the <b>MAP</b> button. Replay this tutorial any time from the home screen.`,
  },
];

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function mountCoach(root: HTMLElement, coarse: boolean): Coach {
  const card = el(`<div class="coach" role="status" aria-live="polite"><div class="ct"></div><div class="cb"></div></div>`);
  root.appendChild(card);
  const ct = card.querySelector(".ct") as HTMLElement;
  const cb = card.querySelector(".cb") as HTMLElement;
  let cur: CoachStep | null = null;
  let panel: HTMLElement | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  function step(s: CoachStep, ammoLeft = 6): void {
    // A hit card stays up for the rest of the round (it covers the finish);
    // the shot card only follows the draw.
    if (cur === "hit" && s === "shot") return;
    if (s === cur && s !== "shot") return;
    const same = s === cur; // shot count update: no slide-in
    cur = s;
    const c = live(s, coarse, ammoLeft);
    ct.textContent = c.t;
    cb.innerHTML = c.b;
    if (same) return;
    card.classList.remove("in");
    void card.offsetWidth; // restart the slide-in
    card.classList.add("in", "on");
  }

  function place(z: DOMRect): void {
    if (z.width <= 0) return; // zone hidden after DRAW: keep the last spot
    const W = window.innerWidth;
    const left = Math.round(z.right + 14);
    const right = W - 122; // clear of the cylinder (90px + 20px margin)
    card.style.left = `${left}px`;
    card.style.width = `${Math.max(200, Math.min(520, right - left))}px`;
    card.style.bottom = `${Math.max(8, Math.round(window.innerHeight - z.bottom))}px`;
    card.style.setProperty("--ay", `${Math.round(z.height / 2 - 9)}px`); // arrow at the zone's middle
  }

  function hide(): void {
    card.classList.remove("on");
    cur = null;
  }

  function rules(done: () => void): void {
    hide();
    let i = 0;
    panel = el(`<div class="rules" role="dialog" aria-label="How to play">
      <div class="rk">HOW TO PLAY</div><div class="rt"></div><div class="rb"></div>
      <div class="rdots">${RULES.map(() => "<i></i>").join("")}</div>
      <div class="rnav"><button data-r="back">◂ BACK</button><button data-r="next" class="go">NEXT ▸</button></div>
      <div class="rhint">${coarse ? "Tap NEXT" : `${key("ENTER")} / ${key("SPACE")} next · ${key("←")} back`}</div>
    </div>`);
    root.appendChild(panel);
    const rt = panel.querySelector(".rt") as HTMLElement;
    const rb = panel.querySelector(".rb") as HTMLElement;
    const back = panel.querySelector("[data-r=back]") as HTMLButtonElement;
    const next = panel.querySelector("[data-r=next]") as HTMLButtonElement;
    const dots = Array.from(panel.querySelectorAll(".rdots i"));
    const paint = () => {
      rt.textContent = RULES[i].t;
      rb.innerHTML = RULES[i].b;
      back.style.visibility = i > 0 ? "visible" : "hidden";
      next.textContent = i < RULES.length - 1 ? "NEXT ▸" : "PLAY ▸";
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    };
    const go = (d: number) => {
      if (i + d >= RULES.length) { done(); return; }
      i = Math.max(0, i + d);
      paint();
    };
    back.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space" || e.code === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    paint();
  }

  function destroy(): void {
    if (onKey) window.removeEventListener("keydown", onKey);
    onKey = null;
    card.remove();
    panel?.remove();
  }

  return { step, place, hide, rules, destroy };
}
