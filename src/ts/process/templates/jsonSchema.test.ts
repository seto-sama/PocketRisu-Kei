import { expect, test, vi } from 'vitest'
import {
    convertInterfaceToSchema,
    getGeneralJSONSchema,
    getOpenAIJSONSchema,
    resolveRequestedJSONSchema,
} from './jsonSchema'
import { convertInterfaceToSchemaCore } from './jsonSchemaCore'

vi.mock('src/ts/parser/parser.svelte', () => ({ risuChatParser: (text: string) => text.replace('{{field}}', 'answer') }))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({ jsonSchema: '{"type":"object","properties":{}}', strictJsonSchema: true }),
}))
vi.mock('src/ts/util', () => ({ jsonOutputTrimmer: (text: string) => text }))

test('browser and server schema conversion share template and interface handling', () => {
    const input = 'interface Output {\n{{field}}: string;\n}'
    const schema = convertInterfaceToSchema(input)
    expect(schema.properties.answer).toEqual({ type: 'string' })
    expect(convertInterfaceToSchemaCore(input, text => text.replace('{{field}}', 'answer'))).toEqual(schema)
})

test('browser schema wrappers retain database defaults and exclusions', () => {
    expect(getOpenAIJSONSchema()).toEqual({
        name: 'format', strict: true, schema: { type: 'object', properties: {} },
    })
    expect(getGeneralJSONSchema('{"type":"string","description":"hidden"}', ['description']))
        .toEqual({ type: 'string' })
})

test('only resolves non-empty explicit or enabled global schemas', () => {
    expect(resolveRequestedJSONSchema(undefined, true, '')).toBeUndefined()
    expect(resolveRequestedJSONSchema('   ', true, '   ')).toBeUndefined()
    expect(resolveRequestedJSONSchema(undefined, false, '{"type":"object"}')).toBeUndefined()
    expect(resolveRequestedJSONSchema(undefined, true, '{"type":"object"}'))
        .toBe('{"type":"object"}')
    expect(resolveRequestedJSONSchema('{"type":"string"}', false, ''))
        .toBe('{"type":"string"}')
})
