import { describe, expect, it } from 'vitest'
import { defaultCBSRegisterArg, registerCBS, type RegisterCallback } from './cbs'

describe('metadata CBS', () => {
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
})
