// Incognito / ITP / partitioned-iframe safe key-value wrapper.
// Nothing can force a browser to persist when it refuses; this guarantees
// the game never crashes and keeps a full session copy instead.
const MEM = new Map<string, string>();
let lsUsable: boolean | null = null;

function lsAvailable(): boolean {
  if (lsUsable !== null) return lsUsable;
  try {
    const k = "__gamey_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    lsUsable = true;
  } catch {
    lsUsable = false;
  }
  return lsUsable;
}

export function safeLoad(key: string): string | null {
  try {
    if (lsAvailable()) {
      const v = window.localStorage.getItem(key);
      if (v !== null) return v;
    }
  } catch {
    lsUsable = false;
  }
  return MEM.has(key) ? MEM.get(key)! : null;
}

export function safeSave(key: string, value: string): void {
  MEM.set(key, value);
  try {
    if (lsAvailable()) window.localStorage.setItem(key, value);
  } catch {
    lsUsable = false;
    // session-only from here; game continues uninterrupted.
  }
}

export function storagePersisted(): boolean {
  try {
    return lsAvailable();
  } catch {
    return false;
  }
}
