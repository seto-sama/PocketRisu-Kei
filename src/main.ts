import "./ts/polyfill";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";

preLoadCheck()
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
document.getElementById('preloading').remove()

export default app;
