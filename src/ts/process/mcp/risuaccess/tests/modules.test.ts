import type { RisuModule } from 'src/ts/process/modules'
import type { customscript, loreBook } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { beforeEach, expect, test, vi } from 'vitest'
import type { RPCToolCallContent, RPCToolCallTextContent } from '../../mcplib'
import { ModuleHandler } from '../modules'

//#region module mocks

// Suppress consoles
vi.mock(import('katex'), () => ({}))

vi.mock(import('src/ts/alert'), () => ({
  alertConfirm: vi.fn(),
}))

vi.mock(import('src/ts/stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [],
        enabledModules: [],
        modules: [],
      },
    },
    selIdState: {
      selId: 0,
    },
  } as typeof import('src/ts/stores.svelte')
})

//#endregion

const makeLorebook = (name: string): loreBook => ({
  alwaysActive: false,
  comment: name,
  content: `${name}Content`,
  insertorder: 100,
  key: `${name}Key`,
  mode: 'normal',
  secondkey: '',
  selective: false,
})

const makeRegex = (name: string): customscript => ({
  ableFlag: true,
  comment: name,
  flag: '',
  in: `${name}In`,
  out: `${name}Out`,
  type: 'editdisplay',
})

const makeModule = (name: string): RisuModule => ({
  backgroundEmbedding: '<style>abc</style>',
  customModuleToggle: 'a=b\nc=d',
  id: name,
  description: `${name}Description`,
  lorebook: [],
  lowLevelAccess: false,
  name,
  regex: [],
  trigger: [],
})

const makeToolResponse = (text: unknown): RPCToolCallTextContent[] => [
  {
    text: typeof text === 'string' ? text : JSON.stringify(text),
    type: 'text',
  },
]

const parseToolResponse = (response: RPCToolCallContent[]) => {
  expect(response).toHaveLength(1)
  const content = response[0]
  expect(content.type).toBe('text')
  if (content.type !== 'text') throw new Error(`Expected text tool response, received ${content.type}`)
  return JSON.parse(content.text)
}

beforeEach(() => {
  vi.resetAllMocks()
})

test('lists installed modules with pagination', async () => {
  const instance = new ModuleHandler()

  const modules = Array(10)
    .fill(0)
    .map((_, i) => makeModule(String(i)))
  DBState.db.modules = modules
  DBState.db.enabledModules = [modules[0].id, modules[2].id]

  const summaries = modules.map((module) => ({
    id: module.id,
    name: module.name,
    description: module.description,
    enabled: DBState.db.enabledModules.includes(module.id),
  }))
  expect(parseToolResponse(await instance.handle('risu-list-modules', { count: 3 }))).toEqual(summaries.slice(0, 3))
  expect(parseToolResponse(await instance.handle('risu-list-modules', { count: 3, offset: 3 }))).toEqual(summaries.slice(3, 6))
  expect(parseToolResponse(await instance.handle('risu-list-modules', { count: 3, offset: 10 }))).toEqual([])

  DBState.db.modules = []
  DBState.db.enabledModules = []

  expect(await instance.handle('risu-list-modules', {})).toEqual(makeToolResponse([]))
})

test('retrieves the documented module information fields', async () => {
  const instance = new ModuleHandler()

  const modules = Array(10)
    .fill(0)
    .map((_, i) => makeModule(String(i)))
  DBState.db.modules = modules
  DBState.db.enabledModules = [modules[0].id, modules[2].id, modules[4].id]

  const target = modules[4]
  const fields = [
    'backgroundEmbedding', 'customModuleToggle', 'description', 'enabled',
    'id', 'lowLevelAccess', 'name',
  ] as const
  const expected = Object.fromEntries(fields.map((field) => [
    field,
    field === 'enabled' ? DBState.db.enabledModules.includes(target.id) : target[field],
  ]))
  expect(parseToolResponse(await instance.handle('risu-get-module-info', { fields, id: target.id }))).toEqual(expected)
})

test('lists lorebooks of a module with pagination', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    lorebook: Array(10)
      .fill(0)
      .map((_, i) => makeLorebook(String(i))),
  }
  DBState.db.modules = [module]

  const summaries = module.lorebook.map((lorebook) => ({
    alwaysActive: lorebook.alwaysActive,
    keys: lorebook.key,
    name: lorebook.comment,
  }))
  expect(parseToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, id: 'A' }))).toEqual(summaries.slice(0, 3))
  expect(parseToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, offset: 3, id: 'A' }))).toEqual(summaries.slice(3, 6))
  expect(parseToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, offset: 10, id: 'A' }))).toEqual([])

  module.lorebook = []

  expect(await instance.handle('risu-list-module-lorebooks', { id: 'A' })).toEqual(makeToolResponse([]))
})

test('retrieves fields of a lorebook', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    lorebook: Array(3)
      .fill(0)
      .map((_, i) => makeLorebook(String(i))),
  }
  DBState.db.modules = [module]

  expect(parseToolResponse(await instance.handle(
    'risu-get-module-lorebook',
    { id: 'A', names: ['0', '2', '99'] },
  ))).toEqual([module.lorebook[0], module.lorebook[2]].map((lorebook) => ({
    alwaysActive: lorebook.alwaysActive,
    content: lorebook.content,
    keys: lorebook.key,
    name: lorebook.comment,
  })))
})

test('lists all regex scripts of a module', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    regex: Array(10)
      .fill(0)
      .map((_, i) => makeRegex(String(i))),
  }
  DBState.db.modules = [module]

  expect(parseToolResponse(await instance.handle('risu-get-module-regex-scripts', { id: 'A' }))).toEqual(module.regex)

  module.regex = []

  expect(await instance.handle('risu-get-module-regex-scripts', { id: 'A' })).toEqual(makeToolResponse([]))
})

test('retrieves a module Lua script', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    trigger: [
      {
        comment: '',
        conditions: [],
        effect: [{
          code: 'print("hello")',
          type: 'triggerlua'
        }],
        type: 'manual',
      }
    ]
  }
  DBState.db.modules = [module]

  expect(await instance.handle('risu-get-module-lua-script', { id: 'A' })).toEqual(makeToolResponse('print("hello")'))
})

test('errs retrieving a module Lua script if it is not using one', async () => {
  const instance = new ModuleHandler()

  DBState.db.modules = [makeModule('A')]

  expect(await instance.handle('risu-get-module-lua-script', { id: 'A' })).toEqual(makeToolResponse('Error: This module does not contain a Lua trigger.'))
})

test('errs if module not found', async () => {
  const instance = new ModuleHandler()
  const subjects = [
    'risu-get-module-info',
    'risu-set-module-info',
    'risu-list-module-lorebooks',
    'risu-get-module-lorebook',
    'risu-set-module-lorebook',
    'risu-delete-module-lorebook',
    'risu-get-module-regex-scripts',
    'risu-set-module-regex-script',
    'risu-delete-module-regex-script',
    'risu-get-module-lua-script',
    'risu-set-module-lua-script',
  ] as const

  const errors = await Promise.all(subjects.map((tool) => instance.handle(tool, { id: 'zzz' })))

  expect(errors.length).toBe(subjects.length)
  expect(
    errors
      .map((responses) => responses[0])
      .every((response) => (response as RPCToolCallTextContent).text === 'Error: Module with ID zzz not found.')
  ).toBe(true)
})
