import "core-js/actual"
import "virtual:pocketrisu-local-fonts.css"
import { applyEarlyLanguage, language } from "./lang"

if (window.isSecureContext) {
    // Database defaults create UUIDs during module evaluation, so defer app imports until this check passes.
    void import('./start')
} else {
    applyEarlyLanguage()
    const title = document.createElement('h1')
    title.className = 'text-xl font-bold'
    title.textContent = language.secureConnectionRequiredTitle
    const message = document.createElement('p')
    message.className = 'mt-4 max-w-xl px-6 text-center text-base'
    message.textContent = language.secureConnectionRequiredBody
    document.getElementById('preloading')?.replaceChildren(title, message)
}
