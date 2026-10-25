import { isCloudflareTunnel, isNodeServer } from './platform'
import { getDatabase } from './storage/database.svelte'

export interface ServerDriveFileRequest {
    extensions: string[]
    multiple: boolean
    finish: (files: File[]) => void
}

export const serverDriveAvailable = isNodeServer && !isCloudflareTunnel
export const serverDriveFileRequest = $state<{ current: ServerDriveFileRequest | null }>({ current: null })

// Set by a right-click on a [data-file-picker] trigger; the next picker uses the other file source.
let alternateSource = false

export function shouldPickFromServerDrive() {
    const alternate = alternateSource
    alternateSource = false
    return serverDriveAvailable && !!getDatabase().useServerDriveForFileImport !== alternate
}

export function pickServerDriveFiles(extensions: string[], multiple: boolean) {
    return new Promise<File[]>(resolve => {
        serverDriveFileRequest.current?.finish([])
        const request: ServerDriveFileRequest = {
            extensions,
            multiple,
            finish: files => {
                if (serverDriveFileRequest.current !== request) return
                serverDriveFileRequest.current = null
                resolve(files)
            },
        }
        serverDriveFileRequest.current = request
    })
}

export function installFilePickerContextMenu() {
    if (!serverDriveAvailable) return () => {}
    // Clear an unused override before the next user action.
    const reset = (event: Event) => { if (event.isTrusted) alternateSource = false }
    const open = (event: MouseEvent) => {
        const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-file-picker]') : null
        if (!trigger || trigger.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return
        event.preventDefault()
        event.stopPropagation()
        alternateSource = true
        trigger.click()
    }
    window.addEventListener('pointerdown', reset, true)
    window.addEventListener('keydown', reset, true)
    window.addEventListener('contextmenu', open, true)
    return () => {
        window.removeEventListener('pointerdown', reset, true)
        window.removeEventListener('keydown', reset, true)
        window.removeEventListener('contextmenu', open, true)
    }
}
