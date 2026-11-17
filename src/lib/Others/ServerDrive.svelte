<script lang="ts" module>
    import type { DriveEntry } from 'src/ts/storage/nodeStorage'

    type ClipboardOperation = 'move' | 'copy'
    let clipboard = $state.raw<{ entries: DriveEntry[], operation: ClipboardOperation } | null>(null)
</script>

<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import type { HTMLAttributes } from 'svelte/elements'
    import { ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, EyeIcon, FileCheckIcon, FolderIcon, FolderPlusIcon, HardDriveIcon, ImportIcon, InfoIcon, PencilIcon, RefreshCwIcon, ScissorsIcon, StarIcon, Trash2Icon, UploadIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/storage/autoStorage'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import { apiErrorCodes } from 'src/ts/network/apiError'
    import { DBState } from 'src/ts/stores.svelte'
    import { mdViewport } from 'src/ts/gui/breakpoints'
    import { DRIVE_TRASH_DIRECTORY as trashPath } from 'src/ts/trashRetention'
    import type { DriveConflict, DriveMergePlan, DriveMergeResolution, DriveRenameResult, NodeStorage } from 'src/ts/storage/nodeStorage'
    import { chooseConflictComparison, SaveConflictCancelledError } from 'src/ts/storage/saveConflict'
    import type { ServerDriveFileRequest } from 'src/ts/serverDriveFilePicker.svelte'
    import { getFileType } from '../../../shared/fileTypes.mjs'
    import ServerDriveEntryIcon from './ServerDriveEntryIcon.svelte'
    import ServerDrivePreview from './ServerDrivePreview.svelte'
    import Button from '../UI/components/Button.svelte'
    import Input from '../UI/components/Input.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import EmptyState from '../UI/components/EmptyState.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import IconButtonGroup from '../UI/components/IconButtonGroup.svelte'
    import TrashSettingsPopup from '../UI/components/TrashSettingsPopup.svelte'
    import * as ContextMenu from '../UI/components/context-menu'
    import * as DropdownMenu from '../UI/components/dropdown-menu'

    let { open = $bindable(true), pick }: { open?: boolean, pick?: ServerDriveFileRequest } = $props()
    let storage = $state.raw<NodeStorage>()
    let preview = $state.raw<{ entry: DriveEntry, file: File | null, importable: boolean } | null>(null)
    let currentPath = $state('')
    let entries = $state<DriveEntry[]>([])
    let loading = $state(true)
    let hasLoaded = $state(false)
    let loadError = $state('')
    let busy = $state(false)
    let uploadStatus = $state('')
    let fileInput = $state<HTMLInputElement>()
    let fileArea = $state<HTMLElement>()
    let loadController: AbortController
    let operationController: AbortController
    let metadataController: AbortController
    let folderMenuController: AbortController
    let folderMenuEntries = $state<DriveEntry[]>([])
    let folderMenuLoading = $state(false)
    let folderMenuError = $state('')
    let disposed = false
    let visibleLimit = $state(100)
    let history = $state([''])
    let historyIndex = $state(0)
    let selectedPaths = $state<string[]>([])
    let selectionAnchor = $state<string | null>(null)
    let movingEntries = $state<DriveEntry[]>([])
    let dropPath = $state<string | null>(null)
    let drag = $state<{
        pointerId: number
        startX: number
        startY: number
        x: number
        y: number
        basePaths: string[]
        active: boolean
    } | null>(null)
    let deleteTargets = $state<DriveEntry[]>([])
    let emptyTrashOpen = $state(false)
    let properties = $state<DriveEntry | null>(null)
    let metadataLoading = $state(false)
    let nameOpen = $state(false)
    let renameTarget = $state<DriveEntry | null>(null)
    let name = $state('')
    let nameError = $state('')
    type ConflictChoice = Exclude<DriveConflict, 'error'> | null
    type ConflictItem = Pick<DriveEntry, 'name' | 'type' | 'size'> & { modifiedAt?: number }
    let conflict = $state<{
        incoming: ConflictItem
        existing: DriveEntry | null
        complete: (choice: ConflictChoice) => void
    } | null>(null)
    const folderMergeConflict = $derived(conflict?.incoming.type === 'directory' && conflict?.existing?.type === 'directory')

    const parts = $derived(currentPath ? currentPath.split('/') : [])
    const inTrash = $derived(currentPath === trashPath || currentPath.startsWith(trashPath + '/'))
    const hasSubfolders = $derived(entries.some(entry => entry.type === 'directory'))
    const sortedEntries = $derived([...entries]
        .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory')
            || a.name.localeCompare(b.name, undefined, { numeric: true })))
    const selectedPathSet = $derived(new Set(selectedPaths))
    const selectedEntries = $derived(sortedEntries.filter(entry => selectedPathSet.has(entry.path)))
    const selectionBox = $derived(drag?.active ? {
        left: Math.min(drag.startX, drag.x), top: Math.min(drag.startY, drag.y),
        width: Math.abs(drag.x - drag.startX), height: Math.abs(drag.y - drag.startY),
    } : null)
    const shortcuts = $derived([...new Set((DBState.db.serverDriveShortcuts ?? []).filter(path => typeof path === 'string' && path !== ''))])
    const disabled = $derived(busy || loading)
    const cutPaths = $derived(new Set(clipboard?.operation === 'move' ? clipboard.entries.map(entry => entry.path) : []))
    const canPaste = $derived(!disabled && !inTrash && !!clipboard?.entries.length
        && !clipboard.entries.some(entry => entry.type === 'directory'
            && (currentPath === entry.path || currentPath.startsWith(entry.path + '/'))))
    const pickExtensions = $derived(new Set(pick?.extensions.map(extension => extension.toLowerCase())))
    const pickedEntries = $derived(pick && selectedEntries.length && selectedEntries.every(canPick)
        && (pick.multiple || selectedEntries.length === 1) ? selectedEntries : [])
    const fileStrokeWidth = 1.5
    const controlCellSize = 40
    const menuClass = 'text-xs [&_[role=menuitem]]:text-xs [&_[role=menuitem]]:gap-1.5 [&_[role=menuitem]]:py-1'

    function actionProps(unavailable = busy) {
        return {
            disabled: unavailable || loading,
            'aria-busy': loading || undefined,
            class: loading && !unavailable ? 'disabled:opacity-100' : '',
        }
    }

    async function loadFolderMenu(path: string, open: boolean) {
        folderMenuController?.abort()
        if (!open) return
        const controller = folderMenuController = new AbortController()
        folderMenuLoading = true
        folderMenuError = ''
        try {
            const listing = path === currentPath ? entries : (await storage.listDrive(path, controller.signal)).entries
            if (!controller.signal.aborted) folderMenuEntries = listing.filter(entry => entry.type === 'directory')
        } catch (error) {
            if (!controller.signal.aborted) folderMenuError = String(error)
        } finally {
            if (folderMenuController === controller) folderMenuLoading = false
        }
    }

    function toggleShortcut(path: string) {
        if (!path) return
        DBState.db.serverDriveShortcuts = shortcuts.includes(path)
            ? shortcuts.filter(shortcut => shortcut !== path)
            : [...shortcuts, path]
    }

    function formatSize(size: number | null) {
        if (size === null) return '—'
        const unit = size > 0 ? Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4) : 0
        return `${(size / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
    }

    async function refresh(path = currentPath, targetHistoryIndex?: number) {
        if (disposed) return
        loadController?.abort()
        const controller = loadController = new AbortController()
        loading = true
        loadError = ''
        try {
            await forageStorage.Init()
            if (controller.signal.aborted) return
            storage = forageStorage.realStorage
            const result = await storage.listDrive(path, controller.signal)
            if (controller.signal.aborted) return
            metadataController?.abort()
            metadataLoading = false
            if (currentPath !== result.path) {
                selectedPaths = []
                selectionAnchor = null
                if (targetHistoryIndex === undefined) {
                    history = [...history.slice(0, historyIndex + 1), result.path]
                    historyIndex = history.length - 1
                }
            }
            if (targetHistoryIndex !== undefined) historyIndex = targetHistoryIndex
            currentPath = result.path
            entries = result.entries
            hasLoaded = true
            const entryPaths = new Set(entries.map(entry => entry.path))
            selectedPaths = selectedPaths.filter(path => entryPaths.has(path))
            if (!entryPaths.has(selectionAnchor)) selectionAnchor = null
            visibleLimit = 100
        } catch (error) {
            if (!controller.signal.aborted) loadError = String(error)
        } finally {
            if (loadController === controller) loading = false
        }
    }

    async function showProperties(entry: DriveEntry) {
        properties = entry
        metadataController?.abort()
        const controller = metadataController = new AbortController()
        metadataLoading = true
        try {
            const fresh = await storage.driveMetadata(entry.path, controller.signal)
            if (!controller.signal.aborted) properties = fresh
        } catch (error) {
            if (!controller.signal.aborted) {
                properties = null
                notifyError(error)
            }
        } finally {
            if (metadataController === controller) metadataLoading = false
        }
    }

    function closeProperties() {
        metadataController?.abort()
        properties = null
    }

    function selectEntry(event: MouseEvent, entry: DriveEntry) {
        if (disabled) return
        const additive = event.ctrlKey || event.metaKey
        const anchor = sortedEntries.findIndex(item => item.path === selectionAnchor)
        if (event.shiftKey && anchor !== -1) {
            const index = sortedEntries.indexOf(entry)
            const range = sortedEntries.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(item => item.path)
            selectedPaths = [...new Set([...(additive ? selectedPaths : []), ...range])]
        } else {
            selectedPaths = additive
                ? selectedPathSet.has(entry.path) ? selectedPaths.filter(path => path !== entry.path) : [...selectedPaths, entry.path]
                : [entry.path]
            selectionAnchor = entry.path
        }
    }

    function ensureSelected(entry: DriveEntry) {
        if (!selectedPathSet.has(entry.path)) {
            selectedPaths = [entry.path]
            selectionAnchor = entry.path
        }
    }

    function stageSelection(operation: ClipboardOperation) {
        if (disabled || inTrash || !selectedEntries.length) return
        clipboard = { operation, entries: selectedEntries.map(entry => ({ ...entry })) }
    }

    async function paste() {
        if (!canPaste) return
        const { entries: sources, operation } = clipboard
        busy = true
        const controller = operationController = new AbortController()
        try {
            for (const source of sources) {
                controller.signal.throwIfAborted()
                if (operation === 'move' && source.path.split('/').slice(0, -1).join('/') === currentPath) continue
                if (!await relocateEntry(source, source.name, currentPath, controller.signal, operation)) break
                controller.signal.throwIfAborted()
                if (operation === 'move') {
                    const remaining = clipboard.entries.filter(entry => entry.path !== source.path)
                    clipboard = remaining.length ? { operation, entries: remaining } : null
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) notifyError(error)
        } finally {
            busy = false
            await refresh()
        }
    }

    function handleClipboardKeydown(event: KeyboardEvent) {
        if (!(event.target instanceof Element) || !event.target.closest('[data-drive-files]')) return
        if (event.defaultPrevented || disabled || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
        const key = event.key.toLowerCase()
        if ((key === 'c' || key === 'x') && selectedEntries.length && !inTrash) {
            event.preventDefault()
            stageSelection(key === 'c' ? 'copy' : 'move')
        } else if (key === 'v' && canPaste) {
            event.preventDefault()
            void paste()
        }
    }

    function startEntryDrag(event: DragEvent, entry: DriveEntry) {
        if (disabled || inTrash || !event.dataTransfer) {
            event.preventDefault()
            return
        }
        ensureSelected(entry)
        movingEntries = [...selectedEntries]
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', movingEntries.map(item => item.path).join('\n'))
    }

    function endEntryDrag() {
        movingEntries = []
        dropPath = null
    }

    function canMoveTo(destination: string) {
        return !disabled && !inTrash && movingEntries.length > 0
            && destination !== currentPath && !movingEntries.some(entry => entry.path === destination)
    }

    function dropProps(destination: string) {
        return {
            ondragover: (event: DragEvent) => {
                if (!movingEntries.length || disabled || inTrash) return
                event.preventDefault()
                event.stopPropagation()
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                dropPath = canMoveTo(destination) ? destination : null
            },
            ondragleave: (event: DragEvent) => {
                if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return
                if (dropPath === destination) dropPath = null
            },
            ondrop: (event: DragEvent) => { void dropEntries(event, destination) },
        }
    }

    async function dropEntries(event: DragEvent, destination: string) {
        if (!movingEntries.length) return
        event.preventDefault()
        event.stopPropagation()
        const sources = [...movingEntries]
        const move = canMoveTo(destination)
        endEntryDrag()
        if (!move) return
        busy = true
        const controller = operationController = new AbortController()
        try {
            for (const source of sources) {
                controller.signal.throwIfAborted()
                if (!await relocateEntry(source, source.name, destination, controller.signal)) break
            }
        } catch (error) {
            if (!controller.signal.aborted) notifyError(error)
        } finally {
            busy = false
            await refresh()
        }
    }

    function startSelection(event: PointerEvent & { currentTarget: HTMLElement }) {
        if (disabled || event.button !== 0 || event.pointerType !== 'mouse'
            || (event.target as Element).closest('button')) return
        event.preventDefault()
        const area = event.currentTarget
        area.focus({ preventScroll: true })
        const rect = area.getBoundingClientRect()
        const x = event.clientX - rect.left + area.scrollLeft
        const y = event.clientY - rect.top + area.scrollTop
        const additive = event.ctrlKey || event.metaKey || event.shiftKey
        if (!additive) {
            selectedPaths = []
            selectionAnchor = null
        }
        drag = { pointerId: event.pointerId, startX: x, startY: y, x, y, basePaths: [...selectedPaths], active: false }
        area.setPointerCapture?.(event.pointerId)
    }

    function moveSelection(event: PointerEvent & { currentTarget: HTMLElement }) {
        if (!drag || event.pointerId !== drag.pointerId) return
        const area = event.currentTarget
        const rect = area.getBoundingClientRect()
        drag.x = event.clientX - rect.left + area.scrollLeft
        drag.y = event.clientY - rect.top + area.scrollTop
        drag.active ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 4
        if (!drag.active) return
        const left = Math.min(drag.startX, drag.x)
        const right = Math.max(drag.startX, drag.x)
        const top = Math.min(drag.startY, drag.y)
        const bottom = Math.max(drag.startY, drag.y)
        const hits = [...area.querySelectorAll<HTMLElement>('[data-drive-entry]')].filter(element => {
            const bounds = element.getBoundingClientRect()
            const x = bounds.left - rect.left + area.scrollLeft
            const y = bounds.top - rect.top + area.scrollTop
            return x < right && x + bounds.width > left && y < bottom && y + bounds.height > top
        }).map(element => element.dataset.driveEntry!)
        selectedPaths = [...new Set([...drag.basePaths, ...hits])]
        selectionAnchor ??= hits[0] ?? null
    }

    function finishSelection(event: PointerEvent & { currentTarget: HTMLElement }) {
        if (!drag || event.pointerId !== drag.pointerId) return
        drag = null
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }

    function askDelete() {
        if (inTrash) return
        deleteTargets = [...selectedEntries]
    }

    function closeDeleteDialog() {
        deleteTargets = []
        emptyTrashOpen = false
    }

    async function deleteSelection() {
        if (disabled || (!deleteTargets.length && !emptyTrashOpen)) return
        busy = true
        const targets = [...deleteTargets]
        const emptyTrash = emptyTrashOpen
        closeDeleteDialog()
        try {
            if (emptyTrash) {
                await storage.emptyDriveTrash()
            } else {
                for (const entry of targets) {
                    await storage.deleteDriveEntry(entry.path)
                    DBState.db.serverDriveShortcuts = shortcuts.filter(path => path !== entry.path && !path.startsWith(entry.path + '/'))
                }
            }
        } catch (error) {
            notifyError(error)
        } finally {
            busy = false
            await refresh(emptyTrash && inTrash ? trashPath : currentPath)
        }
    }

    function handleEntryKeydown(event: KeyboardEvent & { currentTarget: EventTarget & HTMLButtonElement }, entry: DriveEntry) {
        if (event.key === 'Escape' && selectedPaths.length) {
            event.preventDefault()
            event.stopPropagation()
            selectedPaths = []
            selectionAnchor = null
        } else if (event.key === 'Delete' && !disabled) {
            event.preventDefault()
            askDelete()
        } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            selectedPaths = sortedEntries.slice(0, visibleLimit).map(entry => entry.path)
        } else if (event.key === 'Enter') {
            event.preventDefault()
            activate(entry)
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
            }))
        }
    }

    function activate(entry: DriveEntry) {
        if (disabled) return
        if (entry.type === 'directory') void refresh(entry.path).then(() => { if (!disposed) fileArea?.focus({ preventScroll: true }) })
        else if (pick && canPick(entry)) void pickFiles([entry])
        else void openPreview(entry)
    }

    async function openPreview(entry: DriveEntry) {
        if (entry.type !== 'file') return
        // Import formats are binary: preview them through the server thumbnail without downloading.
        if (['character', 'preset', 'module'].includes(getFileType(entry.name))) {
            preview = { entry, file: null, importable: !pick }
            return
        }
        await runFileOperation(async signal => {
            const file = await storage.readDriveFile(entry.path, signal)
            signal.throwIfAborted()
            let importable = false
            if (!pick && /\.(png|jpe?g)$/i.test(entry.name)) {
                const { getCharacterImageFormat } = await import('src/ts/characterCards')
                importable = !!await getCharacterImageFormat(new Uint8Array(await file.arrayBuffer()))
                signal.throwIfAborted()
            }
            preview = { entry, file, importable }
        })
    }

    function thumbnailUrl(entry: DriveEntry) {
        const fileType = getFileType(entry.name)
        return entry.type === 'file' && (fileType === 'image' || fileType === 'character') ? storage.driveThumbnailUrl(entry) : ''
    }

    function canPick(entry: DriveEntry) {
        if (!pick || entry.type !== 'file') return false
        const dot = entry.name.lastIndexOf('.')
        return !pickExtensions.size || (dot >= 0 && pickExtensions.has(entry.name.slice(dot + 1).toLowerCase()))
    }

    async function pickFiles(targets: DriveEntry[]) {
        if (disabled || !targets.length) return
        busy = true
        const controller = operationController = new AbortController()
        try {
            const files: File[] = []
            for (const entry of targets) files.push(await storage.readDriveFile(entry.path, controller.signal))
            controller.signal.throwIfAborted()
            pick.finish(files)
            open = false
        } catch (error) {
            if (!controller.signal.aborted) notifyError(error)
        } finally {
            busy = false
        }
    }

    function canImport(entry: DriveEntry) {
        return entry.type === 'file' && (['character', 'preset', 'module', 'json'].includes(getFileType(entry.name))
            || /\.(png|jpe?g)$/i.test(entry.name))
    }

    async function runFileOperation(run: (signal: AbortSignal) => Promise<void>) {
        if (disabled) return
        busy = true
        const controller = operationController = new AbortController()
        try {
            await run(controller.signal)
        } catch (error) {
            if (!controller.signal.aborted) notifyError(error)
        } finally {
            busy = false
        }
    }

    function importEntry(entry: DriveEntry, downloaded: File | null = null) {
        if (entry.type !== 'file') return
        return runFileOperation(async signal => {
            const data = downloaded ?? await storage.readDriveFile(entry.path, signal)
            signal.throwIfAborted()
            const { importFile } = await import('src/ts/characterCards')
            signal.throwIfAborted()
            if (!await importFile(entry.name, data)) { notifyError(language.errors.noData); return }
            signal.throwIfAborted()
            preview = null
            open = false
        })
    }

    function openNameDialog(entry: DriveEntry | null = null) {
        renameTarget = entry
        name = entry?.name ?? ''
        nameError = ''
        nameOpen = true
    }

    async function saveName() {
        if (busy || !name.trim()) return
        busy = true
        nameError = ''
        const controller = operationController = new AbortController()
        const source = renameTarget
        try {
            const saved = source
                ? await relocateEntry(source, name, currentPath, controller.signal)
                : await resolveConflict({ name, type: 'directory', size: null },
                    policy => storage.createDriveDirectory(currentPath, name, policy), controller.signal)
            if (!saved) return
            nameOpen = false
            await refresh()
        } catch (error) {
            if (!controller.signal.aborted) nameError = String(error)
        } finally {
            busy = false
        }
    }

    async function relocateEntry(source: DriveEntry, name: string, destination: string, signal: AbortSignal, operation: ClipboardOperation = 'move') {
        const targetPath = destination ? `${destination}/${name}` : name
        if (operation === 'copy' && source.type === 'directory' && source.path === targetPath) {
            return storage.copyDriveEntry(source.path, name, 'rename', undefined, destination)
        }
        return resolveConflict({ ...source, name }, async (policy, merge) => {
            if (operation === 'copy') return storage.copyDriveEntry(source.path, name, policy, merge, destination)
            const result = await storage.renameDriveEntry(source.path, name, policy, merge, destination)
            if (source.type === 'directory') updateShortcuts(result.moves)
            return result.entry
        }, signal, operation === 'move' ? source.path : undefined, destination)
    }

    function updateShortcuts(moves: DriveRenameResult['moves']) {
        const orderedMoves = [...moves].sort((a, b) => b.from.length - a.from.length)
        DBState.db.serverDriveShortcuts = [...new Set(shortcuts.map(path => {
            const moved = orderedMoves.find(move => path === move.from || path.startsWith(move.from + '/'))
            return moved ? moved.to + path.slice(moved.from.length) : path
        }))]
    }

    function askConflict(incoming: ConflictItem, existing: DriveEntry | null, signal: AbortSignal): Promise<ConflictChoice> {
        return new Promise(resolve => {
            const abort = () => complete(null)
            const complete = (choice: ConflictChoice) => {
                signal.removeEventListener('abort', abort)
                conflict = null
                resolve(choice)
            }
            conflict = { incoming, existing, complete }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
        })
    }

    function mergePreview(entry: DriveEntry) {
        const type = entry.type === 'directory' ? language.serverDrive.folder : language.serverDrive.file
        return {
            name: entry.name,
            type,
            text: [
                `${language.serverDrive.path}: ${entry.path}`,
                `${language.serverDrive.size}: ${formatSize(entry.size)}`,
                `${language.serverDrive.modified}: ${new Date(entry.modifiedAt).toLocaleString()}`,
            ].join('\n'),
        }
    }

    async function resolveConflict(incoming: ConflictItem, save: (policy: DriveConflict, merge?: DriveMergeResolution) => Promise<DriveEntry>, signal: AbortSignal, sourcePath?: string, destination = currentPath) {
        const path = destination ? `${destination}/${incoming.name}` : incoming.name
        const known = destination === currentPath ? entries.find(entry => entry.path === path && entry.path !== sourcePath) : undefined
        let policy: DriveConflict | null = known ? await askConflict(incoming, known, signal) : 'error'
        let merge: DriveMergeResolution | undefined
        while (policy) {
            signal.throwIfAborted()
            try {
                return await save(policy, merge)
            } catch (error) {
                if (error?.code === apiErrorCodes.DRIVE_MERGE_CONFLICT) {
                    const plan = error.details as DriveMergePlan
                    try {
                        const choices = plan.conflicts.length ? await chooseConflictComparison({
                            title: language.serverDrive.mergeFolders,
                            description: language.serverDrive.mergeDescription,
                            items: plan.conflicts.map(item => ({
                                label: item.path,
                                blocks: [{ server: mergePreview(item.existing), local: mergePreview(item.incoming) }],
                            })),
                            multiple: true,
                            serverLabel: language.serverDrive.existing,
                            localLabel: language.serverDrive.incoming,
                            submitLabel: language.serverDrive.apply,
                        }, signal) : []
                        merge = { revision: plan.revision, choices: Object.fromEntries(plan.conflicts.map((item, index) => [item.path, choices[index]])) }
                        policy = 'overwrite'
                        continue
                    } catch (error) {
                        if (error instanceof SaveConflictCancelledError) return null
                        throw error
                    }
                }
                if (error?.code !== apiErrorCodes.DRIVE_ALREADY_EXISTS) throw error
                merge = undefined
                const existing = await storage.driveMetadata(path, signal).catch(() => null)
                policy = await askConflict(incoming, existing, signal)
            }
        }
        return null
    }

    async function upload(files: File[]) {
        if (!files.length || disabled) return
        busy = true
        const controller = operationController = new AbortController()
        let completed = 0
        try {
            for (const file of files) {
                controller.signal.throwIfAborted()
                uploadStatus = `${completed + 1} / ${files.length} · ${file.name}`
                const saved = await resolveConflict(
                    { name: file.name, type: 'file', size: file.size, modifiedAt: file.lastModified },
                    policy => storage.uploadDriveFile(currentPath, file, controller.signal, policy), controller.signal,
                )
                if (!saved) return
                entries = [...entries.filter(entry => entry.path !== saved.path), saved]
                completed++
            }
            notifySuccess(language.serverDrive.uploadComplete.replace('{count}', String(completed)))
        } catch (error) {
            if (!controller.signal.aborted) notifyError(error)
        } finally {
            uploadStatus = ''
            busy = false
            await refresh()
        }
    }

    async function download(entry: DriveEntry) {
        try { await storage.downloadDriveFile(entry.path) }
        catch (error) { notifyError(error) }
    }

    $effect(() => { if (!open) pick?.finish([]) })
    onMount(() => { void refresh() })
    onDestroy(() => {
        disposed = true
        pick?.finish([])
        loadController?.abort()
        metadataController?.abort()
        operationController?.abort()
        folderMenuController?.abort()
    })
</script>

<svelte:window onkeydown={handleClipboardKeydown} />

{#snippet folderDropdown(path: string)}
    {#if path !== currentPath || hasSubfolders}
        <DropdownMenu.Root onOpenChange={(open) => { void loadFolderMenu(path, open) }}>
            <DropdownMenu.Trigger disabled={disabled}>
                {#snippet child({ props })}
                    <IconButton {...props} {...actionProps()} size="default" className="risu-selectable-row hover:text-subtext" tooltipSide="bottom" title={language.serverDrive.childFolders}><ChevronRightIcon /></IconButton>
                {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content class={menuClass}>
                {#if folderMenuLoading}
                    <DropdownMenu.Item disabled>{language.loading}…</DropdownMenu.Item>
                {:else if folderMenuError}
                    <p class="px-2 py-1 text-danger" role="alert">{folderMenuError}</p>
                {:else}
                    {#each folderMenuEntries as folder (folder.path)}
                        <DropdownMenu.Item onSelect={() => { void refresh(folder.path) }}><FolderIcon />{folder.name}</DropdownMenu.Item>
                    {:else}
                        <DropdownMenu.Item disabled>{language.serverDrive.noFolders}</DropdownMenu.Item>
                    {/each}
                {/if}
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    {/if}
{/snippet}

{#snippet navigationButtons()}
    <IconButtonGroup className="gap-2">
        <IconButton {...actionProps(busy || historyIndex === 0)} tooltipSide="bottom" title={language.serverDrive.back} onclick={() => refresh(history[historyIndex - 1], historyIndex - 1)}><ChevronLeftIcon /></IconButton>
        <IconButton {...actionProps(busy || historyIndex === history.length - 1)} tooltipSide="bottom" title={language.serverDrive.forward} onclick={() => refresh(history[historyIndex + 1], historyIndex + 1)}><ChevronRightIcon /></IconButton>
        <IconButton {...actionProps(busy || !currentPath)} tooltipSide="bottom" title={language.serverDrive.up} onclick={() => refresh(parts.slice(0, -1).join('/'))}><ChevronUpIcon /></IconButton>
    </IconButtonGroup>
{/snippet}

{#snippet windowButtons()}
    <IconButtonGroup cellSize={controlCellSize}>
        {#if inTrash}
            <IconButton {...actionProps(busy || !!loadError || (currentPath === trashPath && !entries.length))} tooltipSide="bottom" title={language.emptyTrash} tone="destructive" onclick={() => { emptyTrashOpen = true }}><Trash2Icon /></IconButton>
        {/if}
        <IconButton tooltipSide="bottom" title={language.close} data-risu-dialog-close onclick={() => { open = false }}><XIcon /></IconButton>
    </IconButtonGroup>
{/snippet}

<Dialog bind:open size="xl" fullscreen={!$mdViewport} closable={false} ariaLabel={pick ? language.serverDrive.pickTitle : language.serverDrive.title}
    contentClass="md:h-[90dvh] overflow-hidden p-0 gap-0"
    bodyClass="flex min-h-0 grow overflow-hidden">
    <section class="grid min-h-0 min-w-0 flex-1 grid-cols-[var(--icon-cell-size)_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]" style:--icon-cell-size="{controlCellSize}px">
        <div class="col-start-1 row-span-2 row-start-2 flex min-h-0 flex-col bg-darkbg" role="navigation" aria-label={language.serverDrive.shortcuts}>
            <IconButtonGroup direction="vertical" className="min-h-0 flex-1 gap-2 overflow-y-auto px-2">
                {#each shortcuts as path (path)}
                    <ContextMenu.Root>
                        <ContextMenu.Trigger disabled={disabled}>
                            {#snippet child({ props })}
                                <IconButton {...props} {...actionProps()} tooltipSide="right" title={path} active={currentPath === path} activeColor="primary" onclick={() => refresh(path)}>
                                    <FolderIcon />
                                </IconButton>
                            {/snippet}
                        </ContextMenu.Trigger>
                        <ContextMenu.Content class={menuClass}>
                            <ContextMenu.Item onSelect={() => toggleShortcut(path)}><StarIcon size={16} />{language.serverDrive.removeShortcut}</ContextMenu.Item>
                        </ContextMenu.Content>
                    </ContextMenu.Root>
                {/each}
            </IconButtonGroup>
            <IconButtonGroup direction="vertical" className="gap-2 p-2">
                <IconButton {...actionProps(busy || !!loadError || inTrash)} tooltipSide="right" title={language.serverDrive.upload} onclick={() => fileInput.click()}><UploadIcon /></IconButton>
                <IconButton {...actionProps()} tooltipSide="right" title={language.serverDrive.refresh} onclick={() => refresh()}><RefreshCwIcon /></IconButton>
                <TrashSettingsPopup>
                    {#snippet trigger()}
                        <IconButton {...actionProps()} tooltipSide="right" title={language.trash} active={inTrash} activeColor="primary" onclick={() => refresh(trashPath)}><Trash2Icon /></IconButton>
                    {/snippet}
                </TrashSettingsPopup>
            </IconButtonGroup>
        </div>

        <div class="col-start-2 row-start-1 flex h-[var(--icon-cell-size)] min-w-0 items-center">
            {#if $mdViewport}{@render navigationButtons()}{/if}
            <nav class="mx-2 flex min-w-0 flex-1 items-center rounded-md bg-lightbg px-1 py-0.5" aria-label={language.serverDrive.path}>
                <div class="flex min-w-0 flex-1 items-center overflow-x-auto">
                    <IconButton {...actionProps()} {...dropProps('')} data-selected={dropPath === ''} size="default" tooltipSide="bottom" className="risu-selectable-row text-maintext hover:text-maintext" title={language.serverDrive.driveRoot} onclick={() => refresh('')}><HardDriveIcon /></IconButton>
                    {@render folderDropdown('')}
                    {#each parts as part, index}
                        {@const path = parts.slice(0, index + 1).join('/')}
                        <button {...dropProps(path)} data-selected={dropPath === path} class="risu-selectable-row h-6 shrink-0 rounded-md px-1.5 text-xs" disabled={disabled} onclick={() => refresh(path)}>{part}</button>
                        {@render folderDropdown(path)}
                    {/each}
                </div>
            </nav>
            {#if $mdViewport}{@render windowButtons()}{/if}
        </div>

        <div class="col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-tl-xl bg-lightbg">
            {#if uploadStatus}
                <div class="flex shrink-0 items-center gap-2 border-b border-darkborderc bg-primary/10 px-3 py-2" role="status">
                    <UploadIcon size={16} class="shrink-0 text-primary" />
                    <span class="min-w-0 flex-1 truncate text-sm">{language.serverDrive.uploading} {uploadStatus}</span>
                    <Button size="sm" variant="outline" onclick={() => operationController.abort()}>{language.cancel}</Button>
                </div>
            {/if}
            <ContextMenu.Root onOpenChange={(open) => { if (open) { selectedPaths = []; selectionAnchor = null } }}>
                <ContextMenu.Trigger disabled={disabled || !!loadError}>
                    {#snippet child({ props })}
                        {@const areaProps = props as HTMLAttributes<HTMLElement>}
                        <main {...areaProps} {...dropProps(currentPath)} bind:this={fileArea} class="relative min-h-0 flex-1 select-none overflow-y-auto p-3" aria-label={language.serverDrive.title} aria-busy={loading} data-drive-files tabindex="-1"
                            onpointerdown={(event) => {
                                if ((event.target as Element).closest('[data-drive-entry]')) return
                                areaProps.onpointerdown?.(event)
                                startSelection(event)
                            }}
                            onpointermove={(event) => { areaProps.onpointermove?.(event); moveSelection(event) }}
                            onpointerup={(event) => { areaProps.onpointerup?.(event); finishSelection(event) }}
                            onpointercancel={(event) => { areaProps.onpointercancel?.(event); finishSelection(event) }}
                            onlostpointercapture={finishSelection}
                            oncontextmenu={(event) => {
                                if (!(event.target as Element).closest('[data-drive-entry]')) areaProps.oncontextmenu?.(event)
                            }}>
                            {#if loading && !hasLoaded}
                                <p class="p-4 text-sm text-subtext" role="status">{language.loading}…</p>
                            {:else if loadError}
                                <p class="break-words p-4 text-sm text-danger" role="alert">{loadError}</p>
                            {:else if !sortedEntries.length}
                                <EmptyState layout="section" title={inTrash ? language.trashEmpty : language.serverDrive.empty} description={inTrash ? '' : language.serverDrive.emptyDescription} />
                            {:else}
                                <div class="grid grid-cols-[repeat(auto-fill,6rem)] gap-1">
                                    {#each sortedEntries.slice(0, visibleLimit) as entry (entry.path)}
                                        <ContextMenu.Root onOpenChange={(open) => { if (open) ensureSelected(entry) }}>
                                            <ContextMenu.Trigger disabled={disabled}>
                                                {#snippet child({ props })}
                                                    <button {...props} {...(entry.type === 'directory' ? dropProps(entry.path) : {})} type="button" tabindex="0" class="risu-selectable-row drive-entry flex min-h-24 min-w-0 select-none flex-col items-center gap-2 rounded-md border border-transparent px-2 py-3 text-[11px]" class:opacity-50={cutPaths.has(entry.path) || (pick && entry.type === 'file' && !canPick(entry))} data-selected={selectedPathSet.has(entry.path) || dropPath === entry.path} data-drive-entry={entry.path}
                                                        aria-label={entry.name} aria-pressed={selectedPathSet.has(entry.path)} disabled={disabled}
                                                        draggable={!disabled && !inTrash} ondragstart={event => startEntryDrag(event, entry)} ondragend={endEntryDrag}
                                                        onclick={(event) => selectEntry(event, entry)} ondblclick={() => activate(entry)}
                                                        onkeydown={(event) => handleEntryKeydown(event, entry)}>
                                                        <ServerDriveEntryIcon {entry} strokeWidth={fileStrokeWidth} thumbnailUrl={thumbnailUrl(entry)} />
                                                        <span class="line-clamp-3 w-full break-all text-center">{entry.name}</span>
                                                    </button>
                                                {/snippet}
                                            </ContextMenu.Trigger>
                                            <ContextMenu.Content class={menuClass} onCloseAutoFocus={(event) => { if (nameOpen || properties || deleteTargets.length) event.preventDefault() }}>
                                                {#if pick}
                                                    <ContextMenu.Item disabled={!pickedEntries.length} onSelect={() => { void pickFiles(pickedEntries) }}><FileCheckIcon size={16} />{language.serverDrive.open}</ContextMenu.Item>
                                                {:else}
                                                    <ContextMenu.Item disabled={selectedEntries.length !== 1 || !canImport(entry)} onSelect={() => { void importEntry(entry) }}><ImportIcon size={16} />{language.serverDrive.import}</ContextMenu.Item>
                                                {/if}
                                                <ContextMenu.Item disabled={selectedEntries.length !== 1 || entry.type !== 'file'} onSelect={() => { void openPreview(entry) }}><EyeIcon size={16} />{language.preview}</ContextMenu.Item>
                                                <ContextMenu.Item disabled={!selectedEntries.length} onSelect={async () => { for (const selected of selectedEntries) await download(selected) }}><DownloadIcon size={16} />{language.download}</ContextMenu.Item>
                                                {#if entry.type === 'directory' && !inTrash}
                                                    <ContextMenu.Item disabled={selectedEntries.length !== 1} onSelect={() => toggleShortcut(entry.path)}><StarIcon size={16} />{shortcuts.includes(entry.path) ? language.serverDrive.removeShortcut : language.serverDrive.addShortcut}</ContextMenu.Item>
                                                {/if}
                                                <ContextMenu.Separator />
                                                <ContextMenu.Item disabled={inTrash || !selectedEntries.length} onSelect={() => stageSelection('move')}><ScissorsIcon size={16} />{language.cut}</ContextMenu.Item>
                                                <ContextMenu.Item disabled={inTrash || !selectedEntries.length} onSelect={() => stageSelection('copy')}><CopyIcon size={16} />{language.copy}</ContextMenu.Item>
                                                <ContextMenu.Item disabled={inTrash} variant="destructive" onSelect={askDelete}><Trash2Icon size={16} />{language.serverDrive.moveToTrash}</ContextMenu.Item>
                                                <ContextMenu.Item disabled={selectedEntries.length !== 1 || inTrash} onSelect={() => openNameDialog(entry)}><PencilIcon size={16} />{language.serverDrive.rename}</ContextMenu.Item>
                                                <ContextMenu.Separator />
                                                <ContextMenu.Item disabled={selectedEntries.length !== 1} onSelect={() => showProperties(entry)}><InfoIcon size={16} />{language.serverDrive.metadata}</ContextMenu.Item>
                                            </ContextMenu.Content>
                                        </ContextMenu.Root>
                                    {/each}
                                </div>
                                {#if sortedEntries.length > visibleLimit}
                                    <Button variant="ghost" size="sm" className="mt-3 w-full" onclick={() => { visibleLimit += 100 }}>{language.serverDrive.showMore}</Button>
                                {/if}
                            {/if}
                            {#if selectionBox}
                                <div class="pointer-events-none absolute z-10 border border-primary bg-primary/10" aria-hidden="true"
                                    style:left="{selectionBox.left}px" style:top="{selectionBox.top}px" style:width="{selectionBox.width}px" style:height="{selectionBox.height}px"></div>
                            {/if}
                        </main>
                    {/snippet}
                </ContextMenu.Trigger>
                <ContextMenu.Content class={menuClass} onCloseAutoFocus={(event) => { if (nameOpen) event.preventDefault() }}>
                    {#if inTrash}
                        <ContextMenu.Item variant="destructive" disabled={currentPath === trashPath && !entries.length} onSelect={() => { emptyTrashOpen = true }}><Trash2Icon size={16} />{language.emptyTrash}</ContextMenu.Item>
                    {:else}
                        <ContextMenu.Item onSelect={() => openNameDialog()}><FolderPlusIcon size={16} />{language.serverDrive.newFolder}</ContextMenu.Item>
                        <ContextMenu.Item onSelect={() => fileInput.click()}><UploadIcon size={16} />{language.serverDrive.upload}</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item disabled={!canPaste} onSelect={() => { void paste() }}><ClipboardPasteIcon size={16} />{language.paste}</ContextMenu.Item>
                    {/if}
                </ContextMenu.Content>
            </ContextMenu.Root>
            {#if pick}
                <div class="flex shrink-0 items-center gap-2 border-t border-darkborderc px-3 py-2">
                    <span class="min-w-0 flex-1 truncate text-sm text-subtext">
                        {pickedEntries.length ? pickedEntries.map(entry => entry.name).join(', ')
                            : pick.extensions.length ? `${language.serverDrive.pickHint} (.${pick.extensions.join(', .')})` : language.serverDrive.pickHint}
                    </span>
                    <Button size="sm" variant="outline" onclick={() => { open = false }}>{language.cancel}</Button>
                    <Button size="sm" disabled={disabled || !pickedEntries.length} onclick={() => { void pickFiles(pickedEntries) }}>{language.serverDrive.open}</Button>
                </div>
            {/if}
        </div>
        {#if !$mdViewport}
            <div class="col-start-2 row-start-3 flex h-[var(--icon-cell-size)] min-w-0 items-center" role="toolbar" aria-label={language.serverDrive.navigation}>
                {@render navigationButtons()}
                <div class="flex-1"></div>
                {@render windowButtons()}
            </div>
        {/if}
        <input class="hidden" type="file" multiple bind:this={fileInput} onchange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            void upload(files)
        }} />
    </section>
</Dialog>

<Dialog open={deleteTargets.length > 0 || emptyTrashOpen} onOpenChange={(open) => { if (!open) closeDeleteDialog() }} onConfirm={() => { void deleteSelection() }} closable={false} role="alertdialog" size="sm">
    {#snippet title()}{emptyTrashOpen ? language.emptyTrash : language.serverDrive.moveToTrash}{/snippet}
    {#snippet description()}{emptyTrashOpen ? language.serverDrive.emptyTrashConfirm : language.serverDrive.trashConfirm.replace('{count}', String(deleteTargets.length))}{/snippet}
    {#if deleteTargets.length}<ul class="max-h-40 overflow-y-auto text-sm">{#each deleteTargets as entry (entry.path)}<li class="break-all">{entry.name}</li>{/each}</ul>{/if}
    {#snippet footer()}
        <Button variant="outline" onclick={closeDeleteDialog}>{language.cancel}</Button>
        <Button variant="destructive" disabled={disabled} onclick={() => { void deleteSelection() }}>{emptyTrashOpen ? language.emptyTrash : language.serverDrive.moveToTrash}</Button>
    {/snippet}
</Dialog>

{#if preview}
    {@const { entry, file, importable } = preview}
    {#key preview}
        <ServerDrivePreview {entry} {file} thumbnailUrl={thumbnailUrl(entry)} busy={disabled}
            onImport={importable ? () => { void importEntry(entry, file) } : undefined}
            onDownload={() => { void download(entry) }} onClose={() => { preview = null }} />
    {/key}
{/if}

<Dialog open={properties !== null} onOpenChange={(open) => { if (!open) closeProperties() }} size="sm">
    {#snippet title()}{language.serverDrive.metadata}{/snippet}
    {#if properties}
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt class="text-subtext">{language.name}</dt><dd class="break-all">{properties.name}</dd>
            <dt class="text-subtext">{language.type}</dt><dd>{properties.type === 'directory' ? language.serverDrive.folder : language.serverDrive.file}</dd>
            <dt class="text-subtext">{language.serverDrive.size}</dt><dd>{formatSize(properties.size)}{#if properties.size !== null} ({properties.size.toLocaleString()} B){/if}</dd>
            <dt class="text-subtext">{language.serverDrive.modified}</dt><dd>{new Date(properties.modifiedAt).toLocaleString()}</dd>
            <dt class="text-subtext">{language.serverDrive.created}</dt><dd>{properties.createdAt ? new Date(properties.createdAt).toLocaleString() : '—'}</dd>
            <dt class="text-subtext">{language.serverDrive.path}</dt><dd class="break-all">{properties.path}</dd>
        </dl>
        {#if metadataLoading}<p class="mt-3 text-xs text-subtext" role="status">{language.loading}…</p>{/if}
    {/if}
</Dialog>

<Dialog bind:open={nameOpen} size="sm" dismissible={!busy} closable={!busy}>
    {#snippet title()}{renameTarget ? language.serverDrive.rename : language.serverDrive.newFolder}{/snippet}
    <form class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void saveName() }}>
        <Input bind:value={name} aria-label={language.name} disabled={busy} maxlength={255} />
        {#if nameError}<p class="text-sm text-danger" role="alert">{nameError}</p>{/if}
        <div class="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onclick={() => { nameOpen = false }}>{language.cancel}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{language.serverDrive.apply}</Button>
        </div>
    </form>
</Dialog>

<Dialog open={conflict !== null} onOpenChange={(open) => { if (!open) conflict?.complete(null) }}
    onConfirm={folderMergeConflict ? () => conflict?.complete('overwrite') : undefined} closable={false} role="alertdialog" size="sm">
    {#snippet title()}{folderMergeConflict ? language.serverDrive.mergeFolders : language.serverDrive.conflictTitle}{/snippet}
    {#snippet description()}{(folderMergeConflict ? language.serverDrive.folderConflict : language.serverDrive.conflictDescription).replace('{name}', conflict?.incoming.name ?? '')}{/snippet}
    {#if conflict && !folderMergeConflict}
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt class="text-subtext">{language.serverDrive.existing}</dt>
            <dd>{conflict.existing?.type === 'directory' ? language.serverDrive.folder : formatSize(conflict.existing?.size ?? null)}{#if conflict.existing} · {new Date(conflict.existing.modifiedAt).toLocaleString()}{/if}</dd>
            <dt class="text-subtext">{language.serverDrive.incoming}</dt>
            <dd>{conflict.incoming.type === 'directory' ? language.serverDrive.folder : formatSize(conflict.incoming.size)}{#if conflict.incoming.modifiedAt} · {new Date(conflict.incoming.modifiedAt).toLocaleString()}{/if}</dd>
        </dl>
    {/if}
    {#snippet footer()}
        <Button variant="outline" onclick={() => conflict?.complete(null)}>{folderMergeConflict ? language.no : language.cancel}</Button>
        {#if !folderMergeConflict}<Button onclick={() => conflict?.complete('rename')}>{language.serverDrive.keepBoth}</Button>{/if}
        <Button variant={folderMergeConflict ? 'primary' : 'destructive'} disabled={!conflict?.existing || conflict.existing.type !== conflict.incoming.type} onclick={() => conflict?.complete('overwrite')}>{folderMergeConflict ? language.yes : language.serverDrive.overwrite}</Button>
    {/snippet}
</Dialog>

<style>
    .drive-entry { -webkit-touch-callout: none; }
</style>
