// Download progress of the session's GLBs (2026-10-23), for the duel's
// loading bar on a cold first visit. The loaders (cowboyGlb, streetGlb,
// setGlb) feed it from GLTFLoader's onProgress; a URL counts as done once
// its parse settled (loaded or failed: the procedural fallback takes over).

type Entry = { loaded: number; total: number; done: boolean };
const entries = new Map<string, Entry>();

/** Weight of a file whose size is not known yet (no Content-Length). */
const GUESS_BYTES = 400_000;

export function noteLoadProgress(url: string, e: ProgressEvent): void {
  const en = entries.get(url) ?? { loaded: 0, total: 0, done: false };
  en.loaded = e.loaded;
  if (e.lengthComputable) en.total = e.total;
  entries.set(url, en);
}

export function noteLoadDone(url: string): void {
  const en = entries.get(url) ?? { loaded: 0, total: 0, done: false };
  en.done = true;
  entries.set(url, en);
}

/** Every URL settled this session (cached duel: no loading bar). */
export function allLoaded(urls: string[]): boolean {
  return urls.every((u) => entries.get(u)?.done);
}

/** 0..1 over the URLs, weighted by their byte size. */
export function loadFraction(urls: string[]): number {
  let got = 0;
  let all = 0;
  for (const u of urls) {
    const en = entries.get(u);
    const size = en?.total || Math.max(GUESS_BYTES, en?.loaded ?? 0);
    all += size;
    got += en?.done ? size : Math.min(en?.loaded ?? 0, size);
  }
  return all > 0 ? got / all : 1;
}
