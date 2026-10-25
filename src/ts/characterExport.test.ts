import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    downloadFile: vi.fn(async (_name: string, _data: unknown) => {}),
    notifySuccess: vi.fn(),
    alertError: vi.fn(),
    setAlert: vi.fn(),
    readImage: vi.fn(async (_uri: string): Promise<Uint8Array> => new Uint8Array([1, 2, 3])),
    compressImage: vi.fn(async (data: Uint8Array) => data),
    getImageType: vi.fn(() => 'JPEG'),
    reencodeImage: vi.fn(async (data: Uint8Array) => data),
    sleep: vi.fn(async (_ms: number) => {}),
}))

vi.mock('./globalApi.svelte', () => {
    class AppendableBuffer {
        private chunks: Uint8Array[] = []
        get buffer() {
            const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const result = new Uint8Array(length)
            let offset = 0
            for (const chunk of this.chunks) {
                result.set(chunk, offset)
                offset += chunk.length
            }
            return result
        }
        append(chunk: Uint8Array) { this.chunks.push(chunk) }
    }
    return {
        AppendableBuffer,
        BlankWriter: class {
            async init() {}
            async write() {}
            async end() {}
        },
        LocalWriter: class {},
        VirtualWriter: class {
            buf = new AppendableBuffer()
            write(data: Uint8Array) { this.buf.append(data) }
        },
        checkCharOrder: vi.fn(),
        forageStorage: {},
        loadAsset: vi.fn(),
        downloadFile: mocks.downloadFile,
        readImage: mocks.readImage,
        requestImmediateSave: vi.fn(),
        saveAsset: vi.fn(async () => 'saved-asset'),
    }
})

vi.mock('./alert', () => ({
        alertCardExport: vi.fn(),
        alertConfirm: vi.fn(),
        alertError: mocks.alertError,
        alertInput: vi.fn(),
        alertStore: { set: mocks.setAlert },
        alertTOS: vi.fn(),
        alertWait: vi.fn(),
        notifySuccess: mocks.notifySuccess,
        notifyError: vi.fn(),
}))

vi.mock('./media', () => ({
        compressImage: mocks.compressImage,
        getImageType: mocks.getImageType,
}))

vi.mock('./process/files/inlays', () => ({ reencodeImage: mocks.reencodeImage }))

vi.mock('./util', () => ({
    checkNullish: vi.fn(),
    decryptBuffer: vi.fn(),
    isKnownUri: vi.fn(() => false),
    selectFileByDom: vi.fn(),
    sleep: mocks.sleep,
}))

vi.mock('./storage/database.svelte', () => ({
    getDatabase: vi.fn(() => ({})),
    importPreset: vi.fn(),
    isSupportedPromptPresetJSON: vi.fn(),
    newChatModelDefaults: {},
    pocketKeiVer: 'test',
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))

vi.mock('./stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        HideIconStore: writable(false),
        moduleBackgroundEmbedding: writable(''),
        selectedCharID: writable(-1),
    }
})

vi.mock('./rpack/rpack_js', () => ({
    decodeRPack: vi.fn(),
    encodeRPack: vi.fn(async () => new Uint8Array([9])),
}))

vi.mock('./process/processzip', () => ({
    CharXImporter: class {},
    CharXWriter: class {
        constructor(private writer: { write(data: Uint8Array): void }) {}
        async init() {}
        async write(_key: string, _data: Uint8Array | string) {}
        async writeJpeg() {}
        async end() { await this.writer.write(new Uint8Array([67, 72, 65, 82, 88])) }
    },
}))

vi.mock('./pngChunk', () => ({
    PngChunk: {
        streamWriter: class {
            constructor(private _image: Uint8Array, private writer: { write(data: Uint8Array): void }) {}
            async init() {}
            async write(_key: string, _data: Uint8Array | string) { this.writer.write(new Uint8Array([1])) }
            async end() {}
        },
        readGenerator: vi.fn(),
    },
}))
vi.mock('./characters', () => ({ characterFormatUpdate: vi.fn() }))
vi.mock('./interchangeability', () => ({ convertCharacterToModule: vi.fn(), convertModuleToCharacter: vi.fn() }))
vi.mock('./preset/tags', () => ({ normalizePresetTagFields: vi.fn() }))
vi.mock('./process/moduleSelection', () => ({ getEnabledModules: vi.fn() }))
vi.mock('./process/lorebook.svelte', () => ({ convertExternalLorebook: vi.fn() }))
vi.mock('./routing', () => ({ AddonSettingsTab: {}, openAddonSettings: vi.fn(), openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./parser/parser.svelte', () => ({ hasher: {} }))
vi.mock('./process/zip', () => ({ zip: {} }))
vi.mock('../../shared/fileTypes.mjs', () => ({ getFileType: vi.fn() }))
vi.mock('./download', () => ({ downloadFile: mocks.downloadFile }))
vi.mock('src/lang', () => ({
    language: {
        browserDownloadStarted: 'Download started',
        export: 'Export',
        exportAssetsPreparing: 'Preparing assets...',
    },
}))

import { exportCharacterCard } from './characterCards'
import { exportModule, exportModuleLegacy } from './process/modules'
import { convertModuleToCharacter } from './interchangeability'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

function character(additionalAssets: [string, string, string][] = []) {
    return {
        name: 'Test Character',
        image: 'avatar-uri',
        globalLore: [],
        additionalAssets,
    } as any
}

function progressAlerts() {
    return mocks.setAlert.mock.calls
        .map(([alert]) => alert)
        .filter((alert: any) => alert.type === 'progress')
}

describe('character export downloads', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.readImage.mockResolvedValue(new Uint8Array([1, 2, 3]))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([
        ['png', '.png'],
        ['json', '.json'],
        ['charx', '.charx'],
        ['charxJpeg', '.jpeg'],
    ] as const)('downloads assetless %s characters without asset progress', async (type, extension) => {
        await exportCharacterCard(character(), type, { spec: 'v3' })

        expect(progressAlerts()).toEqual([])
        expect(mocks.downloadFile).toHaveBeenCalledOnce()
        expect(mocks.downloadFile.mock.calls[0][0]).toMatch(new RegExp(`${extension.replace('.', '\\.')}$`))
        expect(mocks.notifySuccess).toHaveBeenCalledOnce()
    })

    it('exports with the default avatar when the saved image cannot be read', async () => {
        mocks.readImage.mockRejectedValueOnce(new Error('missing image'))
        vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
        try {
            await exportCharacterCard(character(), 'png', { spec: 'v3' })
            expect(mocks.downloadFile).toHaveBeenCalledOnce()
            expect(mocks.alertError).not.toHaveBeenCalled()
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('finishes generating the buffer before download and shows attached-asset progress', async () => {
        const asset = deferred<Uint8Array>()
        mocks.readImage.mockImplementation(async (uri: string) => {
            if (uri === 'attached-asset') return asset.promise
            return new Uint8Array([1, 2, 3])
        })
        const events: string[] = []
        mocks.downloadFile.mockImplementation(async () => { events.push('download') })
        mocks.notifySuccess.mockImplementation(() => { events.push('toast') })

        const exporting = exportCharacterCard(
            character([['asset.png', 'attached-asset', 'png']]),
            'charx',
            { spec: 'v3' },
        )

        await vi.waitFor(() => expect(mocks.readImage).toHaveBeenCalledWith('attached-asset'))
        expect(mocks.downloadFile).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        asset.resolve(new Uint8Array([4, 5, 6]))
        await exporting

        expect(events).toEqual(['download', 'toast'])
        const progress = progressAlerts()
        expect(progress.length).toBeGreaterThan(0)
        expect(progress.at(-1)).toMatchObject({
            type: 'progress',
            title: 'Export',
            msg: 'Preparing assets...',
            progressDetail: '1 / 1',
        })
        expect(String((progress.at(-1) as any).submsg)).toMatch(/100/)
    })

    it('does not download or report success when an attached asset fails to load', async () => {
        mocks.readImage.mockImplementation(async (uri: string) => {
            if (uri === 'broken-asset') throw new Error('asset read failed')
            return new Uint8Array([1, 2, 3])
        })

        await exportCharacterCard(
            character([['asset.png', 'broken-asset', 'png']]),
            'charx',
            { spec: 'v3' },
        )

        expect(mocks.downloadFile).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        expect(mocks.alertError).toHaveBeenCalledOnce()
    })

    it('propagates asset failures when an external writer is supplied', async () => {
        mocks.readImage.mockImplementation(async (uri: string) => {
            if (uri === 'broken-external-asset') throw new Error('asset read failed')
            return new Uint8Array([1, 2, 3])
        })

        await expect(exportCharacterCard(character([['asset.png', 'broken-external-asset', 'png']]), 'charx', {
            spec: 'v3',
            writer: { write: vi.fn() } as any,
        })).rejects.toThrow('asset read failed')

        expect(mocks.downloadFile).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        expect(mocks.alertError).not.toHaveBeenCalled()
    })

    it('finishes generating a legacy module buffer before download and toast', async () => {
        const asset = deferred<Uint8Array>()
        mocks.readImage.mockImplementation(async (uri: string) => {
            if (uri === 'module-asset') return asset.promise
            return new Uint8Array([1, 2, 3])
        })
        const events: string[] = []
        mocks.downloadFile.mockImplementation(async () => { events.push('download') })
        mocks.notifySuccess.mockImplementation(() => { events.push('toast') })

        const exporting = exportModuleLegacy({
            name: 'Test Module',
            description: '',
            id: 'module-id',
            assets: [['asset.png', 'module-asset', 'png']],
        })

        await vi.waitFor(() => expect(mocks.readImage).toHaveBeenCalledWith('module-asset'))
        expect(mocks.downloadFile).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        asset.resolve(new Uint8Array([4, 5, 6]))
        await exporting

        expect(events).toEqual(['download', 'toast'])
        expect(mocks.downloadFile).toHaveBeenCalledWith('Test Module.risum', expect.any(Uint8Array))
        const progress = progressAlerts()
        expect(progress.at(-1)).toMatchObject({
            type: 'progress',
            title: 'Export',
            msg: 'Preparing assets...',
            progressDetail: '1 / 1',
        })
        expect(String((progress.at(-1) as any).submsg)).toMatch(/100/)
    })

    it('downloads assetless legacy and CharX modules without asset progress', async () => {
        const module = {
            name: 'Test Module',
            description: '',
            id: 'module-id',
            assets: [],
        }
        await exportModuleLegacy(module)
        expect(progressAlerts()).toEqual([])
        expect(mocks.downloadFile).toHaveBeenCalledWith('Test Module.risum', expect.any(Uint8Array))

        mocks.downloadFile.mockClear()
        mocks.notifySuccess.mockClear()
        vi.mocked(convertModuleToCharacter).mockReturnValue(character())
        await exportModule(module)

        expect(progressAlerts()).toEqual([])
        expect(mocks.downloadFile).toHaveBeenCalledWith('Test Module.module.charx', expect.any(Uint8Array))
        expect(mocks.notifySuccess).toHaveBeenCalledOnce()
    })

    it('does not download or report success when legacy module asset generation fails', async () => {
        mocks.readImage.mockImplementation(async (uri: string) => {
            if (uri === 'broken-module-asset') throw new Error('asset read failed')
            return new Uint8Array([1, 2, 3])
        })

        await expect(exportModuleLegacy({
            name: 'Test Module',
            description: '',
            id: 'module-id',
            assets: [['asset.png', 'broken-module-asset', 'png']],
        })).rejects.toThrow('asset read failed')

        expect(mocks.downloadFile).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })
})
