// Device tier for weak hardware (user 2026-10-15: "optimize for 4gb ram
// chromebooks and old android and ios phones"). CrazyGames disables a game
// on ChromeOS when it isn't smooth on a 4GB device, and runs its own engine
// builds at DPR 1 on iOS + low-memory Android ("these devices crash with
// higher natively supported DPR"); we follow the same rule. Inputs: the
// portal's device info (SDK systemInfo, per the technical spec) and
// capability APIs only, never our own UA sniffing.

/** What the portal reports (PortalAdapter.deviceInfo()); null without SDK. */
export interface DeviceHints {
  type: "desktop" | "tablet" | "mobile";
  os: string;
}

export interface DeviceTier {
  /** <= 4GB RAM, iOS, or a touch device that hides its memory (Safari,
      Firefox): start at 1x, keep the menu backdrop on one map. */
  lowMemory: boolean;
  /** Pixel-ratio ceiling for every canvas (the frame watchdog only lowers it). */
  maxPixelRatio: number;
  /** Data saver / 2G-3G: no background downloads beyond what is played. */
  saveData: boolean;
}

type Nav = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };

function detect(hints: DeviceHints | null): DeviceTier {
  const nav = (typeof navigator === "object" ? navigator : {}) as Nav;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const mem = nav.deviceMemory;
  const lowMemory = (mem !== undefined && mem <= 4) || hints?.os === "iOS" || (coarse && mem === undefined);
  const touch = coarse || hints?.type === "mobile" || hints?.type === "tablet";
  const conn = nav.connection;
  const saveData = !!conn?.saveData || /2g|3g/.test(conn?.effectiveType ?? "");
  return { lowMemory, maxPixelRatio: lowMemory ? 1 : touch ? 1.5 : 2, saveData };
}

let tier = detect(null);

/** Boot: refine with the portal's device info once the SDK is up. */
export function initDeviceTier(hints: DeviceHints | null): void {
  tier = detect(hints);
}

export function deviceTier(): DeviceTier {
  return tier;
}
