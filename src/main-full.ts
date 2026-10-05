import { boot } from "./ui/home";
import { createCrazyGamesAdapter } from "./portal/CrazyGamesAdapter";

boot(document.getElementById("app")!, createCrazyGamesAdapter());
