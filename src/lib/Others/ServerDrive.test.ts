import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ServerDrive from './ServerDrive.svelte'
import { language } from 'src/lang'
import { DBState } from 'src/ts/stores.svelte'
import { DRIVE_TRASH_DIRECTORY as trashPath } from 'src/ts/trashRetention'

const { storage, notifyError, mdViewport } = await vi.hoisted(async () => {
    const { writable } = await import('svelte/store')
    return {
        storage: {
            listDrive: vi.fn(), driveMetadata: vi.fn(), renameDriveEntry: vi.fn(),
            createDriveDirectory: vi.fn(), uploadDriveFile: vi.fn(), downloadDriveFile: vi.fn(),
            deleteDriveEntry: vi.fn(), emptyDriveTrash: vi.fn(),
        },
        notifyError: vi.fn(),
        mdViewport: writable(true),
    }
})
vi.mock('src/ts/storage/autoStorage', () => ({ forageStorage: { Init: async () => {}, realStorage: storage } }))
vi.mock('src/ts/gui/breakpoints', () => ({ mdViewport }))
vi.mock('src/ts/alert', () => ({ notifyError, notifySuccess: vi.fn() }))
vi.mock('src/ts/parser/parser.svelte', () => ({ parseMarkdownSafe: (text: string) => text }))
vi.mock('src/ts/stores.svelte', async () => {
    const { fromStore, writable } = await import('svelte/store')
    const shortcuts = fromStore(writable<string[]>([]))
    const retention = fromStore(writable(3))
    return { DBState: { db: {
        get serverDriveShortcuts() { return shortcuts.current },
        set serverDriveShortcuts(value: string[]) { shortcuts.current = value },
        get trashRetentionDays() { return retention.current },
        set trashRetentionDays(value: number) { retention.current = value },
    } } }
})

let component: ReturnType<typeof mount>
const folder = { name: 'Documents', path: 'Documents', type: 'directory', size: null, createdAt: 100, modifiedAt: 200 }
const file = { name: 'report.txt', path: 'Documents/report.txt', type: 'file', size: 10, createdAt: 100, modifiedAt: 200 }
let files: typeof file[]
let trashEntries: typeof file[]

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
    const result = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label)
    expect(result, label).toBeDefined()
    return result!
}

async function contextMenu(target: string | HTMLElement) {
    (typeof target === 'string' ? entry(target) : target).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }))
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
}

function dialog(title: string) {
    const result = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find(element => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent === title)
    expect(result, title).toBeDefined()
    return result!
}

function chooseUpload(name = 'report.txt') {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['replacement'], name)], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(async () => {
    vi.resetAllMocks()
    localStorage.clear()
    mdViewport.set(true)
    DBState.db.serverDriveShortcuts = []
    DBState.db.trashRetentionDays = 3
    files = [{ ...file }]
    trashEntries = []
    storage.listDrive.mockImplementation(async (path: string) => ({ path, entries: path === trashPath ? trashEntries : path ? files : [folder] }))
    storage.emptyDriveTrash.mockImplementation(async () => { trashEntries = [] })
    storage.driveMetadata.mockImplementation(async (path: string) => path === folder.path ? folder : { ...file, size: 42 })
    storage.uploadDriveFile.mockImplementation(async (_path, uploaded, _signal, mode) => {
        const name = mode === 'rename' ? 'report (1).txt' : uploaded.name
        const saved = { ...file, name, path: `Documents/${name}`, size: uploaded.size }
        files = [...files.filter(item => item.path !== saved.path), saved]
        return saved
    })
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
    storage.renameDriveEntry.mockRejectedValueOnce(new Error('Name already exists'))
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${language.name}"]`)!
    input.value = 'existing.txt'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Name already exists'))
    expect(input.disabled).toBe(false)
    input.value = 'new.txt'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    storage.renameDriveEntry.mockImplementationOnce(async () => { files = [{ ...file, name: 'new.txt', path: 'Documents/new.txt' }] })
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('new.txt'))
})

it('does not start another listing when a rename completes after the explorer closes', async () => {
    let completeRename!: () => void
    storage.renameDriveEntry.mockImplementationOnce(() => new Promise<void>(resolve => { completeRename = resolve }))
    await openDocuments()
    await contextMenu('report.txt')
    menuItem(language.serverDrive.rename).click()
    await tick()
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${language.name}"]`)!
    input.value = 'renamed.txt'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
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
    DBState.db.serverDriveShortcuts = ['Documents', 'Documents/subfolder', 'Documents-old']
    await contextMenu('Documents')
    menuItem(language.serverDrive.rename).click()
    await tick()
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${language.name}"]`)!
    input.value = 'Renamed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(DBState.db.serverDriveShortcuts).toEqual(['Renamed', 'Renamed/subfolder', 'Documents-old']))
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

it('browses the drive trash and only empties it after confirmation', async () => {
    trashEntries = [{ ...file, path: `${trashPath}/report.txt` }]
    button(language.trash).click()
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toContain('report.txt'))
    expect(button(language.serverDrive.upload).disabled).toBe(true)
    await contextMenu('report.txt')
    expect(menuItem(language.serverDrive.rename).getAttribute('aria-disabled')).toBe('true')
    menuItem(language.download).click()
    await vi.waitFor(() => expect(storage.downloadDriveFile).toHaveBeenCalledWith(`${trashPath}/report.txt`))
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
    mdViewport.set(false)
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
