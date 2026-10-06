import { boot } from "./ui/home";
import { createCrazyGamesAdapter } from "./portal/CrazyGamesAdapter";

// One build (2026-10-06): the CrazyGames SDK loads at runtime (Basic Launch
// allows it; ads stay off via ADS_ENABLED). init() never rejects: without
// the SDK the adapter plays in no-SDK mode.
const adapter = createCrazyGamesAdapter();
void adapter.init().then(() => boot(document.getElementById("app")!, adapter));
