import { boot } from "./ui/home";
import { createNoopAdapter } from "./portal/NoopAdapter";

boot(document.getElementById("app")!, createNoopAdapter());
