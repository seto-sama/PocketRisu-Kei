import { expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ useServerDriveForFileImport: false }))
vi.mock('./platform', () => ({ isNodeServer: true, isCloudflareTunnel: false }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => db }))

const { installFilePickerContextMenu, shouldPickFromServerDrive } = await import('./serverDriveFilePicker.svelte')

it('opens the other file source once when a file picker trigger is right-clicked', () => {
    const uninstall = installFilePickerContextMenu()
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.dataset.filePicker = ''
    const sources: boolean[] = []
    trigger.addEventListener('click', () => sources.push(shouldPickFromServerDrive()))
    const rightClick = () => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        trigger.dispatchEvent(event)
        return event.defaultPrevented
    }

    expect(rightClick()).toBe(true)
    trigger.click()
    db.useServerDriveForFileImport = true
    rightClick()
    trigger.click()
    expect(sources).toEqual([true, false, false, true])

    uninstall()
    trigger.remove()
})
