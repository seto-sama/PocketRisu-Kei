import "./ts/polyfill";
import "core-js/actual"
import "virtual:pocketrisu-local-fonts.css"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";
import { applyEarlyFontPreference } from "./ts/gui/fontPreference";

preLoadCheck()
applyEarlyFontPreference()
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
document.getElementById('preloading').remove()

export default app;
