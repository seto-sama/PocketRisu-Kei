import { describe, expect, it } from 'vitest'
import { defaultCBSRegisterArg, getCBSCompletionNames, getCBSDefinitions, registerCBS, type RegisterCallback } from './cbs'

describe('metadata CBS', () => {
    it('reads chat macros from the room selected by the calling runtime', () => {
        const character = { chats: [
            { message: [{ data: 'First room' }] },
            { message: [{ data: 'Selected room' }] },
        ] }
        let lastMessage: RegisterCallback | undefined
        registerCBS({
            ...defaultCBSRegisterArg,
            getDatabase: () => ({ characters: [character] }) as any,
            getChatPage: () => 1,
            registerFunction: definition => {
                if (definition.name === 'lastmessage' && definition.callback !== 'doc_only') {
                    lastMessage = definition.callback
                }
            },
        })

        expect(lastMessage!('', {} as any, [], null)).toBe('Selected room')
    })

    it('keeps built-in primary names unique', () => {
        const names:string[] = []
        registerCBS({
            ...defaultCBSRegisterArg,
            registerFunction: definition => { names.push(definition.name) },
        })

        expect(new Set(names).size).toBe(names.length)
    })

    it('keeps exact callable names and aliases unique', () => {
        const owners = new Map<string, string>()
        const duplicates:string[] = []

        for(const definition of getCBSDefinitions()){
            for(const name of [definition.name, ...definition.alias]){
                const owner = owners.get(name)
                if(owner) duplicates.push(`${name}: ${owner}, ${definition.name}`)
                else owners.set(name, definition.name)
            }
        }

        expect(duplicates).toEqual([])
    })

    it('exposes current block syntax to editor tooling', () => {
        expect(getCBSCompletionNames()).toEqual(expect.arrayContaining(['#when', '/when']))
    })

    it('uses the effective generation model label for modelname', () => {
        let metadata: RegisterCallback | undefined

        registerCBS({
            ...defaultCBSRegisterArg,
            registerFunction: definition => {
                if (definition.name === 'metadata' && definition.callback !== 'doc_only') {
                    metadata = definition.callback
                }
            },
            getDatabase: () => ({}) as any,
            getGenerationModelString: () => 'Bound Preset',
            getGenerationModelMetadata: () => ({
                ...defaultCBSRegisterArg.getGenerationModelMetadata(),
                name: 'Bound Preset',
            }),
        })

        expect(metadata).toBeDefined()
        expect(metadata!('', {} as any, ['modelname'], null)).toBe('Bound Preset')
    })

    it.each(['personality', 'scenario', 'exampledialogue'])(
        'keeps the legacy %s macro inert',
        name => {
            let callback: RegisterCallback | undefined

            registerCBS({
                ...defaultCBSRegisterArg,
                registerFunction: definition => {
                    if (definition.name === name && definition.callback !== 'doc_only') {
                        callback = definition.callback
                    }
                },
            })

            expect(callback).toBeDefined()
            expect(callback!('', {} as any, [], null)).toBe('')
        },
    )
})
