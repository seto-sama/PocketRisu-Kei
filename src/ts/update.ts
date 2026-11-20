import { writable } from "svelte/store"

export interface UpdateInfo {
    currentVersion: string
    latestVersion: string
    hasUpdate: boolean
    releaseNotes: string
}

/** Reactive store for update info — used by home screen and popup */
export const updateInfoStore = writable<UpdateInfo | null>(null)

/** Independent store for the update popup — does not collide with alertStore */
export const updatePopupStore = writable<UpdateInfo | null>(null)

export async function checkRisuUpdate(): Promise<void> {
    try {
        const res = await fetch('/api/update-check')
        if (!res.ok) return
        const data: UpdateInfo = await res.json()
        updateInfoStore.set(data)
        if (data.hasUpdate) showUpdatePopupOnce(data)
    } catch {}
}

const DISMISSED_KEY = 'pocketRisuKei_dismissedUpdateVersion'

function showUpdatePopupOnce(info: UpdateInfo) {
    const dismissed = localStorage.getItem(DISMISSED_KEY)
    if (dismissed === info.latestVersion) return

    localStorage.setItem(DISMISSED_KEY, info.latestVersion)
    updatePopupStore.set(info)
}

export function dismissUpdatePopup() {
    updatePopupStore.set(null)
}
