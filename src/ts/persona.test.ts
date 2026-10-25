import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'buffer'

const mocks = vi.hoisted(() => {
    const database: any = {}
    const downloadFile = vi.fn(async () => {})
    const readAvatarImageOrDefault = vi.fn()
    const writePng = vi.fn(async (_image: Uint8Array, _metadata: Record<string, string>) => new Uint8Array([9, 8, 7]))
    return {
        database,
        downloadFile,
        readAvatarImageOrDefault,
        writePng,
        reencodeImage: vi.fn(async (image: Uint8Array) => image),
        requestImmediateSave: vi.fn(),
        notifySuccess: vi.fn(),
        notifyError: vi.fn(),
    }
})

vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => mocks.database,
    saveImage: vi.fn(async () => ''),
    setDatabase: vi.fn(),
}))
vi.mock('./util', () => ({
    selectSingleImageFile: vi.fn(),
    selectSingleImportFile: vi.fn(),
}))
vi.mock('./alert', () => ({
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    notifySuccess: mocks.notifySuccess,
    notifyError: mocks.notifyError,
}))
vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {},
    requestImmediateSave: mocks.requestImmediateSave,
}))
vi.mock('./process/files/inlays', () => ({ reencodeImage: mocks.reencodeImage }))
vi.mock('./pngChunk', () => ({ PngChunk: { write: mocks.writePng, readGenerator: vi.fn() } }))
vi.mock('./avatarImage', () => ({ readAvatarImageOrDefault: mocks.readAvatarImageOrDefault }))
vi.mock('./download', () => ({ downloadFile: mocks.downloadFile }))
vi.mock('src/lang', () => ({
    language: {
        browserDownloadStarted: 'Download started',
        personaExportEmpty: 'Persona is empty',
    },
}))

const { changeUserPersona, exportUserPersona } = await import('./persona')

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve: (value: T) => resolve(value) }
}

describe('exportUserPersona', () => {
    it('exports the selected persona snapshot after its avatar read completes', async () => {
        mocks.database.selectedPersona = 0
        mocks.database.username = 'Edited Persona'
        mocks.database.personaPrompt = 'Edited prompt'
        mocks.database.userNote = 'Edited note'
        mocks.database.userIcon = 'edited-avatar'
        mocks.database.personas = [
            { id: 'persona-1', name: 'Old Persona', personaPrompt: 'Old prompt', note: 'Old note', icon: 'old-avatar' },
            { id: 'persona-2', name: 'Other Persona', personaPrompt: 'Other prompt', note: 'Other note', icon: 'other-avatar' },
        ]

        const avatar = deferred<Uint8Array>()
        mocks.readAvatarImageOrDefault.mockReturnValue(avatar.promise)

        const exporting = exportUserPersona(0)

        expect(mocks.database.personas[0]).toMatchObject({
            name: 'Edited Persona',
            personaPrompt: 'Edited prompt',
            note: 'Edited note',
            icon: 'edited-avatar',
        })
        expect(mocks.readAvatarImageOrDefault).toHaveBeenCalledWith('edited-avatar')

        changeUserPersona(1, 'noSave')
        Object.assign(mocks.database.personas[0], {
            name: 'Changed while exporting',
            personaPrompt: 'Changed prompt',
            note: 'Changed note',
        })
        avatar.resolve(new Uint8Array([1, 2, 3]))

        await exporting

        const metadata = mocks.writePng.mock.calls[0][1].persona
        expect(JSON.parse(Buffer.from(metadata, 'base64').toString('utf-8'))).toEqual({
            name: 'Edited Persona',
            personaPrompt: 'Edited prompt',
            note: 'Edited note',
        })
        expect(mocks.downloadFile).toHaveBeenCalledWith('Edited Persona_export.png', new Uint8Array([9, 8, 7]))
        expect(mocks.notifySuccess).toHaveBeenCalledWith('Download started')
        expect(mocks.requestImmediateSave).not.toHaveBeenCalled()
    })
})
