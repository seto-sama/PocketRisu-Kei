import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte"
import { loadData } from "./ts/bootstrap"
import { mount } from "svelte"
import { applyEarlyFontPreference } from "./ts/gui/fontPreference"

applyEarlyFontPreference()
mount(App, {
    target: document.getElementById("app"),
})
loadData()
document.getElementById('preloading').remove()
