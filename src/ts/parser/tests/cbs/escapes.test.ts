import { writable } from 'svelte/store'
import { describe, expect, test, vi } from 'vitest'
import { risuChatParser, risuUnescape } from '../../parser.svelte'

//#region module mocks

vi.mock(
  import('../../../storage/database.svelte'),
  () =>
    ({
      pocketKeiVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => ({}),
    }) as typeof import('../../../storage/database.svelte'),
)

vi.mock(import('../../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../../stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [
          {
            chats: [
              {
                scriptstate: {},
              },
            ],
            defaultVariables: '',
          },
        ],
        globalChatVariables: {},
        templateDefaultVariables: '',
      },
    },
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as typeof import('../../../stores.svelte')
})

//#endregion

const parse = (s: string): string => risuUnescape(risuChatParser(s))

test('bo, bc', () => {
  expect(parse('{{bo}}')).toBe('{{')
  expect(parse('{{bc}}')).toBe('}}')
})

test('br', () => {
  expect(parse('{{br}}')).toBe('\n')
})

test('cbr', () => {
  expect(parse('{{cbr}}')).toBe('\\n')
  // FIXME: Broken => cbr::3cbr::3cbr::3
  // expect(parse('{{cbr::3}}')).toBe('\\n\\n\\n')
})

test('decbo, decbc', () => {
  expect(parse('{{decbo}}')).toBe('{')
  expect(parse('{{decbc}}')).toBe('}')
})

test(';', () => {
  expect(parse('{{;}}')).toBe(';')
})

test('()', () => {
  expect(parse('{{(}}')).toBe('(')
  expect(parse('{{)}}')).toBe(')')
})

test('<>', () => {
  expect(parse('{{<}}')).toBe('&lt;')
  expect(parse('{{>}}')).toBe('&gt;')
})

test('#pure', () => {
  expect(risuChatParser('{{#pure}} {{br}} {{/}}')).toBe('{{br}}')
})

test('#puredisplay', () => {
  expect(risuChatParser('{{#puredisplay}}{{br}}{{/}}')).toBe('\\{\\{br\\}\\}')
})

describe('#escape', () => {
  test('preserves nested CBS without evaluating it and trims whitespace', () => {
    expect(parse('{{#escape}}\n{{br}}\n{{/}}')).toBe('{{br}}')
  })

  test('::keep preserves all whitespaces', () => {
    expect(parse('{{#escape::keep}}\n{{br}}\n{{/}}')).toBe('\n{{br}}\n')
  })
})

test('angle-bracket name tags are parsed even without other CBS', () => {
  expect(risuChatParser('hi <char>, a{b}#}', { consistantChar: true })).toBe('hi botname, a{b}#}')
})
