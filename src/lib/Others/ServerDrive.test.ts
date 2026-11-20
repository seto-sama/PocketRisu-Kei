import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ServerDrive from './ServerDrive.svelte'
import { language } from 'src/lang'
import { DBState } from 'src/ts/stores.svelte'
import { DRIVE_TRASH_DIRECTORY as trashPath } from 'src/ts/trashRetention'
import { apiErrorCodes } from 'src/ts/network/apiError'
import { SaveConflictCancelledError } from 'src/ts/storage/saveConflict'

const { storage, notifyError, mdViewport, chooseConflictComparison, importFile, getCharacterImageFormat, showPopupEditor } = vi.hoisted(() => {
    return {
        storage: {
            listDrive: vi.fn(), driveMetadata: vi.fn(), renameDriveEntry: vi.fn(), copyDriveEntry: vi.fn(),
            createDriveDirectory: vi.fn(), uploadDriveFile: vi.fn(), downloadDriveFile: vi.fn(),
            deleteDriveEntry: vi.fn(), emptyDriveTrash: vi.fn(), driveThumbnailUrl: vi.fn(), readDriveFile: vi.fn(),
            restoreDriveTrashEntry: vi.fn(), deleteDriveTrashEntry: vi.fn(),
        },
        notifyError: vi.fn(),
        mdViewport: { current: true },
        chooseConflictComparison: vi.fn(),
        importFile: vi.fn(),
        getCharacterImageFormat: vi.fn(),
        showPopupEditor: vi.fn(),
    }
})
vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { Init: async () => {}, realStorage: storage } }))
vi.mock('src/ts/gui/breakpoints', () => ({ mdViewport, isTouchDevice: { current: false } }))
vi.mock('src/ts/alert', () => ({ notifyError, notifySuccess: vi.fn() }))
vi.mock('src/ts/storage/saveConflict', async importOriginal => {
    const original = await importOriginal<typeof import('src/ts/storage/saveConflict')>()
    return { ...original, chooseConflictComparison }
})
vi.mock('src/ts/characterCards', () => ({ importFile, getCharacterImageFormat }))
vi.mock('src/ts/parser/parser.svelte', () => ({ parseMarkdownSafe: (text: string) => text }))
vi.mock('src/ts/stores.svelte', async () => {
    const { fromStore, writable } = await import('svelte/store')
    const shortcuts = fromStore(writable<string[]>([]))
    const retention = fromStore(writable(3))
    return { showPopupEditor, DBState: { db: {
        get serverDriveShortcuts() { return shortcuts.current },
        set serverDriveShortcuts(value: string[]) { shortcuts.current = value },
        get trashRetentionDays() { return retention.current },
        set trashRetentionDays(value: number) { retention.current = value },
    } } }
})

let component: ReturnType<typeof mount>
const folder = { name: 'Documents', path: 'Documents', type: 'directory', size: null, createdAt: 100, modifiedAt: 200 }
const file = { name: 'report.txt', path: 'Documents/report.txt', type: 'file', size: 10, createdAt: 100, modifiedAt: 200 }
const renameResult = <T>(entry: T, moves: Array<{ from: string, to: string }> = []) => ({ entry, moves })
let rootEntries: Array<typeof folder | typeof file>
let files: Array<typeof folder | typeof file>
let trashEntries: typeof file[]

function parentPath(path: string) {
    const separator = path.lastIndexOf('/')
    return separator < 0 ? '' : path.slice(0, separator)
}

function dispatchDrag(target: EventTarget, type: string, dataTransfer = new DataTransfer()) {
    const event = new DragEvent(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(event)
    return { event, dataTransfer }
}

async function mountDrive() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(ServerDrive, { target })
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Documents'))
}

function button(label: string, root: ParentNode = document) {
    const result = [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find(element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
    expect(result, label).toBeDefined()
    return result!
}

function menuItems() {
    return document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')
}

function entry(name: string) {
    const result = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(element => element.textContent?.includes(name))
    expect(result, name).toBeDefined()
    return result!
}

async function openDocuments() {
    entry('Documents').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
}

function menuItem(label: string) {
    const result = [...menuItems()].find(item => item.textContent?.trim() === label)
    expect(result, label).toBeDefined()
    return result!
}

async function contextMenu(target: string | HTMLElement) {
    (typeof target === 'string' ? entry(target) : target).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"][data-state="open"]')).not.toBeNull())
}

function dialog(title: string) {
    const result = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find(element => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent === title)
    expect(result, title).toBeDefined()
    return result!
}

function folderMergeDialog(name: string) {
    const result = document.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(result).not.toBeNull()
    expect(document.getElementById(result!.getAttribute('aria-labelledby')!)?.textContent).toBe(language.serverDrive.mergeFolders)
    expect(document.getElementById(result!.getAttribute('aria-describedby')!)?.textContent)
        .toBe(language.serverDrive.folderConflict.replace('{name}', name))
    expect([...result!.querySelectorAll('button')].map(element => element.textContent?.trim()).sort())
        .toEqual([language.no, language.yes].sort())
    return result!
}

function chooseUpload(name = 'report.txt') {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['replacement'], name)], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function submitName(value: string) {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${language.name}"]`)!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

beforeEach(async () => {
    vi.resetAllMocks()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:drive-preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    localStorage.clear()
    mdViewport.current = true
    DBState.db.serverDriveShortcuts = []
    DBState.db.trashRetentionDays = 3
    rootEntries = [{ ...folder }]
    files = [{ ...file }]
    trashEntries = []
    storage.listDrive.mockImplementation(async (path: string) => ({
        path,
        entries: path === trashPath ? trashEntries
            : [...rootEntries, ...files].filter(entry => parentPath(entry.path) === path),
    }))
    storage.emptyDriveTrash.mockImplementation(async () => { trashEntries = [] })
    storage.driveThumbnailUrl.mockImplementation(entry =>
        `/thumbnail?path=${encodeURIComponent(entry.path)}&v=${entry.modifiedAt}:${entry.size}`)
    storage.readDriveFile.mockResolvedValue(new File([], 'import-file'))
    storage.driveMetadata.mockImplementation(async (path: string) => {
        const found = [...rootEntries, ...files].find(entry => entry.path === path)
        return found ? { ...found, size: found.type === 'directory' ? null : 42 } : { ...file, size: 42, path }
    })
    storage.createDriveDirectory.mockImplementation(async (path: string, name: string) => {
        const saved = { ...folder, name, path: path ? `${path}/${name}` : name }
        if (path) files = [...files.filter(item => item.path !== saved.path), saved]
        else rootEntries = [...rootEntries.filter(item => item.path !== saved.path), saved]
        return saved
    })
    storage.renameDriveEntry.mockImplementation(async (path: string, name: string, _policy: string, _merge: unknown, destination = '') => {
        const existing = [...rootEntries, ...files].find(item => item.path === path)
            ?? (path === folder.path ? folder : { ...file, path })
        const destinationPath = destination ? `${destination}/${name}` : name
        const saved = { ...existing, name, path: destinationPath }
        const descendants = [...rootEntries, ...files]
            .filter(item => item.path.startsWith(path + '/'))
            .map(item => ({ ...item, path: `${destinationPath}${item.path.slice(path.length)}` }))
        rootEntries = rootEntries.filter(item => item.path !== path && !item.path.startsWith(path + '/'))
        files = files.filter(item => item.path !== path && !item.path.startsWith(path + '/'))
        const targetList = parentPath(destinationPath) ? files : rootEntries
        if (targetList === files) files = [...files.filter(item => item.path !== destinationPath), saved, ...descendants]
        else rootEntries = [...rootEntries.filter(item => item.path !== destinationPath), saved, ...descendants]
        return renameResult(saved, [{ from: path, to: destinationPath }])
    })
    storage.uploadDriveFile.mockImplementation(async (_path, uploaded, _signal, mode) => {
        const name = mode === 'rename' ? 'report (1).txt' : uploaded.name
        const saved = { ...file, name, path: `Documents/${name}`, size: uploaded.size }
        files = [...files.filter(item => item.path !== saved.path), saved]
        return saved
    })
    chooseConflictComparison.mockResolvedValue([])
    importFile.mockResolvedValue(true)
    await mountDrive()
})

afterEach(async () => {
    if (component) await unmount(component)
    vi.useRealTimers()
    document.body.replaceChildren()
    localStorage.clear()
})

it('navigates the grid and shows fresh file properties only when requested from the context menu', async () => {
    expect(dialog(language.serverDrive.title)).toBeDefined()
    await openDocuments()
    button(language.serverDrive.back).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Documents'))
    button(language.serverDrive.forward).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
    entry('report.txt').click()
    await tick()
    expect(storage.driveMetadata).not.toHaveBeenCalled()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.metadata).click()
    await vi.waitFor(() => expect(dialog(language.serverDrive.metadata).textContent).toContain('42 B'))
    button(language.close, dialog(language.serverDrive.metadata)).click()
    await tick()
    button(language.serverDrive.up).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Documents'))
})

it('requests thumbnails for raster images and charx files, but not presets or modules', async () => {
    const image = { ...file, name: 'photo.webp', path: 'Documents/photo.webp' }
    const character = { ...file, name: 'card.charx', path: 'Documents/card.charx' }
    const preset = { ...file, name: 'prompt.risupreset', path: 'Documents/prompt.risupreset' }
    const module = { ...file, name: 'addon.risum', path: 'Documents/addon.risum' }
    files = [...files, image, character, preset, module]
    await openDocuments()

    const requested = new Set(storage.driveThumbnailUrl.mock.calls.map(([entry]) => entry.name))
    expect(requested).toEqual(new Set([image.name, character.name]))
    expect(document.querySelector(`[data-drive-entry="${image.path}"] img`)?.getAttribute('src'))
        .toContain(encodeURIComponent(image.path))
    expect(document.querySelector(`[data-drive-entry="${character.path}"] img`)).not.toBeNull()
    expect(document.querySelector(`[data-drive-entry="${preset.path}"] img`)).toBeNull()
    expect(document.querySelector(`[data-drive-entry="${module.path}"] img`)).toBeNull()
    expect(storage.driveMetadata).not.toHaveBeenCalled()
})

it('falls back after a thumbnail error and requests a new URL after the entry changes', async () => {
    const image = { ...file, name: 'photo.webp', path: 'Documents/photo.webp' }
    files = [...files, image]
    await openDocuments()

    const thumbnail = () => document.querySelector<HTMLImageElement>(`[data-drive-entry="${image.path}"] img`)
    await vi.waitFor(() => expect(thumbnail()).not.toBeNull())
    const originalUrl = thumbnail()!.getAttribute('src')
    thumbnail()!.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(thumbnail()).toBeNull())
    expect(document.querySelector(`[data-drive-entry="${image.path}"]`)).not.toBeNull()

    files = files.map(entry => entry.path === image.path ? { ...entry, modifiedAt: entry.modifiedAt + 1 } : entry)
    button(language.serverDrive.refresh).click()
    await vi.waitFor(() => expect(thumbnail()?.getAttribute('src')).not.toBe(originalUrl))
})

function footerLabels(root: HTMLElement) {
    return [...root.querySelectorAll('button')].map(element => element.textContent?.trim()).filter(Boolean)
}

it.each(['card.charx', 'prompt.risup', 'prompt.risupreset', 'addon.risum'])(
    'previews %s without downloading and imports it only from the preview', async name => {
        const imported = { ...file, name, path: `Documents/${name}` }
        files = [...files, imported]
        storage.readDriveFile.mockResolvedValueOnce(new File(['contents'], name))
        await openDocuments()

        entry(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const preview = await vi.waitFor(() => dialog(name))
        expect(storage.readDriveFile).not.toHaveBeenCalled()
        button(language.serverDrive.import, preview).click()

        await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce())
        expect(storage.readDriveFile).toHaveBeenCalledWith(imported.path, expect.any(AbortSignal))
        expect(importFile).toHaveBeenCalledWith(name, expect.any(File))
        expect(storage.downloadDriveFile).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    },
)

it('shows the charx thumbnail and reports risum as unavailable', async () => {
    const character = { ...file, name: 'card.charx', path: 'Documents/card.charx' }
    const module = { ...file, name: 'addon.risum', path: 'Documents/addon.risum' }
    files = [...files, character, module]
    await openDocuments()

    await contextMenu(character.name)
    menuItem(language.preview).click()
    const preview = await vi.waitFor(() => dialog(character.name))
    expect(preview.querySelector('img')?.getAttribute('src')).toBe(storage.driveThumbnailUrl(character))
    button(language.close, preview).click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1))

    entry(module.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const unavailable = await vi.waitFor(() => dialog(module.name))
    expect(unavailable.textContent).toContain(language.serverDrive.previewUnavailable)
    expect(footerLabels(unavailable)).toEqual(expect.arrayContaining([language.close, language.serverDrive.import]))
    expect(footerLabels(unavailable)).not.toContain(language.download)
    expect(storage.readDriveFile).not.toHaveBeenCalled()
    expect(importFile).not.toHaveBeenCalled()
})

it.each(['photo.webp', 'photo.png'])('previews the ordinary image %s with only a close action', async name => {
    const image = { ...file, name, path: `Documents/${name}` }
    files = [...files, image]
    storage.readDriveFile.mockResolvedValueOnce(new File(['image'], image.name))
    getCharacterImageFormat.mockResolvedValue(null)
    await openDocuments()

    entry(image.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    await vi.waitFor(() => expect(dialog(image.name).querySelector('img')?.getAttribute('src')).toBe('blob:drive-preview'))
    expect(footerLabels(dialog(image.name))).toEqual([language.close])
    button(language.close, dialog(image.name)).click()
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:drive-preview'))
    expect(dialog(language.serverDrive.title)).toBeDefined()
    expect(importFile).not.toHaveBeenCalled()
})

it('offers import for a character PNG and reuses the downloaded preview file', async () => {
    const image = { ...file, name: 'card.png', path: 'Documents/card.png' }
    files = [...files, image]
    const downloaded = new File(['image'], image.name)
    storage.readDriveFile.mockResolvedValueOnce(downloaded)
    getCharacterImageFormat.mockResolvedValue('png')
    await openDocuments()

    entry(image.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await vi.waitFor(() => expect(dialog(image.name).querySelector('img')).not.toBeNull())
    expect(importFile).not.toHaveBeenCalled()
    button(language.serverDrive.import, dialog(image.name)).click()

    await vi.waitFor(() => expect(importFile).toHaveBeenCalledExactlyOnceWith(image.name, downloaded))
    expect(storage.readDriveFile).toHaveBeenCalledOnce()
})

it('orders folder actions and downloads folders through the download API', async () => {
    await contextMenu('Documents')
    expect([...menuItems()].map(item => item.textContent?.trim())).toEqual([
        language.serverDrive.import, language.preview, language.download, language.serverDrive.addShortcut,
        language.cut, language.copy, language.serverDrive.moveToTrash, language.serverDrive.rename, language.serverDrive.metadata,
    ])
    expect(menuItem(language.serverDrive.import).getAttribute('aria-disabled')).toBe('true')
    expect(menuItem(language.preview).getAttribute('aria-disabled')).toBe('true')
    menuItem(language.download).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledExactlyOnceWith('Documents'))
})

it('copies into the current folder using the existing numbered-name conflict choice', async () => {
    await openDocuments()
    storage.copyDriveEntry.mockResolvedValueOnce({ ...file, name: 'report (1).txt', path: 'Documents/report (1).txt' })
    await contextMenu('report.txt')
    menuItem(language.copy).click()
    await tick()
    await contextMenu(document.querySelector('main')!)
    expect([...menuItems()].map(item => item.textContent?.trim())).toEqual([
        language.serverDrive.newFolder, language.serverDrive.upload, language.paste,
    ])
    menuItem(language.paste).click()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    button(language.serverDrive.keepBoth, document.querySelector('[role="alertdialog"]')!).click()

    await vi.waitFor(() => expect(storage.copyDriveEntry).toHaveBeenCalledExactlyOnceWith('Documents/report.txt', 'report.txt', 'rename', undefined, 'Documents'))
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()
})

it('pastes multiple cut entries in another folder and clears the cut clipboard', async () => {
    rootEntries = [...rootEntries, { ...folder, name: 'Archive', path: 'Archive' }]
    files = [...files, { ...file, name: 'a.txt', path: 'Documents/a.txt' }]
    await openDocuments()
    entry('report.txt').click()
    entry('a.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await contextMenu('a.txt')
    menuItem(language.cut).click()
    await tick()
    button(language.serverDrive.up).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Archive'))
    entry('Archive').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await vi.waitFor(() => expect(storage.listDrive).toHaveBeenLastCalledWith('Archive', expect.any(AbortSignal)))
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain(language.serverDrive.empty))
    await contextMenu(document.querySelector('main')!)
    menuItem(language.paste).click()

    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledTimes(2))
    expect(storage.renameDriveEntry.mock.calls.map(([path, name, conflict, merge, destination]) => ({ path, name, conflict, merge, destination }))).toEqual([
        { path: 'Documents/a.txt', name: 'a.txt', conflict: 'error', merge: undefined, destination: 'Archive' },
        { path: 'Documents/report.txt', name: 'report.txt', conflict: 'error', merge: undefined, destination: 'Archive' },
    ])
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
    await contextMenu(document.querySelector('main')!)
    expect(menuItem(language.paste).getAttribute('aria-disabled')).toBe('true')
    expect(storage.copyDriveEntry).not.toHaveBeenCalled()
})

it('duplicates a folder with a numbered name when copying it into its current parent', async () => {
    storage.copyDriveEntry.mockResolvedValueOnce({ ...folder, name: 'Documents (1)', path: 'Documents (1)' })
    await contextMenu('Documents')
    menuItem(language.copy).click()
    await tick()
    await contextMenu(document.querySelector('main')!)
    menuItem(language.paste).click()

    await vi.waitFor(() => expect(storage.copyDriveEntry).toHaveBeenCalledExactlyOnceWith('Documents', 'Documents', 'rename', undefined, ''))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()
})

it('shows JSON contents in the popup editor on double-click', async () => {
    const json = { ...file, name: 'notes.json', path: 'Documents/notes.json' }
    files = [...files, json]
    const contents = '{"note":"hello"}'
    storage.readDriveFile.mockResolvedValueOnce(new File([contents], json.name))
    await openDocuments()

    entry(json.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    await vi.waitFor(() => expect(showPopupEditor).toHaveBeenCalledOnce())
    const options = showPopupEditor.mock.calls[0][0]
    expect(options).toMatchObject({ value: contents, title: json.name, mode: 'plain', description: '', submitKind: 'download' })
    expect(options.onCommit).toBeUndefined()
    expect(storage.downloadDriveFile).not.toHaveBeenCalled()
    expect(importFile).not.toHaveBeenCalled()
    expect(options.onSubmit()).toBe(false)
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledExactlyOnceWith(json.path))
    expect(storage.readDriveFile).toHaveBeenCalledOnce()
})

it('places the truncated text notice in the popup editor description', async () => {
    const text = { ...file, name: 'notes.txt', path: 'Documents/notes.txt' }
    files = [...files, text]
    storage.readDriveFile.mockResolvedValueOnce(new File(['x'.repeat(1024 * 1024 + 1)], text.name))
    await openDocuments()

    entry(text.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    await vi.waitFor(() => expect(showPopupEditor).toHaveBeenCalledOnce())
    const options = showPopupEditor.mock.calls[0][0]
    expect(options.value).toHaveLength(1024 * 1024)
    expect(options.description).toBe(language.serverDrive.previewTruncated)
    expect(options.onCommit).toBeUndefined()
})

it.each([
    ['archive.zip', new Uint8Array([0, 255, 1])],
    ['document.PDF', '%PDF-1.7\nASCII-only PDF contents'],
])('keeps binary files such as %s available to download without a preview', async (name, contents) => {
    const binary = { ...file, name, path: `Documents/${name}` }
    files = [...files, binary]
    storage.readDriveFile.mockResolvedValueOnce(new File([contents], binary.name))
    await openDocuments()

    entry(binary.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    await vi.waitFor(() => expect(dialog(binary.name).textContent).toContain(language.serverDrive.previewUnavailable))
    expect(storage.downloadDriveFile).not.toHaveBeenCalled()
    expect(dialog(binary.name).querySelector('iframe')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    button(language.download, dialog(binary.name)).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledExactlyOnceWith(binary.path))
})

it('aborts a pending file read when the explorer unmounts before import', async () => {
    const character = { ...file, name: 'card.charx', path: 'Documents/card.charx' }
    files = [...files, character]
    let completeRead!: (data: File) => void
    let signal!: AbortSignal
    storage.readDriveFile.mockImplementationOnce((_path, requestSignal) => {
        signal = requestSignal
        return new Promise(resolve => { completeRead = resolve })
    })
    await openDocuments()

    entry(character.name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    button(language.serverDrive.import, await vi.waitFor(() => dialog(character.name))).click()
    await vi.waitFor(() => expect(storage.readDriveFile).toHaveBeenCalledOnce())
    const pendingRead = storage.readDriveFile.mock.results[0].value as Promise<File>
    await unmount(component)
    component = undefined
    expect(signal.aborted).toBe(true)

    completeRead(new File(['contents'], character.name))
    await pendingRead
    await Promise.resolve()
    expect(importFile).not.toHaveBeenCalled()
    expect(storage.downloadDriveFile).not.toHaveBeenCalled()
})

it('keeps the current file area visible until the next folder finishes loading', async () => {
    let resolveListing!: (value: { path: string, entries: typeof files }) => void
    storage.listDrive.mockImplementationOnce(() => new Promise(resolve => { resolveListing = resolve }))
    const previousEntry = entry('Documents')
    previousEntry.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('main')?.getAttribute('aria-busy')).toBe('true'))
    expect(document.querySelector('main')?.textContent).toContain('Documents')
    const sync = button(language.serverDrive.refresh)
    expect(sync.disabled).toBe(true)
    expect(sync.getAttribute('aria-busy')).toBe('true')
    const calls = storage.listDrive.mock.calls.length
    sync.click()
    expect(storage.listDrive).toHaveBeenCalledTimes(calls)

    resolveListing({ path: 'Documents', entries: files })
    await vi.waitFor(() => expect(document.querySelector('main')?.getAttribute('aria-busy')).toBe('false'))
    expect(entry('report.txt')).toBeDefined()
    expect(document.querySelector('main')?.textContent).not.toContain('Documents')
    expect(sync.disabled).toBe(false)
    expect(sync.hasAttribute('aria-busy')).toBe(false)
})

it('hides the dropdown for a folder without subfolders and navigates from an ancestor menu', async () => {
    await openDocuments()
    const expandButtons = [...document.querySelectorAll('nav button')]
        .filter(element => element.getAttribute('aria-label') === language.serverDrive.childFolders)
    expect(expandButtons).toHaveLength(1)

    expandButtons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(menuItem('Documents')).toBeDefined())
    expect(storage.listDrive.mock.lastCall?.[0]).toBe('')
    menuItem('Documents').click()
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    expect(storage.listDrive.mock.lastCall?.[0]).toBe('Documents')
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
})

it('keeps a failed rename editable and refreshes after a successful retry', async () => {
    await openDocuments()
    storage.renameDriveEntry.mockRejectedValueOnce(new Error('Drive unavailable'))
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${language.name}"]`)!
    await submitName('new.txt')
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Drive unavailable'))
    expect(input.disabled).toBe(false)
    storage.renameDriveEntry.mockImplementationOnce(async () => {
        const saved = { ...file, name: 'new.txt', path: 'Documents/new.txt' }
        files = [saved]
        return renameResult(saved)
    })
    await submitName('new.txt')
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('new.txt'))
})

it.each(['overwrite', 'rename', 'cancel'] as const)('offers %s when renaming a file onto an existing file', async choice => {
    const existing = { ...file, name: 'archive.txt', path: 'Documents/archive.txt' }
    files = [{ ...file }, existing]
    await openDocuments()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('archive.txt')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()

    const alert = document.querySelector('[role="alertdialog"]')!
    const label = choice === 'overwrite' ? language.serverDrive.overwrite : choice === 'rename' ? language.serverDrive.keepBoth : language.cancel
    if (choice !== 'cancel') {
        const saved = choice === 'rename' ? { ...existing, name: 'archive (1).txt', path: 'Documents/archive (1).txt' } : existing
        storage.renameDriveEntry.mockImplementationOnce(async (_path: string, _name: string, policy: string) => {
            expect(policy).toBe(choice)
            files = [...files.filter(item => item.path !== file.path && item.path !== existing.path), saved]
            return renameResult(saved)
        })
    }
    button(label, alert).click()

    if (choice === 'cancel') {
        await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
        expect(storage.renameDriveEntry).not.toHaveBeenCalled()
        expect(document.querySelector('main')?.textContent).toContain('report.txt')
        expect(document.querySelector('main')?.textContent).toContain('archive.txt')
    } else {
        const savedName = choice === 'rename' ? 'archive (1).txt' : 'archive.txt'
        await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(document.querySelector(`input[aria-label="${language.name}"]`)).toBeNull())
        await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain(savedName))
        expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith('Documents/report.txt', 'archive.txt', choice, undefined, 'Documents')
        if (choice === 'overwrite') expect(document.querySelector('main')?.textContent).not.toContain('report.txt')
    }
    expect(notifyError).not.toHaveBeenCalled()
})

it('asks for a choice when another device creates the rename target after the folder was loaded', async () => {
    await openDocuments()
    const existing = { ...file, name: 'raced.txt', path: 'Documents/raced.txt' }
    const saved = { ...file, name: 'raced (1).txt', path: 'Documents/raced (1).txt' }
    storage.driveMetadata.mockResolvedValueOnce(existing)
    storage.renameDriveEntry.mockRejectedValueOnce({ code: 'DRIVE_ALREADY_EXISTS' })
    storage.renameDriveEntry.mockImplementationOnce(async () => {
        files = [...files, saved]
        return renameResult(saved)
    })
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('raced.txt')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('raced.txt'))
    button(language.serverDrive.keepBoth).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('raced (1).txt'))
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(1, 'Documents/report.txt', 'raced.txt', 'error', undefined, 'Documents')
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(2, 'Documents/report.txt', 'raced.txt', 'rename', undefined, 'Documents')
    expect(notifyError).not.toHaveBeenCalled()
})

it('merges a renamed folder with destination previews and choices keyed by full conflict path', async () => {
    const existing = { ...folder, name: 'Archive', path: 'Archive' }
    rootEntries = [{ ...folder }, existing]
    button(language.serverDrive.refresh).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Archive'))
    DBState.db.serverDriveShortcuts = ['Documents', 'Documents/sub', 'Documents/sub/deep', 'Documents-old']

    const names = ['skip.txt', 'server.txt', 'local.txt', 'both.txt']
    const conflicts = names.map(name => ({
        path: `Archive/sub/${name}`,
        existing: { ...file, name, path: `Archive/sub/${name}` },
        incoming: { ...file, name, path: `Documents/sub/${name}` },
    }))
    const plan = { revision: 'revision-1', conflicts }
    storage.renameDriveEntry.mockRejectedValueOnce({ status: 409, code: apiErrorCodes.DRIVE_MERGE_CONFLICT, details: plan })
    storage.renameDriveEntry.mockResolvedValueOnce(renameResult(existing, [
        { from: 'Documents/sub', to: 'Archive/sub' },
        { from: 'Documents/sub/deep', to: 'Archive/renamed-deep' },
    ]))
    chooseConflictComparison.mockResolvedValueOnce([null, 'server', 'local', 'both'])

    await contextMenu('Documents')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('Archive')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    button(language.yes, folderMergeDialog('Archive')).click()

    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledTimes(2))
    const comparison = chooseConflictComparison.mock.calls[0][0]
    expect(comparison.items).toHaveLength(4)
    expect(comparison.items[0].blocks[0].server).toMatchObject({
        name: 'skip.txt',
        text: expect.stringContaining('Archive/sub/skip.txt'),
    })
    expect(comparison.items[0].blocks[0].local).toMatchObject({
        name: 'skip.txt',
        text: expect.stringContaining('Documents/sub/skip.txt'),
    })
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(1, 'Documents', 'Archive', 'overwrite', undefined, '')
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(2, 'Documents', 'Archive', 'overwrite', {
        revision: 'revision-1',
        choices: {
            'Archive/sub/skip.txt': null,
            'Archive/sub/server.txt': 'server',
            'Archive/sub/local.txt': 'local',
            'Archive/sub/both.txt': 'both',
        },
    }, '')
    await vi.waitFor(() => expect(DBState.db.serverDriveShortcuts).toEqual([
        'Documents', 'Archive/sub', 'Archive/renamed-deep', 'Documents-old',
    ]))
    expect(document.querySelector('main')?.textContent).toContain('Archive')
    expect(notifyError).not.toHaveBeenCalled()
})

it('leaves the source in place and does not retry a folder merge after comparison is cancelled', async () => {
    const existing = { ...folder, name: 'Archive', path: 'Archive' }
    rootEntries = [{ ...folder }, existing]
    button(language.serverDrive.refresh).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Archive'))
    const conflicts = [{
        path: 'Archive/report.txt',
        existing: { ...file, name: 'report.txt', path: 'Archive/report.txt' },
        incoming: { ...file, name: 'report.txt', path: 'Documents/report.txt' },
    }]
    storage.renameDriveEntry.mockRejectedValueOnce({
        status: 409,
        code: apiErrorCodes.DRIVE_MERGE_CONFLICT,
        details: { revision: 'revision-1', conflicts },
    })
    chooseConflictComparison.mockRejectedValueOnce(new SaveConflictCancelledError())

    await contextMenu('Documents')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('Archive')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    button(language.yes, folderMergeDialog('Archive')).click()

    await vi.waitFor(() => expect(chooseConflictComparison).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
    expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith('Documents', 'Archive', 'overwrite', undefined, '')
    expect(rootEntries.map(item => item.path)).toEqual(['Documents', 'Archive'])
    expect(document.querySelector(`input[aria-label="${language.name}"]`)).not.toBeNull()
    expect(notifyError).not.toHaveBeenCalled()
})

it('shows a fresh merge plan after a stale revision before retrying', async () => {
    const existing = { ...folder, name: 'Archive', path: 'Archive' }
    rootEntries = [{ ...folder }, existing]
    button(language.serverDrive.refresh).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Archive'))
    const plan = (revision: string, name: string) => ({
        revision,
        conflicts: [{
            path: `Archive/${name}.txt`,
            existing: { ...file, name: `${name}.txt`, path: `Archive/${name}.txt` },
            incoming: { ...file, name: `${name}.txt`, path: `Documents/${name}.txt` },
        }],
    })
    const firstPlan = plan('revision-1', 'first')
    const freshPlan = plan('revision-2', 'fresh')
    storage.renameDriveEntry.mockRejectedValueOnce({ status: 409, code: apiErrorCodes.DRIVE_MERGE_CONFLICT, details: firstPlan })
    storage.renameDriveEntry.mockRejectedValueOnce({ status: 409, code: apiErrorCodes.DRIVE_MERGE_CONFLICT, details: freshPlan })
    storage.renameDriveEntry.mockResolvedValueOnce(renameResult(existing, []))
    chooseConflictComparison.mockResolvedValueOnce(['server']).mockResolvedValueOnce(['local'])

    await contextMenu('Documents')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('Archive')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    button(language.yes, folderMergeDialog('Archive')).click()

    await vi.waitFor(() => expect(chooseConflictComparison).toHaveBeenCalledTimes(2))
    expect(chooseConflictComparison.mock.calls[0][0].items[0].label).toBe('Archive/first.txt')
    expect(chooseConflictComparison.mock.calls[1][0].items[0].label).toBe('Archive/fresh.txt')
    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledTimes(3))
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(1, 'Documents', 'Archive', 'overwrite', undefined, '')
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(2, 'Documents', 'Archive', 'overwrite', {
        revision: 'revision-1', choices: { 'Archive/first.txt': 'server' },
    }, '')
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(3, 'Documents', 'Archive', 'overwrite', {
        revision: 'revision-2', choices: { 'Archive/fresh.txt': 'local' },
    }, '')
    expect(notifyError).not.toHaveBeenCalled()
})

it('does not ask for a conflict when a file is renamed to its current name', async () => {
    await openDocuments()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('report.txt')
    await vi.waitFor(() => expect(document.querySelector(`input[aria-label="${language.name}"]`)).toBeNull())
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.querySelector('main')?.textContent).toContain('report.txt')
})

it('does not start another listing when a rename completes after the explorer closes', async () => {
    let completeRename!: () => void
    const saved = { ...file, name: 'renamed.txt', path: 'Documents/renamed.txt' }
    storage.renameDriveEntry.mockImplementationOnce(() => new Promise(resolve => { completeRename = () => resolve(renameResult(saved)) }))
    await openDocuments()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('renamed.txt')
    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledOnce())
    const listings = storage.listDrive.mock.calls.length
    await unmount(component)
    component = undefined

    completeRename()
    await tick()
    expect(storage.listDrive).toHaveBeenCalledTimes(listings)
})

it('clears selection on Escape before dismissing the explorer', async () => {
    const target = entry('Documents')
    target.click()
    await tick()
    expect(target.getAttribute('aria-pressed')).toBe('true')

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(target.getAttribute('aria-pressed')).toBe('false')
    expect(dialog(language.serverDrive.title)).toBeDefined()

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})

it('pins folders as shortcuts, restores them when reopened and removes them', async () => {
    await contextMenu('Documents')
    menuItem(language.serverDrive.addShortcut).click()
    await tick()
    expect(DBState.db.serverDriveShortcuts).toEqual(['Documents'])
    button(language.serverDrive.driveRoot, document.querySelector('nav')!).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Documents'))
    await unmount(component)
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(ServerDrive, { target })
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Documents'))
    button('Documents', document.querySelector(`[aria-label="${language.serverDrive.shortcuts}"]`)!).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
    await contextMenu(button('Documents', document.querySelector(`[aria-label="${language.serverDrive.shortcuts}"]`)!))
    menuItem(language.serverDrive.removeShortcut).click()
    await tick()
    expect(DBState.db.serverDriveShortcuts).toEqual([])
})

it('updates nested shortcuts when a folder is renamed', async () => {
    const saved = { ...folder, name: 'Renamed', path: 'Renamed' }
    DBState.db.serverDriveShortcuts = ['Documents', 'Documents/subfolder', 'Documents-old']
    storage.renameDriveEntry.mockImplementationOnce(async () => {
        rootEntries = [saved]
        return renameResult(saved, [{ from: 'Documents', to: saved.path }])
    })
    await contextMenu('Documents')
    menuItem(language.serverDrive.rename).click()
    await tick()
    await submitName('Renamed')
    await vi.waitFor(() => expect(DBState.db.serverDriveShortcuts).toEqual(['Renamed', 'Renamed/subfolder', 'Documents-old']))
    expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith('Documents', 'Renamed', 'error', undefined, '')
})

it('moves every selected file dropped on a grid folder, even when its later click changes selection', async () => {
    const target = { ...folder, name: 'Target', path: 'Documents/Target' }
    const alpha = { ...file, name: 'alpha.txt', path: 'Documents/alpha.txt' }
    const beta = { ...file, name: 'beta.txt', path: 'Documents/beta.txt' }
    files = [{ ...file }, target, alpha, beta]
    await openDocuments()
    entry('alpha.txt').click()
    entry('beta.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await tick()

    const transfer = dispatchDrag(entry('alpha.txt'), 'dragstart').dataTransfer
    entry('alpha.txt').click()
    await tick()
    expect(entry('alpha.txt').getAttribute('aria-pressed')).toBe('true')
    expect(entry('beta.txt').getAttribute('aria-pressed')).toBe('false')

    dispatchDrag(entry('Target'), 'dragover', transfer)
    await tick()
    expect(entry('Target').getAttribute('data-selected')).toBe('true')
    dispatchDrag(entry('Target'), 'drop', transfer)

    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledTimes(2))
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(1, 'Documents/alpha.txt', 'alpha.txt', 'error', undefined, 'Documents/Target')
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(2, 'Documents/beta.txt', 'beta.txt', 'error', undefined, 'Documents/Target')
    await vi.waitFor(() => expect(document.querySelector('[data-drive-entry="Documents/alpha.txt"]')).toBeNull())
    expect(document.querySelector('[data-drive-entry="Documents/beta.txt"]')).toBeNull()
    expect(notifyError).not.toHaveBeenCalled()
})

it('moves an unselected folder by its returned path mappings and remaps nested shortcuts', async () => {
    const incoming = { ...folder, name: 'Incoming', path: 'Documents/Incoming' }
    const target = { ...folder, name: 'Target', path: 'Documents/Target' }
    const nested = { ...folder, name: 'Nested', path: 'Documents/Incoming/Nested' }
    files = [{ ...file }, incoming, target, nested]
    DBState.db.serverDriveShortcuts = [
        'Documents/Incoming',
        'Documents/Incoming/Nested',
        'Documents/Incoming-old',
    ]
    await openDocuments()

    const transfer = dispatchDrag(entry('Incoming'), 'dragstart').dataTransfer
    dispatchDrag(entry('Target'), 'dragover', transfer)
    dispatchDrag(entry('Target'), 'drop', transfer)

    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledOnce())
    expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith(
        'Documents/Incoming', 'Incoming', 'error', undefined, 'Documents/Target',
    )
    await vi.waitFor(() => expect(DBState.db.serverDriveShortcuts).toEqual([
        'Documents/Target/Incoming',
        'Documents/Target/Incoming/Nested',
        'Documents/Incoming-old',
    ]))
    expect(document.querySelector('[data-drive-entry="Documents/Incoming"]')).toBeNull()
    expect(notifyError).not.toHaveBeenCalled()
})

it('ignores drops on the current grid, current breadcrumb and a folder onto itself', async () => {
    const target = { ...folder, name: 'Target', path: 'Documents/Target' }
    files = [{ ...file }, target]
    await openDocuments()
    const main = document.querySelector('main')!

    let transfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    dispatchDrag(main, 'dragover', transfer)
    dispatchDrag(main, 'drop', transfer)
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()

    transfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    const navigation = document.querySelector(`nav[aria-label="${language.serverDrive.path}"]`)!
    const currentBreadcrumb = [...navigation.querySelectorAll<HTMLButtonElement>('button')]
        .find(element => element.textContent?.trim() === 'Documents')!
    dispatchDrag(currentBreadcrumb, 'drop', transfer)
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()

    transfer = dispatchDrag(entry('Target'), 'dragstart').dataTransfer
    dispatchDrag(entry('Target'), 'drop', transfer)
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
})

it('clears a cancelled drag so the file can be dropped on the root IconButton', async () => {
    await openDocuments()
    const rootButton = [...document.querySelectorAll<HTMLButtonElement>(
        `nav[aria-label="${language.serverDrive.path}"] button`,
    )].find(element => element.title === language.serverDrive.driveRoot
        || element.getAttribute('aria-label') === language.serverDrive.driveRoot)
    expect(rootButton).toBeDefined()

    const cancelledTransfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    dispatchDrag(entry('report.txt'), 'dragend', cancelledTransfer)
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()

    const transfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    dispatchDrag(rootButton!, 'dragover', transfer)
    await tick()
    expect(rootButton!.getAttribute('data-selected')).toBe('true')
    dispatchDrag(rootButton!, 'drop', transfer)

    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledOnce())
    expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith(
        'Documents/report.txt', 'report.txt', 'error', undefined, '',
    )
    await vi.waitFor(() => expect(document.querySelector('[data-drive-entry="Documents/report.txt"]')).toBeNull())
    expect(notifyError).not.toHaveBeenCalled()
})

it('cancels a file move conflict and ignores another drag while the choice dialog is open', async () => {
    const target = { ...folder, name: 'Target', path: 'Documents/Target' }
    const existing = { ...file, path: 'Documents/Target/report.txt' }
    files = [{ ...file }, target, existing]
    storage.renameDriveEntry.mockRejectedValueOnce({ code: apiErrorCodes.DRIVE_ALREADY_EXISTS })
    await openDocuments()
    const transfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    dispatchDrag(entry('Target'), 'drop', transfer)
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect([...alert.querySelectorAll('button')].map(element => element.textContent?.trim()).sort())
        .toEqual([language.cancel, language.serverDrive.keepBoth, language.serverDrive.overwrite].sort())
    expect(storage.renameDriveEntry).toHaveBeenCalledExactlyOnceWith(
        'Documents/report.txt', 'report.txt', 'error', undefined, 'Documents/Target',
    )

    const blockedTransfer = dispatchDrag(entry('report.txt'), 'dragstart').dataTransfer
    dispatchDrag(entry('Target'), 'drop', blockedTransfer)
    expect(storage.renameDriveEntry).toHaveBeenCalledOnce()
    button(language.cancel, alert).click()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
    expect(storage.renameDriveEntry).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-drive-entry="Documents/report.txt"]')).not.toBeNull()
    expect(notifyError).not.toHaveBeenCalled()
})

it('keeps a dropped folder and its shortcut when a merge comparison skips the conflict', async () => {
    const incoming = { ...folder, name: 'Incoming', path: 'Documents/Incoming' }
    const target = { ...folder, name: 'Target', path: 'Documents/Target' }
    const existing = { ...folder, name: 'Incoming', path: 'Documents/Target/Incoming' }
    const conflicts = [{
        path: 'Documents/Target/Incoming/notes.txt',
        existing: { ...file, name: 'notes.txt', path: 'Documents/Target/Incoming/notes.txt' },
        incoming: { ...file, name: 'notes.txt', path: 'Documents/Incoming/notes.txt' },
    }]
    files = [{ ...file }, incoming, target, existing]
    DBState.db.serverDriveShortcuts = ['Documents/Incoming', 'Documents/Incoming/subfolder']
    storage.renameDriveEntry.mockRejectedValueOnce({ code: apiErrorCodes.DRIVE_ALREADY_EXISTS })
    storage.renameDriveEntry.mockRejectedValueOnce({
        status: 409,
        code: apiErrorCodes.DRIVE_MERGE_CONFLICT,
        details: { revision: 'drop-revision', conflicts },
    })
    storage.renameDriveEntry.mockResolvedValueOnce(renameResult(existing, []))
    chooseConflictComparison.mockResolvedValueOnce([null])
    await openDocuments()

    const transfer = dispatchDrag(entry('Incoming'), 'dragstart').dataTransfer
    dispatchDrag(entry('Target'), 'drop', transfer)
    const confirmation = await vi.waitFor(() => folderMergeDialog('Incoming'))
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(
        1, 'Documents/Incoming', 'Incoming', 'error', undefined, 'Documents/Target',
    )
    button(language.yes, confirmation).click()

    await vi.waitFor(() => expect(chooseConflictComparison).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(storage.renameDriveEntry).toHaveBeenCalledTimes(3))
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(
        2, 'Documents/Incoming', 'Incoming', 'overwrite', undefined, 'Documents/Target',
    )
    expect(storage.renameDriveEntry).toHaveBeenNthCalledWith(
        3, 'Documents/Incoming', 'Incoming', 'overwrite', {
            revision: 'drop-revision', choices: { 'Documents/Target/Incoming/notes.txt': null },
        }, 'Documents/Target',
    )
    await vi.waitFor(() => expect(document.querySelector('[data-drive-entry="Documents/Incoming"]')).not.toBeNull())
    expect(DBState.db.serverDriveShortcuts).toEqual(['Documents/Incoming', 'Documents/Incoming/subfolder'])
    expect(notifyError).not.toHaveBeenCalled()
})

it('offers new folder and upload actions on empty space without opening the file menu', async () => {
    const area = document.querySelector('main')!
    await contextMenu(area)
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    menuItem(language.serverDrive.newFolder).click()
    await tick()
    expect(dialog(language.serverDrive.newFolder)).toBeDefined()
    button(language.cancel, dialog(language.serverDrive.newFolder)).click()
    await tick()
    const picker = vi.spyOn(document.querySelector<HTMLInputElement>('input[type="file"]')!, 'click').mockImplementation(() => {})
    await contextMenu(area)
    menuItem(language.serverDrive.upload).click()
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce())
})

it('merges a new empty folder into an existing folder', async () => {
    await contextMenu(document.querySelector('main')!)
    menuItem(language.serverDrive.newFolder).click()
    await tick()
    await submitName('Documents')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())

    const alert = folderMergeDialog('Documents')
    alert.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(storage.createDriveDirectory).toHaveBeenCalledOnce())
    expect(storage.createDriveDirectory).toHaveBeenCalledExactlyOnceWith('', 'Documents', 'overwrite')
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()
    expect(document.querySelector('main')?.textContent).toContain('Documents')
})

it('cancels a pending folder conflict and leaves the name form ready for another save', async () => {
    await contextMenu(document.querySelector('main')!)
    menuItem(language.serverDrive.newFolder).click()
    await tick()
    await submitName('Documents')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())

    button(language.no, folderMergeDialog('Documents')).click()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
    expect(storage.createDriveDirectory).not.toHaveBeenCalled()
    expect(storage.renameDriveEntry).not.toHaveBeenCalled()
    expect(dialog(language.serverDrive.newFolder)).toBeDefined()
    await submitName('Notes')
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('Notes'))
    expect(storage.createDriveDirectory).toHaveBeenCalledExactlyOnceWith('', 'Notes', 'error')
})

it('toggles with Ctrl or Meta, extends from the anchor with Shift, and preserves the selection on right click', async () => {
    files = ['a.txt', 'b.txt', 'c.txt', 'report.txt'].map(name => ({ ...file, name, path: `Documents/${name}` }))
    await openDocuments()
    const selectedNames = () => [...document.querySelectorAll<HTMLButtonElement>('main button[aria-pressed="true"]')].map(button => button.getAttribute('aria-label'))
    entry('a.txt').click()
    entry('c.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await tick()
    expect(selectedNames()).toEqual(['a.txt', 'c.txt'])
    entry('a.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    await tick()
    expect(selectedNames()).toEqual(['c.txt'])
    entry('report.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await tick()
    expect(selectedNames()).toEqual(['a.txt', 'b.txt', 'c.txt', 'report.txt'])
    await contextMenu('b.txt')
    expect(selectedNames()).toHaveLength(4)
    expect(menuItem(language.serverDrive.rename).getAttribute('aria-disabled')).toBe('true')
    menuItem(language.download).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile.mock.calls.map(call => call[0])).toEqual(files.map(file => file.path)))
})

it('selects intersecting tiles by dragging and clears them with an empty-space click', async () => {
    files = ['a.txt', 'b.txt', 'report.txt'].map(name => ({ ...file, name, path: `Documents/${name}` }))
    await openDocuments()
    const area = document.querySelector('main')!
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
    vi.spyOn(entry('a.txt'), 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 80, 60))
    vi.spyOn(entry('b.txt'), 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 20, 80, 60))
    vi.spyOn(entry('report.txt'), 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 140, 80, 60))
    const pointer = { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 }
    area.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 5, clientY: 5 }))
    area.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 210, clientY: 100 }))
    area.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: 210, clientY: 100 }))
    await tick()
    expect(entry('a.txt').getAttribute('aria-pressed')).toBe('true')
    expect(entry('b.txt').getAttribute('aria-pressed')).toBe('true')
    expect(entry('report.txt').getAttribute('aria-pressed')).toBe('false')
    area.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 350, clientY: 250 }))
    area.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: 350, clientY: 250 }))
    await tick()
    expect(document.querySelectorAll('main button[aria-pressed="true"]')).toHaveLength(0)
})

it('confirms moving to trash and removes shortcuts only after deletion succeeds', async () => {
    DBState.db.serverDriveShortcuts = ['Documents', 'Documents/subfolder', 'Photos']
    await contextMenu('Documents')
    menuItem(language.serverDrive.moveToTrash).click()
    await tick()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Documents')
    button(language.cancel).click()
    await tick()
    expect(storage.deleteDriveEntry).not.toHaveBeenCalled()
    await contextMenu('Documents')
    menuItem(language.serverDrive.moveToTrash).click()
    await tick()
    button(language.serverDrive.moveToTrash, document.querySelector('[role="alertdialog"]')!).click()
    await vi.waitFor(() => expect(storage.deleteDriveEntry).toHaveBeenCalledWith('Documents'))
    await vi.waitFor(() => expect(DBState.db.serverDriveShortcuts).toEqual(['Photos']))
})

it('restores, downloads and permanently deletes trash entries, and leaves the trash from its icon', async () => {
    const trashed = (name: string) => ({ ...file, name, path: `${trashPath}/${name}` })
    trashEntries = [trashed('report.txt'), trashed('old.txt')]
    storage.restoreDriveTrashEntry.mockImplementation(async (path: string) => { trashEntries = trashEntries.filter(entry => entry.path !== path) })
    storage.deleteDriveTrashEntry.mockImplementation(async (path: string) => { trashEntries = trashEntries.filter(entry => entry.path !== path) })
    await openDocuments()
    button(language.trash).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('old.txt'))
    await vi.waitFor(() => expect(entry('old.txt').disabled).toBe(false))
    const address = document.querySelector(`nav[aria-label="${language.serverDrive.path}"]`)!
    expect(address.textContent).not.toContain(trashPath)
    await contextMenu('report.txt')
    menuItem(language.download).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledWith(`${trashPath}/report.txt`))
    await tick()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.restoreFromTrash).click()
    await vi.waitFor(() => expect(storage.restoreDriveTrashEntry).toHaveBeenCalledWith(`${trashPath}/report.txt`))
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).not.toContain('report.txt'))

    await tick()
    await contextMenu('old.txt')
    menuItem(language.serverDrive.deleteForever).click()
    await tick()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(language.serverDrive.deleteForeverConfirm.replace('{count}', '1'))
    button(language.serverDrive.deleteForever, document.querySelector('[role="alertdialog"]')!).click()
    await vi.waitFor(() => expect(storage.deleteDriveTrashEntry).toHaveBeenCalledWith(`${trashPath}/old.txt`))
    expect(storage.deleteDriveEntry).not.toHaveBeenCalled()

    const railTrash = button(language.trash, document.querySelector(`[role="navigation"][aria-label="${language.serverDrive.shortcuts}"]`)!)
    await vi.waitFor(() => expect(railTrash.disabled).toBe(false))
    railTrash.click()
    await vi.waitFor(() => expect(storage.listDrive).toHaveBeenLastCalledWith('Documents', expect.anything()))
})

it('browses the drive trash and only empties it after confirmation', async () => {
    trashEntries = [{ ...file, path: `${trashPath}/report.txt` }]
    button(language.trash).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
    expect(button(language.serverDrive.upload).disabled).toBe(true)
    button(language.emptyTrash).click()
    await tick()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(language.serverDrive.emptyTrashConfirm)
    button(language.cancel).click()
    await tick()
    expect(storage.emptyDriveTrash).not.toHaveBeenCalled()
    button(language.emptyTrash).click()
    await tick()
    button(language.emptyTrash, document.querySelector('[role="alertdialog"]')!).click()
    await vi.waitFor(() => expect(storage.emptyDriveTrash).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain(language.trashEmpty))
    expect(document.querySelector('main')?.textContent).not.toContain(language.noSearchResultsDesc)
    expect(button(language.emptyTrash).disabled).toBe(true)
    expect(storage.deleteDriveEntry).not.toHaveBeenCalled()
})

it('uses the mobile navigation toolbar and refreshes the current folder from the left rail', async () => {
    await unmount(component)
    document.body.replaceChildren()
    mdViewport.current = false
    await mountDrive()

    await openDocuments()
    const driveNav = document.querySelector(`nav[aria-label="${language.serverDrive.path}"]`)!
    const addressButtons = [...driveNav.parentElement!.querySelectorAll<HTMLButtonElement>('button')]
        .map(element => element.getAttribute('aria-label'))
    expect(addressButtons).not.toContain(language.serverDrive.back)
    expect(addressButtons).not.toContain(language.serverDrive.forward)
    expect(addressButtons).not.toContain(language.serverDrive.up)
    expect(addressButtons).not.toContain(language.close)

    const shortcuts = document.querySelector(`[role="navigation"][aria-label="${language.serverDrive.shortcuts}"]`)!
    const railButtons = [...shortcuts.querySelectorAll<HTMLButtonElement>('button')]
        .map(element => element.getAttribute('aria-label'))
    expect(railButtons).toEqual([
        language.serverDrive.privateFolder,
        language.serverDrive.upload,
        language.serverDrive.refresh,
        language.trash,
    ])
    const previousCalls = storage.listDrive.mock.calls.length
    button(language.serverDrive.refresh, shortcuts).click()
    await vi.waitFor(() => expect(storage.listDrive).toHaveBeenCalledTimes(previousCalls + 1))
    expect(storage.listDrive).toHaveBeenLastCalledWith('Documents', expect.any(AbortSignal))

    const toolbarLabel = `[role="toolbar"][aria-label="${language.serverDrive.navigation}"]`
    expect(document.querySelector(toolbarLabel)).not.toBeNull()
    expect([...document.querySelector(toolbarLabel)!.querySelectorAll('button')]
        .map(element => element.getAttribute('aria-label'))).not.toContain(language.emptyTrash)
    button(language.trash, shortcuts).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain(language.trashEmpty))
    const toolbar = document.querySelector(toolbarLabel)!
    const toolbarButtons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')]
        .map(element => element.getAttribute('aria-label'))
    expect(toolbarButtons).toEqual([
        language.serverDrive.back,
        language.serverDrive.forward,
        language.serverDrive.up,
        language.emptyTrash,
        language.close,
    ])
})

it('edits the shared trash retention setting from the trash button context popup', async () => {
    await contextMenu(button(language.trash))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')?.textContent).toContain(language.trashAutoDeleteSchedule))
    const input = document.querySelector<HTMLInputElement>('[role="menu"] input[type="number"]')!
    expect(input.value).toBe('3')
    input.value = '0'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await tick()
    expect(DBState.db.trashRetentionDays).toBe(0)
    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    button(language.trash).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain(language.trashEmpty))
})

it('reports a failed trash move without offering or performing permanent deletion', async () => {
    await openDocuments()
    const error = new Error('Disk is full')
    storage.deleteDriveEntry.mockRejectedValueOnce(error)
    await contextMenu('report.txt')
    menuItem(language.serverDrive.moveToTrash).click()
    await tick()
    button(language.serverDrive.moveToTrash, document.querySelector('[role="alertdialog"]')!).click()
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(error))
    expect(storage.deleteDriveEntry).toHaveBeenCalledExactlyOnceWith(file.path)
    expect(storage.emptyDriveTrash).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})

it('opens file actions with the keyboard and downloads from the menu', async () => {
    await openDocuments()
    entry('report.txt').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
    menuItem(language.download).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledWith(file.path))
})

it('opens the same actions after a touch hold, while allowing a short touch to finish normally', async () => {
    await openDocuments()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const target = entry('report.txt')
    const pointer = { pointerType: 'touch', pointerId: 1, bubbles: true, clientX: 100, clientY: 100 }
    target.dispatchEvent(new PointerEvent('pointerdown', pointer))
    target.dispatchEvent(new PointerEvent('pointerup', pointer))
    await vi.advanceTimersByTimeAsync(800)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    target.dispatchEvent(new PointerEvent('pointerdown', pointer))
    await vi.advanceTimersByTimeAsync(800)
    await tick()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    target.dispatchEvent(new PointerEvent('pointerup', pointer))
    expect(menuItem(language.serverDrive.rename)).toBeDefined()
    expect(menuItem(language.download)).toBeDefined()
    expect(menuItem(language.serverDrive.metadata)).toBeDefined()
    expect(storage.downloadDriveFile).not.toHaveBeenCalled()
})

it.each(['overwrite', 'rename', 'cancel'] as const)('asks before uploading a duplicate and honors %s', async choice => {
    await openDocuments()
    chooseUpload()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    expect(storage.uploadDriveFile).not.toHaveBeenCalled()
    const label = choice === 'overwrite' ? language.serverDrive.overwrite : choice === 'rename' ? language.serverDrive.keepBoth : language.cancel
    button(label, document.querySelector('[role="alertdialog"]')!).click()
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull())
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    if (choice === 'cancel') expect(storage.uploadDriveFile).not.toHaveBeenCalled()
    else {
        expect(storage.uploadDriveFile).toHaveBeenCalledWith('Documents', expect.any(File), expect.any(AbortSignal), choice)
        expect(document.querySelector('main')?.textContent).toContain(choice === 'rename' ? 'report (1).txt' : 'report.txt')
    }
    expect(notifyError).not.toHaveBeenCalled()
})

it('also asks when another device creates a name after the folder was loaded', async () => {
    await openDocuments()
    storage.uploadDriveFile.mockRejectedValueOnce({ code: 'DRIVE_ALREADY_EXISTS' })
    chooseUpload('raced.txt')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('raced.txt'))
    button(language.serverDrive.keepBoth).click()
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull())
    expect(storage.uploadDriveFile).toHaveBeenLastCalledWith('Documents', expect.any(File), expect.any(AbortSignal), 'rename')
    expect(notifyError).not.toHaveBeenCalled()
})

it('aborts an in-flight upload when the explorer closes', async () => {
    storage.uploadDriveFile.mockImplementation((_path, _file, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    chooseUpload('new.txt')
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('new.txt'))
    await unmount(component)
    component = undefined
    expect(storage.uploadDriveFile.mock.calls[0][2].aborted).toBe(true)
    expect(notifyError).not.toHaveBeenCalled()
})

async function mountPicker(extensions: string[]) {
    await unmount(component)
    const finish = vi.fn()
    rootEntries = [{ ...folder }, { ...file, name: 'cover.png', path: 'cover.png' }, { ...file, name: 'notes.txt', path: 'notes.txt' }]
    const target = document.body.appendChild(document.createElement('div'))
    component = mount(ServerDrive, { target, props: { pick: { extensions, multiple: false, finish } } })
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('notes.txt'))
    return finish
}

it('returns a picked file instead of importing it', async () => {
    const finish = await mountPicker(['png'])
    const picked = new File(['image'], 'cover.png')
    storage.readDriveFile.mockResolvedValueOnce(picked)
    entry('notes.txt').click()
    await tick()
    const openButton = button(language.serverDrive.open)
    expect(openButton.disabled).toBe(true)
    openButton.click()
    expect(finish).not.toHaveBeenCalled()
    expect(storage.readDriveFile).not.toHaveBeenCalled()

    entry('cover.png').click()
    await tick()
    expect(openButton.disabled).toBe(false)
    openButton.click()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith([picked]))
    expect(storage.readDriveFile).toHaveBeenCalledWith('cover.png', expect.any(AbortSignal))
    expect(importFile).not.toHaveBeenCalled()
})

it('returns no files when the picker closes', async () => {
    const finish = await mountPicker([])
    button(language.cancel).click()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith([]))
    expect(storage.readDriveFile).not.toHaveBeenCalled()
})
