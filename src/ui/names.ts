// Player display name (user 2026-10-23). A CrazyGames account name always
// wins (account spec: never ask a logged-in player for a separate name);
// guests are asked once after the tutorial (skippable), older saves get a
// random one, SETTINGS renames. Single player: only the player sees it.
import type { PortalAdapter, Progress } from "../portal/PortalAdapter";

const FIRST = ["Dusty", "Rattlesnake", "Lucky", "Silver", "Coyote", "Whiskey", "Tumbleweed", "Iron", "Copper", "Lone", "Rusty", "Sundown", "Mesa", "Buckshot", "Prairie", "Quick"];
const LAST = ["Jim", "Kid", "Pete", "Jack", "Sal", "Hank", "Belle", "Sam", "Joe", "Rose", "Cody", "Wade", "Mae", "Hoss", "Lou", "Ned"];

export const NAME_MAX = 16;

export function randomCowboyName(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${pick(FIRST)} ${pick(LAST)}`;
}

/** Typed name -> a safe display name, or null when nothing is left. */
export function cleanName(raw: string): string | null {
  const s = raw.replace(/[^A-Za-z0-9 _.'-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return s ? s : null;
}

/** Names are rendered through innerHTML templates (`el()`). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function displayName(adapter: PortalAdapter, p: Progress = adapter.loadProgress()): string {
  return adapter.getUser().name ?? p.playerName ?? "Stranger";
}
