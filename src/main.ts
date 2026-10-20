import { createCrazyGamesAdapter } from "./portal/CrazyGamesAdapter";

// One build (2026-10-06): the CrazyGames SDK loads at runtime (Basic Launch
// allows it; ads stay off via ADS_ENABLED). init() never rejects: without
// the SDK the adapter plays in no-SDK mode.
// Load order (2026-10-15, low-end pass): basic.html paints a CSS splash at
// once, and the game chunks (three + game code) download WHILE the SDK
// script loads and inits, instead of after it.
const root = document.getElementById("app")!;
const adapter = createCrazyGamesAdapter();
const game = import("./ui/home");
Promise.all([adapter.init(), game]).then(
  ([, m]) => m.boot(root, adapter),
  () => {
    // A game chunk failed to download (flaky mobile data): offer a reload.
    const splash = root.querySelector(".boot");
    splash?.classList.add("failed");
    splash?.querySelector("button")?.addEventListener("click", () => location.reload());
  },
);
