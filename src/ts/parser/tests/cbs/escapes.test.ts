import { writable } from 'svelte/store'
import { describe, expect, test, vi } from 'vitest'
import { risuChatParser, risuUnescape } from '../../parser.svelte'
import { trimVarPrefix } from './lib'

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

/** Returns accessed key as the value. */
const varStorage = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get(_, prop) {
          return trimVarPrefix(prop)
        },
      },
    ),
)

vi.mock(import('../../../stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
            chats: [
              {
                scriptstate: varStorage,
              },
            ],
            defaultVariables: '',
          },
        ],
        globalChatVariables: varStorage,
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
