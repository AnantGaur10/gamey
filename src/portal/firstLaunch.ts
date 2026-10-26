import type { PortalAdapter, Progress } from "./PortalAdapter";
import { safeLoad, safeSave } from "../store/SafeStore";

// First-launch gate (user 2026-10-14): a first-time player boots straight
// into the tutorial (CrazyGames quality guideline: land in gameplay, an
// in-gameplay skippable tutorial). The SDK has no first-play signal, so the
// answer is "nothing says this player has played":
// - the save (`Progress.tutorialDone`: SDK Data module, cloud-synced for
//   logged-in users; SafeStore in no-SDK mode),
// - a device flag in SafeStore, written synchronously next to the save. It
//   covers what the save alone misses: Data saves are debounced 1-30s (tab
//   closed right after SKIP), a later visit without the SDK (adblock) cannot
//   read the Data module's guest save, a login reload onto an account save
//   that predates the tutorial, and a Data call throwing at boot,
// - progress made before the tutorial existed (veteran saves).
// No storage at all (blocked cookies) = every session looks new; SKIP is one
// tap. A login needs nothing here: with the Data module the SDK reloads the
// game itself and this runs again on the account's save.

const SEEN_KEY = "gamey.tutorialSeen";
// Two-thumb touch controls (user 2026-10-26: left thumb holds the holster,
// right thumb the QTE pad, drag aims + a SHOOT button): every touch device
// sees the tutorial once more, veterans included. Device flag only: the
// controls belong to the device, not the account.
const TOUCH_SEEN_KEY = "gamey.touchTutorialSeen";

function hasPlayed(p: Progress): boolean {
  return (
    p.gold > 0 ||
    p.bestStreak > 0 ||
    p.bestBestOf > 0 ||
    p.reviveToken > 0 ||
    p.gunsOwned.length > 1 ||
    p.equippedGun !== "default" ||
    // Only the home screen sets these.
    p.settings.map !== undefined ||
    p.settings.mute
  );
}

/** True for a first-time player, and once per touch device for the
    two-thumb controls. Settles the answer for players who are not new: the
    save and the device flag both get the tutorial mark. */
export function needsTutorial(adapter: PortalAdapter, p: Progress, touch: boolean): boolean {
  if (touch && safeLoad(TOUCH_SEEN_KEY) !== "1") return true;
  const seenHere = safeLoad(SEEN_KEY) === "1";
  if (!p.tutorialDone && !seenHere && !hasPlayed(p)) return true;
  markTutorialSeen(adapter, p);
  return false;
}

/** Tutorial finished or skipped (or the player is not new): never forced again. */
export function markTutorialSeen(adapter: PortalAdapter, p: Progress = adapter.loadProgress()): void {
  if (safeLoad(SEEN_KEY) !== "1") safeSave(SEEN_KEY, "1");
  if (safeLoad(TOUCH_SEEN_KEY) !== "1") safeSave(TOUCH_SEEN_KEY, "1");
  if (p.tutorialDone) return;
  p.tutorialDone = true;
  adapter.saveProgress(p);
}
