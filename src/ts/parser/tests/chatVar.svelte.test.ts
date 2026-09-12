import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { DBState, selectedCharID } from '../../stores.svelte'
import { getChatVar, getGlobalChatVar, setChatVar } from '../chatVar.svelte'
import { risuChatParser } from '../parser.svelte'
import { resetChatVariables } from './cbs/lib'

//#region module mocks

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      pocketKeiVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => ({}),
    } as typeof import('../../storage/database.svelte'))
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
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
  } as typeof import('../../stores.svelte')
})

//#endregion

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: 'grapheme' }).filter((s) => !/[=\n]/.test(s))
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s))

beforeEach(() => {
  vi.resetAllMocks()
  resetChatVariables()
  selectedCharID.set(0)
})

test('can get a character default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.characters[0].defaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can get a template default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.templateDefaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can set a chat variable over its default value', () => {
  DBState.db.characters[0].defaultVariables = 'char=default'
  DBState.db.templateDefaultVariables = 'template=default'

  setChatVar('char', 'overridden')
  setChatVar('template', 'overridden')

  expect(getChatVar('char')).toBe('overridden')
  expect(getChatVar('template')).toBe('overridden')
})

test('returns an empty string without a selected character', () => {
  selectedCharID.set(-1)
  expect(getChatVar('missing')).toBe('')
})

test.each(['', '0', 'null'])('preserves the stored value %j', (value) => {
  DBState.db.characters[0].defaultVariables = 'value=fallback'
  setChatVar('value', value)
  DBState.db.globalChatVariables.toggle_value = value

  expect(getChatVar('value')).toBe(value)
  expect(getGlobalChatVar('toggle_value')).toBe(value)
})

test('CBS renders unset chat variables and toggles as empty strings', () => {
  expect(risuChatParser('[{{getvar::missing}}][{{getglobalvar::toggle_missing}}]')).toBe('[][]')
  expect(risuChatParser('{{equal::{{getglobalvar::toggle_missing}}::}}')).toBe('1')
})
