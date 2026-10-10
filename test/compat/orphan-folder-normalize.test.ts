/** Legacy backup import repairs chat folder references to deleted folders. */
import { describe, test, expect, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function encodeRisuSave(data: unknown): Buffer {
    return Buffer.concat([MAGIC_RAW, packr.encode(data)])
}

function buildBackupWithOrphanFolderId(): Buffer {
    const character = {
        name: 'OrphanCharacter',
        chaId: 'orphan-char-1',
        desc: '',
        firstMessage: 'hi',
        chats: [
            { id: 'c-valid', name: 'Valid Chat', folderId: 'F1',
              message: [{ role: 'user', data: 'hi' }], lastDate: Date.now(),
              localLore: [], note: '' },
            { id: 'c-orphan', name: 'Orphan Chat', folderId: 'F-deleted',
              message: [{ role: 'user', data: 'lost' }], lastDate: Date.now(),
              localLore: [], note: '' },
            { id: 'c-nofolder', name: 'No folder', message: [],
              lastDate: Date.now(), localLore: [], note: '' },
        ],
        chatFolders: [
            { id: 'F1', name: 'Folder 1', folded: false },
        ],
        chatPage: 0,
        image: '',
        type: 'character',
    }

    const database: Record<string, unknown> = {
        characters: [character],
        apiType: 'openai',
        mainPrompt: '',
        jailbreak: '',
        globalNote: '',
        temperature: 80,
        maxContext: 4000,
        maxResponse: 300,
        frequencyPenalty: 70,
        PresensePenalty: 70,
        personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
        botPresets: [],
        botPresetsId: 0,
        moduleIntergration: [],
        selectedCharacter: 0,
    }

    const dbBin = encodeRisuSave(database)
    return encodeBackup([{ name: 'database.risudat', data: dbBin }])
}

const servers: ServerHandle[] = []
afterAll(async () => {
    await Promise.allSettled(servers.map(s => s.cleanup()))
})

describe('legacy backup folder normalization', () => {
    test('clears deleted folder references while preserving chat content', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const seed = buildBackupWithOrphanFolderId()
        const importResult = await client.importBackup(seed)
        expect(importResult.ok).toBe(true)

        const exported = await client.exportBackup()
        const entries = decodeBackup(exported)
        const dbEntry = entries.find(e => e.name === 'database.risudat')
        expect(dbEntry).toBeDefined()

        const db = decodeRisuDat(dbEntry!.data) as any
        const character = db.characters.find((c: any) => c?.chaId === 'orphan-char-1')
        expect(character).toBeDefined()

        const chatById = (id: string) => character.chats.find((c: any) => c?.id === id)

        expect(chatById('c-valid').folderId).toBe('F1')
        expect(chatById('c-orphan').folderId == null).toBe(true)
        expect(chatById('c-nofolder').folderId == null).toBe(true)
        expect(chatById('c-orphan').message).toMatchObject([
            { role: 'user', data: 'lost' },
        ])
        expect(chatById('c-orphan').message[0].chatId).toEqual(expect.any(String))
    })
})
