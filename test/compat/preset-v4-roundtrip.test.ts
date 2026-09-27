/**
 * v4 ModelPreset / ModelBinding / apiKeyPool .bin round-trip compatibility
 * (plan §14-11).
 *
 * Confirms that the persistence layer (SQLite KV + msgpackr round-trip + KV
 * encoder) preserves every v4-specific top-level DB field. This locks in
 * forward compatibility so a user with v4 data exported from one local
 * instance can re-import it on another instance without losing migration
 * state, model presets, api key pool, or task bindings.
 *
 * Flow: build a v4-flavored backup → import → export → decode → deep compare.
 */
import { Packr } from 'msgpackr'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { normalizeBackup } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function encodeRisuSaveLegacy(data: unknown): Buffer {
    const encoded = packr.encode(data)
    return Buffer.concat([MAGIC_RAW, encoded])
}

interface V4Fixture {
    modelPresets: Array<Record<string, unknown>>
    apiKeyPool: Record<string, Record<string, unknown>>
    modelBinding: Record<string, unknown>
    subModelBinding: Record<string, unknown>
    taskModelBindings: Record<string, Record<string, unknown>>
    modelPresetMigrationVersion: number
    modelPresetMigrationAppliedAt: number
    modelPresetMigrationReport: Record<string, unknown>
}

function buildV4Fixture(): V4Fixture {
    return {
        modelPresets: [
            {
                id: 'preset-openai-1',
                name: 'OpenAI GPT-4o',
                profileSnapshot: {
                    profileId: 'openai:standard',
                    profileVersion: 1,
                    providerBaseId: 'openai',
                    adapterKind: 'openai-compatible',
                    auth: { kind: 'bearer', fields: ['apiKey'] },
                    endpoint: { kind: 'static', url: 'https://api.openai.com/v1/chat/completions' },
                    modelId: 'gpt-4o',
                    schema: [
                        {
                            key: 'apiKey',
                            type: 'string',
                            label: 'API Key',
                            secret: true,
                            mapsTo: { target: 'auth', path: 'apiKey' },
                        },
                        {
                            key: 'modelId',
                            type: 'string',
                            label: 'Model ID',
                            default: 'gpt-4o',
                            mapsTo: { target: 'body', path: 'model' },
                        },
                    ],
                    uiSchema: { groups: [], fields: [] },
                    defaults: {},
                    headerTemplate: { 'Content-Type': 'application/json' },
                    capabilities: ['streaming', 'reasoning', 'vision', 'tools'],
                },
                userValues: { modelId: 'gpt-4o', apiKey: 'sk-roundtrip-1' },
                sourceProfile: {
                    registryId: 'bundled',
                    profileId: 'openai:standard',
                    profileVersion: 1,
                    fetchedAt: 1_700_000_000_000,
                },
                migrationSource: {
                    sourceKind: 'global',
                    sourcePath: 'db.aiModel',
                    configHash: 'deadbeef',
                },
                apiKeyRef: 'key-1',
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
                orphanValues: { legacyField: 'will-be-orphaned' },
            },
            {
                id: 'preset-vertex-1',
                name: 'Vertex Gemini',
                profileSnapshot: {
                    profileId: 'vertex-openai:standard',
                    profileVersion: 2,
                    providerBaseId: 'vertex-openai',
                    adapterKind: 'openai-compatible',
                    auth: { kind: 'google-service-account', fields: ['serviceAccountJson'] },
                    endpoint: { kind: 'vertex-openai' },
                    modelId: '',
                    schema: [
                        {
                            key: 'serviceAccountJson',
                            type: 'string',
                            label: 'Service Account JSON',
                            secret: true,
                            mapsTo: { target: 'auth', path: 'apiKey' },
                        },
                        {
                            key: 'projectId',
                            type: 'string',
                            label: 'Project ID',
                            mapsTo: { target: 'custom', path: 'project' },
                        },
                        {
                            key: 'location',
                            type: 'string',
                            label: 'Location',
                            default: 'us-central1',
                            mapsTo: { target: 'custom', path: 'location' },
                        },
                    ],
                    uiSchema: { groups: [], fields: [] },
                    defaults: {},
                    headerTemplate: { 'Content-Type': 'application/json' },
                    capabilities: ['streaming', 'reasoning', 'vision', 'tools'],
                },
                userValues: { projectId: 'my-gcp-project', location: 'us-east5' },
                apiKeyRef: 'key-2',
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
            },
        ],
        apiKeyPool: {
            'key-1': {
                id: 'key-1',
                name: 'OpenAI Personal',
                provider: 'openai:standard',
                key: 'sk-pool-1',
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
            },
            'key-2': {
                id: 'key-2',
                name: 'Vertex SA',
                provider: 'vertex-openai:standard',
                key: '{"type":"service_account","client_email":"x@y.iam"}',
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_000,
            },
        },
        modelBinding: { kind: 'modelPreset', id: 'preset-openai-1' },
        subModelBinding: { kind: 'pluginModel', id: 'pluginmodel:::summarizer' },
        taskModelBindings: {
            memory: { kind: 'modelPreset', id: 'preset-openai-1' },
            translate: { kind: 'manualRequired', reason: 'NovelAI is not a v4 provider family' },
            emotion: { kind: 'modelPreset', id: 'preset-vertex-1' },
        },
        modelPresetMigrationVersion: 1,
        modelPresetMigrationAppliedAt: 1_700_000_000_000,
        modelPresetMigrationReport: {
            version: 1,
            appliedAt: 1_700_000_000_000,
            createdModelPresetCount: 2,
            botPresetBindingCount: 0,
            chatBindingCount: 0,
            pluginBindingCount: 1,
            manualRequiredCount: 1,
            skippedBiasCount: 0,
            warnings: [],
        },
    }
}

function buildBackupWithV4(v4: V4Fixture): Buffer {
    const database: Record<string, unknown> = {
        characters: [
            {
                name: 'TestCharacter',
                chaId: 'char-v4',
                desc: 'roundtrip',
                firstMessage: 'hi',
                chats: [
                    {
                        id: 'chat-1',
                        name: 'Chat',
                        message: [{ role: 'user', data: 'hello v4' }],
                        lastDate: 1_700_000_000_000,
                        localLore: [],
                        scriptstate: {},
                        note: '',
                    },
                ],
                chatPage: 0,
                image: '',
                type: 'character',
            },
        ],
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
        // v4 fields — the actual subject of this round-trip.
        ...v4,
    }
    const dbBin = encodeRisuSaveLegacy(database)
    return encodeBackup([{ name: 'database.risudat', data: dbBin }])
}

const servers: ServerHandle[] = []
afterAll(async () => {
    await Promise.allSettled(servers.map((s) => s.cleanup()))
})

describe('ModelPreset v4 .bin round-trip', () => {
    test('all v4 top-level fields survive import → export with byte-identical semantics', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const v4 = buildV4Fixture()
        const seed = buildBackupWithV4(v4)
        const importRes = await client.importBackup(seed)
        expect(importRes.ok).toBe(true)

        const exported = await client.exportBackup()
        const { raw } = normalizeBackup(exported)

        // ── modelPresets ────────────────────────────────────────────────
        expect(raw.modelPresets).toBeTruthy()
        const presetsOut = raw.modelPresets as Array<Record<string, unknown>>
        expect(presetsOut).toHaveLength(v4.modelPresets.length)
        // Two presets, identifiable by id; compare by id (order may differ).
        const presetById = new Map(presetsOut.map((p) => [p.id as string, p]))
        for (const expected of v4.modelPresets) {
            const got = presetById.get(expected.id as string)
            expect(got).toEqual(expected)
        }

        // ── apiKeyPool ──────────────────────────────────────────────────
        expect(raw.apiKeyPool).toEqual(v4.apiKeyPool)

        // ── ModelBinding fields ─────────────────────────────────────────
        expect(raw.modelBinding).toEqual(v4.modelBinding)
        expect(raw.subModelBinding).toEqual(v4.subModelBinding)
        expect(raw.taskModelBindings).toEqual(v4.taskModelBindings)

        // ── migration audit trail ──────────────────────────────────────
        expect(raw.modelPresetMigrationVersion).toBe(v4.modelPresetMigrationVersion)
        expect(raw.modelPresetMigrationAppliedAt).toBe(v4.modelPresetMigrationAppliedAt)
        expect(raw.modelPresetMigrationReport).toEqual(v4.modelPresetMigrationReport)

        // ── legacy fields still in place (regression net) ──────────────
        expect((raw as Record<string, unknown>).apiType).toBe('openai')
        expect(Array.isArray(raw.characters)).toBe(true)
        expect((raw.characters as unknown[]).length).toBe(1)
    })

    test('survives a second round-trip (export → import → export → compare to first export)', async () => {
        const srv = await spawnServer()
        servers.push(srv)
        const client = await createClient(srv.port, srv.password)

        const v4 = buildV4Fixture()
        await client.importBackup(buildBackupWithV4(v4))
        const firstExport = await client.exportBackup()

        // Spin up a fresh server and re-import the export.
        const srv2 = await spawnServer()
        servers.push(srv2)
        const client2 = await createClient(srv2.port, srv2.password)
        const importRes2 = await client2.importBackup(firstExport)
        expect(importRes2.ok).toBe(true)
        const secondExport = await client2.exportBackup()

        const { raw: rawA } = normalizeBackup(firstExport)
        const { raw: rawB } = normalizeBackup(secondExport)

        // Every v4 field round-trips identically across an instance hop.
        expect(rawB.modelPresets).toEqual(rawA.modelPresets)
        expect(rawB.apiKeyPool).toEqual(rawA.apiKeyPool)
        expect(rawB.modelBinding).toEqual(rawA.modelBinding)
        expect(rawB.subModelBinding).toEqual(rawA.subModelBinding)
        expect(rawB.taskModelBindings).toEqual(rawA.taskModelBindings)
        expect(rawB.modelPresetMigrationVersion).toBe(rawA.modelPresetMigrationVersion)
        expect(rawB.modelPresetMigrationAppliedAt).toBe(rawA.modelPresetMigrationAppliedAt)
        expect(rawB.modelPresetMigrationReport).toEqual(rawA.modelPresetMigrationReport)
    })
})
