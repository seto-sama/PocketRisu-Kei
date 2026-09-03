/**
 * Boot-time orphan folderId normalize integration test.
 *
 * Reproduces a database where a chat's folderId references a folder that no
 * longer exists in chatFolders — the symptom users see as "chat exists in
 * data but invisible in sidebar". The server should detect and clear orphan
 * folderIds during decodeDatabaseWithPersistentChatIds and persist the fix.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

// Mirror server's "raw" magic header for uncompressed RisuSave format.
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
            // Valid: in folder F1 (which exists)
            { id: 'c-valid', name: 'Valid Chat', folderId: 'F1',
              message: [{ role: 'user', data: 'hi' }], lastDate: Date.now(),
              localLore: [], note: '' },
            // Orphan: folderId points to a folder that doesn't exist
            { id: 'c-orphan', name: 'Orphan Chat', folderId: 'F-deleted',
              message: [{ role: 'user', data: 'lost' }], lastDate: Date.now(),
              localLore: [], note: '' },
            // No-folder
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

describe('orphan folderId boot-time normalize', () => {
    test('chats with folderId pointing to a deleted folder are normalized to null', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const seed = buildBackupWithOrphanFolderId()
        const importResult = await client.importBackup(seed)
        expect(importResult.ok).toBe(true)

        // Trigger /api/read so the server runs decodeDatabaseWithPersistentChatIds,
        // which is where normalizeOrphanFolderIds lives.
        const readRes = await client.fetch('/api/read', {
            headers: {
                'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex'),
            },
        })
        expect(readRes.ok).toBe(true)

        // Export the now-normalized backup and inspect the on-disk state.
        const exported = await client.exportBackup()
        const entries = decodeBackup(exported)
        const dbEntry = entries.find(e => e.name === 'database.risudat')
        expect(dbEntry).toBeDefined()

        const db = decodeRisuDat(dbEntry!.data) as any
        const character = db.characters.find((c: any) => c?.chaId === 'orphan-char-1')
        expect(character).toBeDefined()

        const chatById = (id: string) => character.chats.find((c: any) => c?.id === id)

        // Valid folder reference must survive untouched.
        expect(chatById('c-valid').folderId).toBe('F1')

        // Orphan folderId must be null/undefined — anything else means the
        // sidebar would still hide this chat after a server restart.
        const orphanFolder = chatById('c-orphan').folderId
        expect(orphanFolder == null).toBe(true)

        // No-folder chat must remain no-folder.
        expect(chatById('c-nofolder').folderId == null).toBe(true)

        // Orphan chat's payload (messages) must be preserved — we only fix
        // the folder pointer, not the data the user typed.
        expect(chatById('c-orphan').message).toMatchObject([
            { role: 'user', data: 'lost' },
        ])
        expect(chatById('c-orphan').message[0].chatId).toEqual(expect.any(String))
    })

    test('database with no orphans is left alone (no false positives)', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const character = {
            name: 'CleanCharacter',
            chaId: 'clean-char-1',
            desc: '',
            firstMessage: 'hi',
            chats: [
                { id: 'c1', name: 'In F1', folderId: 'F1',
                  message: [], lastDate: Date.now(), localLore: [], note: '' },
                { id: 'c2', name: 'No folder',
                  message: [], lastDate: Date.now(), localLore: [], note: '' },
            ],
            chatFolders: [{ id: 'F1', name: 'Folder 1', folded: false }],
            chatPage: 0,
            image: '',
            type: 'character',
        }
        const database: Record<string, unknown> = {
            characters: [character],
            apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
            temperature: 80, maxContext: 4000, maxResponse: 300,
            frequencyPenalty: 70, PresensePenalty: 70,
            personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
            botPresets: [], botPresetsId: 0, moduleIntergration: [],
            selectedCharacter: 0,
        }
        const seed = encodeBackup([
            { name: 'database.risudat', data: encodeRisuSave(database) },
        ])
        await client.importBackup(seed)
        await client.fetch('/api/read', {
            headers: {
                'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex'),
            },
        })

        const exported = await client.exportBackup()
        const dbEntry = decodeBackup(exported)
            .find(e => e.name === 'database.risudat')!
        const db = decodeRisuDat(dbEntry.data) as any
        const char = db.characters.find((c: any) => c?.chaId === 'clean-char-1')
        const find = (id: string) => char.chats.find((c: any) => c?.id === id)
        expect(find('c1').folderId).toBe('F1')
        expect(find('c2').folderId == null).toBe(true)
    })
})
